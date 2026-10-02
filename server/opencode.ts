// Translates an OpenChat request into the wire format of the model's Opencode endpoint
// (/chat/completions, /responses, /messages or Gemini's :streamGenerateContent) and
// normalizes the upstream SSE stream into OpenChat's NDJSON StreamEvents.
import type { ToolSpec } from "./search";
import { nearestEffort, PLANS, type Attachment, type ChatRequest, type Effort, type ModelInfo, type Protocol, type StreamEvent, type WireMessage } from "../shared/types";

// Opencode Go asks clients to identify themselves and send a stable per-conversation session id.
export const USER_AGENT = "openchat/1.0";

type Json = Record<string, unknown>;

interface Upstream {
  url: string;
  headers: Record<string, string>;
  body: Json;
}

/** Tool-calling state for a request: tool definitions plus the turns produced so far. */
export interface ToolOptions {
  tools: ToolSpec[];
  /** Native-format items (assistant tool calls and tool results) appended after the conversation. */
  extra: Json[];
  /** Forbid further tool calls (the last round must answer). */
  final?: boolean;
}

const BUDGETS: Record<Exclude<Effort, "off">, number> = { low: 2048, medium: 8192, high: 16000, xhigh: 24000, max: 31999 };

const base64Of = (a: Attachment) => a.dataUrl.slice(a.dataUrl.indexOf(",") + 1);
const isImage = (a: Attachment) => a.mime.startsWith("image/");
const isPdf = (a: Attachment) => a.mime === "application/pdf";

function buildChat(model: ModelInfo, req: ChatRequest, effort: Effort | undefined, tools?: ToolOptions): Json {
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
  if (tools) {
    messages.push(...tools.extra);
    body.tools = tools.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (tools.final) body.tool_choice = "none";
  }
  if (effort === "off") {
    body.reasoning_effort = "none";
    // Upstreams differ on how thinking is switched off; send both forms (unknown fields are ignored).
    if (model.reasoning.toggle) body.thinking = { type: "disabled" };
  } else if (effort && model.reasoning.mode === "effort") body.reasoning_effort = effort;
  return body;
}

function buildResponses(model: ModelInfo, req: ChatRequest, effort: Effort | undefined, tools?: ToolOptions): Json {
  const input: Json[] = req.messages.map((m) => {
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
  if (tools) {
    input.push(...tools.extra);
    body.tools = tools.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
    if (tools.final) body.tool_choice = "none";
    // Without server-side storage, reasoning must be replayed (encrypted) alongside tool calls.
    if (effort && effort !== "off" && model.reasoning.mode === "effort") body.include = ["reasoning.encrypted_content"];
  }
  return body;
}

function buildMessages(model: ModelInfo, req: ChatRequest, effort: Effort | undefined, tools?: ToolOptions): Json {
  const messages: Json[] = req.messages.map((m) => {
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
  if (tools) {
    messages.push(...tools.extra);
    body.tools = tools.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (tools.final) body.tool_choice = { type: "none" };
  }
  return body;
}

function buildGemini(model: ModelInfo, req: ChatRequest, effort: Effort | undefined, tools?: ToolOptions): Json {
  const contents: Json[] = req.messages.map((m) => {
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
  if (tools) {
    contents.push(...tools.extra);
    body.tools = [{ functionDeclarations: tools.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    if (tools.final) body.toolConfig = { functionCallingConfig: { mode: "NONE" } };
  }
  return body;
}

export function buildUpstream(model: ModelInfo, req: ChatRequest & { key: string }, tools?: ToolOptions): Upstream {
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
      return { url: `${baseURL}/chat/completions`, headers, body: buildChat(model, req, effort, tools) };
    case "responses":
      return { url: `${baseURL}/responses`, headers, body: buildResponses(model, req, effort, tools) };
    case "messages":
      return {
        url: `${baseURL}/messages`,
        headers: { ...headers, "x-api-key": req.key, "anthropic-version": "2023-06-01" },
        body: buildMessages(model, req, effort, tools),
      };
    case "gemini":
      return {
        url: `${baseURL}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`,
        headers: { ...headers, "x-goog-api-key": req.key },
        body: buildGemini(model, req, effort, tools),
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

export type Usage = { input?: number; output?: number };

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments. */
  args: string;
  /** Gemini only: whether `id` came from the model (and must be echoed back). */
  nativeId?: boolean;
}

/** Everything one upstream response produced, in a form that can be replayed for the next round. */
export interface TurnState {
  finish?: string;
  usage: Usage;
  text: string;
  reasoning: string;
  /** chat: tool call deltas merged by index */
  chatCalls: { id?: string; name: string; args: string }[];
  /** responses: completed output items */
  items: Json[];
  /** messages: content blocks by index (tool_use input accumulates in `_json`) */
  blocks: Json[];
  /** gemini: raw parts, signatures included */
  parts: Json[];
}

type Handler = (msg: SSEMessage, emit: (e: StreamEvent) => void, state: TurnState) => void;

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
    for (const tc of delta.tool_calls ?? []) {
      const i = typeof tc.index === "number" ? tc.index : state.chatCalls.length;
      const slot = (state.chatCalls[i] ??= { name: "", args: "" });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name ||= tc.function.name;
      const args = tc.function?.arguments;
      if (typeof args === "string") slot.args += args;
      else if (args && typeof args === "object") slot.args = JSON.stringify(args);
    }
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
      case "response.output_item.done":
        if (j.item) state.items.push(j.item);
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
      case "content_block_start": {
        const block: Json = { ...j.content_block };
        if (block.type === "tool_use") block._json = "";
        state.blocks[j.index] = block;
        return;
      }
      case "content_block_delta": {
        const block = state.blocks[j.index] as Record<string, any> | undefined;
        const d = j.delta ?? {};
        if (d.type === "text_delta") {
          emit({ t: "text", v: d.text });
          if (block) block.text = (block.text ?? "") + d.text;
        } else if (d.type === "thinking_delta") {
          emit({ t: "reasoning", v: d.thinking });
          if (block) block.thinking = (block.thinking ?? "") + d.thinking;
        } else if (d.type === "signature_delta" && block) {
          block.signature = (block.signature ?? "") + d.signature;
        } else if (d.type === "input_json_delta" && block) {
          block._json += d.partial_json ?? "";
        }
        return;
      }
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
      state.parts.push(part);
      if (typeof part.text !== "string" || !part.text) continue;
      emit({ t: part.thought ? "reasoning" : "text", v: part.text });
    }
    if (cand?.finishReason) state.finish = String(cand.finishReason).toLowerCase();
    const u = j.usageMetadata;
    if (u?.promptTokenCount != null) state.usage = { input: u.promptTokenCount, output: u.candidatesTokenCount };
  },
};

/** Tool calls the model made in a turn, plus that turn in native form for replay. */
export function finishTurn(protocol: Protocol, state: TurnState): { calls: ToolCall[]; assistant: Json[] } {
  switch (protocol) {
    case "chat": {
      const calls = state.chatCalls
        .filter((c) => c?.name)
        .map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, args: c.args || "{}" }));
      if (!calls.length) return { calls, assistant: [] };
      const assistant: Json = {
        role: "assistant",
        content: state.text || null,
        tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
      };
      // Thinking models such as DeepSeek and Kimi require their reasoning back alongside tool calls.
      if (state.reasoning) assistant.reasoning_content = state.reasoning;
      return { calls, assistant: [assistant] };
    }
    case "responses": {
      const calls = state.items
        .filter((it) => it.type === "function_call")
        .map((it) => ({ id: String(it.call_id), name: String(it.name), args: String(it.arguments ?? "{}") }));
      // Items aren't stored server-side (store: false), so replay them without their ids.
      const assistant = state.items.map(({ id: _id, status: _status, ...rest }) => rest);
      return { calls, assistant: calls.length ? assistant : [] };
    }
    case "messages": {
      const blocks: Json[] = [];
      const calls: ToolCall[] = [];
      for (const b of state.blocks) {
        if (!b) continue;
        if (b.type === "tool_use") {
          const { _json, ...rest } = b;
          let input: unknown = {};
          try {
            input = _json ? JSON.parse(String(_json)) : {};
          } catch {}
          blocks.push({ ...rest, input });
          calls.push({ id: String(b.id), name: String(b.name), args: JSON.stringify(input) });
        } else if (b.type === "text") {
          if (String(b.text ?? "").trim()) blocks.push({ type: "text", text: b.text });
        } else blocks.push(b);
      }
      return { calls, assistant: calls.length ? [{ role: "assistant", content: blocks }] : [] };
    }
    case "gemini": {
      const calls: ToolCall[] = [];
      const parts: Json[] = [];
      for (const p of state.parts) {
        const fc = p.functionCall as { id?: string; name?: string; args?: unknown } | undefined;
        if (fc?.name) calls.push({ id: fc.id ?? `call_${calls.length}`, nativeId: !!fc.id, name: fc.name, args: JSON.stringify(fc.args ?? {}) });
        // Merge streamed text chunks; parts with signatures or calls are kept exactly as sent.
        const prev = parts[parts.length - 1];
        const plain = (x: Json) => Object.keys(x).every((k) => k === "text" || k === "thought");
        if (prev && plain(prev) && plain(p) && !!prev.thought === !!p.thought) prev.text = String(prev.text ?? "") + String(p.text ?? "");
        else parts.push({ ...p });
      }
      return { calls, assistant: calls.length ? [{ role: "model", parts }] : [] };
    }
  }
}

/** Native-format tool result items for a round of calls. */
export function toolResults(protocol: Protocol, calls: ToolCall[], outputs: string[]): Json[] {
  switch (protocol) {
    case "chat":
      return calls.map((c, i) => ({ role: "tool", tool_call_id: c.id, content: outputs[i] }));
    case "responses":
      return calls.map((c, i) => ({ type: "function_call_output", call_id: c.id, output: outputs[i] }));
    case "messages":
      return [{ role: "user", content: calls.map((c, i) => ({ type: "tool_result", tool_use_id: c.id, content: outputs[i] })) }];
    case "gemini":
      return [
        {
          role: "user",
          parts: calls.map((c, i) => ({ functionResponse: { name: c.name, ...(c.nativeId ? { id: c.id } : {}), response: { result: outputs[i] } } })),
        },
      ];
  }
}

export const newTurn = (): TurnState => ({ usage: {}, text: "", reasoning: "", chatCalls: [], items: [], blocks: [], parts: [] });

/**
 * Read one upstream SSE response, emitting text/reasoning as it arrives.
 * Returns the turn state, or undefined if the upstream reported an error (already emitted).
 */
export async function readTurn(model: ModelInfo, upstream: Response, emit: (e: StreamEvent) => void): Promise<TurnState | undefined> {
  const handle = handlers[model.protocol];
  const state = newTurn();
  let failed = false;
  const onEvent = (e: StreamEvent) => {
    if (e.t === "error") failed = true;
    else if (e.t === "text") state.text += e.v;
    else if (e.t === "reasoning") state.reasoning += e.v;
    emit(e);
  };
  for await (const msg of parseSSE(upstream.body!)) {
    try {
      handle(msg, onEvent, state);
    } catch {
      // Ignore malformed / non-JSON keep-alive frames.
    }
    if (failed) break;
  }
  if (failed) {
    await upstream.body?.cancel().catch(() => {});
    return undefined;
  }
  return state;
}

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

/**
 * Whether a failed request should be retried with the plan's next key: the key itself is
 * rejected, out of credit/billing, disabled, or rate/usage limited.
 */
export function isKeyFailure(status: number | undefined, message: string) {
  if (status === 401 || status === 402 || status === 403 || status === 429) return true;
  return /billing|credit|balance|quota|insufficient|payment|subscription|revoked|expired|disabled|usage limit|limit reached|exceeded/i.test(message);
}

export function validateMessages(messages: unknown): messages is WireMessage[] {
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
  );
}
