// Offline Pi protocol stand-in. Only used by piRuntime.test.ts with a temporary agent/data dir.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.PI_TEST_CASE;
const log = (record) => appendFileSync(process.env.PI_TEST_LOG, JSON.stringify(record) + "\n");
const out = (record) => process.stdout.write(JSON.stringify(record) + "\n");
log({ type: "fixture_start", pid: process.pid });
const entry = (id, parentId, role, content = id) => ({ type: "message", id, parentId, message: { role, content } });
let entries = mode === "branch"
  ? [entry("u1", null, "user"), entry("a1", "u1", "assistant"), entry("abandoned-u2", "a1", "user"), entry("abandoned-a2", "abandoned-u2", "assistant"), entry("active-a1", "u1", "assistant")]
  : mode === "image"
    ? [entry("image-u1", null, "user", [{ type: "image", data: "AA==", mimeType: "image/png" }]), entry("a1", "image-u1", "assistant"), entry("u2", "a1", "user"), entry("a2", "u2", "assistant")]
    : [];
let leafId = entries.at(-1)?.id ?? null;
let queued = [];
let prompts = 0;
let working = false;
let question = false;
const settle = () => { working = false; out({ type: "agent_settled", aborted: true }); };
// Exercise the host's hard-stop fallback, including a child that ignores SIGTERM.
if (mode === "stuck") process.on("SIGTERM", () => {});
const rl = createInterface({ input: process.stdin });
rl.on("close", () => { if (mode !== "stuck") process.exit(0); });
// Keep stuck mode alive even when the host closes stdin.
if (mode === "stuck") setInterval(() => {}, 1000);
rl.on("line", (line) => {
  const c = JSON.parse(line);
  log(c);
  const reply = (data) => out({ type: "response", id: c.id, command: c.type, success: true, ...(data === undefined ? {} : { data }) });
  switch (c.type) {
    case "get_state": return reply({ model: { provider: "test", id: "model" } });
    case "get_entries": return reply({ entries, leafId });
    // Mirrors Pi 1.4's actual selector: all branches, text-only user messages.
    case "get_fork_messages": return reply({ messages: entries.filter((e) => e.message.role === "user" && typeof e.message.content === "string" && e.message.content).map((e) => ({ entryId: e.id, text: e.message.content })) });
    case "fork": leafId = entries.find((e) => e.id === c.entryId)?.parentId ?? null; return reply({ cancelled: false });
    case "get_available_thinking_levels": return reply({ levels: ["off"] });
    case "get_session_stats": return reply({});
    case "prompt": {
      const start = () => {
        prompts++;
        if (c.message === "/handled") return reply({ disposition: "handled" });
        if (c.message === "/fail") return out({ type: "response", id: c.id, command: c.type, success: false, error: "Rejected in preflight" });
        log({ type: "prompt_context", leafId });
        reply({ disposition: "started" });
        working = true;
        out({ type: "agent_start" });
        out({ type: "message_start", message: { role: "user", content: c.message } });
        out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Working" } });
        if (mode === "ask" && prompts === 1) {
          question = true;
          out({ type: "tool_execution_start", toolName: "question_ask", toolCallId: "question-call", args: { question: "Proceed?" } });
          out({ type: "extension_ui_request", id: "dialog-1", method: "select", title: "Proceed?", options: ["Yes"] });
        }
        if (mode === "branch" || mode === "image" || (mode === "ask" && prompts > 1)) setTimeout(settle, 5);
      };
      if (mode === "late-prompt") return setTimeout(start, 100);
      return start();
    }
    case "steer": {
      const accept = () => {
        queued.push(c.message);
        log({ type: "steer_accepted" });
        reply({ disposition: "queued" });
        if (mode === "cancel-stream") setTimeout(() => out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "More work" } }), 5);
      };
      if (mode === "late-steer-finish") setTimeout(settle, 10);
      if (mode === "late-steer" || mode === "late-steer-finish") return setTimeout(accept, 100);
      return accept();
    }
    case "clear_queue": { const steering = queued; queued = []; return reply({ steering, followUp: [] }); }
    case "extension_ui_response": question = false; return;
    case "abort": {
      if (mode === "stuck") return; // A tool/extension never becomes idle.
      if (queued.length) {
        for (const text of queued.splice(0)) {
          log({ type: "continued_after_abort", text });
          out({ type: "message_start", message: { role: "user", content: text } });
          out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "I will proceed" } });
        }
      }
      if (question) out({ type: "tool_execution_end", toolName: "question_ask", toolCallId: "question-call", result: {}, isError: false });
      reply();
      if (working) settle();
      return;
    }
    default: return reply({});
  }
});
