// OpenBuild server: serves the React app (bundled by Bun, with HMR in dev) and runs threads on the
// installed Pi (server/pi/), in projects and worktrees on this machine (projects.ts). Threads and
// settings are kept on disk (see storage.ts), so they don't depend on which port or browser you open
// the app in. The older Opencode proxy (/api/chat) is still served for API-key-only setups.
import index from "../src/index.html";
import { CLOUD_URL } from "../shared/cloud";
import { isStreamId, isStreamRef } from "../shared/replies";
import { SEARCH_PROVIDERS, type ChatRequest, type KeyEdit, type KeyInventory } from "../shared/types";
import { bad, handleChat, handleModels, handleSearchCheck, isKey, isPlan, isSearchProvider, readJson } from "./handlers";
import { piRoutes } from "./pi/routes";
import { terminalRoutes } from "./terminals";
import { usageRoutes } from "./usage/routes";
import { loadPlugins, pluginRoutes } from "./plugins";
import { discoverSessions } from "./pi/discovery";
import { createChatRefresh } from "./chatRefresh";
import { localAuth } from "./localAuth";
import { checkWhisper, transcribe } from "./dictation";
import { findRun, localRun, startRun } from "./runs";
import * as storage from "./storage";
import * as vault from "./vault";
import { runtimeChangeAllowed, threadRuntime } from "./threadRuntime";
import * as durable from "./durable";
import * as piWorker from "./pi/remote";
import { projectChat, projectStoredChats } from "./pi/projection";
import type { Chat } from "../src/lib/types";
import * as devices from "./devices";
import * as folderPicker from "./folderPicker";
import * as sessionImport from "./sessionImport";

const refreshChats = createChatRefresh(async () => {
  const snapshots = await piWorker.snapshots();
  projectStoredChats(snapshots);
  await discoverSessions();
}, (err) => {
  // Never fall back to transcript discovery when the worker is unavailable: it would
  // overwrite authoritative OpenBuild stream identities.
  console.warn("[pi-worker] Showing saved chats; worker unavailable:", (err as Error).message);
});

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
const serverId = devices.serverId();
/** This device's name (chosen when pairing, else the computer name), read per request so a rename shows up. */
const machine = () => devices.deviceName();
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
/**
 * What a paired device may do: work in projects, run Pi there, and manage that Pi (Settings → Pi
 * from the other device: install, updates, extensions, skills, prompts, packages, providers).
 * It can't read saved keys, change this device's password, manage plugins, or list other devices.
 */
const devicePathAllowed = (path: string) =>
  path === "/api/config" ||
  path === "/api/pair/self" ||
  path === "/api/runtimes" ||
  path === "/api/runtimes/status" ||
  path === "/api/runtimes/update" ||
  /^\/api\/remote(\/|$)/.test(path) ||
  // Usage on this device, so the one it's paired to can show every machine's together.
  /^\/api\/usage(\/|$)/.test(path) ||
  /^\/api\/chat\/runs\//.test(path) ||
  /^\/api\/(projects|fs|workspaces)(\/|$)/.test(path) ||
  /^\/api\/pi\/(status|models|prices|commands|problems|complete|chat)(\/|$)/.test(path) ||
  /^\/api\/(fx|codex|cursor|claude|opencode)\/(status|models)(\/|$)/.test(path) ||
  /^\/api\/claude\/permissions(\/|$)/.test(path) ||
  /^\/api\/pi\/(threads|shells)\/[^/]+/.test(path) ||
  // A terminal in a project's folder. It's a shell on this device, which Pi turns here already are.
  /^\/api\/terminals(\/|$)/.test(path) ||
  // Managing Pi on this device. It already runs Pi turns here — tools included — so this is not
  // a wider grant: it's the same power through a settings page instead of a prompt.
  /^\/api\/pi\/(install|update|job|resources|packages|providers|login)(\/|$)/.test(path);

/** Wrap an API handler with the request check. Paired devices use a bearer token instead of a browser session. */
const api =
  <R extends Request, A extends unknown[]>(handler: (req: R, ...rest: A) => Response | Promise<Response>) =>
  (req: R, ...rest: A) => {
    const denied = forbidden(req);
    if (denied) return denied;
    if (devices.authenticateDevice(req)) {
      if (!devicePathAllowed(new URL(req.url).pathname)) return bad("Forbidden", 403);
      return handler(req, ...rest);
    }
    return localAuth.protect(req, () => handler(req, ...rest));
  };

/** Headers from a proxied remote response that are safe to pass back to the browser. */
const PROXY_RESPONSE_HEADERS = ["content-type", "cache-control", "content-disposition", "x-openchat-run", "retry-after"];
/**
 * How long a paired device gets to send response headers. A sleeping machine's tailnet address
 * swallows connections instead of refusing them, and without a deadline the browser's request (and
 * whatever waits on it, such as the project list) hangs for minutes.
 */
const PROXY_HEADER_TIMEOUT_MS = 6000;

/**
 * Forward a request to a paired device's server. The browser never sees the device token: it is
 * added here, and the device's session cookie is not forwarded either way. Response bodies stream
 * through, so replies and shell output keep arriving as they are produced.
 */
async function proxyDevice(req: Request, id: string): Promise<Response> {
  const device = devices.deviceCredentials(id);
  if (!device) return bad("No such device. Pair it again with `openbuild pair --client`.", 404);
  const url = new URL(req.url);
  const prefix = `/api/devices/${encodeURIComponent(id)}`;
  const path = url.pathname.slice(prefix.length) || "/";
  if (!path.startsWith("/api/")) return bad("Not found", 404);
  const headers = new Headers();
  for (const name of ["content-type", "accept", "range", "if-range", "if-none-match"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${device.token}`);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  let lastError = "the device didn't answer";
  for (const base of device.urls) {
    const target = `${base.replace(/\/$/, "")}${path}${url.search}`;
    // Abort only until the headers arrive: a reply's body streams for as long as it runs.
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    req.signal.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(abort, PROXY_HEADER_TIMEOUT_MS);
    try {
      const res = await fetch(target, { method: req.method, headers, body, signal: ctrl.signal });
      clearTimeout(deadline);
      req.signal.removeEventListener("abort", abort);
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        lastError = `the device answered HTTP ${res.status}`;
        void res.body?.cancel().catch(() => {});
        continue;
      }
      devices.touchDevice(id, true);
      const out = new Headers();
      for (const name of PROXY_RESPONSE_HEADERS) {
        const value = res.headers.get(name);
        if (value) out.set(name, value);
      }
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
    } catch (err) {
      clearTimeout(deadline);
      req.signal.removeEventListener("abort", abort);
      lastError = req.signal.aborted ? "the browser went away" : ctrl.signal.aborted ? `no answer in ${PROXY_HEADER_TIMEOUT_MS / 1000}s` : (err as Error).message;
    }
  }
  return bad(`Couldn't reach ${device.name}: ${lastError}`, 502);
}

const proxyRoute = async (req: Bun.BunRequest<"/api/devices/:id/*">, server: Bun.Server<unknown>) => {
  // Replies and shell output stream for as long as they run.
  server.timeout(req, 0);
  return proxyDevice(req, req.params.id);
};

function serve(port: number, hostname: string) {
  return Bun.serve({
    port,
    // Loopback by default, even with password protection.
    hostname,
    idleTimeout: 120,
    development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
    routes: {
      "/*": index,
      // The bundle's own files are exact routes and win over this. A script or stylesheet that
      // isn't one of them is from an older build (a tab left open across an update): answer 404
      // instead of the page, so it fails plainly. Anything else here (/thread-<id>) is the page.
      "/:file": (req, server: Bun.Server<unknown>) =>
        /\.(?:js|css|map)$/.test(req.params.file) ? new Response("Not found", { status: 404 }) : fetch(new URL("/", server.url)),

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
        GET: api(() => Response.json({ convexUrl: process.env.OPENCHAT_CLOUD_URL || CLOUD_URL || null, mode: "local", serverId, deviceId: serverId, machine: machine() })),
      },

      // The OS folder picker, for a browser on this same machine (server/folderPicker.ts).
      "/api/native/folder": {
        GET: api((req, server: Bun.Server<unknown>) => Response.json({ available: folderPicker.sameMachine(req, server.requestIP(req)?.address) && folderPicker.available() })),
        POST: api(async (req, server: Bun.Server<unknown>) => {
          if (!folderPicker.sameMachine(req, server.requestIP(req)?.address)) return bad("The folder picker only opens for a browser on this machine", 403);
          // The picker stays open for as long as it takes to choose.
          server.timeout(req, 0);
          const body = await readJson(req);
          try {
            return Response.json({ path: (await folderPicker.pickFolder(typeof body?.dir === "string" ? body.dir.slice(0, 1024) : undefined)) ?? null });
          } catch (err) {
            return bad((err as Error).message, 500);
          }
        }),
      },

      // Pairing: public, because the other device has no session yet. The code is the credential,
      // and it only exists while `openbuild pair --host` is waiting.
      "/api/pair/info": {
        GET: (req) => forbidden(req) ?? Response.json(devices.pairingInfo()),
      },
      "/api/pair/claim": {
        POST: async (req) => {
          const denied = forbidden(req);
          if (denied) return denied;
          const body = await readJson(req);
          if (typeof body?.code !== "string" || !body.code.trim() || body.code.length > 40) return bad("Expected { code }");
          const claimed = devices.claimPairing(body.code, typeof body.name === "string" ? body.name : "");
          return claimed ? Response.json(claimed) : bad("That pairing code isn't valid anymore. Run `openbuild pair --host` again on the other device.", 403);
        },
      },

      // Controlling this server from a paired device. While the server is stopped, the keeper
      // (server/keeper.ts) answers the same paths on the same port, so starting it again works.
      "/api/remote/status": {
        GET: api(() => Response.json({ running: true, paired: true, device: machine(), keeper: devices.keeperRunning() })),
      },
      "/api/remote/start": {
        POST: api(() => Response.json({ ok: true, running: true, already: true })),
      },
      "/api/remote/stop": {
        POST: api(() => {
          // Answer first, then stop the way `openbuild stop` does: the keeper takes the port and
          // tailscale serve keeps pointing at it, so the paired address still answers a start.
          setTimeout(() => process.kill(process.pid, "SIGTERM"), 300);
          return Response.json({ ok: true, running: false, stopping: true });
        }),
      },
      // A client can revoke its own token when it unpairs, so the host stops trusting it.
      "/api/pair/self": {
        DELETE: api((req: Request) => {
          const who = devices.authenticateDevice(req);
          if (!who) return bad("Unauthorized", 401);
          devices.forgetPairedClient(who.id);
          return Response.json({ ok: true });
        }),
      },

      // Paired devices this server's UI can use (tokens stay on the server).
      "/api/devices": {
        GET: api(async () => Response.json({ devices: await Promise.all(devices.readDevices().map(devices.probeDevice)) })),
      },
      "/api/devices/:id": {
        DELETE: api(async (req: Bun.BunRequest<"/api/devices/:id">) => {
          const device = devices.deviceCredentials(req.params.id);
          // Revoke on the host too, so unpairing removes its trust rather than only this copy.
          if (device) await devices.revokeDevice(device);
          return devices.removeDevice(req.params.id) ? Response.json({ ok: true }) : bad("No such device", 404);
        }),
      },
      // Restart a paired device's server (or start it while it's stopped). Waits until it answers again.
      "/api/devices/:id/restart": {
        POST: api(async (req: Bun.BunRequest<"/api/devices/:id/restart">) => {
          const device = devices.deviceCredentials(req.params.id);
          if (!device) return bad("No such device", 404);
          const { error } = await devices.restartDevice(device);
          return error ? bad(error, 502) : Response.json({ ok: true });
        }),
      },
      // Devices that use this server (they entered its pairing code), and revoking one of them.
      "/api/paired-clients": {
        GET: api(() => Response.json({ clients: devices.pairedClients() })),
      },
      "/api/paired-clients/:id": {
        DELETE: api((req: Bun.BunRequest<"/api/paired-clients/:id">) => {
          devices.forgetPairedClient(req.params.id);
          return Response.json({ ok: true });
        }),
      },
      // Everything the UI needs on that device: /api/devices/<id>/api/projects, /api/pi/chat, …
      "/api/devices/:id/*": {
        GET: api(proxyRoute),
        POST: api(proxyRoute),
        PUT: api(proxyRoute),
        PATCH: api(proxyRoute),
        DELETE: api(proxyRoute),
        HEAD: api(proxyRoute),
        OPTIONS: api(proxyRoute),
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
        GET: api(async (req: Bun.BunRequest<"/api/chat/runs/:id">, server: Bun.Server<unknown>) => {
          server.timeout(req, 0);
          const run = isStreamId(req.params.id) ? findRun(req.params.id) ?? await piWorker.findRun(req.params.id) ?? await durable.findRun(req.params.id) : undefined;
          return run ? new Response(run.stream(), { headers: runHeaders }) : bad("No such reply", 404);
        }),
      },
      "/api/chat/runs/:id/stop": {
        POST: api(async (req: Bun.BunRequest<"/api/chat/runs/:id/stop">) => {
          if (isStreamId(req.params.id)) {
            const run = findRun(req.params.id);
            if (run) run.stop();
            else if (!(await piWorker.stopRun(req.params.id))) await durable.stopRun(req.params.id);
          }
          return Response.json({ ok: true });
        }),
      },

      // Chats, stored on disk. Deleting keeps a tombstone so a deleted chat can't come back.
      // `?index`: only ids and versions, so browsers fetch just the chats their cache lacks.
      "/api/chats": {
        GET: api(async (req) => {
          const params = new URL(req.url).searchParams;
          // Refreshes show the saved list promptly even if Pi is cold or transcripts are large.
          // Discovery continues in the background; subsequent polls await its fresh result.
          await refreshChats(params.has("startup") ? 100 : undefined);
          if (params.has("index")) return Response.json({ index: storage.chatIndex() });
          return Response.json({ chats: storage.listChats() });
        }),
        DELETE: api(async () => {
          await Promise.all(storage.listChats().map((chat) => threadRuntime(chat.id) === "durable" ? durable.stopThread(chat.id) : piWorker.deleteThread(chat.id)));
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
          if (!runtimeChangeAllowed(chat)) return bad("A thread's runtime cannot change after it starts.");
          const needsPi = chat.runtime !== "durable" && (chat as unknown as Chat).messages.some(message => message.model?.plan === "pi" || message.model?.plan === "fx" || message.model?.plan === "codex" || message.model?.plan === "cursor" || message.model?.plan === "claude" || message.model?.plan === "opencode" || message.shell);
          const snapshots = needsPi ? await piWorker.snapshots(chat.id) : [];
          const projected = projectChat(chat as unknown as Chat, snapshots, storage.getChat(chat.id) as Chat | undefined);
          const v = storage.putChat({ ...projected });
          return v ? Response.json({ ok: true, v, chat: projected }) : bad("Chat was deleted", 410);
        }),
        DELETE: api(async (req: Bun.BunRequest<"/api/chats/:id">) => {
          if (threadRuntime(req.params.id) === "durable") await durable.stopThread(req.params.id);
          else await piWorker.deleteThread(req.params.id);
          storage.deleteChat(req.params.id);
          return Response.json({ ok: true });
        }),
      },

      // The one-time offer to import native runtimes' sessions (sessionImport.ts). POST is the
      // answer: the runtimes to import, [] to skip. Either way it's never offered again.
      "/api/session-import": {
        GET: api(async () => Response.json(await sessionImport.offer())),
        POST: api(async (req, server: Bun.Server<unknown>) => {
          server.timeout(req, 0);
          const body = await readJson(req);
          if (!Array.isArray(body?.runtimes) || !body.runtimes.every(sessionImport.isImportRuntime)) return bad("Expected { runtimes: string[] }");
          return Response.json(await sessionImport.answer([...new Set<sessionImport.ImportRuntime>(body.runtimes)]));
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

      ...terminalRoutes(api),

      ...usageRoutes(api),

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
// Recover before any browser reconnects; attach also awaits this same recovery barrier.
void durable.recover().catch((err) => console.error("[durable] Startup recovery failed:", err));
void piWorker.recover().catch((err) => console.error("[pi-worker] Startup reconnect failed:", err));
console.log(`\n  OpenBuild running at ${servers.map((s) => s.url).join(", ")}`);
console.log(`  Threads and settings are saved in ${storage.location()}\n`);
if (!localAuth.configured()) console.warn("  Access is locked. Set a local password with: openbuild set pass <password>\n");
