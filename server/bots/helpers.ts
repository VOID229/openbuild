// A bot's background work: the jobs it has going beside its main turn, and the helper sessions that
// do some of them. A helper is a second, short-lived Pi of the same bot: the bot's own model at low
// reasoning, no session of its own, nothing the user sees or sets up. It writes a quick side reply
// while the main session is inside a long tool call, or runs a check the bot handed off and wakes
// the main session with the result. Stopping a bot cancels all of it.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BOT_EFFORTS } from "../../shared/bots";
import { PiError, PiProcess, type PiRecord } from "../pi/rpc";
import { agentSocketPath, mintToken, revokeToken } from "./agent";
import { botsDir } from "./db";
import * as db from "./db";
import * as svc from "./service";

/**
 * How many background jobs one bot runs at once: side replies, questions out to other bots and
 * handed-off checks together. Internal, with no setting: change it here.
 */
export const BACKGROUND_JOB_CAP = 3;
/** How many more may wait for a free slot. Past that a job is refused, with the reason. */
export const BACKGROUND_QUEUE_MAX = 6;
/** The reasoning level every helper session runs at, on the bot's own model. */
export const HELPER_EFFORT = "low";

export type JobKind = "reply" | "ask" | "lookup";
export type JobStart = { state: "started" | "queued" } | { state: "skipped"; reason: string };

interface Job {
  botId: string;
  kind: JobKind;
  abort: AbortController;
  run: (signal: AbortSignal) => Promise<void>;
}

const hot = globalThis as { openbotsJobs?: Map<string, Set<Job>>; openbotsJobQueue?: Map<string, Job[]> };
const running = (hot.openbotsJobs ??= new Map());
const waiting = (hot.openbotsJobQueue ??= new Map());

/** A job stopped because its bot was: not a failure, and it wakes nobody. */
export class JobCancelled extends Error {
  constructor() {
    super("Cancelled.");
  }
}

/**
 * Start a background job for a bot, within its cap. Over the cap it waits its turn (`queue`), or is
 * skipped when waiting would make it pointless (a quick reply) or the line is full. Never throws:
 * the caller decides what a skipped job means.
 */
export function startJob(botId: string, kind: JobKind, run: Job["run"], opts: { queue?: boolean } = {}): JobStart {
  const job: Job = { botId, kind, abort: new AbortController(), run };
  if ((running.get(botId)?.size ?? 0) < BACKGROUND_JOB_CAP) {
    launch(job);
    return { state: "started" };
  }
  const line = waiting.get(botId) ?? [];
  if (opts.queue === false || line.length >= BACKGROUND_QUEUE_MAX) {
    const reason = opts.queue === false ? `${BACKGROUND_JOB_CAP} background jobs are already running` : `${BACKGROUND_JOB_CAP} background jobs are running and ${line.length} more are waiting`;
    console.info(`[bots] ${botId} background ${kind} skipped: ${reason}`);
    return { state: "skipped", reason };
  }
  line.push(job);
  waiting.set(botId, line);
  return { state: "queued" };
}

function launch(job: Job) {
  const set = running.get(job.botId) ?? new Set<Job>();
  set.add(job);
  running.set(job.botId, set);
  void (async () => {
    try {
      await job.run(job.abort.signal);
    } catch (err) {
      if (!(err instanceof JobCancelled) && !job.abort.signal.aborted) console.warn(`[bots] ${job.botId} background ${job.kind} failed:`, err instanceof Error ? err.message : err);
    } finally {
      set.delete(job);
      if (!set.size && running.get(job.botId) === set) running.delete(job.botId);
      const next = job.abort.signal.aborted ? undefined : waiting.get(job.botId)?.shift();
      if (next) launch(next);
    }
  })();
}

/** Stop everything a bot has going in the background, running or waiting. Says how many jobs that was. */
export function cancelJobs(botId: string): number {
  const line = waiting.get(botId) ?? [];
  waiting.delete(botId);
  const set = [...(running.get(botId) ?? [])];
  for (const job of set) job.abort.abort();
  return set.length + line.length;
}

/** What a bot has in the background right now, by kind. */
export function backgroundJobs(botId: string): { running: JobKind[]; queued: JobKind[] } {
  return { running: [...(running.get(botId) ?? [])].map((j: Job) => j.kind), queued: (waiting.get(botId) ?? []).map((j: Job) => j.kind) };
}

// ------------------------------------------------------------------ helper sessions

/** As much of a Pi process as a helper needs. Tests stand in their own (see `seams`). */
export interface HelperProc {
  send<T = any>(command: PiRecord, timeoutMs?: number): Promise<T>;
  on(listener: (record: PiRecord) => void): () => void;
  close(): void;
}

export const seams = {
  spawn(botId: string, flags: string[], env: Record<string, string>): HelperProc {
    const cwd = join(botsDir(), "minds", `${botId}~helper`);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    return new PiProcess(["--no-session", ...flags], cwd, env);
  },
};

/** The level nearest `effort` among those a model takes, or none when it takes none. */
export function nearestEffort(levels: string[], effort: string): string | undefined {
  const order: readonly string[] = BOT_EFFORTS;
  const supported = levels.filter((level) => order.includes(level));
  if (supported.includes(effort)) return effort;
  return supported.sort((a, b) => Math.abs(order.indexOf(a) - order.indexOf(effort)) - Math.abs(order.indexOf(b) - order.indexOf(effort)))[0];
}

/**
 * Put a helper's Pi on its bot's own model, at low reasoning. The model is the one the user chose for
 * the bot (or as the bots' default), else the one its main session settled on with no choice made;
 * with neither, a new Pi starts on Pi's default, which is what the main session runs on too. Never
 * another, cheaper model: a chosen model that can't be set fails the helper.
 */
export async function applyHelperModel(proc: Pick<HelperProc, "send">, botId: string): Promise<void> {
  const chosen = db.getBot(botId)?.model || svc.getSettings().defaultModel;
  const model = chosen || db.getValue<string>(`primary:${botId}`) || undefined;
  if (model?.includes("/")) {
    const slash = model.indexOf("/");
    try {
      await proc.send({ type: "set_model", provider: model.slice(0, slash), modelId: model.slice(slash + 1) }, 20_000);
    } catch (err) {
      // Nobody chose the one it settled on: Pi's own default, which the process started on, stands.
      if (chosen) throw err;
    }
  }
  const { levels } = await proc.send<{ levels?: string[] }>({ type: "get_available_thinking_levels" });
  const level = nearestEffort(Array.isArray(levels) ? levels : [], HELPER_EFFORT);
  if (level) await proc.send({ type: "set_thinking_level", level });
}

const assistantText = (message: PiRecord) => (Array.isArray(message.content) ? message.content.filter((b: PiRecord) => b?.type === "text").map((b: PiRecord) => String(b.text ?? "")).join("") : "");

/**
 * Run one prompt on a helper session and return what it answered, in plain text. With `tools` it can
 * look things up (HELPER_TOOLS, held to those in agent.ts); without, it only writes.
 * The process is gone when this returns, however it ends.
 */
export async function runHelper(botId: string, opts: { prompt: string; tools?: boolean; signal: AbortSignal; timeoutMs?: number }): Promise<string> {
  if (opts.signal.aborted) throw new JobCancelled();
  const token = opts.tools ? mintToken(botId, "helper") : undefined;
  let proc: HelperProc | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => proc?.close();
  try {
    // Asked for when it's needed: extensions.ts starts Pi processes of its own, which most of what loads this file never wants.
    const { helperFlags } = await import("./extensions");
    if (opts.signal.aborted) throw new JobCancelled();
    proc = seams.spawn(botId, helperFlags(!!opts.tools), token ? { OPENBOTS_SOCKET: agentSocketPath(), OPENBOTS_TOKEN: token, OPENBOTS_BOT: botId, OPENBOTS_HELPER: "1" } : {});
    opts.signal.addEventListener("abort", onAbort);
    let text = "";
    let error: string | undefined;
    const settled = new Promise<void>((resolve, reject) => {
      proc!.on((record) => {
        if (record.type === "agent_settled") resolve();
        if (record.type === "process_exit") reject(new PiError(String(record.message ?? "Pi exited")));
        const ended = record.type === "message_end" && record.message?.role === "assistant" ? record.message : undefined;
        if (!ended) return;
        if (ended.stopReason === "error") error = String(ended.errorMessage || "The model returned an error.");
        else if (assistantText(ended).trim()) text = assistantText(ended);
      });
      // Cancelled: nothing waits for the process to say it's gone.
      opts.signal.addEventListener("abort", () => reject(new JobCancelled()), { once: true });
      timer = setTimeout(() => reject(new PiError("The helper took too long.")), opts.timeoutMs ?? 60_000);
      timer.unref?.();
    });
    // Nothing waits on a helper that's cancelled before it settles.
    settled.catch(() => {});
    await applyHelperModel(proc, botId);
    await proc.send({ type: "prompt", message: opts.prompt }, 60_000);
    await settled;
    if (opts.signal.aborted) throw new JobCancelled();
    if (error && !text.trim()) throw new PiError(error);
    return text.trim();
  } catch (err) {
    throw opts.signal.aborted ? new JobCancelled() : err;
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener("abort", onAbort);
    proc?.close();
    if (token) revokeToken(token);
  }
}
