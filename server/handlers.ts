// Request handling for the local Bun server (server/index.ts), which reads API keys from the OS
// keychain.
import { EFFORTS, GITHUB_SCOPE, PLANS, SEARCH_PROVIDERS, type ChatRequest, type PlanId, type SearchCredentials, type SearchProviderId, type StreamEvent } from "../shared/types";
import { streamReply } from "./agent";
import { searchDigest } from "./digest";
import { describeModels, detectModels } from "./catalog";
import { buildUpstream, isKeyFailure, upstreamError, validateMessages } from "./opencode";
import { checkSearch, searchToolkit } from "./search";
import { isPublicUrl } from "./fetch";

// "pi" models run through /api/pi/chat, not the Opencode proxy.
export const isPlan = (p: unknown): p is PlanId => typeof p === "string" && p in PLANS && p !== "pi" && p !== "fx" && p !== "codex" && p !== "cursor";
export const isKey = (k: unknown): k is string => typeof k === "string" && k.trim().length > 0 && k.length < 512;
export const isKeyList = (k: unknown): k is string[] => Array.isArray(k) && k.length > 0 && k.length <= 20 && k.every(isKey);
const isSearchList = (s: unknown): s is SearchCredentials[] =>
  Array.isArray(s) &&
  s.length <= 10 &&
  s.every((c) => c && typeof c.provider === "string" && c.provider in SEARCH_PROVIDERS && (SEARCH_PROVIDERS[c.provider as keyof typeof SEARCH_PROVIDERS].credential === "key" ? c.keys === undefined : isKeyList(c.keys)));

const isDigest = (d: any) => d && isPlan(d.plan) && typeof d.model === "string" && d.model.length < 256 && EFFORTS.includes(d.effort);

export const bad = (error: string, status = 400) => Response.json({ error }, { status });

export async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

const ndjson = { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform" };
const ndjsonResponse = (events: StreamEvent[]) => new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", { headers: ndjson });

/** The secrets for a plan or key-based search provider, in priority order. */
export type KeysFor = (scope: string) => Promise<string[]>;

export { isPublicUrl };

/** Check a key and list the models it can use. */
export async function handleModels(plan: unknown, key: string | undefined): Promise<Response> {
  if (!isPlan(plan)) return bad("Expected { plan }");
  if (!key) return bad("Unknown key", 404);
  return Response.json(await detectModels(plan, key));
}

export const isSearchProvider = (p: unknown): p is SearchProviderId => typeof p === "string" && p in SEARCH_PROVIDERS;

/** Check a search provider key, or a SearXNG instance address, with one small search. */
export async function handleSearchCheck(provider: unknown, credential: string | undefined, opts: { hosted?: boolean } = {}): Promise<Response> {
  if (!isSearchProvider(provider)) return bad("Expected { provider }");
  if (!credential) return bad(SEARCH_PROVIDERS[provider].credential === "url" ? "Expected { url }" : "Unknown key", SEARCH_PROVIDERS[provider].credential === "url" ? 400 : 404);
  if (SEARCH_PROVIDERS[provider].credential === "url" && opts.hosted && !isPublicUrl(credential)) {
    return Response.json({ provider, status: "invalid", error: "On the website, a SearXNG instance must be a public https:// address" });
  }
  return Response.json(await checkSearch(provider, credential));
}

/** Run a chat turn (with web search tools when configured) and stream it back as NDJSON. `signal` stops it. */
export async function handleChat(signal: AbortSignal, body: ChatRequest | undefined, keysFor: KeysFor, opts: { hosted?: boolean } = {}): Promise<Response> {
  if (!body || !isPlan(body.plan) || typeof body.model !== "string" || !validateMessages(body.messages) || (body.search !== undefined && !isSearchList(body.search)) || (body.digest !== undefined && !isDigest(body.digest))) {
    return bad("Malformed chat request");
  }
  const keys = await keysFor(body.plan);
  if (!keys.length) return bad(`No ${PLANS[body.plan].label} API key saved. Add one in Settings → API Keys.`);
  const [model] = await describeModels(body.plan, [body.model]);
  if (!model) return bad(`Unknown model ${body.model}`);

  // Tools only go to models that can call them: web search (for configured providers; key-based
  // providers' keys come from keysFor, instance URLs such as SearXNG come with the request) and the
  // page reader, which needs no setup.
  const creds =
    model.tools !== false && body.search?.length
      ? await Promise.all(
          body.search.map(async (c) => ({
            provider: c.provider,
            keys: SEARCH_PROVIDERS[c.provider].credential === "key" ? await keysFor(c.provider) : (c.keys ?? []).map((k) => k.trim()).filter((k) => !opts.hosted || isPublicUrl(k)),
          })),
        )
      : [];
  const usable = creds.filter((c) => c.keys.length);
  // A GitHub token (optional) only goes to the page reader, for GitHub's own hosts.
  const github = model.tools !== false ? await keysFor(GITHUB_SCOPE) : [];
  const search = model.tools !== false ? searchToolkit(usable, { hosted: opts.hosted, githubToken: github[0] }) : undefined;
  const system = [typeof body.system === "string" ? body.system.trim() : "", search?.guidance ?? ""].filter(Boolean).join("\n\n");
  const { secrets: _secrets, stream: _stream, ...rest } = body as ChatRequest & { secrets?: unknown };
  const request: ChatRequest = {
    ...rest,
    sessionId: String(body.sessionId || crypto.randomUUID()).slice(0, 128),
    system: system || undefined,
  };
  const digest = search && body.digest ? await searchDigest(body.digest, await keysFor(body.digest.plan), request) : undefined;
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
        signal,
      });
    } catch (err) {
      if (signal.aborted) return new Response(null, { status: 499 });
      const message = `Couldn't reach Opencode: ${(err as Error).message}`;
      return ndjsonResponse([...notices, { t: "error", message }]);
    }
    if (res.ok && res.body) {
      const stream = streamReply(model, { ...request, key }, res, signal, { prelude: notices, label, search, digest });
      return new Response(stream, { headers: ndjson });
    }

    const event = await upstreamError(res, label);
    const message = event.t === "error" ? event.message : "";
    const hasNext = i < keys.length - 1;
    if (!hasNext || !isKeyFailure(res.status, message)) return ndjsonResponse([...notices, event]);
    if (!opts.hosted) console.warn(`[chat] ${label} key ${i + 1} failed (HTTP ${res.status}); trying key ${i + 2}`);
    const reason = res.status === 401 ? "key rejected" : message;
    notices.push({ t: "notice", message: `${label} key ${i + 1} failed (${reason}), so key ${i + 2} was used.` });
  }
  return bad("No usable API key");
}
