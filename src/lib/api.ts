import { SEARCH_PROVIDERS, type ChatRequest, type DetectResult, type PlanId, type StreamEvent } from "../../shared/types";
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
    return { plan, status: "error", error: "Couldn't reach the OpenChat server", models: [], checkedAt: Date.now() };
  }
}

/** Hosted site: the keys a chat request needs (its plan's, and key-based search providers'). */
async function secretsFor(req: ChatRequest): Promise<Record<string, string[]>> {
  const scopes = [req.plan, ...(req.search ?? []).filter((c) => SEARCH_PROVIDERS[c.provider].credential === "key").map((c) => c.provider)];
  const secrets: Record<string, string[]> = {};
  for (const scope of scopes) {
    const list = await browserSecrets(scope);
    if (list.length) secrets[scope] = list;
  }
  return secrets;
}

/** POST /api/chat and yield normalized stream events. */
export async function* streamChat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  const body = (await config).mode === "hosted" ? { ...req, secrets: await secretsFor(req) } : req;
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    yield { t: "error", message: "Couldn't reach the OpenChat server. Check your connection." };
    return;
  }
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    yield { t: "error", status: res.status, message: body?.error ?? `Request failed (HTTP ${res.status})` };
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield JSON.parse(line) as StreamEvent;
      }
    }
    if (buf.trim()) yield JSON.parse(buf) as StreamEvent;
  } finally {
    reader.releaseLock();
  }
}
