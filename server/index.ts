// OpenBuild server: serves the React app (bundled by Bun, with HMR in dev) and runs threads on the
// installed Pi (server/pi/), in projects and worktrees on this machine (projects.ts). Threads and
// settings are kept on disk (see storage.ts), so they don't depend on which port or browser you open
// the app in. The older Opencode proxy (/api/chat) is still served for API-key-only setups.
import { hostname as osHostname } from "node:os";
import index from "../src/index.html";
import { CLOUD_URL } from "../shared/cloud";
import { isStreamId, isStreamRef } from "../shared/replies";
import { SEARCH_PROVIDERS, type ChatRequest, type KeyEdit, type KeyInventory } from "../shared/types";
import { bad, handleChat, handleModels, handleSearchCheck, isKey, isPlan, isSearchProvider, readJson } from "./handlers";
import { piRoutes } from "./pi/routes";
import { loadPlugins, pluginRoutes } from "./plugins";
import { discoverSessions } from "./pi/discovery";
import { localAuth } from "./localAuth";
import { checkWhisper, transcribe } from "./dictation";
import { findRun, localRun, startRun } from "./runs";
import * as storage from "./storage";
import * as vault from "./vault";

const isEdits = (e: unknown): e is KeyEdit[] =>
  Array.isArray(e) &&
  e.length <= 20 &&
  e.every((x) => x && (typeof x.id === "string" ? x.secret === undefined && x.id.length <= 64 : isKey(x.secret)));
const isChatId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 128;
const isChat = (c: any): c is storage.StoredChat =>
  !!c && typeof c === "object" && isChatId(c.id) && Number.isFinite(c.updatedAt) && Number.isFinite(c.createdAt) && Array.isArray(c.messages);
/** The client's persisted UI state (settings, sidebar layout), stored as one JSON document. */
const STATE_KEY = "client-state";
/** Names this server (its data), so a synced reply that's running here is only picked up by apps it serves. */
const serverId = (() => {
  let id = storage.getValue("server-id");
  if (!id) storage.setValue("server-id", (id = crypto.randomUUID()));
  return id;
})();
/** This computer's name as people know it ("Gal's MacBook Pro"), shown where threads run. */
const machine = (() => {
  if (process.platform === "darwin") {
    const r = Bun.spawnSync(["scutil", "--get", "ComputerName"]);
    const name = r.stdout.toString().trim();
    if (r.exitCode === 0 && name) return name;
  }
  return osHostname().replace(/\.local$/, "");
})();
const runHeaders = { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform", "x-openchat-run": "1" };

// Every API checks the Host allowlist (DNS rebinding), exact browser Origin (CSRF),
// and the local password session. Only status/login/logout omit the session check
// (verify/password check it themselves).
// Serving beyond localhost is opt-in: set HOST and OPENCHAT_ALLOWED_HOSTS.
const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", ...(process.env.OPENCHAT_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)]);
const hostname = (host: string) => host.toLowerCase().replace(/:\d+$/, "");
function forbidden(req: Request): Response | undefined {
  const host = req.headers.get("host");
  const origin = req.headers.get("origin");
  let originHost: string | undefined;
  try {
    originHost = origin && origin !== "null" ? new URL(origin).host : undefined;
  } catch {}
  const ok = host && allowedHosts.has(hostname(host)) && (origin === null || (originHost !== undefined && originHost.toLowerCase() === host.toLowerCase()));
  return ok ? undefined : bad("Forbidden", 403);
}
/** Wrap an API handler with the request check. */
const api =
  <R extends Request, A extends unknown[]>(handler: (req: R, ...rest: A) => Response | Promise<Response>) =>
  (req: R, ...rest: A) =>
    forbidden(req) ?? localAuth.protect(req, () => handler(req, ...rest));

function serve(port: number, hostname: string) {
  return Bun.serve({
    port,
    // Loopback by default, even with password protection.
    hostname,
    idleTimeout: 120,
    development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
    routes: {
      "/*": index,

      // Only these authentication routes are public; never allow first-time password setup over the network.
      "/api/auth/status": { GET: (req) => forbidden(req) ?? localAuth.status(req) },
      "/api/auth/login": { POST: (req) => forbidden(req) ?? localAuth.login(req) },
      "/api/auth/logout": { POST: (req) => forbidden(req) ?? localAuth.logout(req) },
      // Signed-in browsers only, and the current password is re-checked.
      "/api/auth/verify": { POST: (req) => forbidden(req) ?? localAuth.verify(req) },
      "/api/auth/password": { POST: (req) => forbidden(req) ?? localAuth.change(req) },

      // Authenticated client config: the sync service to sign in to (shared/cloud.ts), unless
      // OPENCHAT_CLOUD_URL points this server at another one (e.g. a dev deployment).
      "/api/config": {
        GET: api(() => Response.json({ convexUrl: process.env.OPENCHAT_CLOUD_URL || CLOUD_URL || null, mode: "local", serverId, machine })),
      },

      "/api/dictation/check": { GET: api(checkWhisper) },
      "/api/dictation/transcribe": { POST: api(transcribe) },

      // Saved keys as opaque ids, never secrets.
      "/api/keys": {
        GET: api(async () => Response.json({ backend: await vault.backend(), keys: await vault.listIds() } satisfies KeyInventory)),
      },

      // The secrets themselves, for account key sync (Settings → Account → Sync API keys), which
      // encrypts them in the browser before upload. Same request checks as every other API route.
      "/api/keys/secrets": {
        GET: api(async () => Response.json({ secrets: await vault.allSecrets() })),
      },

      // Replace a scope's ordered key list: keep saved keys by id, add new ones by secret.
      "/api/keys/:scope": {
        PUT: api(async (req: Bun.BunRequest<"/api/keys/:scope">) => {
          const { scope } = req.params;
          const body = await readJson(req);
          if (!vault.isScope(scope) || !isEdits(body?.keys)) return bad("Expected { keys: ({ id } | { secret })[] }");
          try {
            return Response.json({ ids: await vault.setKeys(scope, body.keys.map((e: KeyEdit) => ("id" in e ? e : { secret: e.secret.trim() }))) });
          } catch (err) {
            return bad((err as Error).message);
          }
        }),
      },

      // Check a saved key (by id) and list the models it can use.
      "/api/models": {
        POST: api(async (req) => {
          const body = await readJson(req);
          if (!isPlan(body?.plan) || typeof body?.id !== "string") return bad("Expected { plan, id }");
          return handleModels(body.plan, await vault.secretById(body.plan, body.id));
        }),
      },

      // Check a saved search key (by id), or a SearXNG address (by url), with one small search.
      "/api/verify-search": {
        POST: api(async (req) => {
          const body = await readJson(req);
          const provider = body?.provider;
          if (!isSearchProvider(provider)) return bad("Expected { provider, id } or { provider, url }");
          if (SEARCH_PROVIDERS[provider].credential === "url") return handleSearchCheck(provider, isKey(body?.url) ? body.url.trim() : undefined);
          if (typeof body?.id !== "string") return bad("Expected { provider, id }");
          return handleSearchCheck(provider, await vault.secretById(provider, body.id));
        }),
      },

      // A reply runs on its own (runs.ts): if this request's connection drops, it keeps going, and the
      // app picks it back up from /api/chat/runs/:id. Sending the same reply id again just watches it.
      "/api/chat": {
        POST: api(async (req, server: Bun.Server<unknown>) => {
          // Long generations shouldn't be cut off by the idle timeout.
          server.timeout(req, 0);
          const body = (await readJson(req)) as ChatRequest | undefined;
          if (!isStreamRef(body?.stream)) return handleChat(req.signal, body, (scope) => vault.secrets(scope));
          const run = localRun(body.stream.id, () => startRun((signal) => handleChat(signal, body, (scope) => vault.secrets(scope))));
          return new Response(run.stream(), { headers: runHeaders });
        }),
      },
      "/api/chat/runs/:id": {
        GET: api((req: Bun.BunRequest<"/api/chat/runs/:id">, server: Bun.Server<unknown>) => {
          server.timeout(req, 0);
          const run = isStreamId(req.params.id) ? findRun(req.params.id) : undefined;
          return run ? new Response(run.stream(), { headers: runHeaders }) : bad("No such reply", 404);
        }),
      },
      "/api/chat/runs/:id/stop": {
        POST: api((req: Bun.BunRequest<"/api/chat/runs/:id/stop">) => {
          if (isStreamId(req.params.id)) findRun(req.params.id)?.stop();
          return Response.json({ ok: true });
        }),
      },

      // Chats, stored on disk. Deleting keeps a tombstone so a deleted chat can't come back.
      // `?index`: only ids and versions, so browsers fetch just the chats their cache lacks.
      "/api/chats": {
        GET: api(async (req) => {
          await discoverSessions();
          if (new URL(req.url).searchParams.has("index")) return Response.json({ index: storage.chatIndex() });
          return Response.json({ chats: storage.listChats() });
        }),
        DELETE: api(() => {
          storage.deleteAllChats();
          return Response.json({ ok: true });
        }),
      },
      // Chats a browser kept before they were stored on disk (IndexedDB, per port).
      "/api/chats/import": {
        POST: api(async (req) => {
          const body = await readJson(req);
          if (!Array.isArray(body?.chats) || !body.chats.every(isChat)) return bad("Expected { chats: Chat[] }");
          return Response.json({ imported: storage.importChats(body.chats) });
        }),
      },
      // The given chats as stored, spliced in raw rather than parsed and serialized again.
      "/api/chats/fetch": {
        POST: api(async (req) => {
          const body = await readJson(req);
          if (!Array.isArray(body?.ids) || !body.ids.every((id: unknown) => typeof id === "string")) return bad("Expected { ids: string[] }");
          const rows = storage.chatsById(body.ids);
          return new Response(`{"chats":[${rows.map((r) => `{"v":${JSON.stringify(r.v)},"chat":${r.data}}`).join(",")}]}`, {
            headers: { "content-type": "application/json" },
          });
        }),
      },
      "/api/chats/:id": {
        PUT: api(async (req: Bun.BunRequest<"/api/chats/:id">) => {
          const chat = await readJson(req);
          if (!isChat(chat) || chat.id !== req.params.id) return bad("Expected a chat whose id matches the URL");
          const v = storage.putChat(chat);
          return v ? Response.json({ ok: true, v }) : bad("Chat was deleted", 410);
        }),
        DELETE: api((req: Bun.BunRequest<"/api/chats/:id">) => {
          storage.deleteChat(req.params.id);
          return Response.json({ ok: true });
        }),
      },

      // Settings and UI layout. `state` is null until the first save.
      "/api/state": {
        GET: api(() => Response.json({ state: storage.getValue(STATE_KEY) ?? null })),
        PUT: api(async (req) => {
          const body = await readJson(req);
          if (typeof body?.state !== "string" || body.state.length > 4_000_000) return bad("Expected { state: string }");
          storage.setValue(STATE_KEY, body.state);
          return Response.json({ ok: true });
        }),
      },

      ...pluginRoutes(api),

      ...piRoutes(api),

      "/api/*": api(() => bad("Not found", 404)),
    },
    error(err) {
      console.error(err);
      return bad("Internal server error", 500);
    },
  });
}

// Plugins are read before routes are assembled: a server plugin contributes routes at startup.
// A broken plugin is reported in Settings, never fatal to the app.
await loadPlugins().catch((err) => console.error("[plugins] Startup failed:", err));

// Under `bun --hot` this module re-runs on every edit. Stop the previous server and take over its
// port, so a reload always serves the current routes and bind address instead of leaving the old
// server answering on the port your browser already has open.
//
// The port never changes on its own: if it's taken, startup fails instead of quietly moving to
// the next one, so the app is always at the address you expect.
// HOST can list several addresses (comma-separated), e.g. localhost and a Tailscale IP.
const hosts = (process.env.HOST || "127.0.0.1").split(",").map((h) => h.trim()).filter(Boolean);
const hot = globalThis as { openbuildServers?: ReturnType<typeof serve>[] };
const previous = hot.openbuildServers;
for (const p of previous ?? []) p.stop(true);
const port = previous?.[0]?.port ?? Number(process.env.PORT ?? 3100);
const servers: ReturnType<typeof serve>[] = [];
try {
  for (const host of hosts) servers.push(serve(port, host));
} catch (err) {
  if ((err as { code?: string }).code !== "EADDRINUSE") throw err;
  for (const s of servers) s.stop(true);
  console.error(
    `\n  Port ${port} is already in use, probably by another OpenBuild that's still running.` +
      `\n  Stop it (or find it with \`lsof -i :${port}\`) and run this again, or pick another port with PORT=<port>.\n`,
  );
  process.exit(1);
}
hot.openbuildServers = servers;
console.log(`\n  OpenBuild running at ${servers.map((s) => s.url).join(", ")}`);
console.log(`  Threads and settings are saved in ${storage.location()}\n`);
if (!localAuth.configured()) console.warn("  Access is locked. Set a local password with: openbuild set pass <password>\n");
