import type { StreamEvent, Usage } from "../../shared/types";
type Tool = Extract<StreamEvent, { t: "tool" }>;
const names: Record<string, string> = { shellToolCall: "bash", readToolCall: "read", editToolCall: "edit", writeToolCall: "write", deleteToolCall: "edit", lsToolCall: "ls", globToolCall: "find", grepToolCall: "grep", updateTodosToolCall: "todo", readTodosToolCall: "todo", webSearchToolCall: "web_search", webFetchToolCall: "web_fetch", taskToolCall: "task", mcpToolCall: "mcp" };
export function toolEvent(m: any): Tool | undefined {
  const call = m.tool_call;
  if (!call || typeof call !== "object" || !m.call_id) return;
  // protobuf JSON uses the selected oneof key. Accept the in-memory case/value
  // form as well for forward-compatible fixtures/CLI builds.
  const kind = call.tool?.case ?? Object.keys(call).find(k => k.endsWith("ToolCall"));
  if (!kind) return;
  const body = call.tool?.value ?? call[kind] ?? {};
  const rawArgs = body.args ?? {}, result = body.result;
  const state = result?.result?.case ?? (result && Object.keys(result).find(k => k !== "$typeName"));
  const value = result?.result?.value ?? result?.[state];
  const done = m.subtype === "completed";
  const failed = !!state && !["success", "pending", "backgrounded"].includes(state);
  const args = { ...rawArgs, ...(rawArgs.command ? { command: rawArgs.command } : {}), ...(rawArgs.path ?? rawArgs.filePath ? { path: rawArgs.path ?? rawArgs.filePath } : {}), cursor: { kind, toolCall: call } };
  let output: string | undefined;
  if (value !== undefined) {
    if (typeof value === "string") output = value;
    else if (kind === "shellToolCall") output = [value.stdout, value.stderr, value.error, value.reason].filter(v => typeof v === "string" && v.length).join("") || JSON.stringify(value, null, 2);
    else output = typeof value.content === "string" ? value.content : typeof value.text === "string" ? value.text : JSON.stringify(value, null, 2);
  }
  return { t: "tool", id: m.call_id, name: names[kind] ?? kind.replace(/ToolCall$/, ""), args, status: done ? failed ? "error" : "done" : "running", ...(output !== undefined ? { output } : {}), ...(failed ? { error: output || `Cursor tool ${state}` } : {}), ...(typeof value?.diff === "string" ? { patch: value.diff } : {}) };
}
/** stream-json WITHOUT partial-output: assistant chunks are non-overlapping flushes;
 * result.result repeats the concatenated text and must not be appended again. */
export class CursorProtocol {
  sessionId?: string;
  result?: any;
  usage?: Usage;
  private text = "";
  private afterTool = false;
  constructor(private send: (event: StreamEvent) => void) {}
  accept(m: any) {
    if (!m || typeof m !== "object" || typeof m.type !== "string") throw new Error("Invalid Cursor stream event");
    if (m.session_id) {
      if (typeof m.session_id !== "string" || (this.sessionId && this.sessionId !== m.session_id)) throw new Error("Cursor changed session id during a turn");
      this.sessionId = m.session_id;
    }
    if (m.type === "assistant") {
      const text = (m.message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("");
      if (text) { if (this.afterTool && this.text) this.send({ t: "text", v: "\n\n" }); this.afterTool = false; this.text += text; this.send({ t: "text", v: text }); }
    } else if (m.type === "thinking" && m.subtype === "delta" && typeof m.text === "string") this.send({ t: "reasoning", v: m.text });
    else if (m.type === "tool_call") { const event = toolEvent(m); if (event) { this.afterTool = true; this.send(event); } }
    else if (m.type === "error") throw new Error(typeof m.message === "string" ? m.message : m.error?.message ?? JSON.stringify(m.error ?? m));
    else if (m.type === "result") {
      if (this.result) throw new Error("Cursor sent more than one terminal result");
      this.result = m;
      if (m.is_error || m.subtype !== "success") throw new Error(m.result || m.error?.message || "Cursor turn failed");
      if (!this.text && typeof m.result === "string" && m.result) { this.text = m.result; this.send({ t: "text", v: m.result }); }
      if (m.usage) {
        this.usage = { input: Number(m.usage.inputTokens ?? 0), output: Number(m.usage.outputTokens ?? 0), cacheRead: Number(m.usage.cacheReadTokens ?? 0), cacheWrite: Number(m.usage.cacheWriteTokens ?? 0) };
        this.send({ t: "usage", usage: this.usage });
      }
    }
  }
}
