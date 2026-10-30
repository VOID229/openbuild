import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamEvent } from "../../shared/types";
import { cleanOptions } from "../pi/extensions/question-ask";

export type QuestionReply = { value?: string; confirmed?: boolean; cancelled?: boolean };
const tool = {
  name: "question_ask",
  description: "Ask the user a question and wait for their answer. Supply suggested options; the user can always enter a free-text answer. Ask one question at a time.",
  inputSchema: { type: "object", properties: { question: { type: "string", minLength: 1, maxLength: 16000 }, options: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 2000 } } }, required: ["question"], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};
/** This prefix is adapter guidance, not a rewrite of the user's message. The
 * complete original user text follows it verbatim, including whitespace. */
export const QUESTION_PREFIX = "[OpenBuild transport instructions: To ask the user a question, call the openbuild-questions MCP tool question_ask with question and options. The UI always allows free text, so do not add an Other option. Wait for the tool answer; never invent it. Native print-mode questions cannot receive replies. If the MCP tool is unavailable or denied by native policy, explain that limitation instead of pretending an answer was received. The user message follows after this paragraph.]\n\n";

/** Minimal stateless Streamable HTTP MCP transport. The random path is a
 * per-turn capability, never a workspace/global MCP configuration or approval. */
export function createQuestions(send: (event: StreamEvent) => void, onSteer: () => void = () => {}) {
  let closed = false;
  const steering: { id: string; text: string }[] = [];
  const pending = new Map<string, (reply: QuestionReply) => void>();
  const active = new Set<string | number>();
  const path = `/mcp/${crypto.randomUUID()}/${crypto.randomUUID()}`;
  const finish = (id: string, reply: QuestionReply) => {
    const resolve = pending.get(id); if (!resolve) return false;
    pending.delete(id);
    send({ t: "asked", id, ...(reply.cancelled ? {} : { answer: reply.value ?? "" }) });
    resolve(reply); return true;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!closed && url.pathname === path + "/steering" && !req.headers.has("origin") && req.method === "POST") {
        const input = await req.json();
        // Only the root consumes input; an aborted turn must never auto-continue.
        if (input.subagent_id || input.agent_id || input.parent_conversation_id || input.is_interrupt || (input.hook_event_name === "stop" && input.status !== "completed")) return Response.json({});
        const items = steering.splice(0);
        for (const item of items) { onSteer(); send({ t: "steer", id: item.id, text: item.text }); }
        const text = items.map(item => item.text).join("\n\n");
        return Response.json(text ? input.hook_event_name === "stop" ? { followup_message: text } : { additional_context: text } : {});
      }
      // No CORS; reject browser-origin requests, even with the capability URL.
      if (closed || url.pathname !== path || req.headers.has("origin")) return new Response("Not found", { status: 404 });
      if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
      if (!req.headers.get("content-type")?.includes("application/json")) return new Response(null, { status: 415 });
      if (Number(req.headers.get("content-length")) > 65536) return new Response(null, { status: 413 });
      let m: any;
      try {
        // Stream-limit before parsing (Content-Length is optional/untrusted).
        const reader = req.body?.getReader(); let text = "", size = 0; const decoder = new TextDecoder();
        if (!reader) throw new Error("Missing body");
        try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 65536) { await reader.cancel(); return new Response(null, { status: 413 }); } text += decoder.decode(value, { stream: true }); } }
        finally { reader.releaseLock(); }
        m = JSON.parse(text + decoder.decode());
      } catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); }
      const respond = (value: object) => Response.json({ jsonrpc: "2.0", id: m?.id ?? null, ...value });
      const error = (code: number, message: string) => respond({ error: { code, message } });
      if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string" || (m.id !== undefined && typeof m.id !== "string" && typeof m.id !== "number")) return error(-32600, "Invalid request");
      if (m.id === undefined) return new Response(null, { status: 202 });
      if (m.method === "initialize") return respond({ result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "openbuild-questions", version: "1.0.0" }, instructions: "Use question_ask to ask the user. Free text is always available." } });
      if (m.method === "ping") return respond({ result: {} });
      if (m.method === "tools/list") return respond({ result: { tools: [tool] } });
      if (m.method !== "tools/call") return error(-32601, "Method not found");
      if (m.params?.name !== tool.name) return error(-32602, "Unknown tool");
      const a = m.params.arguments;
      if (!a || typeof a.question !== "string" || !a.question.trim() || a.question.length > 16000 || (a.options !== undefined && (!Array.isArray(a.options) || a.options.length > 30 || a.options.some((o: unknown) => typeof o !== "string" || o.length > 2000))) || Object.keys(a).some(k => !["question", "options"].includes(k))) return error(-32602, "Expected question and optional string options");
      const options = cleanOptions(a.options);
      if (active.has(m.id)) return error(-32600, "Duplicate active request ID");
      if (pending.size >= 16) return error(-32600, "Too many pending questions");
      active.add(m.id);
      const id = `cursor-ask-${crypto.randomUUID()}`;
      const abort = () => finish(id, { cancelled: true });
      try {
        const reply = await new Promise<QuestionReply>(resolve => {
          pending.set(id, resolve);
          req.signal.addEventListener("abort", abort, { once: true });
          if (req.signal.aborted || closed) abort();
          else send({ t: "ask", id, method: options.length ? "select" : "input", title: a.question.trim(), options, other: true });
        });
        return respond({ result: { content: [{ type: "text", text: JSON.stringify(reply.cancelled ? { cancelled: true } : { answer: reply.value ?? "" }) }] } });
      } finally { active.delete(m.id); req.signal.removeEventListener("abort", abort); }
    },
  });
  let pluginDir = "";
  try {
    pluginDir = mkdtempSync(join(tmpdir(), "openbuild-cursor-questions-"));
    mkdirSync(join(pluginDir, "hooks"), { mode: 0o700 });
    mkdirSync(join(pluginDir, ".cursor-plugin"), { mode: 0o700 });
    writeFileSync(join(pluginDir, ".cursor-plugin", "plugin.json"), JSON.stringify({ name: "openbuild-questions" }), { mode: 0o600 });
    const script = join(pluginDir, "hooks", "steer.js");
    writeFileSync(script, `const input = JSON.parse(await new Response(Bun.stdin.stream()).text());
const response = await fetch(${JSON.stringify(`http://127.0.0.1:${server.port}${path}/steering`)}, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...input,hook_event_name:process.argv[2]})});
console.log(await response.text());`, { mode: 0o600 });
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const command = `${quote(process.execPath)} ${quote(script)}`;
    writeFileSync(join(pluginDir, "hooks", "hooks.json"), JSON.stringify({ version: 1, hooks: Object.fromEntries(["postToolUse", "postToolUseFailure", "stop"].map(name => [name, [{ command: `${command} ${name}`, ...(name === "stop" ? { loop_limit: null } : {}) }]])) }), { mode: 0o600 });
    writeFileSync(join(pluginDir, ".mcp.json"), JSON.stringify({ mcpServers: { "openbuild-questions": { type: "http", url: `http://127.0.0.1:${server.port}${path}` } } }), { mode: 0o600 });
  } catch (e) { server.stop(true); if (pluginDir) rmSync(pluginDir, { recursive: true, force: true }); throw e; }
  return {
    pluginDir,
    steer(id: string, text: string) { if (closed) throw new Error("Cursor isn't working on this thread"); steering.push({ id, text }); },
    stopSteering() { steering.length = 0; },
    hasAsk: (id: string) => pending.has(id),
    answer: finish,
    close() {
      if (closed) return; closed = true;
      for (const id of pending.keys()) finish(id, { cancelled: true });
      server.stop(true);
      rmSync(pluginDir, { recursive: true, force: true });
    },
  };
}
