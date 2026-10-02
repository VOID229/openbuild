// OpenChat server: serves the React app (bundled by Bun, with HMR in dev) and proxies
// chat requests to Opencode. API keys are supplied per request by the browser and never stored.
import index from "../src/index.html";
import { PLANS, type ChatRequest, type PlanId, type StreamEvent } from "../shared/types";
import { describeModels, detectModels } from "./catalog";
import { buildUpstream, isKeyFailure, normalizeStream, upstreamError, validateMessages } from "./opencode";

const isPlan = (p: unknown): p is PlanId => typeof p === "string" && p in PLANS;
const isKey = (k: unknown): k is string => typeof k === "string" && k.trim().length > 0 && k.length < 512;
const isKeyList = (k: unknown): k is string[] => Array.isArray(k) && k.length > 0 && k.length <= 20 && k.every(isKey);
const bad = (error: string, status = 400) => Response.json({ error }, { status });

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
    idleTimeout: 120,
    development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
    routes: {
      "/*": index,

      "/api/models": {
        async POST(req) {
          const body = await readJson(req);
          if (!isPlan(body?.plan) || !isKey(body?.key)) return bad("Expected { plan, key }");
          return Response.json(await detectModels(body.plan, body.key.trim()));
        },
      },

      "/api/chat": {
        async POST(req, server) {
          // Long generations shouldn't be cut off by the idle timeout.
          server.timeout(req, 0);
          const body = (await readJson(req)) as ChatRequest | undefined;
          if (!body || !isPlan(body.plan) || !isKeyList(body.keys) || typeof body.model !== "string" || !validateMessages(body.messages)) {
            return bad("Malformed chat request");
          }
          const [model] = await describeModels(body.plan, [body.model]);
          if (!model) return bad(`Unknown model ${body.model}`);

          const request: ChatRequest = {
            ...body,
            keys: body.keys.map((k) => k.trim()),
            sessionId: String(body.sessionId || crypto.randomUUID()).slice(0, 128),
            system: typeof body.system === "string" && body.system.trim() ? body.system : undefined,
          };
          const label = PLANS[body.plan].label;
          const notices: StreamEvent[] = [];
          // Try the plan's keys in order; fall back to the next key when one is rejected or out of credit.
          for (let i = 0; i < request.keys.length; i++) {
            const upstream = buildUpstream(model, { ...request, key: request.keys[i]! });
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
            if (res.ok && res.body) return new Response(normalizeStream(model, res, req.signal, notices), { headers: ndjson });

            const event = await upstreamError(res, label);
            const message = event.t === "error" ? event.message : "";
            const hasNext = i < request.keys.length - 1;
            if (!hasNext || !isKeyFailure(res.status, message)) return ndjsonResponse([...notices, event]);
            console.warn(`[chat] ${label} key ${i + 1} failed (HTTP ${res.status}); trying key ${i + 2}`);
            const reason = res.status === 401 ? "key rejected" : message;
            notices.push({ t: "notice", message: `${label} key ${i + 1} failed (${reason}), so key ${i + 2} was used.` });
          }
          return bad("No usable API key");
        },
      },

      "/api/*": () => bad("Not found", 404),
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
