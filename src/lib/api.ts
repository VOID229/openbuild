import type { FunctionReturnType } from "convex/server";
import { api as convexApi } from "../../convex/_generated/api";
import { openEvents, readEvents, type ReplyStream } from "../../shared/replies";
import { GITHUB_SCOPE, SEARCH_PROVIDERS, type ChatRequest, type DetectResult, type PiChatRequest, type PlanId, type SearchCheckResult, type SearchProviderId, type StreamEvent } from "../../shared/types";
import { cloudClient } from "./cloud";
import { apiUrl } from "./devices";
import { browserSecretById, browserSecrets } from "./keyStore";
import { config } from "./runtime";

/**
 * Check a saved key (by id) and list its models. Local app: the secret stays on the server, which
 * looks it up by id. Hosted site: the key is sent along for this one check.
 */
export async function detectModels(plan: PlanId, id: string, signal?: AbortSignal): Promise<DetectResult> {
  try {
    const hosted = (await config).mode === "hosted";
    const res = await fetch("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(hosted ? { plan, key: await browserSecretById(plan, id) } : { plan, id }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as DetectResult;
  } catch (err) {
    if (signal?.aborted) throw err;
    return { plan, status: "error", error: "Couldn't reach the OpenBuild server", models: [], checkedAt: Date.now() };
  }
}

/**
 * Check a search provider's saved key (by id) or SearXNG address with one small search. Like
 * detectModels, the local server looks the key up by id; the hosted site sends it along.
 */
export async function verifySearch(provider: SearchProviderId, entry: string, signal?: AbortSignal): Promise<SearchCheckResult> {
  try {
    const hosted = (await config).mode === "hosted";
    const body =
      SEARCH_PROVIDERS[provider].credential === "url"
        ? { provider, url: entry }
        : hosted
          ? { provider, key: await browserSecretById(provider, entry) }
          : { provider, id: entry };
    const res = await fetch("/api/verify-search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (res.status === 404 && !hosted) return { provider, status: "error", error: "Restart the OpenBuild server (`bun dev`) to check search keys" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as SearchCheckResult;
  } catch (err) {
    if (signal?.aborted) throw err;
    return { provider, status: "error", error: "Couldn't reach the OpenBuild server" };
  }
}

/** Hosted site: the keys a chat request needs (its plan's, the digest model's plan's, and key-based search providers'). */
async function secretsFor(req: ChatRequest): Promise<Record<string, string[]>> {
  const scopes = new Set<string>([req.plan, ...(req.digest ? [req.digest.plan] : []), GITHUB_SCOPE, ...(req.search ?? []).filter((c) => SEARCH_PROVIDERS[c.provider].credential === "key").map((c) => c.provider)]);
  const secrets: Record<string, string[]> = {};
  for (const scope of scopes) {
    const list = await browserSecrets(scope);
    if (list.length) secrets[scope] = list;
  }
  return secrets;
}

/** POST /api/chat for a short one-off request (chat titles), and yield its events. Not picked back up. */
export async function* streamOnce(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  const body = (await config).mode === "hosted" ? { ...req, secrets: await secretsFor(req) } : req;
  let res: Response;
  try {
    res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  } catch (err) {
    if (signal.aborted) throw err;
    yield { t: "error", message: "Couldn't reach the OpenBuild server. Check your connection." };
    return;
  }
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    yield { t: "error", status: res.status, message: body?.error ?? `Request failed (HTTP ${res.status})` };
    return;
  }
  yield* readEvents(res.body);
}

export type ReplyEvent = StreamEvent | { t: "reset" };

/** A dropped connection the reply can be picked back up from; `busy` waits for this thread's turn. */
type Outcome = "end" | "lost" | "gone" | "busy";

/** Give up on a reply that can't be reached for this long. */
const POST_PATIENCE = 30_000;
const RESUME_PATIENCE = 10 * 60 * 1000;
/** The hosted relay writes a running reply out at least every few seconds; quiet this long, it died. */
const SILENT = 30_000;
/** A hosted reply isn't saved until the relay has claimed it; wait this long before calling it lost. */
const CLAIM_GRACE = 90_000;

/**
 * Stream a reply: POST /api/chat (unless `req` is omitted, to pick up a reply already running) and
 * yield its events. The reply runs on the server apart from this connection, so if it drops (a
 * network blip, the tab was frozen) this reconnects and replays the reply from the start, after a
 * {t:"reset"}. Ends after the reply's last event.
 */
export async function* streamChat(req: ChatRequest | PiChatRequest | undefined, stream: ReplyStream, startedAt: number, signal: AbortSignal, recoverable = false): AsyncGenerator<ReplyEvent> {
  const pi = !!req && "threadId" in req;
  const probeBeforeRetry = pi && !recoverable;
  recoverable ||= pi;
  let posted = !req;
  // A failed POST may already have admitted the turn. Look up its stable id before retrying;
  // only a definitive 404 permits another (idempotent) admission attempt.
  let probing = false;
  /** When the current run of failed attempts began. */
  let failingSince: number | undefined;
  let delay = 500;
  /** Only say we're waiting on the thread's turn once, not on every retry. */
  let waiting = false;
  while (!signal.aborted) {
    let outcome: Outcome;
    const source = posted || probing ? attach(stream, signal) : post(req!, stream, signal, () => (posted = true), recoverable);
    try {
      let next = await source.next();
      while (!next.done) {
        failingSince = undefined;
        delay = 500;
        yield next.value;
        next = await source.next();
      }
      outcome = next.value;
    } catch (err) {
      if (signal.aborted) return;
      console.warn("[chat] lost the connection to a reply", err);
      outcome = "lost";
    } finally {
      await source.return("lost").catch(() => {});
    }
    if (outcome === "end") return;
    if (probing && outcome === "gone") {
      probing = false;
      continue;
    }
    if (probeBeforeRetry && !posted && outcome === "lost") probing = true;
    failingSince ??= Date.now();
    if (outcome === "busy") {
      // Persisted Pi workers work one turn at a time: wait for the running one instead of failing.
      // The server rejects it before admitting it (nothing is recorded), so retrying is safe.
      if (Date.now() - failingSince > RESUME_PATIENCE) {
        yield { t: "error", message: "This thread is still working on its previous reply. Stop it, or wait for it to finish, then try again." };
        return;
      }
      if (!waiting) {
        waiting = true;
        yield { t: "notice", message: "Waiting for this thread's current reply to finish…" };
      }
      await pause(Math.max(delay, 1500), signal);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    if (outcome === "gone" && (stream.via !== "hosted" || Date.now() - startedAt > CLAIM_GRACE)) {
      // Over and gone (the server restarted, or it was a while ago). A hosted reply only counts once the
      // relay has had time to claim it.
      yield { t: "error", message: "Lost the connection to this reply, and it can't be picked back up." };
      return;
    }
    // Persisted work remains recoverable even when the server is down longer than ten minutes.
    if (outcome === "lost" && !(recoverable && (posted || probing)) && Date.now() - failingSince > (recoverable || posted ? RESUME_PATIENCE : POST_PATIENCE)) {
      yield { t: "error", message: posted ? "Lost the connection to this reply." : "Couldn't reach the OpenBuild server. Check your connection." };
      return;
    }
    await pause(delay, signal);
    delay = Math.min(delay * 2, 5000);
  }
}

/** Wait, but retry right away when the network or the page comes back. */
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      removeEventListener("online", done);
      document.removeEventListener("visibilitychange", onVisible);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const onVisible = () => document.visibilityState === "visible" && done();
    const timer = setTimeout(done, ms);
    addEventListener("online", done);
    document.addEventListener("visibilitychange", onVisible);
    signal.addEventListener("abort", done);
  });
}

/** Read a reply's NDJSON stream until its end marker; "lost" if it's cut off before that. */
async function* readReply(res: Response): AsyncGenerator<ReplyEvent, Outcome> {
  for await (const ev of readEvents(res.body!)) {
    if (ev.t === "end") return "end";
    yield ev;
  }
  return "lost";
}

async function* post(req: ChatRequest | PiChatRequest, stream: ReplyStream, signal: AbortSignal, onPosted: () => void, recoverable: boolean): AsyncGenerator<ReplyEvent, Outcome> {
  // Pi threads (they name a working directory) run on the local server's Pi.
  const pi = "threadId" in req;
  const hosted = !pi && (await config).mode === "hosted";
  const body = { ...req, stream: { id: stream.id, key: pi ? undefined : stream.key }, ...(hosted ? { secrets: await secretsFor(req as ChatRequest) } : {}) };
  const res = await fetch(pi ? apiUrl(stream.deviceId, "/api/pi/chat") : "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    if (recoverable) {
      // The thread's previous turn is still running. Nothing was admitted, so wait and ask again.
      if (body?.code === "busy") return "busy";
      // Anything else (a rewind, a deleted thread, a reused request id) won't change by retrying.
      yield { t: "error", status: 409, message: body?.error ?? `Request failed (HTTP 409)` };
      return "end";
    }
    // A retry of a request that got through: the reply is running, so pick it up.
    onPosted();
    return "lost";
  }
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    // Persisted workers survive a restart/proxy failure; their stable request id is recoverable.
    if (recoverable && (res.status >= 500 || res.status === 408 || res.status === 425 || res.status === 429)) return "lost";
    yield { t: "error", status: res.status, message: body?.error ?? `Request failed (HTTP ${res.status})` };
    return "end";
  }
  onPosted();
  if (res.headers.get("x-openchat-run") === "1") return yield* readReply(res);
  // A server that doesn't keep replies running (an older one): a dropped connection ends the reply.
  try {
    for await (const ev of readEvents(res.body)) yield ev;
  } catch (err) {
    if (signal.aborted) throw err;
    yield { t: "error", message: `Connection lost: ${(err as Error).message}` };
  }
  return "end";
}

async function* attach(stream: ReplyStream, signal: AbortSignal): AsyncGenerator<ReplyEvent, Outcome> {
  if (stream.via === "hosted") return yield* attachSaved(stream, signal);
  const res = await fetch(apiUrl(stream.deviceId, `/api/chat/runs/${encodeURIComponent(stream.id)}`), { signal });
  if (res.status === 404) return "gone";
  if (!res.ok || !res.body) return "lost";
  yield { t: "reset" };
  return yield* readReply(res);
}

/** Hosted: follow the copy of the reply the relay saves to the sync service, live. */
async function* attachSaved(stream: ReplyStream, signal: AbortSignal): AsyncGenerator<ReplyEvent, Outcome> {
  const client = cloudClient();
  if (!client || !stream.key) return "gone";
  type Page = NonNullable<FunctionReturnType<typeof convexApi.streams.read>>;
  let after = 0;
  let reset = false;
  let heardAt = Date.now();
  let updatedAt: number | undefined;
  while (!signal.aborted) {
    // The next page of the reply, once there's something new (or it's over, or quiet too long).
    const page = await new Promise<Page | null | "silent">((resolve, reject) => {
      const watch = client.watchQuery(convexApi.streams.read, { id: stream.id, after });
      const check = () => {
        let r: Page | null | undefined;
        try {
          r = watch.localQueryResult();
        } catch (err) {
          return finish(() => reject(err));
        }
        if (r === undefined) return;
        if (r && r.updatedAt !== updatedAt) {
          updatedAt = r.updatedAt;
          heardAt = Date.now();
        }
        if (!r || r.chunks.length || r.done) finish(() => resolve(r));
      };
      const timer = setInterval(() => {
        // Only the relay going quiet counts, not this device being offline.
        if (!client.connectionState().isWebSocketConnected) heardAt = Date.now();
        else if (Date.now() - heardAt > SILENT) finish(() => resolve("silent"));
      }, 1000);
      const onAbort = () => finish(() => resolve(null));
      const unsubscribe = watch.onUpdate(check);
      const finish = (then: () => void) => {
        clearInterval(timer);
        signal.removeEventListener("abort", onAbort);
        unsubscribe();
        then();
      };
      signal.addEventListener("abort", onAbort);
      check();
    });
    if (signal.aborted) return "lost";
    if (page === null) return "gone";
    if (page === "silent") {
      yield { t: "error", message: "The reply stopped partway: the server working on it went quiet." };
      return "end";
    }
    if (!reset) {
      yield { t: "reset" };
      reset = true;
    }
    for (const c of page.chunks) {
      after = c.seq;
      for (const ev of await openEvents(stream.key, stream.id, c.iv, c.data)) {
        if (ev.t === "end") return "end";
        yield ev;
      }
    }
    // Finished, but the relay couldn't write its last part.
    if (page.done && !page.chunks.length) return "end";
  }
  return "lost";
}

/** Stop a reply on the server (the app has already stopped listening to it). */
export async function stopReply(stream: ReplyStream) {
  try {
    if (stream.via === "hosted") await cloudClient()?.mutation(convexApi.streams.stop, { id: stream.id });
    else await fetch(apiUrl(stream.deviceId, `/api/chat/runs/${encodeURIComponent(stream.id)}/stop`), { method: "POST" });
  } catch (err) {
    console.warn("[chat] couldn't stop a reply on the server", err);
  }
}
