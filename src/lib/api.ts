import type { ChatRequest, DetectResult, PlanId, StreamEvent } from "../../shared/types";

/** Check a saved key (by id) and list its models. The secret stays on the server. */
export async function detectModels(plan: PlanId, id: string, signal?: AbortSignal): Promise<DetectResult> {
  try {
    const res = await fetch("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan, id }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as DetectResult;
  } catch (err) {
    if (signal?.aborted) throw err;
    return { plan, status: "error", error: "Couldn't reach the OpenChat server", models: [], checkedAt: Date.now() };
  }
}

/** POST /api/chat and yield normalized stream events. */
export async function* streamChat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
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
