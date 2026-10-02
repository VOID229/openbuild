// Translates an OpenChat request into the wire format of the model's Opencode endpoint
// (/chat/completions, /responses, /messages or Gemini's :streamGenerateContent) and
// normalizes the upstream SSE stream into OpenChat's NDJSON StreamEvents.
import { nearestEffort, PLANS, type Attachment, type ChatRequest, type Effort, type ModelInfo, type StreamEvent, type WireMessage } from "../shared/types";

// Opencode Go asks clients to identify themselves and send a stable per-conversation session id.
export const USER_AGENT = "openchat/1.0";

type Json = Record<string, unknown>;

interface Upstream {
  url: string;
  headers: Record<string, string>;
  body: Json;
}

const BUDGETS: Record<Exclude<Effort, "off">, number> = { low: 2048, medium: 8192, high: 16000, xhigh: 24000, max: 31999 };

const base64Of = (a: Attachment) => a.dataUrl.slice(a.dataUrl.indexOf(",") + 1);
const isImage = (a: Attachment) => a.mime.startsWith("image/");
const isPdf = (a: Attachment) => a.mime === "application/pdf";

function buildChat(model: ModelInfo, req: ChatRequest, effort: Effort | undefined): Json {
  const messages: Json[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    const files = m.attachments ?? [];
    if (m.role === "assistant" || files.length === 0) {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    const parts: Json[] = [];
    if (m.content) parts.push({ type: "text", text: m.content });
    for (const a of files) {
      if (isImage(a)) parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
      else if (isPdf(a)) parts.push({ type: "file", file: { filename: a.name, file_data: a.dataUrl } });
    }
    messages.push({ role: "user", content: parts });
  }
  const body: Json = { model: model.id, stream: true, messages };
  if (effort && model.reasoning.mode === "effort") body.reasoning_effort = effort === "off" ? "none" : effort;
  return body;
}

function buildResponses(model: ModelInfo, req: ChatRequest, effort: Effort | undefined): Json {
  const input = req.messages.map((m) => {
    if (m.role === "assistant") return { role: "assistant", content: m.content };
    const parts: Json[] = [];
    if (m.content) parts.push({ type: "input_text", text: m.content });
    for (const a of m.attachments ?? []) {
      if (isImage(a)) parts.push({ type: "input_image", image_url: a.dataUrl });
      else if (isPdf(a)) parts.push({ type: "input_file", filename: a.name, file_data: a.dataUrl });
    }
    return { role: "user", content: parts };
  });
  const body: Json = { model: model.id, stream: true, store: false, input };
  if (req.system) body.instructions = req.system;
  if (effort && model.reasoning.mode === "effort") {
    body.reasoning = effort === "off" ? { effort: "none" } : { effort, summary: "auto" };
  }
  return body;
}

function buildMessages(model: ModelInfo, req: ChatRequest, effort: Effort | undefined): Json {
  const messages = req.messages.map((m) => {
    const files = m.attachments ?? [];
    if (m.role === "assistant" || files.length === 0) return { role: m.role, content: m.content };
    const blocks: Json[] = [];
    for (const a of files) {
      if (isImage(a)) blocks.push({ type: "image", source: { type: "base64", media_type: a.mime, data: base64Of(a) } });
      else if (isPdf(a)) blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Of(a) } });
    }
    if (m.content) blocks.push({ type: "text", text: m.content });
    return { role: "user", content: blocks };
  });

  const outputLimit = model.outputLimit ?? 16384;
  let maxTokens = Math.min(outputLimit, effort === "max" || effort === "xhigh" ? 64000 : 32000);
  const body: Json = { model: model.id, stream: true, messages };
  if (req.system) body.system = req.system;

  const { mode, toggle } = model.reasoning;
  if (effort === "off") {
    if (toggle) body.thinking = { type: "disabled" };
  } else if (effort && mode === "effort") {
    if (/opus-4[-.]5/.test(model.id)) {
      // Opus 4.5 predates adaptive thinking: effort + an explicit budget.
      body.thinking = { type: "enabled", budget_tokens: Math.min(16000, Math.floor(outputLimit / 2) - 1) };
    } else {
      body.thinking = { type: "adaptive", display: "summarized" };
    }
    body.output_config = { effort };
  } else if (effort && mode === "budget") {
    const budget = Math.min(BUDGETS[effort], outputLimit - 1024);
    body.thinking = { type: "enabled", budget_tokens: budget };
    maxTokens = Math.min(outputLimit, Math.max(maxTokens, budget + 8192));
  }
  body.max_tokens = maxTokens;
  return body;
}

function buildGemini(model: ModelInfo, req: ChatRequest, effort: Effort | undefined): Json {
  const contents = req.messages.map((m) => {
    const parts: Json[] = [];
    for (const a of m.attachments ?? []) {
      if (isImage(a) || isPdf(a)) parts.push({ inlineData: { mimeType: a.mime, data: base64Of(a) } });
    }
    if (m.content || parts.length === 0) parts.push({ text: m.content || " " });
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });
  const body: Json = { contents };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  const { mode } = model.reasoning;
  if (effort && mode === "effort") {
    body.generationConfig = {
      thinkingConfig: effort === "off" ? { thinkingBudget: 0 } : { includeThoughts: true, thinkingLevel: effort },
    };
  } else if (effort && mode === "budget") {
    body.generationConfig = {
      thinkingConfig: effort === "off" ? { thinkingBudget: 0 } : { includeThoughts: true, thinkingBudget: BUDGETS[effort] },
    };
  }
  return body;
}

export function buildUpstream(model: ModelInfo, req: ChatRequest): Upstream {
  const { baseURL } = PLANS[req.plan];
  const effort = nearestEffort(model.reasoning.efforts, req.effort);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${req.key}`,
    "user-agent": USER_AGENT,
    "x-opencode-session": req.sessionId,
  };
  switch (model.protocol) {
    case "chat":
      return { url: `${baseURL}/chat/completions`, headers, body: buildChat(model, req, effort) };
    case "responses":
      return { url: `${baseURL}/responses`, headers, body: buildResponses(model, req, effort) };
    case "messages":
      return {
        url: `${baseURL}/messages`,
        headers: { ...headers, "x-api-key": req.key, "anthropic-version": "2023-06-01" },
        body: buildMessages(model, req, effort),
      };
    case "gemini":
      return {
        url: `${baseURL}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`,
        headers: { ...headers, "x-goog-api-key": req.key },
        body: buildGemini(model, req, effort),
      };
  }
}

// ---------------------------------------------------------------------------------------
// SSE → StreamEvent

interface SSEMessage {
  event?: string;
  data: string;
}

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const decoder = new TextDecoder();
  let buf = "";
  let event: string | undefined;
  let data: string[] = [];
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n") };
          event = undefined;
          data = [];
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
      }
    }
    buf += decoder.decode();
    if (buf.trim().startsWith("data:")) data.push(buf.trim().slice(5).trim());
    if (data.length) yield { event, data: data.join("\n") };
  } finally {
    reader.releaseLock();
  }
}

type Usage = { input?: number; output?: number };
type Handler = (msg: SSEMessage, emit: (e: StreamEvent) => void, state: { finish?: string; usage: Usage }) => void;

function errorMessage(j: any): string | undefined {
  const e = j?.error ?? (j?.type === "error" ? j : undefined);
  if (!e) return undefined;
  return typeof e === "string" ? e : (e.message ?? JSON.stringify(e));
}

const handlers: Record<ModelInfo["protocol"], Handler> = {
  chat(msg, emit, state) {
    if (msg.data === "[DONE]") return;
    const j = JSON.parse(msg.data);
    const err = errorMessage(j);
    if (err) return emit({ t: "error", message: err });
    const choice = j.choices?.[0];
    const delta = choice?.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text;
    if (typeof reasoning === "string" && reasoning) emit({ t: "reasoning", v: reasoning });
    if (typeof delta.content === "string" && delta.content) emit({ t: "text", v: delta.content });
    if (choice?.finish_reason) state.finish = choice.finish_reason;
    if (j.usage) state.usage = { input: j.usage.prompt_tokens, output: j.usage.completion_tokens };
  },
  responses(msg, emit, state) {
    const j = JSON.parse(msg.data);
    switch (j.type) {
      case "response.output_text.delta":
        return emit({ t: "text", v: j.delta });
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        return emit({ t: "reasoning", v: j.delta });
      case "response.reasoning_summary_part.added":
        if (j.summary_index > 0) emit({ t: "reasoning", v: "\n\n" });
        return;
      case "response.completed":
      case "response.incomplete": {
        const u = j.response?.usage;
        if (u) state.usage = { input: u.input_tokens, output: u.output_tokens };
        state.finish = j.type === "response.incomplete" ? (j.response?.incomplete_details?.reason ?? "incomplete") : "stop";
        return;
      }
      case "response.failed":
        return emit({ t: "error", message: j.response?.error?.message ?? "The response failed." });
      case "error":
        return emit({ t: "error", message: j.message ?? errorMessage(j) ?? "Upstream error" });
    }
  },
  messages(msg, emit, state) {
    const j = JSON.parse(msg.data);
    switch (j.type) {
      case "content_block_delta":
        if (j.delta?.type === "text_delta") emit({ t: "text", v: j.delta.text });
        else if (j.delta?.type === "thinking_delta") emit({ t: "reasoning", v: j.delta.thinking });
        return;
      case "message_start":
        state.usage.input = j.message?.usage?.input_tokens;
        return;
      case "message_delta":
        if (j.delta?.stop_reason) state.finish = j.delta.stop_reason;
        if (j.usage?.output_tokens != null) state.usage.output = j.usage.output_tokens;
        return;
      case "error":
        return emit({ t: "error", message: errorMessage(j) ?? "Upstream error" });
    }
  },
  gemini(msg, emit, state) {
    const j = JSON.parse(msg.data);
    const err = errorMessage(j);
    if (err) return emit({ t: "error", message: err });
    if (j.promptFeedback?.blockReason) return emit({ t: "error", message: `Blocked by the provider (${j.promptFeedback.blockReason}).` });
    const cand = j.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) {
      if (typeof part.text !== "string" || !part.text) continue;
      emit({ t: part.thought ? "reasoning" : "text", v: part.text });
    }
    if (cand?.finishReason) state.finish = String(cand.finishReason).toLowerCase();
    const u = j.usageMetadata;
    if (u?.promptTokenCount != null) state.usage = { input: u.promptTokenCount, output: u.candidatesTokenCount };
  },
};

/** Extract a human-readable message from a failed upstream response. */
export async function upstreamError(res: Response, planLabel: string): Promise<StreamEvent> {
  let text = await res.text().catch(() => "");
  // Some upstreams answer errors in SSE framing even on non-2xx responses.
  if (/^(event|data):/m.test(text)) {
    text = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
  }
  let message: string | undefined;
  try {
    const j = JSON.parse(text);
    message = errorMessage(j) ?? (typeof j.message === "string" ? j.message : undefined);
    if (Array.isArray(j) && j[0]?.error) message = j[0].error.message;
  } catch {
    message = text.trim().slice(0, 400) || undefined;
  }
  if (!message?.trim() || message.trim() === "{}") {
    message =
      res.status === 400
        ? "The provider rejected the request (HTTP 400). This can happen with attachments the model can't process."
        : `Upstream error (HTTP ${res.status})`;
  }
  if (res.status === 401) message = `Your ${planLabel} API key was rejected. Replace it in Settings → API Keys.`;
  return { t: "error", status: res.status, message };
}

/** Pipe an upstream SSE body into NDJSON StreamEvents. */
export function normalizeStream(model: ModelInfo, upstream: Response, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const handle = handlers[model.protocol];
  return new ReadableStream({
    async start(controller) {
      const send = (e: StreamEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      // Keep the connection warm while a model thinks silently.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);
      const state: { finish?: string; usage: Usage } = { usage: {} };
      let failed = false;
      const emit = (e: StreamEvent) => {
        if (e.t === "error") failed = true;
        send(e);
      };
      try {
        for await (const msg of parseSSE(upstream.body!)) {
          try {
            handle(msg, emit, state);
          } catch {
            // Ignore malformed / non-JSON keep-alive frames.
          }
          if (failed) break;
        }
        if (!failed) send({ t: "done", finish: state.finish, usage: state.usage });
      } catch (err) {
        if (!signal.aborted) send({ t: "error", message: `Connection to Opencode was interrupted: ${(err as Error).message}` });
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      upstream.body?.cancel().catch(() => {});
    },
  });
}

export function validateMessages(messages: unknown): messages is WireMessage[] {
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
  );
}
