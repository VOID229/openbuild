// OpenChat server: serves the React app (bundled by Bun, with HMR in dev) and proxies
// chat requests to Opencode. API keys are kept in the OS keychain (see vault.ts) and are never
// sent back to the browser; requests refer to them by plan.
import index from "../src/index.html";
import { PLANS, SEARCH_PROVIDERS, type ChatRequest, type KeyEdit, type KeyInventory, type PlanId, type SearchCredentials, type StreamEvent } from "../shared/types";
import { streamReply } from "./agent";
import { describeModels, detectModels } from "./catalog";
import { buildUpstream, isKeyFailure, upstreamError, validateMessages } from "./opencode";
import { searchToolkit } from "./search";
import * as vault from "./vault";

const isPlan = (p: unknown): p is PlanId => typeof p === "string" && p in PLANS;
const isKey = (k: unknown): k is string => typeof k === "string" && k.trim().length > 0 && k.length < 512;
const isKeyList = (k: unknown): k is string[] => Array.isArray(k) && k.length > 0 && k.length <= 20 && k.every(isKey);
const isSearchList = (s: unknown): s is SearchCredentials[] =>
  Array.isArray(s) &&
  s.length <= 10 &&
  s.every((c) => c && typeof c.provider === "string" && c.provider in SEARCH_PROVIDERS && (SEARCH_PROVIDERS[c.provider as keyof typeof SEARCH_PROVIDERS].credential === "key" ? c.keys === undefined : isKeyList(c.keys)));
const isEdits = (e: unknown): e is KeyEdit[] =>
  Array.isArray(e) &&
  e.length <= 20 &&
  e.every((x) => x && (typeof x.id === "string" ? x.secret === undefined && x.id.length <= 64 : isKey(x.secret)));
const bad = (error: string, status = 400) => Response.json({ error }, { status });

// The API holds your keys' power (it can spend them), so it only answers requests that really come
// from this app: a loopback Host (defeats DNS rebinding) and, when the browser says, our own Origin
// (defeats other websites calling localhost). Serving beyond localhost is opt-in: set HOST, and list
// the names you'll browse to in OPENCHAT_ALLOWED_HOSTS.
const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", ...(process.env.OPENCHAT_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)]);
const hostname = (host: string) => host.toLowerCase().replace(/:\d+$/, "");
function forbidden(req: Request): Response | undefined {
  const host = req.headers.get("host");
  const origin = req.headers.get("origin");
  let originHost: string | undefined;
  try {
    originHost = origin && origin !== "null" ? new URL(origin).host : undefined;
  } catch {}
  const ok = host && allowedHosts.has(hostname(host)) && (origin === null || (originHost !== undefined && allowedHosts.has(hostname(originHost))));
  return ok ? undefined : bad("Forbidden", 403);
}
/** Wrap an API handler with the request check. */
const api =
  <R extends Request, A extends unknown[]>(handler: (req: R, ...rest: A) => Response | Promise<Response>) =>
  (req: R, ...rest: A) =>
    forbidden(req) ?? handler(req, ...rest);

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function serve(port: number) {
  return Bun.serve({
    port,
    // Loopback by default: keys are spent by anything that can reach this port.
    hostname: process.env.HOST || "127.0.0.1",
    idleTimeout: 120,
    development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
    routes: {
      "/*": index,

      // Saved keys as opaque ids, never secrets.
      "/api/keys": {
        GET: api(async () => Response.json({ backend: await vault.backend(), keys: await vault.listIds() } satisfies KeyInventory)),
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
          const key = await vault.secretById(body.plan, body.id);
          if (!key) return bad("Unknown key", 404);
          return Response.json(await detectModels(body.plan, key));
        }),
      },

      "/api/chat": {
        POST: api(async (req, server: Bun.Server<unknown>) => {
          // Long generations shouldn't be cut off by the idle timeout.
          server.timeout(req, 0);
          const body = (await readJson(req)) as ChatRequest | undefined;
          if (
            !body ||
            !isPlan(body.plan) ||
            typeof body.model !== "string" ||
            !validateMessages(body.messages) ||
            (body.search !== undefined && !isSearchList(body.search))
          ) {
            return bad("Malformed chat request");
          }
          const keys = await vault.secrets(body.plan);
          if (!keys.length) return bad(`No ${PLANS[body.plan].label} API key saved. Add one in Settings → API Keys.`);
          const [model] = await describeModels(body.plan, [body.model]);
          if (!model) return bad(`Unknown model ${body.model}`);

          // Web search runs as tools, so only for models that can call them. Key-based providers
          // read their keys from the vault; instance URLs (SearXNG) come with the request.
          const creds = model.tools !== false && body.search?.length
            ? await Promise.all(body.search.map(async (c) => ({ provider: c.provider, keys: SEARCH_PROVIDERS[c.provider].credential === "key" ? await vault.secrets(c.provider) : (c.keys ?? []).map((k) => k.trim()) })))
            : [];
          const search = creds.length ? searchToolkit(creds) : undefined;
          const system = [typeof body.system === "string" ? body.system.trim() : "", search?.guidance ?? ""].filter(Boolean).join("\n\n");
          const request: ChatRequest = {
            ...body,
            sessionId: String(body.sessionId || crypto.randomUUID()).slice(0, 128),
            system: system || undefined,
          };
          const tools = search && { tools: search.specs, extra: [] };
          const label = PLANS[body.plan].label;
          const notices: StreamEvent[] = [];
          // Try the plan's keys in order; fall back to the next key when one is rejected or out of credit.
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i]!;
            const upstream = buildUpstream(model, { ...request, key }, tools);
            let res: Response;
            try {
              res = await fetch(upstream.url, {
                method: "POST",
                headers: upstream.headers,
                body: JSON.stringify(upstream.body),
                signal: req.signal,
              });
            } catch (err) {
              if (req.signal.aborted) return new Response(null, { status: 499 });
              const message = `Couldn't reach Opencode: ${(err as Error).message}`;
              return ndjsonResponse([...notices, { t: "error", message }]);
            }
            if (res.ok && res.body) {
              const stream = streamReply(model, { ...request, key }, res, req.signal, { prelude: notices, label, search });
              return new Response(stream, { headers: ndjson });
            }

            const event = await upstreamError(res, label);
            const message = event.t === "error" ? event.message : "";
            const hasNext = i < keys.length - 1;
            if (!hasNext || !isKeyFailure(res.status, message)) return ndjsonResponse([...notices, event]);
            console.warn(`[chat] ${label} key ${i + 1} failed (HTTP ${res.status}); trying key ${i + 2}`);
            const reason = res.status === 401 ? "key rejected" : message;
            notices.push({ t: "notice", message: `${label} key ${i + 1} failed (${reason}), so key ${i + 2} was used.` });
          }
          return bad("No usable API key");
        }),
      },

      "/api/*": api(() => bad("Not found", 404)),
    },
    error(err) {
      console.error(err);
      return bad("Internal server error", 500);
    },
  });
}

const ndjson = { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform" };
const ndjsonResponse = (events: StreamEvent[]) => new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", { headers: ndjson });

const preferred = Number(process.env.PORT ?? 3000);
let server: ReturnType<typeof serve> | undefined;
for (let port = preferred; !server; port++) {
  try {
    server = serve(port);
  } catch (err) {
    if ((err as { code?: string }).code !== "EADDRINUSE" || port > preferred + 20) throw err;
  }
}
console.log(`\n  OpenChat running at ${server.url}\n`);
