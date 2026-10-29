// Threads run on fx (Vercel Labs' coding agent) through its Agent Client Protocol server
// (`fx acp`). Each thread has its own fx session (saved by fx under ~/.fx/sessions, so
// `fx session resume <id>` in a terminal opens it too) and, while it's in use, its own `fx acp`
// process in the thread's workspace. fx owns the conversation: a turn sends only the new message.
//
// This runs inside OpenBuild's detached agent worker (server/pi/worker.ts), like Pi turns, so a
// server restart doesn't interrupt a turn and the restarted server reattaches to its events.
//
// fx's events are translated into the same StreamEvents Pi turns produce, with its tools renamed to
// the ones the thread UI knows (shell → bash, read_file → read, edit_file → edit, …), so a fx
// thread looks and behaves like a Pi thread.
import { structuredPatch } from "diff";
import { isAbsolute, join } from "node:path";
import type { Effort, PiChatRequest, StreamEvent, Usage } from "../../shared/types";
import * as storage from "../storage";
import { AcpProcess, FxError, type AcpMessage } from "./acp";

/** Close a thread's fx process after this long without use (its session stays on disk). */
const IDLE = 20 * 60 * 1000;
const OUTPUT_MAX = 12_000;
const PATCH_MAX = 60_000;

interface Live {
  threadId: string;
  proc: AcpProcess;
  ready: Promise<string>;
  busy: boolean;
  idle: Promise<void>;
  /** Config options fx reported for the session (model, effort, mode). */
  options: ConfigOption[];
  /** Permission requests waiting for the user, replayed to whoever watches the run. */
  asks: Map<string, { ask: Extract<StreamEvent, { t: "ask" }>; requestId: number | string; options: PermissionOption[] }>;
  emit?: (e: StreamEvent) => void;
}

interface ConfigOption {
  id: string;
  category?: string;
  currentValue?: string;
  options?: { value: string; name?: string; permissionMode?: string; _meta?: { fx?: { permissionMode?: string } } }[];
}
interface PermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

const hot = globalThis as { openbuildFxLive?: Map<string, Live>; openbuildFxReaper?: ReturnType<typeof setInterval> };
const live = (hot.openbuildFxLive ??= new Map());
if (hot.openbuildFxReaper) clearInterval(hot.openbuildFxReaper);
hot.openbuildFxReaper = setInterval(() => {
  for (const [id, l] of live) {
    if (l.proc.exited || (!l.busy && Date.now() - l.proc.lastUsed > IDLE)) {
      l.proc.close();
      live.delete(id);
    }
  }
}, 60_000);

/** The fx session a thread uses, and how many of its user messages fx has been sent. */
interface Saved {
  id: string;
  cwd: string;
  turns: number;
}
const savedKey = (threadId: string) => `fx-session:${threadId}`;
function saved(threadId: string): Saved | undefined {
  try {
    return JSON.parse(storage.getValue(savedKey(threadId)) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
}
const save = (threadId: string, s: Saved) => storage.setValue(savedKey(threadId), JSON.stringify(s));

export const isSessionLive = (threadId: string) => {
  const l = live.get(threadId);
  return !!l && !l.proc.exited;
};

/** The permission mode fx itself is configured with (`fx status`), so OpenBuild doesn't change it. */
let configuredMode: Promise<string | undefined> | undefined;
async function fxPermissionMode(): Promise<string | undefined> {
  return (configuredMode ??= (async () => {
    const { fxBin, fxEnv } = await import("./install");
    const bin = fxBin();
    if (!bin) return undefined;
    const p = Bun.spawn([bin, "status", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: fxEnv() });
    const out = await new Response(p.stdout).text();
    try {
      return JSON.parse(out.slice(out.indexOf("{"))).permission_mode as string | undefined;
    } catch {
      return undefined;
    }
  })());
}

function ensure(threadId: string, cwd: string): Live {
  const existing = live.get(threadId);
  if (existing && !existing.proc.exited && existing.proc.cwd === cwd) return existing;
  if (existing) {
    if (existing.busy) throw new FxError("This thread is still working in another directory");
    existing.proc.close();
    live.delete(threadId);
  }
  const proc = new AcpProcess(cwd);
  const l: Live = { threadId, proc, busy: false, idle: Promise.resolve(), options: [], asks: new Map(), ready: Promise.resolve("") };
  // fx asks before an action its permission mode doesn't allow on its own: show it as a question.
  proc.on((m) => {
    if (m.method !== "session/request_permission" || m.id === undefined) return;
    const p = m.params ?? {};
    const options: PermissionOption[] = Array.isArray(p.options) ? p.options : [];
    if (!options.length) return proc.respond(m.id, { outcome: { outcome: "cancelled" } });
    const askId = `fx-perm-${m.id}-${Date.now()}`;
    const call = p.toolCall ?? {};
    const what = describeCall(call);
    const ask: Extract<StreamEvent, { t: "ask" }> = {
      t: "ask",
      id: askId,
      method: "select",
      title: `Allow fx to ${what}?`,
      options: options.map((o) => o.name),
    };
    l.asks.set(askId, { ask, requestId: m.id, options });
    l.emit?.(ask);
  });
  // Requests fx may send that a client without those capabilities shouldn't get; refuse politely.
  proc.on((m) => {
    if (m.id !== undefined && m.method && m.method !== "session/request_permission" && m.method !== "session/update") {
      proc.respondError(m.id, -32601, "Method not supported by OpenBuild");
    }
  });
  l.ready = (async () => {
    await proc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 30_000);
    const s = saved(threadId);
    let sessionId: string | undefined;
    if (s && s.cwd === cwd) {
      // Pick the thread's fx session back up (without replaying its history at us).
      const r = await proc.request<{ configOptions?: ConfigOption[] }>("session/resume", { sessionId: s.id, cwd, mcpServers: [] }, 60_000).catch(async () =>
        proc.request<{ configOptions?: ConfigOption[] }>("session/load", { sessionId: s.id, cwd, mcpServers: [] }, 60_000).catch(() => undefined),
      );
      if (r) {
        sessionId = s.id;
        l.options = r.configOptions ?? [];
      }
    }
    if (!sessionId) {
      const r = await proc.request<{ sessionId: string; configOptions?: ConfigOption[] }>("session/new", { cwd, mcpServers: [] }, 60_000);
      sessionId = r.sessionId;
      l.options = r.configOptions ?? [];
      save(threadId, { id: sessionId, cwd, turns: s && s.cwd === cwd ? s.turns : 0 });
    }
    // Use the permission mode fx is configured with ("auto" reviews actions itself); ACP sessions
    // otherwise start in "ask", which would stop for every edit.
    const mode = l.options.find((o) => o.id === "mode");
    const wanted = await fxPermissionMode();
    const pick =
      mode?.options?.find((o) => (o._meta?.fx?.permissionMode ?? o.permissionMode) === wanted) ??
      mode?.options?.find((o) => o.value === "auto" || o.value === "code");
    if (mode && pick && mode.currentValue !== pick.value) await setOption(l, sessionId, "mode", pick.value).catch(() => {});
    return sessionId;
  })();
  l.ready.catch(() => {});
  live.set(threadId, l);
  return l;
}

async function setOption(l: Live, sessionId: string, configId: string, value: string) {
  const r = await l.proc.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", { sessionId, configId, value });
  if (r?.configOptions) l.options = r.configOptions;
}

/** Answer a permission question fx asked. */
export function answer(threadId: string, askId: string, reply: { value?: string; confirmed?: boolean; cancelled?: boolean }): boolean {
  const l = live.get(threadId);
  const pending = l?.asks.get(askId);
  if (!l || !pending) return false;
  l.asks.delete(askId);
  const option = reply.cancelled ? undefined : pending.options.find((o: PermissionOption) => o.name === reply.value) ?? (reply.confirmed ? pending.options.find((o: PermissionOption) => o.kind?.startsWith("allow")) : undefined);
  l.proc.respond(pending.requestId, option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } });
  l.emit?.({ t: "asked", id: askId, answer: option?.name });
  return true;
}

export const hasAsk = (threadId: string, askId: string) => !!live.get(threadId)?.asks.has(askId);

/** Stop a thread's fx process (its session stays on disk). */
export function release(threadId: string) {
  live.get(threadId)?.proc.close();
  live.delete(threadId);
}

export function restartIdle() {
  for (const [id, l] of live) if (!l.busy) release(id);
  configuredMode = undefined;
}

// ------------------------------------------------------------------ fx tools as OpenBuild tools

function clip(text: string, max: number) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n… ${text.length - max} characters not shown …\n\n${text.slice(-half)}`;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** fx's tool, as the tool name and arguments the thread UI renders (Pi's names). */
function mapTool(name: string | undefined, kind: string | undefined, input: Record<string, unknown> = {}): { name: string; args: Record<string, unknown> } {
  const path = str(input.path) ?? str(input.file_path) ?? str(input.filePath);
  switch (name) {
    case "shell":
    case "bash":
    case "exec":
      return { name: "bash", args: { command: str(input.command) ?? str(input.cmd) ?? "", ...(input.cwd ? { cwd: input.cwd } : {}) } };
    case "read_file":
    case "read":
      return { name: "read", args: { path, ...(input.offset !== undefined ? { offset: input.offset } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) } };
    case "edit_file":
    case "edit":
    case "multi_edit":
    case "apply_patch":
      return { name: "edit", args: { ...input, path } };
    case "write_file":
    case "write":
    case "create_file":
      return { name: "write", args: { path, content: input.content } };
    case "grep_files":
    case "grep":
      return { name: "grep", args: { pattern: input.pattern, path } };
    case "glob_files":
    case "glob":
    case "find":
      return { name: "find", args: { pattern: input.pattern, path } };
    case "list_dir":
    case "list_directory":
    case "ls":
      return { name: "ls", args: { path: path ?? "." } };
    case "web_search":
      return { name: "web_search", args: { query: input.query } };
    case "web_fetch":
    case "fetch":
      return { name: "fetch", args: { url: input.url } };
  }
  // Unknown tools: fall back on the ACP kind, keeping fx's own name otherwise.
  if (!name) {
    if (kind === "execute") return { name: "bash", args: { command: str(input.command) ?? "" } };
    if (kind === "read") return { name: "read", args: { path } };
    if (kind === "edit") return { name: "edit", args: { ...input, path } };
    if (kind === "search") return { name: "grep", args: { pattern: input.pattern, path } };
    if (kind === "fetch") return { name: "fetch", args: { url: input.url } };
  }
  return { name: name ?? kind ?? "tool", args: input };
}

/** A tool call in a few words, for a permission question. */
function describeCall(call: { name?: string; kind?: string; title?: string; rawInput?: Record<string, unknown> }) {
  const { name, args } = mapTool(call.name, call.kind, call.rawInput ?? {});
  if (name === "bash") return `run \`${String(args.command ?? "").split("\n")[0]!.slice(0, 120)}\``;
  if (name === "edit") return `edit ${args.path ?? "a file"}`;
  if (name === "write") return `write ${args.path ?? "a file"}`;
  if (name === "read") return `read ${args.path ?? "a file"}`;
  return call.title ? call.title.toLowerCase() : `use ${name.replace(/_/g, " ")}`;
}

/** A unified diff of a change, as the thread UI shows edits. */
function unified(path: string, oldText: string, newText: string): string | undefined {
  if (oldText === newText) return undefined;
  const p = structuredPatch(path, path, oldText, newText, "", "", { context: 3 });
  const lines = [`--- ${path}`, `+++ ${path}`];
  for (const h of p.hunks) lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines.filter((l) => !l.startsWith("\\")));
  return lines.join("\n");
}

function editPatch(args: Record<string, unknown>): string | undefined {
  const path = str(args.path) ?? "file";
  const oldText = str(args.old_string) ?? str(args.oldText) ?? str(args.old_text);
  const newText = str(args.new_string) ?? str(args.newText) ?? str(args.new_text);
  if (oldText !== undefined && newText !== undefined) return unified(path, oldText, newText);
  // A list of edits.
  if (Array.isArray(args.edits)) {
    const parts = (args.edits as Record<string, unknown>[]).map((e) => editPatch({ path, ...e })).filter(Boolean) as string[];
    if (parts.length) return [parts[0]!, ...parts.slice(1).map((p) => p.split("\n").slice(2).join("\n"))].join("\n");
  }
  if (typeof args.patch === "string") return args.patch;
  return undefined;
}

/** Text of ACP tool call content blocks (and any diffs they carry). */
function contentOf(content: unknown, cwd: string): { text: string; patch?: string } {
  if (!Array.isArray(content)) return { text: "" };
  let text = "";
  const patches: string[] = [];
  for (const c of content as any[]) {
    if (c?.type === "content" && c.content?.type === "text") text += c.content.text ?? "";
    else if (c?.type === "diff" && typeof c.newText === "string") {
      const path = typeof c.path === "string" ? (isAbsolute(c.path) && c.path.startsWith(cwd + "/") ? c.path.slice(cwd.length + 1) : c.path) : "file";
      const p = unified(path, c.oldText ?? "", c.newText);
      if (p) patches.push(p);
    }
  }
  return { text, patch: patches.length ? patches.join("\n") : undefined };
}

/** fx's shell result is a JSON summary; the streamed output is what the user wants to see. */
function shellSummary(text: string, result: any): string {
  const r = result ?? (() => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  })();
  if (!r || typeof r !== "object") return "";
  const bits: string[] = [];
  if (r.timed_out) bits.push("timed out");
  if (r.signal) bits.push(`killed by ${r.signal}`);
  if (typeof r.exit_code === "number" && r.exit_code !== 0) bits.push(`exit code ${r.exit_code}`);
  if (r.error?.problems) bits.push(...r.error.problems);
  else if (r.error?.message) bits.push(r.error.message);
  return bits.join(" · ");
}

/** The fx effort level closest to the app's. */
function nearestOption(values: string[], effort: Effort): string | undefined {
  const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const usable = values.filter((v) => order.includes(v));
  if (!usable.length) return undefined;
  if (usable.includes(effort)) return effort;
  const at = order.indexOf(effort === "off" ? "low" : effort);
  return [...usable].sort((a, b) => Math.abs(order.indexOf(a) - at) - Math.abs(order.indexOf(b) - at))[0];
}

// ------------------------------------------------------------------ turns

/** Run one turn and stream it as NDJSON StreamEvents. `signal` stops fx (session/cancel). */
export function runTurn(req: PiChatRequest, signal: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (e: StreamEvent) => {
        if (!closed) controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      };
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(enc.encode("\n"));
      }, 15_000);
      let l: Live | undefined;
      let off: (() => void) | undefined;
      let free: (() => void) | undefined;
      let onAbort: (() => void) | undefined;
      const finish = () => {
        if (closed) return;
        clearInterval(heartbeat);
        off?.();
        if (onAbort) signal.removeEventListener("abort", onAbort);
        if (l && free) {
          l.busy = false;
          // Questions nobody answered are void once the turn is over.
          for (const [id, a] of l.asks) {
            l.proc.respond(a.requestId, { outcome: { outcome: "cancelled" } });
            send({ t: "asked", id });
          }
          l.asks.clear();
          l.emit = undefined;
          l.proc.lastUsed = Date.now();
          free();
        }
        closed = true;
        controller.close();
      };
      try {
        l = ensure(req.threadId, req.cwd);
        if (l.busy) await Promise.race([l.idle, new Promise((r) => setTimeout(r, 15_000))]);
        if (l.busy) throw new FxError("fx is still working on this thread's previous message.");
        l.busy = true;
        l.idle = new Promise<void>((r) => (free = r));
        l.emit = send;
        const proc = l.proc;
        const sessionId = await l.ready;
        if (signal.aborted) return finish();

        const s = saved(req.threadId);
        if (s && req.prior < s.turns) {
          send({ t: "notice", message: "fx can't rewind a thread: its earlier replies stay in its context." });
        }
        if (req.forkFrom) send({ t: "notice", message: "fx can't copy another thread's session; this thread starts fresh." });

        // Model and reasoning effort for this turn.
        const modelId = req.model.startsWith("fx/") ? req.model.slice(3) : req.model;
        const model = l.options.find((o) => o.id === "model");
        if (model && model.currentValue !== modelId) {
          if (model.options && !model.options.some((o) => o.value === modelId)) throw new FxError(`fx can't use ${modelId} with its current sign-in. Pick another model.`);
          await setOption(l, sessionId, "model", modelId);
        }
        const effort = l.options.find((o) => o.id === "effort" || o.category === "thought_level");
        if (effort?.options) {
          const level = nearestOption(effort.options.map((o) => o.value), req.effort);
          if (level && level !== effort.currentValue) await setOption(l, sessionId, effort.id, level).catch(() => {});
        }

        // Everything fx reports from here on belongs to this turn.
        const usage: Usage = {};
        let lastText = false;
        let wroteText = false;
        let messageId: string | undefined;
        const tools = new Map<string, { name: string; args: Record<string, unknown>; output: string; at: number; started: number; shell: boolean }>();
        off = proc.on((m: AcpMessage) => {
          if (m.method === "$/exit") return;
          if (m.method !== "session/update" || m.params?.sessionId !== sessionId) return;
          const u = m.params.update ?? {};
          switch (u.sessionUpdate) {
            case "agent_message_chunk": {
              const text = u.content?.type === "text" ? String(u.content.text ?? "") : "";
              if (!text) break;
              // A new message after some tools reads as a new paragraph.
              if (u.messageId && messageId && u.messageId !== messageId && wroteText && lastText) send({ t: "text", v: "\n\n" });
              else if (wroteText && !lastText) send({ t: "text", v: "\n\n" });
              messageId = u.messageId ?? messageId;
              send({ t: "text", v: text });
              lastText = wroteText = true;
              break;
            }
            case "agent_thought_chunk": {
              const text = u.content?.type === "text" ? String(u.content.text ?? "") : "";
              if (!text) break;
              send({ t: "reasoning", v: text });
              break;
            }
            case "tool_call": {
              lastText = false;
              const mapped = mapTool(u.name, u.kind, u.rawInput ?? {});
              const t = { ...mapped, output: "", at: 0, started: Date.now(), shell: mapped.name === "bash" };
              tools.set(u.toolCallId, t);
              const patch = t.name === "edit" ? editPatch(t.args) : undefined;
              send({ t: "tool", id: u.toolCallId, name: t.name, args: t.args, status: u.status === "failed" ? "error" : u.status === "completed" ? "done" : "running", ...(patch ? { patch: clip(patch, PATCH_MAX) } : {}) });
              break;
            }
            case "tool_call_update": {
              let t = tools.get(u.toolCallId);
              if (!t) {
                const mapped = mapTool(u.name, u.kind, u.rawInput ?? {});
                t = { ...mapped, output: "", at: 0, started: Date.now(), shell: mapped.name === "bash" };
                tools.set(u.toolCallId, t);
              } else if (u.rawInput) {
                const mapped = mapTool(u.name ?? undefined, u.kind, u.rawInput);
                if (mapped.name === t.name) t.args = mapped.args;
              }
              const { text, patch: diffPatch } = contentOf(u.content, req.cwd);
              if (u.status === "completed" || u.status === "failed") {
                let output: string;
                if (t.shell) {
                  const note = shellSummary(text, u.command_result);
                  output = [t.output.replace(/\n$/, ""), note && `[${note}]`].filter(Boolean).join("\n");
                } else output = text;
                const patch = diffPatch ?? (t.name === "edit" && u.status === "completed" ? editPatch(t.args) : undefined);
                send({
                  t: "tool",
                  id: u.toolCallId,
                  name: t.name,
                  args: t.args,
                  status: u.status === "failed" ? "error" : "done",
                  output: clip(output, OUTPUT_MAX),
                  patch: patch ? clip(patch, PATCH_MAX) : undefined,
                  ms: typeof u.command_result?.duration_ms === "number" ? u.command_result.duration_ms : Date.now() - t.started,
                });
                tools.delete(u.toolCallId);
              } else if (text) {
                // Live output (a long build or test run): fx streams shell output as it comes.
                t.output = t.shell ? t.output + text : text;
                if (Date.now() - t.at < 500) break;
                t.at = Date.now();
                send({ t: "tool", id: u.toolCallId, name: t.name, status: "running", output: clip(t.output, OUTPUT_MAX) });
              }
              break;
            }
            case "plan": {
              const entries = Array.isArray(u.entries) ? u.entries : [];
              if (entries.length) {
                const lines = entries.map((e: any) => `${e.status === "completed" ? "[x]" : e.status === "in_progress" ? "[~]" : "[ ]"} ${e.content}`);
                send({ t: "tool", id: `fx-plan-${req.stream?.id ?? ""}`, name: "todo", args: { title: "Plan" }, status: "done", output: lines.join("\n") });
              }
              break;
            }
            case "usage_update": {
              if (typeof u.used === "number") usage.contextTokens = u.used;
              if (typeof u.size === "number") usage.contextWindow = u.size;
              if (typeof u.cost?.amount === "number") usage.cost = u.cost.amount;
              send({ t: "usage", usage: { ...usage } });
              break;
            }
          }
        });
        let exited: string | undefined;
        const offExit = proc.on((m) => {
          if (m.method === "$/exit") exited = m.params?.message;
        });
        const prevOff = off;
        off = () => {
          prevOff();
          offExit();
        };
        onAbort = () => proc.notify("session/cancel", { sessionId });
        signal.addEventListener("abort", onAbort, { once: true });

        const prompt: unknown[] = [];
        for (const image of req.images ?? []) prompt.push({ type: "image", mimeType: image.mimeType, data: image.data });
        prompt.push({ type: "text", text: req.message });
        save(req.threadId, { id: sessionId, cwd: req.cwd, turns: Math.max(req.prior, s?.turns ?? 0) + 1 });
        const result = await proc.request<{ stopReason?: string; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }>(
          "session/prompt",
          { sessionId, prompt },
          0,
        );
        // Give trailing notifications (usage) a moment to arrive.
        await new Promise((r) => setTimeout(r, 50));
        const u = result?.usage;
        if (u) {
          const cacheRead = u.cacheReadTokens ?? 0;
          const cacheWrite = u.cacheWriteTokens ?? 0;
          usage.input = Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite);
          usage.output = u.outputTokens ?? 0;
          usage.cacheRead = cacheRead;
          usage.cacheWrite = cacheWrite;
        }
        if (exited) throw new FxError(exited);
        const stop = result?.stopReason;
        const finishReason = signal.aborted || stop === "cancelled" ? "aborted" : stop === "max_tokens" ? "length" : stop === "refusal" ? "refusal" : "stop";
        if (stop === "refusal" && !wroteText) send({ t: "error", message: "The model refused to answer." });
        else send({ t: "done", finish: finishReason, usage });
      } catch (err) {
        if (!signal.aborted) send({ t: "error", message: (err as Error).message });
        else send({ t: "done", finish: "aborted" });
      }
      finish();
    },
  });
}

/** Where fx keeps a thread's session, for display. */
export const sessionDir = () => join(process.env.HOME ?? "", ".fx", "sessions");
