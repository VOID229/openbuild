// Threads run on Grok Build through its Agent Client Protocol server (`grok agent stdio`). Each
// thread has its own Grok session (saved by Grok under ~/.grok/sessions, so `grok -r <id>` in a
// terminal opens it too) and, while it's in use, its own process in the thread's workspace. Grok owns
// the conversation: a turn sends only the new message.
//
// This runs inside OpenBuild's detached agent worker (server/pi/worker.ts), like Pi turns, so a
// server restart doesn't interrupt a turn and the restarted server reattaches to its events.
import { join } from "node:path";
import type { PiChatRequest, StreamEvent, Usage } from "../../shared/types";
import { clip } from "../acpContent";
import { AcpProcess, type AcpMessage } from "../fx/acp";
import * as storage from "../storage";
import { grokEnv, grokProgram } from "./install";
import { describeCall, isHidden, mapUpdate, planLines, resultOf, toolName } from "./tools";

/** Close a thread's Grok process after this long without use (its session stays on disk). */
const IDLE = 20 * 60 * 1000;
const OUTPUT_MAX = 12_000;
const PATCH_MAX = 60_000;
export const QUESTION_NOTE = "When you need a decision or clarification from the user, use the ask_user_question tool instead of asking in prose. Wait for the real answer; never invent it.";
/** How Grok names the turn it starts for an interjection that arrives once it's idle. */
const FALLBACK_TURN = "interject-fallback-";

type Ask = Extract<StreamEvent, { t: "ask" }>;
type Reply = { value?: string; confirmed?: boolean; cancelled?: boolean };
interface ConfigOption { id: string; category?: string; currentValue?: string; options?: { value: string }[] }
interface Steer { id: string; text: string; delivered: boolean; sent?: Promise<unknown> }
interface Live {
  threadId: string;
  proc: AcpProcess;
  ready: Promise<string>;
  busy: boolean;
  idle: Promise<void>;
  /** Config options Grok reported for the session (model, effort). */
  options: ConfigOption[];
  /** Context window by model id, from the session's model list. */
  windows: Map<string, number>;
  asks: Map<string, { ask: Ask; reply: (r: Reply) => void }>;
  steering?: { accepting: boolean; sessionId: string; items: Map<string, Steer> };
  emit?: (e: StreamEvent) => void;
}

const hot = globalThis as { openbuildGrokLive?: Map<string, Live>; openbuildGrokReaper?: ReturnType<typeof setInterval> };
const live: Map<string, Live> = (hot.openbuildGrokLive ??= new Map());
if (hot.openbuildGrokReaper) clearInterval(hot.openbuildGrokReaper);
hot.openbuildGrokReaper = setInterval(() => {
  for (const [id, l] of live) if (l.proc.exited || (!l.busy && Date.now() - l.proc.lastUsed > IDLE)) release(id);
}, 60_000);
hot.openbuildGrokReaper.unref();

/** The Grok session a thread uses, and how many of its user messages Grok has been sent. */
interface Saved { id: string; cwd: string; turns: number }
const savedKey = (threadId: string) => `grok-session:${threadId}`;
function saved(threadId: string): Saved | undefined {
  const raw = storage.getValue(savedKey(threadId));
  if (!raw) return;
  const s = JSON.parse(raw);
  if (!s?.id || typeof s.turns !== "number" || !s.cwd) throw new Error("Invalid saved Grok mapping; refusing to replace its history");
  return s;
}
const save = (threadId: string, s: Saved) => storage.setValue(savedKey(threadId), JSON.stringify(s));

export const isSessionLive = (id: string) => !!live.get(id) && !live.get(id)!.proc.exited;
export const hasAsk = (id: string, askId: string) => !!live.get(id)?.asks.has(askId);
export const canSteer = (id: string) => !!live.get(id)?.steering?.accepting;

/**
 * Hand Grok a message while it works on a turn (`_x.ai/interject`); it reads it at its next safe gap.
 * Grok announces it with `_x.ai/session/interjection`, which the turn reports as a `steer` event.
 */
export async function steer(id: string, steerId: string, message: string, images?: PiChatRequest["images"]): Promise<{ handled: boolean }> {
  const l = live.get(id), turn = l?.steering;
  if (!l || !turn?.accepting || l.proc.exited) throw new Error("Grok isn't working on this thread");
  if (!message.trim()) throw new Error("Grok steering requires nonempty text");
  const old = turn.items.get(steerId);
  if (old) {
    if (old.text !== message) throw new Error("Steering ID was reused with different input");
    return { handled: false };
  }
  const item: Steer = { id: steerId, text: message, delivered: false };
  turn.items.set(steerId, item);
  const sent = l.proc.request("_x.ai/interject", {
    sessionId: turn.sessionId,
    text: message,
    interjectionId: steerId,
    ...(images?.length ? { content: images.map((i) => ({ type: "image", mimeType: i.mimeType, data: i.data })) } : {}),
  }, 30_000);
  item.sent = sent.catch(() => {});
  try {
    await sent;
  } catch (e) {
    turn.items.delete(steerId);
    throw new Error(`Grok couldn't take the message: ${(e as Error).message}`);
  }
  return { handled: false };
}

function consumed(l: Live, item: Steer) {
  if (item.delivered) return;
  item.delivered = true;
  const state = saved(l.threadId);
  if (state) save(l.threadId, { ...state, turns: state.turns + 1 });
  l.emit?.({ t: "steer", id: item.id, text: item.text });
}

export function answer(id: string, askId: string, reply: Reply): boolean {
  const l = live.get(id), p = l?.asks.get(askId);
  if (!l || !p) return false;
  l.asks.delete(askId);
  p.reply(reply);
  return true;
}

function question(l: Live, ask: Omit<Ask, "t" | "id">, reply: (r: Reply) => string | undefined) {
  const id = `grok-ask-${crypto.randomUUID()}`;
  const event: Ask = { t: "ask", id, ...ask };
  l.asks.set(id, { ask: event, reply: (r) => { const shown = reply(r); l.emit?.({ t: "asked", id, answer: r.cancelled ? undefined : shown }); } });
  l.emit?.(event);
}

function cancelAsks(l: Live) {
  for (const id of [...l.asks.keys()]) answer(l.threadId, id, { cancelled: true });
}

/** Grok asks before an action its permission mode doesn't allow on its own. */
function askPermission(l: Live, m: AcpMessage) {
  const requestId = m.id!, options: { optionId: string; name: string; kind?: string }[] = Array.isArray(m.params?.options) ? m.params.options : [];
  if (!options.length || !l.emit) return l.proc.respond(requestId, { outcome: { outcome: "cancelled" } });
  question(l, { method: "select", title: `Allow Grok to ${describeCall(m.params?.toolCall)}?`, options: options.map((o) => o.name) }, (r) => {
    const option = r.cancelled ? undefined : options.find((o) => o.name === r.value) ?? (r.confirmed ? options.find((o) => o.kind === "allow_once") : undefined);
    if (!l.proc.exited) l.proc.respond(requestId, option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } });
    return option?.name;
  });
}

/** Grok's ask_user_question: answers are keyed by question text, and dismissing one declines them all. */
async function askQuestions(l: Live, m: AcpMessage) {
  const requestId = m.id!, answers: Record<string, string> = {};
  const declined = () => { if (!l.proc.exited) l.proc.respond(requestId, { outcome: "cancelled" }); };
  if (!l.emit) return declined();
  for (const q of Array.isArray(m.params?.questions) ? m.params.questions : []) {
    const labels: string[] | undefined = q?.options?.length ? q.options.map((o: any) => String(o?.label)) : undefined;
    const reply = await new Promise<Reply>((resolve) => question(l, { method: labels ? "select" : "input", title: String(q?.question ?? "Grok has a question"), options: labels, other: true }, (r) => { resolve(r); return r.value; }));
    if (reply.cancelled) return declined();
    answers[String(q?.question)] = reply.value ?? "";
  }
  if (!l.proc.exited) l.proc.respond(requestId, { outcome: "accepted", answers });
}

function remember(l: Live, r: { configOptions?: ConfigOption[]; models?: { availableModels?: any[] } }) {
  l.options = r.configOptions ?? [];
  for (const m of r.models?.availableModels ?? []) if (typeof m?._meta?.totalContextTokens === "number") l.windows.set(m.modelId, m._meta.totalContextTokens);
}

function ensure(threadId: string, cwd: string): Live {
  const existing = live.get(threadId);
  if (existing && !existing.proc.exited && existing.proc.cwd === cwd) return existing;
  if (existing) {
    if (existing.busy) throw new Error("This thread is still working in another directory");
    release(threadId);
  }
  const proc = new AcpProcess(cwd, grokProgram());
  const l: Live = { threadId, proc, busy: false, idle: Promise.resolve(), options: [], windows: new Map(), asks: new Map(), ready: Promise.resolve("") };
  proc.on((m) => {
    if (m.id === undefined || !m.method) return;
    if (m.method === "session/request_permission") askPermission(l, m);
    else if (m.method === "_x.ai/ask_user_question") void askQuestions(l, m);
    // Never run delegated client tools or authorize a request this client doesn't know.
    else proc.respondError(m.id, -32601, "Method not supported by OpenBuild");
  });
  l.ready = (async () => {
    await proc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 30_000);
    const s = saved(threadId);
    if (s && s.cwd === cwd) {
      // An empty replacement would silently lose the conversation, so a failure here is the thread's.
      const r = await proc.request<any>("session/resume", { sessionId: s.id, cwd, mcpServers: [] }, 60_000).catch((e: Error) => { throw new Error(`Grok couldn't resume this thread's session ${s.id}: ${e.message}`); });
      remember(l, r);
      return s.id;
    }
    if (s) throw new Error("Grok thread workspace mismatch; cannot resume in another directory");
    const r = await proc.request<any>("session/new", { cwd, mcpServers: [] }, 60_000);
    remember(l, r);
    save(threadId, { id: r.sessionId, cwd, turns: 0 });
    return r.sessionId as string;
  })();
  l.ready.catch(() => {});
  live.set(threadId, l);
  return l;
}

async function setOption(l: Live, sessionId: string, configId: string, value: string) {
  const r = await l.proc.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", { sessionId, configId, value });
  if (r?.configOptions) l.options = r.configOptions;
}

/** Stop a thread's Grok process (its session stays on disk). */
export function release(id: string) {
  const l = live.get(id);
  if (l) { cancelAsks(l); l.proc.close(); }
  live.delete(id);
}
export function restartIdle() { for (const [id, l] of live) if (!l.busy) release(id); }

const authHint = (message: string) => /auth|login|sign.?in/i.test(message) ? `${message}\nSign in with \`grok login\` on this device.` : message;

/** Run one turn and stream it as NDJSON StreamEvents. `signal` stops Grok (session/cancel). */
export function runTurn(req: PiChatRequest, signal: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let cancel: (() => void) | undefined;
  return new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (e: StreamEvent) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(JSON.stringify(e) + "\n")); } catch { closed = true; cancel?.(); }
      };
      let l: Live | undefined, off: (() => void) | undefined, free: (() => void) | undefined, onAbort: (() => void) | undefined;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (signal.aborted) { send({ t: "done", finish: "aborted" }); return; }
        l = ensure(req.threadId, req.cwd);
        if (l.busy) await Promise.race([l.idle, new Promise((r) => setTimeout(r, 15_000))]);
        if (l.busy) throw new Error("Grok is still working on this thread's previous message.");
        l.busy = true;
        l.idle = new Promise<void>((r) => (free = r));
        l.emit = send;
        const proc = l.proc;
        const sessionId = await l.ready;
        if (signal.aborted) { send({ t: "done", finish: "aborted" }); return; }

        const s = saved(req.threadId);
        if (s && req.prior < s.turns) send({ t: "notice", message: "Grok can't rewind a thread through OpenBuild: its earlier replies stay in its context." });
        if (req.forkFrom) send({ t: "notice", message: "Grok can't copy another thread's session; this thread starts fresh." });

        const modelId = req.model.replace(/^grok\//, "");
        const model = l.options.find((o) => o.id === "model");
        if (model && model.currentValue !== modelId) {
          if (model.options && !model.options.some((o) => o.value === modelId)) throw new Error(`Grok can't use ${modelId} with its current sign-in. Pick another model.`);
          await setOption(l, sessionId, "model", modelId);
        }
        const effort = l.options.find((o) => o.category === "thought_level");
        if (req.effort !== "off" && effort?.options?.some((o) => o.value === req.effort) && effort.currentValue !== req.effort) await setOption(l, sessionId, effort.id, req.effort);

        // Everything Grok reports from here on belongs to this turn.
        const usage: Usage = { contextWindow: l.windows.get(modelId) };
        const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        let wroteText = false, lastText = false, category: string | undefined;
        let fallback: string | undefined, fallbackDone = false, settleFallback!: () => void;
        const fallbackEnded = new Promise<void>((r) => (settleFallback = r));
        const tools = new Map<string, { name: string; args: Record<string, unknown>; output: string; at: number; started: number; hidden: boolean }>();
        const noteFallback = (promptId: unknown) => { if (typeof promptId === "string" && promptId.startsWith(FALLBACK_TURN)) fallback = promptId; };
        const finishTool = (id: string, u: any) => {
          const t = tools.get(id);
          if (!t || t.hidden) return;
          const r = resultOf(t.name, u, req.cwd, t.output);
          send({ t: "tool", id, name: t.name, args: t.args, status: r.status, output: clip(r.output ?? "", OUTPUT_MAX), patch: r.patch ? clip(r.patch, PATCH_MAX) : undefined, ms: Date.now() - t.started });
          tools.delete(id);
        };
        off = proc.on((m: AcpMessage) => {
          const p = m.params ?? {};
          if (m.method === "_x.ai/queue/changed" && p.sessionId === sessionId) { noteFallback(p.runningPromptId); return; }
          if (m.method === "_x.ai/session/interjection" && p.sessionId === sessionId) {
            const item = l!.steering?.items.get(p.interjectionId);
            if (item) { consumed(l!, item); lastText = false; }
            return;
          }
          if (m.method === "_x.ai/session/prompt_complete" && p.sessionId === sessionId) { category = p.cancellationCategory; return; }
          if (!["session/update", "_x.ai/session_notification", "_x.ai/session/update"].includes(m.method ?? "") || p.sessionId !== sessionId) return;
          noteFallback(p._meta?.promptId);
          if (typeof p._meta?.totalTokens === "number") usage.contextTokens = p._meta.totalTokens;
          const u = p.update ?? {};
          switch (u.sessionUpdate) {
            case "agent_message_chunk": {
              const text = u.content?.type === "text" ? String(u.content.text ?? "") : "";
              if (!text) break;
              if (wroteText && !lastText) send({ t: "text", v: "\n\n" });
              send({ t: "text", v: text });
              lastText = wroteText = true;
              break;
            }
            case "agent_thought_chunk": {
              const text = u.content?.type === "text" ? String(u.content.text ?? "") : "";
              if (text) send({ t: "reasoning", v: text });
              break;
            }
            case "tool_call": {
              lastText = false;
              const name = toolName(u), mapped = mapUpdate(u);
              const t = { ...mapped, output: "", at: 0, started: Date.now(), hidden: isHidden(name) };
              tools.set(u.toolCallId, t);
              if (!t.hidden) send({ t: "tool", id: u.toolCallId, name: t.name, args: t.args, status: "running" });
              break;
            }
            case "tool_call_update": {
              let t = tools.get(u.toolCallId);
              if (!t) {
                const mapped = mapUpdate(u);
                t = { ...mapped, output: "", at: 0, started: Date.now(), hidden: isHidden(toolName(u)) };
                tools.set(u.toolCallId, t);
              }
              if (t.hidden) {
                if (u.status === "completed" || u.status === "failed") tools.delete(u.toolCallId);
                break;
              }
              if (u.rawInput) {
                // Without a status, `content` is Grok's own description of the call, not output.
                const mapped = mapUpdate(u, t.name);
                if (mapped.name === t.name) t.args = mapped.args;
                if (!u.status) send({ t: "tool", id: u.toolCallId, name: t.name, args: t.args, status: "running" });
              }
              if (u.status === "completed" || u.status === "failed") finishTool(u.toolCallId, u);
              else if (u.status === "in_progress") {
                // Each update carries all of a command's output so far.
                const text = (u.content ?? []).map((c: any) => c?.content?.text ?? "").join("");
                if (!text || text === t.output) break;
                t.output = text;
                if (Date.now() - t.at < 500) break;
                t.at = Date.now();
                send({ t: "tool", id: u.toolCallId, name: t.name, status: "running", output: clip(t.output, OUTPUT_MAX) });
              }
              break;
            }
            case "plan": {
              const entries = Array.isArray(u.entries) ? u.entries : [];
              if (entries.length) send({ t: "tool", id: `grok-plan-${req.stream?.id ?? ""}`, name: "todo", args: { title: "Plan" }, status: "done", output: planLines(entries) });
              break;
            }
            case "response_completed": {
              lastText = false;
              if (usage.contextTokens !== undefined) send({ t: "usage", usage: { ...usage } });
              break;
            }
            case "turn_completed": {
              const n = u.usage ?? {}, read = n.cachedReadTokens ?? 0, write = n.cacheCreationTokens ?? 0;
              totals.input += Math.max(0, (n.inputTokens ?? 0) - read - write);
              totals.output += n.outputTokens ?? 0;
              totals.cacheRead += read;
              totals.cacheWrite += write;
              if (typeof n.costUsdTicks === "number") totals.cost += n.costUsdTicks / 1e10;
              if (typeof u.prompt_id === "string" && u.prompt_id.startsWith(FALLBACK_TURN)) { fallback = u.prompt_id; fallbackDone = true; settleFallback(); }
              break;
            }
            case "image_dropped": {
              for (const note of u.notes ?? []) send({ t: "notice", message: String(note) });
              break;
            }
          }
        });
        const offExit = proc.on((m) => { if (m.method === "$/exit") settleFallback(); });
        const offTurn = off;
        off = () => { offTurn(); offExit(); };
        onAbort = () => {
          if (l!.steering) l!.steering.accepting = false;
          cancelAsks(l!);
          proc.notify("session/cancel", { sessionId });
          // Don't leave the worker blocked if Grok ignores the cancel.
          stopTimer ??= setTimeout(() => proc.close(), 15_000);
        };
        cancel = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });

        const prompt: unknown[] = [{ type: "text", text: QUESTION_NOTE }];
        for (const image of req.images ?? []) prompt.push({ type: "image", mimeType: image.mimeType, data: image.data });
        prompt.push({ type: "text", text: req.message });
        // Reserve before writing: a failure must never cause an automatic resend.
        save(req.threadId, { id: sessionId, cwd: req.cwd, turns: Math.max(req.prior, s?.turns ?? 0) + 1 });
        const steering: NonNullable<Live["steering"]> = { accepting: true, sessionId, items: new Map() };
        l.steering = steering;
        const result = await proc.request<{ stopReason?: string }>("session/prompt", { sessionId, prompt }, 0);
        steering.accepting = false;
        // Grok runs an interjection that reached it just as the turn ended as a turn of its own.
        // Stay attached, or its reply would go nowhere and the message would look undelivered.
        await Promise.all([...steering.items.values()].map((item) => item.sent));
        await new Promise((r) => setTimeout(r, steering.items.size ? 250 : 50));
        if (fallback && !fallbackDone) await fallbackEnded;
        Object.assign(usage, totals, { cost: totals.cost || undefined });
        const stop = result?.stopReason;
        if (stop === "cancelled" && !signal.aborted && category === "PermissionRejected") send({ t: "notice", message: "Grok stopped this reply because a tool was declined. Send a message to tell it what to do instead." });
        if (stop === "refusal" && !wroteText) send({ t: "error", message: "The model refused to answer." });
        else send({ t: "done", finish: signal.aborted || stop === "cancelled" ? "aborted" : stop === "max_tokens" ? "length" : stop === "refusal" ? "refusal" : "stop", usage });
      } catch (err) {
        if (signal.aborted) send({ t: "done", finish: "aborted" });
        else send({ t: "error", message: authHint((err as Error).message) });
      } finally {
        clearTimeout(stopTimer);
        off?.();
        if (onAbort) signal.removeEventListener("abort", onAbort);
        if (l && free) {
          cancelAsks(l);
          l.steering = undefined;
          l.busy = false;
          l.emit = undefined;
          l.proc.lastUsed = Date.now();
          free();
        }
        send({ t: "end" });
        if (!closed) { closed = true; controller.close(); }
      }
    },
    cancel() { cancel?.(); },
  });
}

/** Where Grok keeps a thread's session, for display. */
export const sessionDir = () => join(grokEnv().GROK_HOME ?? join(process.env.HOME ?? "", ".grok"), "sessions");
