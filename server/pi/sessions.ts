// Threads run on Pi. Each thread has its own Pi session (a JSONL file under ~/.pi/agent/sessions,
// so `pi -r` in a terminal can open it too) and, while it's in use, its own `pi --mode rpc` process
// running in the thread's workspace. Pi owns the conversation: a turn sends only the new message.
//
// The app's thread can diverge from Pi's history (a retry, an edited resend, a legacy fork). Each
// turn says how many user messages come before it; when Pi's session has more, it's forked back to
// that point first (Pi's `fork`), and the thread follows the new session file from then on.
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { EFFORTS, type Effort, type ModelScope, type PiChatRequest, type PiCommand, type StreamEvent, type Usage } from "../../shared/types";
import * as storage from "../storage";
import { dataDir } from "../paths";
import { CommandCache } from "../../shared/commandCache";
import { partialTitle } from "../../shared/htmlRender";
import { TOOL as HTML_TOOL } from "./extensions/html-render";
import { TOOL as QUESTION_TOOL } from "./extensions/question-ask";
import { FLAG as SPEED_FLAG } from "./extensions/speed";
import { PiError, PiProcess, type PiRecord } from "./rpc";
import { addUsage, emptyUsage } from "./usage";

/** Close a thread's Pi process after this long without use. */
const IDLE = 20 * 60 * 1000;
/** Tool output kept per call (head and tail), and the diff of a file change. */
const OUTPUT_MAX = 12_000;
const PATCH_MAX = 60_000;
/** OpenBuild's own extensions, loaded into every thread: question_ask, html_render with html_preview, and speed (service tiers). */
const EXTENSIONS = ["question-ask.ts", "html-render.ts", "speed.ts"].map((e) => join(import.meta.dir, "extensions", e));

interface Live {
  threadId: string;
  proc: PiProcess;
  ready: Promise<void>;
  busy: boolean;
  /** Settles once the running turn is over. */
  idle: Promise<void>;
  /** The running turn: whether Pi has taken its prompt (only then can it be steered), and the steers it hasn't read yet. */
  turn?: { taking: boolean; steers: string[] };
  /** Questions from extensions still waiting for an answer, replayed to whoever watches the run. */
  asks: Map<string, Extract<StreamEvent, { t: "ask" }>>;
  /** Running question_ask calls and their questions, to tell their dialogs from other extensions'. */
  questions: Map<string, string>;
  /** Commands the user is running with "!" or "!!" (shell.ts); they keep the process open like a turn. */
  shells: number;
  emit?: (e: StreamEvent) => void;
}

/** Working on something: a turn, or a command the user ran. */
const inUse = (l: Live) => l.busy || l.shells > 0;

const hot = globalThis as { openbuildPiLive?: Map<string, Live>; openbuildPiReaper?: ReturnType<typeof setInterval> };
const live = (hot.openbuildPiLive ??= new Map());
if (hot.openbuildPiReaper) clearInterval(hot.openbuildPiReaper);
hot.openbuildPiReaper = setInterval(() => {
  for (const [id, l] of live) {
    if (l.proc.exited || (!inUse(l) && Date.now() - l.proc.lastUsed > IDLE)) {
      l.proc.close();
      live.delete(id);
    }
  }
}, 60_000);

interface Saved {
  file: string;
  cwd: string;
}
/** Discovery must not replace a thread while OpenBuild owns its RPC process. */
export const isSessionLive = (threadId: string) => {
  const l = live.get(threadId);
  return !!l && !l.proc.exited;
};

const savedKey = (threadId: string) => `pi-session:${threadId}`;
function saved(threadId: string): Saved | undefined {
  try {
    return JSON.parse(storage.getValue(savedKey(threadId)) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
}
const save = (threadId: string, s: Saved) => storage.setValue(savedKey(threadId), JSON.stringify(s));

export const isThreadId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id);

/** Pi thinking levels for the app's effort levels ("minimal" has no app equivalent). */
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Effort levels a Pi model supports, from its thinkingLevelMap (null = unsupported). */
export function modelEfforts(model: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }): Effort[] {
  if (!model.reasoning) return [];
  const map = model.thinkingLevelMap;
  const standard = new Set(["off", "low", "medium", "high"]);
  return EFFORTS.filter((e) => (map?.[e] === null ? false : standard.has(e) || (map?.[e] !== undefined && map[e] !== null)));
}

function clip(text: string, max: number) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n… ${text.length - max} characters not shown …\n\n${text.slice(-half)}`;
}

const textOf = (result: any): string =>
  Array.isArray(result?.content) ? result.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n") : typeof result === "string" ? result : "";

/** Where a thread's speed choice is kept for its Pi process (extensions/speed.ts reads it per request). */
const speedFile = (threadId: string) => join(dataDir(), "pi-speed", `${threadId}.json`);
function saveSpeed(threadId: string, model: string, speed: string | undefined) {
  const file = speedFile(threadId);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ model, speed: speed ?? null }));
}

/** The thread's Pi process, started (or restarted in another directory) as needed. */
function ensure(threadId: string, cwd: string, forkFrom?: string): Live {
  const existing = live.get(threadId);
  if (existing && !existing.proc.exited && existing.proc.cwd === cwd) return existing;
  if (existing) {
    if (inUse(existing)) throw new PiError("This thread is still working in another directory");
    existing.proc.close();
    live.delete(threadId);
  }
  const s = saved(threadId);
  const from = forkFrom ? saved(forkFrom) : undefined;
  const args =
    s && s.cwd === cwd && existsSync(s.file)
      ? ["--session", s.file]
      : from && existsSync(from.file)
        ? ["--fork", from.file]
        : ["--session-id", threadId];
  const proc = new PiProcess([...args, ...EXTENSIONS.flatMap((e) => ["-e", e]), `--${SPEED_FLAG}`, speedFile(threadId)], cwd);
  const l: Live = { threadId, proc, busy: false, idle: Promise.resolve(), asks: new Map(), questions: new Map(), shells: 0, ready: Promise.resolve() };
  // Extension questions can come at any time, also before a run (e.g. while starting up).
  proc.on((r) => {
    if (r.toolName === QUESTION_TOOL) {
      if (r.type === "tool_execution_start") l.questions.set(r.toolCallId, String(r.args?.question ?? "").trim());
      else if (r.type === "tool_execution_end") l.questions.delete(r.toolCallId);
      return;
    }
    if (r.type !== "extension_ui_request") return;
    if (["select", "confirm", "input", "editor"].includes(r.method)) {
      const ask: Extract<StreamEvent, { t: "ask" }> = {
        t: "ask",
        id: r.id,
        method: r.method,
        title: String(r.title ?? "Pi asks"),
        message: r.message,
        options: Array.isArray(r.options) ? r.options.map(String) : undefined,
        placeholder: r.placeholder,
        prefill: r.prefill,
        // question_ask's dialog takes the user's own words too.
        other: r.method === "select" && [...l.questions.values()].includes(r.title) ? true : undefined,
      };
      l.asks.set(r.id, ask);
      l.emit?.(ask);
      if (r.timeout) setTimeout(() => l.asks.delete(r.id) && l.emit?.({ t: "asked", id: r.id }), r.timeout).unref?.();
    } else if (r.method === "notify" && r.message) {
      l.emit?.({ t: "notice", message: String(r.message) });
    }
  });
  l.ready = proc.send<{ sessionFile?: string }>({ type: "get_state" }, 60_000).then((st) => {
    if (st.sessionFile) save(threadId, { file: st.sessionFile, cwd });
  });
  // Whoever uses the process awaits this and reports a failed start; don't also report it unhandled.
  l.ready.catch(() => {});
  live.set(threadId, l);
  return l;
}

/** Answer a question an extension asked in this thread. */
export function answer(threadId: string, askId: string, reply: { value?: string; confirmed?: boolean; cancelled?: boolean }): boolean {
  const l = live.get(threadId);
  if (!l || !l.asks.has(askId)) return false;
  l.asks.delete(askId);
  const record: PiRecord = { type: "extension_ui_response", id: askId };
  if (reply.cancelled) record.cancelled = true;
  else if (reply.confirmed !== undefined) record.confirmed = reply.confirmed;
  else record.value = reply.value ?? "";
  l.proc.write(record);
  l.emit?.({ t: "asked", id: askId, answer: reply.cancelled ? undefined : reply.confirmed !== undefined ? (reply.confirmed ? "Yes" : "No") : reply.value });
  return true;
}

/** Hand Pi a message while it works on a turn; it reads it once its current step is done. */
export async function steer(threadId: string, steerId: string, message: string, images?: PiChatRequest["images"]): Promise<{ handled: boolean }> {
  const l: Live | undefined = live.get(threadId);
  const turn = l?.turn;
  if (!l || !turn) throw new PiError("Pi isn't working on this thread anymore.");
  if (!turn.taking) throw new PiError("Pi hasn't started on this reply yet. Try again in a moment.");
  turn.steers.push(steerId);
  const drop = () => (turn.steers = turn.steers.filter((id) => id !== steerId));
  try {
    const r = await l.proc.send<{ disposition?: string }>({ type: "steer", message, images: images?.length ? images.map((i) => ({ type: "image", ...i })) : undefined });
    // An extension's input handler took it; Pi won't read it as a message.
    if (r.disposition === "handled") drop();
    return { handled: r.disposition === "handled" };
  } catch (err) {
    drop();
    throw err;
  }
}

/** What Pi's `bash` command reports when a command is over. */
export interface BashResult {
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
}

/** Longest a command may run; setTimeout can't wait any longer. */
const FOREVER = 2 ** 31 - 1;

/**
 * Run a command the user typed ("!" or, with `exclude`, "!!") through Pi's own `bash`, in the
 * thread's Pi process, so it's recorded in the session like `!` in Pi's terminal UI: the model reads
 * the command and its output with the next prompt, unless it's excluded. Pi handles these alongside
 * a running turn (a result that comes in mid-turn waits for the turn to end), and runs the user's
 * `user_bash` extensions on them first, like any `!` command.
 *
 * `signal` stops it. Pi can only stop all of a thread's commands at once (`abort_bash`), so it stops
 * the others too.
 */
export async function bash(threadId: string, cwd: string, id: string, command: string, exclude: boolean, onOutput: (delta: string) => void, signal: AbortSignal): Promise<BashResult> {
  const l = ensure(threadId, cwd);
  l.shells++;
  const off = l.proc.on((r) => {
    if (r.type === "bash_execution_update" && r.id === id && typeof r.delta === "string") onOutput(r.delta);
  });
  const onAbort = () => void l.proc.send({ type: "abort_bash" }).catch(() => {});
  try {
    await l.ready;
    if (signal.aborted) return { output: "", cancelled: true, truncated: false };
    signal.addEventListener("abort", onAbort, { once: true });
    return await l.proc.send<BashResult>({ type: "bash", id, command, excludeFromContext: exclude || undefined }, FOREVER);
  } finally {
    signal.removeEventListener("abort", onAbort);
    off();
    l.shells--;
    l.proc.lastUsed = Date.now();
  }
}

/** Run one turn and stream it as NDJSON StreamEvents. `signal` stops Pi (abort). */
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
      const finish = () => {
        if (closed) return;
        clearInterval(heartbeat);
        off?.();
        if (l && free) {
          l.busy = false;
          l.turn = undefined;
          // Pi drops pending extension requests on abort without sending a UI dismissal. Retire
          // turn-visible dialogs here so a later reply never replays a question nobody can answer.
          for (const id of l.asks.keys()) send({ t: "asked", id });
          l.asks.clear();
          l.questions.clear();
          l.emit = undefined;
          l.proc.lastUsed = Date.now();
          free();
        }
        closed = true;
        controller.close();
      };
      try {
        l = ensure(req.threadId, req.cwd, req.forkFrom);
        // A reply that was just interrupted may still be winding down.
        if (l.busy) await Promise.race([l.idle, new Promise((r) => setTimeout(r, 15_000))]);
        if (l.busy) throw new PiError("Pi is still working on this thread's previous message.");
        l.busy = true;
        l.idle = new Promise<void>((r) => (free = r));
        const turn: NonNullable<Live["turn"]> = { taking: false, steers: [] };
        l.turn = turn;
        const proc = l.proc;
        await l.ready;
        // An extension can start another run after agent_settled. Older workers may have
        // already closed its stream: stop that unowned run before rewinding or resending.
        const initial = await proc.send<{ isStreaming?: boolean }>({ type: "get_state" });
        if (initial.isStreaming) {
          for (const id of l.asks.keys()) answer(req.threadId, id, { cancelled: true });
          await proc.send({ type: "abort" });
          await proc.send({ type: "clear_queue" });
        }
        l.emit = send;
        for (const ask of l.asks.values()) send(ask);

        // Everything Pi reports from here on belongs to this turn.
        let settled!: () => void;
        const done = new Promise<void>((r) => (settled = r));
        let started = false;
        let generation = 0;
        let lastText = false;
        let wroteText = false;
        let lastThought = false;
        let lastError: string | undefined;
        const usage: Usage = emptyUsage();
        const progress = new Map<string, number>();
        /** html_render calls still being written, by their place in the message. */
        const drawing = new Map<number, { id: string; json: string; at: number }>();
        off = proc.on((r) => {
          switch (r.type) {
            case "agent_start":
              started = true;
              generation++;
              break;
            case "message_start":
              drawing.clear();
              if (r.message?.role === "assistant" && wroteText && lastText) send({ t: "text", v: "\n\n" });
              else if (r.message?.role === "user") {
                // The first is this turn's prompt; any later one is a message steered in meanwhile.
                if (!turn.taking) turn.taking = true;
                else {
                  const c = r.message.content;
                  send({ t: "steer", id: turn.steers.shift(), text: typeof c === "string" ? c : textOf(r.message) });
                  lastText = lastThought = false;
                }
              }
              break;
            case "message_update": {
              const ev = r.assistantMessageEvent;
              if (ev?.type === "text_delta" && ev.delta) {
                send({ t: "text", v: ev.delta });
                lastText = wroteText = true;
                lastThought = false;
              } else if (ev?.type === "thinking_start") {
                // Back-to-back thinking blocks read as separate paragraphs of the same thought.
                if (lastThought) send({ t: "reasoning", v: "\n\n" });
              } else if (ev?.type === "thinking_delta" && ev.delta) {
                send({ t: "reasoning", v: ev.delta });
                lastThought = true;
              } else if (ev?.type === "toolcall_start" && ev.toolName === HTML_TOOL && ev.id) {
                // A page takes a while to write: show that it's coming, and its title once it's written.
                drawing.set(ev.contentIndex, { id: ev.id, json: "", at: 0 });
              } else if (ev?.type === "toolcall_delta" && drawing.has(ev.contentIndex)) {
                const d = drawing.get(ev.contentIndex)!;
                d.json += ev.delta ?? "";
                if (Date.now() - d.at < 500) break;
                d.at = Date.now();
                send({ t: "tool", id: d.id, name: HTML_TOOL, status: "running", args: { title: partialTitle(d.json), written: d.json.length } });
                lastText = lastThought = false;
              }
              break;
            }
            case "message_end": {
              const m = r.message;
              if (m?.role !== "assistant") break;
              addUsage(usage, m.usage);
              if (m.usage) send({ t: "usage", usage: { ...usage } });
              if (m.stopReason === "error") lastError = m.errorMessage || "The model returned an error.";
              else if (m.stopReason !== "aborted") lastError = undefined;
              break;
            }
            case "tool_execution_start":
              lastText = lastThought = false;
              // Its question card stands for it; only a failure shows as a tool call.
              if (r.toolName === QUESTION_TOOL) break;
              send({ t: "tool", id: r.toolCallId, name: r.toolName, args: r.args, status: "running" });
              break;
            case "tool_execution_update": {
              // Live output (a long build or test run), at most twice a second.
              if (r.toolName === QUESTION_TOOL) break;
              const at = progress.get(r.toolCallId) ?? 0;
              if (Date.now() - at < 500) break;
              progress.set(r.toolCallId, Date.now());
              const out = textOf(r.partialResult);
              if (out) send({ t: "tool", id: r.toolCallId, name: r.toolName, status: "running", output: clip(out, OUTPUT_MAX) });
              break;
            }
            case "tool_execution_end": {
              if (r.toolName === QUESTION_TOOL && !r.isError) break;
              const patch = r.result?.details?.patch;
              send({
                t: "tool",
                id: r.toolCallId,
                name: r.toolName,
                status: r.isError ? "error" : "done",
                output: clip(textOf(r.result), OUTPUT_MAX),
                patch: typeof patch === "string" ? clip(patch, PATCH_MAX) : undefined,
                ms: r.durationMs,
              });
              break;
            }
            case "auto_retry_start":
              send({ t: "notice", message: `Retrying (attempt ${r.attempt} of ${r.maxAttempts}): ${r.errorMessage}` });
              break;
            case "auto_retry_end":
              if (!r.success && r.finalError) lastError = r.finalError;
              break;
            case "compaction_start":
              send({ t: "notice", message: r.reason === "overflow" ? "The context was full, so Pi compacted it." : "Pi compacted the context." });
              break;
            case "compaction_end":
              if (r.errorMessage) send({ t: "notice", message: `Compacting failed: ${r.errorMessage}` });
              break;
            case "agent_settled":
              // This event ends one Pi run, but an extension may immediately start
              // another (e.g. a subagent result). Keep its output and questions attached.
              const endedGeneration = generation;
              void proc.send<{ isStreaming?: boolean }>({ type: "get_state" }).then((state) => {
                if (generation === endedGeneration && !state.isStreaming) settled();
              }).catch((err) => {
                lastError = (err as Error).message;
                settled();
              });
              break;
            case "process_exit":
              lastError = r.message;
              settled();
              break;
          }
        });
        const onAbort = () => {
          // Extensions are not required to pass an AbortSignal to their dialogs. Dismiss them
          // explicitly, otherwise abort may wait forever for a question with no UI attached.
          for (const id of l!.asks.keys()) answer(req.threadId, id, { cancelled: true });
          void proc.send({ type: "abort" }).catch(() => {});
        };
        signal.addEventListener("abort", onAbort, { once: true });

        await l.ready;
        // Cut Pi's history back to where this message goes, if the thread changed since.
        const forkable = await proc.send<{ messages: { entryId: string }[] }>({ type: "get_fork_messages" });
        const target = forkable.messages[req.prior];
        if (target) {
          const r = await proc.send<{ cancelled?: boolean }>({ type: "fork", entryId: target.entryId });
          if (r.cancelled) throw new PiError("An extension stopped Pi from going back to that point of the thread.");
          const st = await proc.send<{ sessionFile?: string }>({ type: "get_state" });
          if (st.sessionFile) save(req.threadId, { file: st.sessionFile, cwd: req.cwd });
        }

        // Model and thinking level for this turn.
        const slash = req.model.indexOf("/");
        const provider = req.model.slice(0, slash);
        const modelId = req.model.slice(slash + 1);
        const state = await proc.send<{ model?: { provider: string; id: string } }>({ type: "get_state" });
        if (state.model?.provider !== provider || state.model?.id !== modelId) await proc.send({ type: "set_model", provider, modelId });
        const { levels } = await proc.send<{ levels: string[] }>({ type: "get_available_thinking_levels" });
        const level = nearestLevel(levels, req.effort);
        if (level) await proc.send({ type: "set_thinking_level", level });
        saveSpeed(req.threadId, req.model, req.speed);

        if (signal.aborted) return finish();
        const res = await proc.send<{ disposition?: string }>({ type: "prompt", message: req.message, images: req.images?.length ? req.images.map((i) => ({ type: "image", ...i })) : undefined }, 5 * 60_000);
        if (res.disposition === "handled") {
          // An extension command handled it. It may still start a run of its own; give it a moment.
          await Promise.race([done, new Promise((r) => setTimeout(r, 2500))]);
          if (!started) {
            send({ t: "done", finish: "handled" });
            return finish();
          }
        }
        await done;
        signal.removeEventListener("abort", onAbort);
        // Steers Pi never got to (it was stopped, or finished first) mustn't turn up in a later turn.
        if (turn.steers.length) await proc.send({ type: "clear_queue" }).catch(() => {});
        if (lastError && !signal.aborted) send({ t: "error", message: lastError });
        else {
          const stats = await proc.send<{ contextUsage?: { tokens: number | null; contextWindow: number } }>({ type: "get_session_stats" }).catch(() => undefined);
          if (stats?.contextUsage) {
            usage.contextTokens = stats.contextUsage.tokens ?? undefined;
            usage.contextWindow = stats.contextUsage.contextWindow;
            // Just compacted: what the context holds isn't known until the next reply.
            if (stats.contextUsage.tokens == null) usage.last = undefined;
          }
          send({ t: "done", finish: signal.aborted ? "aborted" : "stop", usage });
        }
      } catch (err) {
        if (!signal.aborted) send({ t: "error", message: (err as Error).message });
      }
      finish();
    },
  });
}

/** The supported Pi level closest to the app's effort level. */
function nearestLevel(levels: string[], effort: Effort): string | undefined {
  if (!levels.length) return undefined;
  if (levels.includes(effort)) return effort;
  const at = PI_LEVELS.indexOf(effort);
  return [...levels].sort((a, b) => Math.abs(PI_LEVELS.indexOf(a as never) - at) - Math.abs(PI_LEVELS.indexOf(b as never) - at))[0];
}

/** Run something against a short-lived Pi process that isn't tied to a thread. */
async function withScratch<T>(cwd: string, fn: (p: PiProcess) => Promise<T>): Promise<T> {
  const proc = new PiProcess(["--no-session"], cwd);
  try {
    return await fn(proc);
  } finally {
    proc.close();
  }
}

// ------------------------------------------------------------------ models and commands

export interface PiModels {
  models: any[];
  defaultModel?: string;
  defaultThinking?: string;
  /** Pi's `enabledModels` scope on this device, if it has one. Display only: the list stays full. */
  scope?: ModelScope;
  checkedAt: number;
}
let modelsCache: { at: number; value: Promise<PiModels> } | undefined;
/** Providers seen in the last good listing, so a half-finished one can be recognised. */
let knownProviders = new Set<string>();

/**
 * Pi answers `get_available_models` from a snapshot that fills in as each provider's auth check
 * finishes. Providers backed by a CLI (claude-code, claude-code-2 spawn `claude auth status`) finish
 * after stored-credential ones, so asking straight after start-up sometimes left them out — and the
 * app then switched a chat away from a Claude model. Ask again until the snapshot settles: every
 * provider from the last listing is back, or two answers in a row agree.
 */
async function settledModels(p: PiProcess): Promise<any[]> {
  const ask = async () => (await p.send<{ models: any[] }>({ type: "get_available_models" })).models;
  const providers = (models: any[]) => new Set<string>(models.map((m) => m.provider));
  const deadline = Date.now() + 8_000;
  let models = await ask();
  let previous: string | undefined;
  for (let wait = 150; Date.now() < deadline; wait = Math.min(wait * 2, 1_000)) {
    const have = providers(models);
    const missing = [...knownProviders].some((id) => !have.has(id));
    const key = [...have].sort().join(",") + "#" + models.length;
    if (!missing && (knownProviders.size > 0 || key === previous)) break;
    previous = key;
    await new Promise((r) => setTimeout(r, wait));
    models = await ask();
  }
  knownProviders = providers(models);
  return models;
}

/** Pi's model scope, or undefined. A scope that can't be resolved must never stop models being listed. */
async function modelScope(): Promise<ModelScope | undefined> {
  try {
    // Loaded here so this module doesn't import auth.ts (which imports this one) at load time.
    const { modelScope: resolve } = await import("./auth");
    return await resolve();
  } catch (err) {
    console.warn("[pi] model scope unavailable:", (err as Error).message);
    return undefined;
  }
}

/** The models configured in Pi (those with credentials), Pi's default, and its model scope. Cached for a minute. */
export function listModels(fresh = false): Promise<PiModels> {
  if (!fresh && modelsCache && Date.now() - modelsCache.at < 60_000) return modelsCache.value;
  const value = Promise.all([
    withScratch(homedir(), async (p) => {
      const [models, state] = await Promise.all([settledModels(p), p.send<{ model?: any; thinkingLevel?: string }>({ type: "get_state" })]);
      return { models, defaultModel: state.model ? `${state.model.provider}/${state.model.id}` : undefined, defaultThinking: state.thinkingLevel, checkedAt: Date.now() };
    }),
    modelScope(),
  ]).then(([models, scope]) => ({ ...models, scope }));
  modelsCache = { at: Date.now(), value };
  value.catch(() => modelsCache?.value === value && (modelsCache = undefined));
  return value;
}

export const forgetModels = () => (modelsCache = undefined);

const commandsCache = new CommandCache<PiCommand[]>(60_000);

/** Pi's slash commands for a directory: extension commands, prompt templates and skills. */
export function listCommands(cwd: string): Promise<PiCommand[]> {
  return commandsCache.get(cwd, () => {
    const fetchFrom = (p: PiProcess) =>
      p.send<{ commands: { name: string; description?: string; source: PiCommand["source"] }[] }>({ type: "get_commands" }).then((r) =>
        r.commands.map((c) => ({ name: c.name, description: c.description, source: c.source })),
      );
    const idle = [...live.values()].find((l) => l.proc.cwd === cwd && !inUse(l) && !l.proc.exited);
    return idle ? idle.ready.then(() => fetchFrom(idle.proc)) : withScratch(cwd, fetchFrom);
  });
}

export const forgetCommands = () => commandsCache.clear();

/** Compact a thread's context now (/compact). */
export async function compact(threadId: string, instructions?: string) {
  const s = saved(threadId);
  if (!s) throw new PiError("This thread has no Pi session yet.");
  const l = ensure(threadId, s.cwd);
  if (l.busy) throw new PiError("Wait for the current reply to finish first.");
  await l.ready;
  return l.proc.send<{ tokensBefore: number; estimatedTokensAfter?: number }>({ type: "compact", customInstructions: instructions }, 10 * 60_000);
}

/** Stop a thread's process (its session file stays). */
export function release(threadId: string) {
  live.get(threadId)?.proc.close();
  live.delete(threadId);
}

/** Restart every idle process, so changed extensions, skills or credentials take effect. */
export function restartIdle() {
  for (const [id, l] of live) if (!inUse(l)) release(id);
  forgetModels();
  forgetCommands();
}

/** A one-off completion with no tools or session (thread titles). Pi reads images from `@path` arguments. */
export async function complete(model: string, system: string, prompt: string, signal: AbortSignal, images: { data: string; mimeType?: string }[] = []): Promise<string> {
  const { piBin, piEnv } = await import("./install");
  const bin = piBin();
  if (!bin) throw new PiError("Pi isn't installed.");
  const dir = images.length ? await mkdtemp(join(tmpdir(), "openbuild-complete-")) : undefined;
  try {
    const files = images.map((_, i) => join(dir!, `image-${i}`));
    await Promise.all(images.map((image, i) => Bun.write(files[i]!, Buffer.from(image.data, "base64"))));
    const proc = Bun.spawn(
      [bin, "-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--model", model, "--thinking", "off", "--system-prompt", system, "--", ...files.map((f) => `@${f}`), prompt],
      { cwd: homedir(), stdout: "pipe", stderr: "pipe", stdin: "ignore", env: piEnv() },
    );
    const kill = () => proc.kill();
    signal.addEventListener("abort", kill, { once: true });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    signal.removeEventListener("abort", kill);
    if (code !== 0) throw new PiError(err.trim().split("\n").pop() || `pi exited with code ${code}`);
    return out.trim();
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
