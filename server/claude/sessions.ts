// Native Claude Code threads: the installed `claude` CLI, driven through the Agent SDK in streaming
// input mode. One warm process per thread, hosted in the detached agent worker (never the HTTP
// server), so OpenBuild restarts only detach watchers. Claude Code keeps the conversation in its own
// transcript (~/.claude/projects); OpenBuild saves the session id and sends only each new message.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CanUseTool, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PiChatRequest, StreamEvent, Usage } from "../../shared/types";
import * as storage from "../storage";
import { claudeArgs, claudeEnv, FAST, baseOptions, isClaudePermission, listPermissions, modelRow, type ClaudePermission } from "./install";
import { doneEvent, startEvent, type ToolEvent } from "./tools";

interface Saved {
  /** Claude Code's session id (a UUID, the transcript's file name). */
  id: string;
  cwd: string;
  /** OpenBuild user messages Claude has been given (reserved before each submission). */
  turns: number;
  /** anchors[k]: the last top-level assistant message after turn k, where a rewind to k+1 resumes. */
  anchors: (string | null)[];
}
const key = (id: string) => `claude-session:${id}`;
function saved(id: string): Saved | undefined {
  const raw = storage.getValue(key(id));
  if (!raw) return;
  const s = JSON.parse(raw);
  if (!s || !/^[0-9a-f-]{36}$/i.test(s.id) || !Number.isInteger(s.turns) || s.turns < 0 || typeof s.cwd !== "string") throw new Error("Invalid saved Claude Code mapping; refusing to replace its history");
  return { ...s, anchors: Array.isArray(s.anchors) ? s.anchors : [] };
}
function save(id: string, s: Saved) { storage.setValue(key(id), JSON.stringify(s)); }

type Ask = Extract<StreamEvent, { t: "ask" }>;
type Reply = { value?: string; confirmed?: boolean; cancelled?: boolean };

/** Messages for the CLI's stdin: pushed per turn, open for the process's whole life. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  push(m: SDKUserMessage) { this.items.push(m); this.wake?.(); }
  close() { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      const next = this.items.shift();
      if (next) { yield next; continue; }
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}

interface Turn {
  steers: Map<string, { id: string; text: string }>;
  settled: boolean;
  awaiting: Set<string>;
  emit: (e: StreamEvent) => void;
  onMessage: (m: SDKMessage) => void;
  fail: (e: Error) => void;
}
interface Live {
  q: Query;
  inbox: Inbox;
  cwd: string;
  /** Options only a new process can change (thinking off, the bypass opt-in). */
  startKey: string;
  sessionId: string;
  busy: boolean;
  exited: boolean;
  lastUsed: number;
  stderr: string;
  asks: Map<string, { ask: Ask; reply: (r: Reply) => void }>;
  turn?: Turn;
  /** The permission mode the process is in (Claude can leave plan mode itself). */
  mode?: string;
}
const hot = globalThis as typeof globalThis & { openbuildClaudeLive?: Map<string, Live>; openbuildClaudeReaper?: ReturnType<typeof setInterval> };
const live = hot.openbuildClaudeLive ??= new Map<string, Live>();
if (hot.openbuildClaudeReaper) clearInterval(hot.openbuildClaudeReaper);
hot.openbuildClaudeReaper = setInterval(() => {
  for (const [id, l] of live) if (l.exited || (!l.busy && Date.now() - l.lastUsed > 20 * 60_000)) release(id);
}, 60_000);
hot.openbuildClaudeReaper.unref();

export const isSessionLive = (id: string) => !!live.get(id) && !live.get(id)!.exited;
export const hasAsk = (id: string, askId: string) => !!live.get(id)?.asks.has(askId);
export function answer(id: string, askId: string, reply: Reply): boolean {
  const l = live.get(id), p = l?.asks.get(askId);
  if (!l || !p) return false;
  l.asks.delete(askId); p.reply(reply);
  l.turn?.emit({ t: "asked", id: askId, answer: reply.cancelled ? undefined : reply.value ?? (reply.confirmed ? "Allow once" : undefined) });
  return true;
}
/** Submit native streaming input while the current reply is active. */
export const canSteer = (id: string) => !!live.get(id)?.turn && !live.get(id)!.turn!.settled;
export async function steer(id: string, steerId: string, message: string, images?: PiChatRequest["images"]): Promise<{ handled: boolean }> {
  const l = live.get(id);
  if (!l?.turn || l.turn.settled || l.exited) throw new Error("Claude Code isn't working on this thread");
  const input = userMessage({ message, images }, l.sessionId);
  l.turn.awaiting.add(input.uuid!);
  l.turn.steers.set(input.uuid!, { id: steerId, text: message });
  l.inbox.push(input);
  return { handled: false };
}
export function release(id: string) {
  const l = live.get(id);
  if (!l) return;
  for (const askId of [...l.asks.keys()]) answer(id, askId, { cancelled: true });
  live.delete(id);
  l.exited = true; l.inbox.close();
  try { l.q.close(); } catch {}
}
export function restartIdle() { for (const [id, l] of live) if (!l.busy) release(id); }

function ask(l: Live, a: Omit<Ask, "t" | "id">, signal: AbortSignal): Promise<Reply> {
  if (signal.aborted) return Promise.resolve({ cancelled: true });
  return new Promise((done) => {
    const id = `claude-ask-${crypto.randomUUID()}`;
    const event: Ask = { t: "ask", id, ...a };
    const finish = (r: Reply) => { signal.removeEventListener("abort", abort); done(r); };
    const abort = () => { if (l.asks.delete(id)) { l.turn?.emit({ t: "asked", id }); finish({ cancelled: true }); } };
    l.asks.set(id, { ask: event, reply: finish });
    signal.addEventListener("abort", abort, { once: true });
    if (l.turn) l.turn.emit(event);
    else abort();
  });
}

/** Claude Code keeps each session as ~/.claude/projects/<folder>/<id>.jsonl. */
export function transcriptExists(id: string): boolean {
  const root = join(claudeEnv().CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  try { return readdirSync(root).some((d) => existsSync(join(root, d, `${id}.jsonl`))); } catch { return false; }
}

// Keep Claude's native prompt/tools. This is UI guidance, not a replacement system prompt.
const QUESTION_INSTRUCTIONS = "When you need a decision, clarification, or missing information from the user to proceed, use the native AskUserQuestion tool instead of asking in prose. Offer concrete choices when useful; the user can also enter a custom answer. Wait for the tool response before continuing. Never invent the user's answer. If the user dismisses a question, do not assume an answer or immediately ask it again.";

const summary = (tool: string, input: any) => typeof input?.command === "string" ? input.command : input?.file_path ?? input?.notebook_path ?? input?.url ?? input?.pattern ?? input?.query ?? (tool.startsWith("mcp__") ? JSON.stringify(input).slice(0, 2000) : undefined);

/** Claude asks before a tool its permission mode and rules don't allow: the user decides here. */
function permissions(threadId: string): CanUseTool {
  return async (tool, input, options) => {
    const l = live.get(threadId);
    if (!l?.turn) return { behavior: "deny", message: "OpenBuild has no reply waiting on this thread", toolUseID: options.toolUseID };
    // AskUserQuestion is a native interaction exception: unlike ordinary tools it reaches
    // canUseTool even in bypassPermissions. Do not enable allow-all rules or fake a tool.
    if (tool === "AskUserQuestion") {
      const questions = Array.isArray((input as any).questions) ? (input as any).questions : [];
      if (!questions.length || questions.some((q: any) => typeof q?.question !== "string" || !Array.isArray(q.options) || q.options.some((o: any) => typeof o?.label !== "string"))) return { behavior: "deny", message: "Invalid AskUserQuestion input; no answer was collected.", toolUseID: options.toolUseID };
      const answers: Record<string, string> = {};
      for (const q of questions) {
        const r = await ask(l, { method: "select", title: q.header ? `${q.header}: ${q.question}` : q.question, message: q.multiSelect ? "Pick one, or type several separated by commas." : undefined, options: (q.options ?? []).map((o: any) => o.label), other: true }, options.signal);
        if (r.cancelled || options.signal.aborted) return { behavior: "deny", message: "The user dismissed the question. Do not assume an answer.", toolUseID: options.toolUseID };
        answers[q.question] = r.value ?? "";
      }
      return { behavior: "allow", updatedInput: { ...input, answers }, toolUseID: options.toolUseID };
    }
    if (tool === "ExitPlanMode") {
      const r = await ask(l, { method: "select", title: "Claude's plan is ready. Start working on it?", options: ["Yes, and accept edits", "Yes, ask before edits", "No, keep planning"] }, options.signal);
      if (r.cancelled || r.value === "No, keep planning" || !r.value) return { behavior: "deny", message: "The user wants to keep planning. Stay in plan mode and wait for their feedback.", toolUseID: options.toolUseID };
      const mode = r.value === "Yes, and accept edits" ? "acceptEdits" : "default";
      l.mode = mode;
      return { behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "setMode", mode, destination: "session" }], toolUseID: options.toolUseID };
    }
    const session = options.suggestions?.length ? ["Allow for this session"] : [];
    const r = await ask(l, {
      method: "select",
      title: options.title ?? `Allow Claude to use ${options.displayName ?? tool}?`,
      message: [options.description ?? options.decisionReason, summary(tool, input), options.blockedPath && `Path: ${options.blockedPath}`].filter(Boolean).join("\n") || undefined,
      options: ["Allow once", ...(options.suppressAlwaysAllowRule ? [] : session), "Deny"],
    }, options.signal);
    if (!r.cancelled && (r.confirmed || r.value === "Allow once")) return { behavior: "allow", updatedInput: input, toolUseID: options.toolUseID };
    // "For this session" only: never write the user's settings files from OpenBuild.
    if (!r.cancelled && r.value === "Allow for this session") return { behavior: "allow", updatedInput: input, updatedPermissions: options.suggestions!.map((s) => ({ ...s, destination: "session" as const })), toolUseID: options.toolUseID };
    return { behavior: "deny", message: r.cancelled ? "The user cancelled this tool call." : "The user denied this tool call.", interrupt: !!r.cancelled, toolUseID: options.toolUseID };
  };
}

async function open(req: PiChatRequest, s: Saved, start: { thinkingOff: boolean; bypass: boolean; row: any; resumeAt?: string; forkTo?: string }): Promise<Live> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const inbox = new Inbox();
  const cwd = resolve(req.cwd);
  const identity = start.forkTo
    ? { resume: s.id, forkSession: true, sessionId: start.forkTo, ...(start.resumeAt ? { resumeSessionAt: start.resumeAt } : {}) }
    : s.turns > 0 ? { resume: s.id } : { sessionId: s.id };
  const l: Live = { q: undefined as unknown as Query, inbox, cwd, startKey: JSON.stringify([start.thinkingOff, start.bypass]), sessionId: start.forkTo ?? s.id, busy: false, exited: false, lastUsed: Date.now(), stderr: "", asks: new Map() };
  l.q = query({
    prompt: inbox,
    options: {
      ...baseOptions(cwd),
      ...identity,
      model: start.row.value,
      systemPrompt: { type: "preset", preset: "claude_code", append: QUESTION_INSTRUCTIONS },
      includePartialMessages: true,
      extraArgs: { ...claudeArgs(), "replay-user-messages": null },
      canUseTool: permissions(req.threadId),
      ...(start.bypass ? { allowDangerouslySkipPermissions: true } : {}),
      ...(start.thinkingOff ? { thinking: { type: "disabled" as const } } : start.row.supportsAdaptiveThinking ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
      stderr: (chunk: string) => { l.stderr = (l.stderr + chunk).slice(-8000); },
    },
  });
  live.set(req.threadId, l);
  // One reader for the process's life; each message goes to the turn it belongs to.
  void (async () => {
    try {
      for await (const m of l.q) l.turn?.onMessage(m);
      l.turn?.fail(new Error(`Claude Code exited${l.stderr.trim() ? `: ${l.stderr.trim().slice(-2000)}` : ""}`));
    } catch (e) {
      l.turn?.fail(new Error(`${e instanceof Error ? e.message : String(e)}${l.stderr.trim() ? `\n${l.stderr.trim().slice(-2000)}` : ""}`));
    } finally {
      l.exited = true;
      if (live.get(req.threadId) === l) live.delete(req.threadId);
    }
  })();
  return l;
}

const userMessage = (req: Pick<PiChatRequest, "message" | "images">, sessionId: string): SDKUserMessage => ({
  type: "user",
  session_id: sessionId,
  parent_tool_use_id: null,
  uuid: crypto.randomUUID() as SDKUserMessage["uuid"],
  message: {
    role: "user",
    content: [
      ...(req.images ?? []).map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mimeType as "image/png", data: i.data } })),
      { type: "text" as const, text: req.message },
    ],
  },
});

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Claude Code didn't answer ${what} in time`)), ms).unref?.())]);

export function runTurn(req: PiChatRequest, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cancel: (() => void) | undefined;
  return new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (e: StreamEvent) => { if (!closed) { try { controller.enqueue(encoder.encode(JSON.stringify(e) + "\n")); } catch { closed = true; cancel?.(); } } };
      void (async () => {
        let l: Live | undefined, owned = false, onAbort: (() => void) | undefined;
        try {
          if (signal.aborted) { send({ t: "done", finish: "aborted" }); return; }
          if (req.forkFrom) throw new Error("Claude Code threads can't be forked through OpenBuild; start a new thread");
          if (req.speed !== undefined && req.speed !== FAST) throw new Error(`Claude Code has no speed ${req.speed}`);
          if (req.permission !== undefined && !isClaudePermission(req.permission)) throw new Error(`Claude Code has no permission mode ${req.permission}`);
          const cwd = resolve(req.cwd);
          let s = saved(req.threadId);
          if (s && s.cwd !== cwd) throw new Error("Claude Code thread workspace mismatch; cannot resume in another directory");
          if (!Number.isInteger(req.prior) || req.prior < 0 || req.prior > (s?.turns ?? 0)) throw new Error("Claude Code history mismatch: this thread's saved session is missing or behind; old messages will not be resent");
          const row = await modelRow(req.model);
          const thinkingOff = req.effort === "off" && !!row.supportsThinkingOff;
          if (req.effort !== "off" && row.supportsEffort && !(row.supportedEffortLevels ?? []).includes(req.effort)) throw new Error(`Claude Code model ${row.value} doesn't support effort ${req.effort}`);
          if (req.speed === FAST && !row.supportsFastMode) throw new Error(`Claude Code's fast mode isn't available for ${row.displayName ?? row.value}`);
          const configured = (await listPermissions(cwd)).defaultMode as ClaudePermission;
          const mode = (req.permission as ClaudePermission | undefined) ?? configured;
          const startKey = JSON.stringify([thinkingOff, mode === "bypassPermissions"]);

          l = live.get(req.threadId);
          if (l?.busy) throw new Error("Claude Code is still working on this thread");
          // Retrying or editing an earlier message: Claude forks its transcript at that point, so
          // nothing after it is replayed or kept in the new branch. The old transcript is untouched.
          let fork: { forkTo: string; resumeAt?: string } | undefined;
          if (s && req.prior < s.turns) {
            const anchor = req.prior > 0 ? s.anchors[req.prior - 1] : undefined;
            if (req.prior > 0 && !anchor) throw new Error("Claude Code can't rewind to that message (its place in the saved session is unknown); start a new thread instead");
            if (l) release(req.threadId), l = undefined;
            if (req.prior === 0) s = { id: crypto.randomUUID(), cwd, turns: 0, anchors: [] };
            else fork = { forkTo: crypto.randomUUID(), resumeAt: anchor! };
          }
          if (l && (l.exited || l.startKey !== startKey || l.cwd !== cwd)) { release(req.threadId); l = undefined; }
          if (!s) { s = { id: crypto.randomUUID(), cwd, turns: 0, anchors: [] }; save(req.threadId, s); }
          if (!l) {
            if (s.turns > 0 && !fork) {
              if (!transcriptExists(s.id)) throw new Error("Claude Code's saved session for this thread is missing (was ~/.claude/projects cleared?). Start a new thread; old messages will not be resent.");
            }
            l = await open(req, s, { thinkingOff, bypass: mode === "bypassPermissions", row, ...fork });
            if (fork) s = { id: fork.forkTo, cwd, turns: req.prior, anchors: s.anchors.slice(0, req.prior) };
          }
          l.busy = owned = true;
          const proc = l;
          if (signal.aborted) { send({ t: "done", finish: "aborted" }); return; }

          // Per-turn settings on the warm process: model, effort, fast mode and permission mode.
          await withTimeout(proc.q.setModel(row.value), 30_000, "the model change");
          await withTimeout(proc.q.applyFlagSettings({ effortLevel: row.supportsEffort && req.effort !== "off" ? req.effort as never : null, fastMode: req.speed === FAST ? true : null }), 30_000, "the settings change");
          if (proc.mode !== mode) { await withTimeout(proc.q.setPermissionMode(mode), 30_000, "the permission change"); proc.mode = mode; }
          if (signal.aborted) { send({ t: "done", finish: "aborted" }); return; }

          const usage: Usage = {};
          const tools = new Map<string, { start: ToolEvent; native: string; at: number }>();
          const streamed = new Set<string>();
          let anchor: string | null = s.anchors[req.prior - 1] ?? null;
          let lastText: "text" | "tool" | undefined, hadText = false;
          let currentMessage: string | undefined;
          let aborted = false;
          let finish!: (r: any) => void, fail!: (e: Error) => void;
          const completion = new Promise<any>((res, rej) => { finish = res; fail = rej; });
          completion.catch(() => {});
          const text = (v: string) => {
            if (!v) return;
            if (lastText === "tool" && hadText) send({ t: "text", v: "\n\n" });
            lastText = "text"; hadText = true; send({ t: "text", v });
          };
          const contextOf = (u: any) => u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0) : undefined;
          proc.turn = {
            steers: new Map(),
            awaiting: new Set(),
            settled: false,
            emit: send,
            fail: (e) => fail(e),
            onMessage: (m: any) => {
              const sub = m.parent_tool_use_id ?? null;
              if (!sub && m.type === "user" && proc.turn?.steers.has(m.uuid)) {
                const item = proc.turn.steers.get(m.uuid)!;
                proc.turn.steers.delete(m.uuid);
                const state = saved(req.threadId)!;
                save(req.threadId, { ...state, turns: state.turns + 1, anchors: [...state.anchors, anchor] });
                send({ t: "steer", id: item.id, text: item.text });
              }
              if (m.type === "system" && m.subtype === "init" && m.session_id && m.session_id !== s!.id) {
                // A fork gets its own id: from here on the thread follows the new transcript.
                s = { ...s!, id: m.session_id }; save(req.threadId, s); proc.sessionId = m.session_id;
              } else if (m.type === "stream_event" && !sub) {
                const e = m.event;
                if (e.type === "message_start") currentMessage = e.message?.id;
                else if (e.type === "content_block_start" && e.content_block?.type === "text" && lastText === "text") send({ t: "text", v: "\n\n" }), lastText = undefined;
                else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") { if (currentMessage) streamed.add(currentMessage); text(e.delta.text); }
                else if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta") send({ t: "reasoning", v: e.delta.thinking });
              } else if (m.type === "assistant") {
                const msg = m.message ?? {};
                if (!sub) { anchor = m.uuid; const c = contextOf(msg.usage); if (c) usage.contextTokens = c; }
                for (const b of msg.content ?? []) {
                  if (b.type === "text" && !sub && !streamed.has(msg.id)) text(b.text);
                  else if (b.type === "tool_use" && b.name !== "AskUserQuestion") {
                    const start = startEvent(b.id, b.name, b.input, sub ? { parentToolUseId: sub } : undefined);
                    tools.set(b.id, { start, native: b.name, at: Date.now() });
                    lastText = "tool"; send(start);
                  }
                }
              } else if (m.type === "user") {
                const content = Array.isArray(m.message?.content) ? m.message.content : [];
                for (const b of content) {
                  if (b?.type !== "tool_result") continue;
                  const t = tools.get(b.tool_use_id);
                  if (!t) continue;
                  tools.delete(b.tool_use_id);
                  send(doneEvent(t.start, t.native, b, m.tool_use_result, Date.now() - t.at));
                }
              } else if (m.type === "result") {
                const u = m.usage ?? {};
                usage.cacheRead = u.cache_read_input_tokens ?? 0;
                usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
                usage.input = u.input_tokens ?? 0;
                usage.output = u.output_tokens ?? 0;
                const windows = Object.values(m.modelUsage ?? {}).map((x: any) => x?.contextWindow).filter((x) => typeof x === "number");
                if (windows.length) usage.contextWindow = Math.max(...(windows as number[]));
                send({ t: "usage", usage: { ...usage } });
                if (req.speed === FAST && m.fast_mode_state && m.fast_mode_state !== "on") send({ t: "notice", message: m.fast_mode_state === "cooldown" ? "Fast mode is cooling down after a rate limit; this reply used standard speed." : `Fast mode wasn't used${m.fast_mode_disabled_reason ? ` (${m.fast_mode_disabled_reason.replace(/_/g, " ")})` : ""}.` });
                // An input arriving at the end may start another native turn. Keep this
                // reply attached until Claude acknowledges all submitted inputs.
                const answered: string[] = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []);
                for (const uuid of answered) proc.turn!.awaiting.delete(uuid);
                if (aborted || m.is_error || (!proc.turn!.steers.size && (!answered.length || !proc.turn!.awaiting.size))) { proc.turn!.settled = true; finish(m); }
              }
            },
          };

          onAbort = () => {
            if (aborted) return; aborted = true;
            proc.turn!.settled = true;
            for (const id of [...proc.asks.keys()]) answer(req.threadId, id, { cancelled: true });
            void withTimeout(proc.q.interrupt(), 10_000, "the stop").catch(() => release(req.threadId));
            // Never leave a turn hanging if the CLI ignores the interrupt.
            const timer = setTimeout(() => { release(req.threadId); fail(new Error("Claude Code did not stop after interrupt")); }, 15_000); timer.unref?.();
            completion.finally(() => clearTimeout(timer)).catch(() => {});
          };
          cancel = onAbort;
          signal.addEventListener("abort", onAbort, { once: true });

          // Reserve before submission: an ambiguous failure must never cause an automatic resend.
          save(req.threadId, { ...s, turns: req.prior + 1, anchors: [...s.anchors.slice(0, req.prior), anchor] });
          proc.inbox.push(userMessage(req, proc.sessionId));
          let result: any;
          try { result = await completion; }
          finally {
            // Wherever the turn got to, a later rewind to the next message resumes from there.
            const cur = saved(req.threadId);
            if (cur) save(req.threadId, { ...cur, anchors: [...cur.anchors.slice(0, req.prior), ...Array(cur.turns - req.prior).fill(anchor)] });
          }
          for (const [id, t] of tools) send({ ...t.start, status: aborted ? "error" : "done", output: aborted ? "Stopped" : t.start.output }), tools.delete(id);
          if (aborted || signal.aborted) { release(req.threadId); send({ t: "done", finish: "aborted", usage }); return; }
          if (result.subtype !== "success" || result.is_error) throw new Error((result.errors?.length ? result.errors.join("\n") : result.result) || `Claude Code turn failed (${result.subtype})`);
          send({ t: "done", finish: "stop", usage });
        } catch (e) {
          if (signal.aborted) send({ t: "done", finish: "aborted" });
          else send({ t: "error", message: e instanceof Error ? e.message : String(e) });
          if (owned && l && !l.exited && !signal.aborted) release(req.threadId);
        } finally {
          if (onAbort) signal.removeEventListener("abort", onAbort);
          if (owned && l) { for (const id of [...l.asks.keys()]) answer(req.threadId, id, { cancelled: true }); l.busy = false; l.turn = undefined; l.lastUsed = Date.now(); }
          send({ t: "end" }); if (!closed) { closed = true; controller.close(); }
        }
      })();
    },
    cancel() { cancel?.(); },
  });
}
