// A bot's job board. A tool call that's still running past a threshold stops holding the turn: the
// bot is told at once that it carries on as "job N", its turn can end, and the job's result wakes it
// in the conversation it started from. The board (what's running, what each is for, what's queued
// behind it) rides with every prompt, so a bot that's asked for something else meanwhile knows what
// it still has going, and a result that comes back late is read against it before anything is done
// with it. No second session and no other model: the work is the tool call itself, on this server.
//
// The numbers here were decided from the bots' own sessions: scripts/bot-tool-latency.ts prints the
// tables, and docs/openbots-async-jobs.md keeps the ones they were read from.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { botsDir } from "./db";
import * as db from "./db";
import * as svc from "./service";

/**
 * How long a call may hold a turn nobody is waiting on. Between 5 and 10 seconds the tool time a
 * detach frees, less the model call it costs, is flat; inside that plateau 9 s wastes the fewest: one
 * call in five that's still running then would have returned within a model call anyway, against one
 * in two at 5 s. Past 9 s a call typically runs another 11 s.
 */
export const DETACH_AFTER_MS = 9_000;
/**
 * The same, once someone is waiting on the bot (a message steered into the turn that Pi can't hand
 * over until the call returns, or one queued for it in another chat). A call that young has most
 * likely nearly finished, so it gets this long; past it, the share that would have returned by
 * themselves stops falling (24% from here to 5 s) while the wait keeps growing.
 */
export const DETACH_WAITED_MS = 3_000;
/**
 * A result up to this many characters comes back whole. It's the 90th percentile of the results of
 * calls that ran long, rounded up: more than nine results in ten fit, with nothing more to fetch.
 */
export const RESULT_WHOLE_MAX = 6_000;
/** A longer one comes back as its start and its end (where a command says how it went), the rest one call away. */
export const RESULT_SUMMARY_HEAD = 500;
export const RESULT_SUMMARY_TAIL = 1_500;
/** How much of a stored result one `jobs result` call returns: 99 results in 100 fit in one. */
export const RESULT_PAGE = 20_000;
/** Finished jobs a bot can still read the result of. */
const KEEP_FINISHED = 12;
/**
 * How many jobs one bot has going at once. With that many out, a further call holds its turn like
 * any call used to, which is what slows a bot down that keeps starting more.
 */
export const JOB_CAP = 4;
/** The longest a job may go without returning. Past it the bot is told it never came back, and it's stopped if it can be. */
export const JOB_MAX_MS = 30 * 60_000;
/** How long after a job ended its bot still has the jobs tool declared without asking, to read the result. */
const RECENT_MS = 30 * 60_000;

/**
 * The tools a call can detach from: work on the bot's computers, the web, apps and coding threads.
 * Never the bot's own messaging (send_message, question, poll, vote_poll, html_render), reactions or
 * memory, nor anything else that talks to the chat or to other bots: those are the turn itself.
 */
export const DETACHABLE = new Set(["bash", "read", "write", "edit", "browser", "process", "openbuild", "use_app", "bot_web_search"]);
/** Of those, the ones whose work really stops when the job is cancelled. The others finish, and their result is dropped. */
const STOPPABLE = new Set(["bash", "bot_web_search"]);

/** Tests shorten these. */
export const tuning = { detachAfterMs: DETACH_AFTER_MS, detachWaitedMs: DETACH_WAITED_MS, maxMs: JOB_MAX_MS };

export interface Job {
  id: number;
  tool: string;
  /** What it's for: the status line the bot wrote for the call. */
  label: string;
  /** The call itself, in brief: the command, the query, the page. */
  detail?: string;
  /** Where it was started, and where its result wakes the bot. */
  conversationId: string;
  /** The user's request it was started for, where the conversation tracks those. */
  request?: string[];
  startedAt: number;
  /** The conversation's last message when the call was made: what came after is news to this job. */
  seq: number;
  state: "running" | "done" | "failed" | "cancelled" | "lost";
  endedAt?: number;
  /** How long its result is. The text is in a file of its own. */
  chars?: number;
  /** Its result has gone to the bot: it's off the board. */
  told?: boolean;
  /** What the bot queued to do once it's in, in order. */
  followUps: string[];
}

/** What a detached call returns in place of its result. */
export interface Started {
  job: number;
  state: "running";
  note: string;
}

type Waiting = "here" | "elsewhere" | undefined;
type Hooks = {
  /** Someone is waiting on the bot right now: in the chat its turn is in, or in another. */
  waiting: (botId: string) => Waiting;
  /** The status line the bot wrote for the call it's inside, if that's a call to `tool`. */
  label: (botId: string, tool: string) => string | undefined;
  /** The bot's board changed: its status may need to say so. */
  changed: (botId: string) => void;
};

/** A call in flight: one that hasn't returned yet, detached or not. */
interface Live {
  botId: string;
  tool: string;
  startedAt: number;
  abort: AbortController;
  waited: Waiting;
  detach?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  job?: number;
}

const hot = globalThis as { openbotsLiveCalls?: Map<string, Set<Live>>; openbotsJobHooks?: Hooks; openbotsBrowserTails?: Map<string, Promise<unknown>> };
const live: Map<string, Set<Live>> = (hot.openbotsLiveCalls ??= new Map());
const tails: Map<string, Promise<unknown>> = (hot.openbotsBrowserTails ??= new Map());
let hooks: Hooks = (hot.openbotsJobHooks ??= { waiting: () => undefined, label: () => undefined, changed() {} });
/** runner.ts registers these at startup. */
export function setJobHooks(next: Hooks) {
  hooks = hot.openbotsJobHooks = next;
}

// ------------------------------------------------------------------ the board, as stored

interface Stored {
  next: number;
  jobs: Job[];
}
const key = (botId: string) => `jobs:${botId}`;
const read = (botId: string): Stored => db.getValue<Stored>(key(botId)) ?? { next: 1, jobs: [] };
const resultFile = (botId: string, id: number) => join(botsDir(), "jobs", botId, `${id}.txt`);

function write(botId: string, board: Stored) {
  // Old results go once enough newer ones have come in.
  const finished = board.jobs.filter((j) => j.state !== "running" && j.told);
  for (const gone of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
    board.jobs = board.jobs.filter((j) => j !== gone);
    rmSync(resultFile(botId, gone.id), { force: true });
  }
  db.setValue(key(botId), board);
}

function change(botId: string, id: number, edit: (job: Job) => void): Job | undefined {
  const board = read(botId);
  const job = board.jobs.find((j) => j.id === id);
  if (!job) return undefined;
  edit(job);
  write(botId, board);
  return job;
}

/** A bot's jobs, oldest first: the running ones, and the latest finished. */
export function jobsOf(botId: string): Job[] {
  return read(botId).jobs;
}
/** What it's still waiting on. */
export function runningJobs(botId: string): Job[] {
  return jobsOf(botId).filter((j) => j.state === "running");
}
/** Whether its board is live enough to declare the jobs tool for: something running, or just in. */
export function hasBoard(botId: string): boolean {
  const now = Date.now();
  return jobsOf(botId).some((j) => j.state === "running" || (j.endedAt !== undefined && now - j.endedAt < RECENT_MS));
}

// ------------------------------------------------------------------ a call that may detach

const seconds = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)} min`;
};
const brief = (value: unknown, max = 80) => {
  const line = String(value ?? "").split("\n").find((l) => l.trim())?.replace(/\s+/g, " ").trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** The call in a few words, for the bot that made it: which command, which query, which page. */
export function callDetail(tool: string, p: Record<string, unknown>): string {
  const parts = (...values: unknown[]) => values.map((v) => brief(v)).filter(Boolean).join(" ");
  if (tool === "bash") return brief(p.command);
  if (tool === "bot_web_search") return brief(p.query);
  if (tool === "browser") return parts(p.action, p.url ?? p.text ?? p.ref);
  if (tool === "openbuild") return parts(p.action, p.thread ?? p.project, p.number ? `#${p.number}` : "");
  if (tool === "use_app") return parts(p.app, p.tool);
  if (tool === "process") return parts(p.action, p.name ?? p.command ?? p.id);
  return brief(p.path);
}

function arm(call: Live) {
  clearTimeout(call.timer);
  if (!call.detach) return;
  const after = call.waited ? tuning.detachWaitedMs : tuning.detachAfterMs;
  call.timer = setTimeout(call.detach, Math.max(0, call.startedAt + after - Date.now()));
  call.timer.unref?.();
}

/**
 * Someone just wrote to a bot that's inside a call: it can't read them until the call returns, so
 * the call gets the shorter threshold from when it started, and detaches now if it's already past it.
 */
export function hurry(botId: string, where: Exclude<Waiting, undefined>) {
  for (const call of live.get(botId) ?? []) {
    if (!call.detach || call.waited === "here") continue;
    call.waited = where;
    arm(call);
  }
}

/**
 * Run a tool call for a bot's own session. One that can detach returns its result as ever when it's
 * quick; still running at the threshold, it returns `Started` instead and carries on as a job.
 * `conversationId` is the chat the call was made in.
 */
export async function run<T>(
  botId: string,
  tool: string,
  params: Record<string, unknown>,
  work: (signal: AbortSignal) => Promise<T>,
  opts: { conversationId?: string } = {},
): Promise<T | Started> {
  const abort = new AbortController();
  if (!DETACHABLE.has(tool)) return work(abort.signal);
  const call: Live = { botId, tool, startedAt: Date.now(), abort, waited: hooks.waiting(botId) };
  const seq = opts.conversationId ? db.latestSeq(opts.conversationId) : 0;
  const calls = live.get(botId) ?? new Set<Live>();
  calls.add(call);
  live.set(botId, calls);
  const done = () => {
    clearTimeout(call.timer);
    calls.delete(call);
    if (!calls.size && live.get(botId) === calls) live.delete(botId);
  };
  // One browser per machine: a call made while an earlier one is still going there waits for it.
  const lane = tool === "browser" ? `${botId}:${String(params.machine ?? "")}` : undefined;
  const before = lane ? tails.get(lane) : undefined;
  const started = before ? before.then(() => work(abort.signal)) : work(abort.signal);
  const outcome = started.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  if (lane) {
    tails.set(lane, outcome);
    void outcome.then(() => { if (tails.get(lane) === outcome) tails.delete(lane); });
  }
  const detached = new Promise<"detached">((resolve) => (call.detach = () => resolve("detached")));
  arm(call);
  const first = await Promise.race([outcome, detached]);
  call.detach = undefined;
  clearTimeout(call.timer);
  if (first !== "detached") {
    done();
    if (first.ok) return first.value;
    throw first.error;
  }
  const conversationId = opts.conversationId ?? svc.directId(botId);
  // Stopped meanwhile (a call that can't be interrupted still runs to its end), nowhere to report to
  // (the bot is gone), or enough out already: the call is waited out, as any call used to be.
  if (abort.signal.aborted || !conversationId || !db.getBot(botId) || runningJobs(botId).length >= JOB_CAP) {
    const late = await outcome.finally(done);
    if (late.ok) return late.value;
    throw late.error;
  }
  const board = read(botId);
  const detail = callDetail(tool, params);
  const job: Job = {
    id: board.next++,
    tool,
    label: hooks.label(botId, tool) || detail || tool,
    ...(detail ? { detail } : {}),
    conversationId,
    request: svc.requestIn(botId, conversationId),
    startedAt: call.startedAt,
    seq: conversationId === opts.conversationId ? seq : db.latestSeq(conversationId),
    state: "running",
    followUps: [],
  };
  board.jobs.push(job);
  write(botId, board);
  call.job = job.id;
  // One that never returns doesn't sit on the board for good.
  const limit = setTimeout(() => {
    finish(botId, job.id, { error: `It hadn't returned after ${seconds(tuning.maxMs)}, so it was given up on${STOPPABLE.has(tool) ? " and stopped" : ""}.` });
    abort.abort();
  }, Math.max(0, call.startedAt + tuning.maxMs - Date.now()));
  limit.unref?.();
  void outcome.then((late) => {
    clearTimeout(limit);
    done();
    finish(botId, job.id, late.ok ? { text: resultText(late.value) } : { error: late.error instanceof Error ? late.error.message : String(late.error) });
  });
  hooks.changed(botId);
  const others = runningJobs(botId).length - 1;
  return {
    job: job.id,
    state: "running",
    note: [
      `Still running after ${seconds(Date.now() - call.startedAt)}, so it carries on in the background as job ${job.id}. Don't wait for it and don't run it again: its result wakes you here when it's in.`,
      call.waited === "elsewhere"
        ? "A message is waiting for you in another chat: end this turn now, with one short line here if the user is waiting on this."
        : "If the user is waiting on this and hasn't heard from you, tell them in one short line what's running. Then carry on with anything else you were asked, or end your turn.",
      `The jobs tool cancels it, or queues what to do once it's in (action follow_up).${others > 0 ? ` You have ${others} other ${others === 1 ? "job" : "jobs"} running.` : ""}`,
    ].join(" "),
  };
}

/** A tool's result as its text, the way the extension writes one for the model. */
function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  const app = value as { text?: unknown; images?: unknown[]; isError?: boolean } | null;
  // An app's tool answers with text and maybe images: the text is what there is to hand over later.
  if (app && typeof app === "object" && typeof app.text === "string" && ("images" in app || "isError" in app)) {
    const images = Array.isArray(app.images) ? app.images.length : 0;
    return `${app.isError ? "Error: " : ""}${app.text || "(no output)"}${images ? `\n(${images} ${images === 1 ? "image" : "images"} came with it; call the tool again to see ${images === 1 ? "it" : "them"}.)` : ""}`;
  }
  return JSON.stringify(value, null, 2) ?? "";
}

/** A job's call returned. Cancelled meanwhile, its result goes nowhere; otherwise it's kept and the bot is woken with it. */
function finish(botId: string, id: number, outcome: { text: string } | { error: string }) {
  if (!db.getBot(botId)) return;
  const text = "text" in outcome ? outcome.text : `Error: ${outcome.error}`;
  if (jobsOf(botId).find((j) => j.id === id)?.state !== "running") return;
  const job = change(botId, id, (j) => {
    j.state = "text" in outcome ? "done" : "failed";
    j.endedAt = Date.now();
    j.chars = text.length;
  })!;
  try {
    mkdirSync(join(botsDir(), "jobs", botId), { recursive: true, mode: 0o700 });
    writeFileSync(resultFile(botId, id), text, { mode: 0o600 });
  } catch (err) {
    console.warn(`[bots] ${botId} couldn't keep job ${id}'s result:`, err instanceof Error ? err.message : err);
  }
  tell(botId, job, text);
}

/** Wake the bot with a job's result, where the job was started, or in its own chat if that one is gone. */
function tell(botId: string, job: Job, text: string) {
  const origin = db.getConversation(job.conversationId)?.botIds.includes(botId) ? job.conversationId : svc.directId(botId);
  const note = resultNote(job, text, origin);
  change(botId, job.id, (j) => {
    j.told = true;
    j.followUps = [];
  });
  hooks.changed(botId);
  if (!origin) return;
  svc.wakeBot(botId, { kind: "note", conversationId: origin, ...(job.request?.length && origin === job.conversationId ? { messageIds: job.request } : {}), text: note });
}

const describe = (job: Job) => `${job.tool}${job.detail && job.detail !== job.label ? ` “${job.detail}”` : ""}`;

/** A result as it's handed over: whole when it's short, else its two ends and how to get the rest. */
export function resultBody(job: Pick<Job, "id">, text: string): string {
  if (text.length <= RESULT_WHOLE_MAX) return `Its result:\n${text || "(no output)"}`;
  const lines = text.split("\n").length;
  const left = text.length - RESULT_SUMMARY_HEAD - RESULT_SUMMARY_TAIL;
  return [
    `Its result is ${text.length.toLocaleString("en-US")} characters over ${lines.toLocaleString("en-US")} ${lines === 1 ? "line" : "lines"}, so here are its first ${RESULT_SUMMARY_HEAD} and last ${RESULT_SUMMARY_TAIL.toLocaleString("en-US")}. The whole of it is one call away: jobs with action result and job ${job.id} (offset and limit page through it).`,
    text.slice(0, RESULT_SUMMARY_HEAD),
    `[… ${left.toLocaleString("en-US")} characters left out …]`,
    text.slice(-RESULT_SUMMARY_TAIL),
  ].join("\n");
}

/**
 * What wakes the bot when a job is in: the result, and what to read it against. A job answers the
 * plan as it stood when it started; the note says what was queued behind it and what the user wrote
 * since, so a result nobody wants anymore is dropped rather than acted on.
 */
export function resultNote(job: Job, text: string, origin: string | undefined = job.conversationId): string {
  const user = svc.getSettings().user?.name || "the user";
  const took = seconds((job.endedAt ?? Date.now()) - job.startedAt);
  const since = origin === job.conversationId ? db.messagesAfter(origin, job.seq, 200).filter((r) => r.message.author === "me" && !r.message.event) : [];
  const moved = origin !== job.conversationId ? " The chat you started it from is gone, so it's reported here." : "";
  const ids = since.slice(-6).map((r) => `[${r.message.id.slice(0, 8)}]`).join(" ");
  const check = since.length
    ? `Before you act on it, read it against what's changed: ${user} wrote ${since.length === 1 ? "a message" : `${since.length} messages`} here after you started it (${ids}). If that changed the plan and this no longer matters, drop it: don't act on it and don't report it.`
    : `${user[0]!.toUpperCase()}${user.slice(1)} hasn't written here since you started it, so the plan stands.`;
  const queued = job.followUps.length
    ? `Queued behind it, to do now and in this order unless the plan changed:\n${job.followUps.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
    : "";
  return [
    `Job ${job.id} ${job.state === "failed" ? "failed" : "finished"} after ${took}: ${describe(job)}, which you started for “${job.label}”.${moved}`,
    job.state === "failed" ? `It failed:\n${text.slice(0, RESULT_WHOLE_MAX)}` : resultBody(job, text),
    check,
    queued,
    "Carry on from it. If there's nothing in it the user needs to hear, end with [silent].",
  ].filter(Boolean).join("\n\n");
}

// ------------------------------------------------------------------ the board, as the bot reads it

/**
 * The board for a prompt in `conversationId`: every job still running and what's queued behind each.
 * Empty when there's nothing going, so a bot with no jobs pays nothing for it.
 */
export function board(botId: string, conversationId?: string): string {
  const running = runningJobs(botId);
  if (!running.length) return "";
  const now = Date.now();
  const lines = running.map((j) => {
    const where = conversationId && j.conversationId !== conversationId ? `, started in conversation ${j.conversationId.slice(0, 8)}` : "";
    const queued = j.followUps.map((f, i) => `\n  then ${i + 1}. ${f}`).join("");
    return `- job ${j.id}, running for ${seconds(now - j.startedAt)}: ${describe(j)}, for “${j.label}”${where}${queued}`;
  });
  return `Your job board: what you have running in the background. Each result wakes you when it's in, so don't wait on one or run it again. The jobs tool cancels one (when it's no longer wanted) or queues a follow-up behind it (what to do once it's in).\n${lines.join("\n")}`;
}

/** What a bot between turns is waiting on, for its status: the jobs' own lines, never a generic word. */
export function waitingLine(botId: string): { activity: string; conversationId: string; since: number; jobs: number } | undefined {
  const running = runningJobs(botId);
  const first = running[0];
  if (!first) return undefined;
  const more = running.length - 1;
  return { activity: `Waiting on: ${first.label}${more ? ` (+${more} more)` : ""}`, conversationId: first.conversationId, since: first.startedAt, jobs: running.length };
}

// ------------------------------------------------------------------ cancelling

function stop(botId: string, job: Job) {
  for (const call of live.get(botId) ?? []) if (call.job === job.id) call.abort.abort();
}

/**
 * Stop everything a bot has going through its tools: its jobs, and any call still holding its turn.
 * Nothing is reported for them. Says how many jobs that was.
 */
export function cancelAll(botId: string): number {
  const board = read(botId);
  const running = board.jobs.filter((j) => j.state === "running");
  for (const job of running) {
    job.state = "cancelled";
    job.endedAt = Date.now();
    job.told = true;
  }
  if (running.length) write(botId, board);
  for (const call of live.get(botId) ?? []) call.abort.abort();
  if (running.length) hooks.changed(botId);
  return running.length;
}

/** The bot is gone: so are its board and the results it kept. */
export function forget(botId: string) {
  cancelAll(botId);
  db.setValue(key(botId), { next: 1, jobs: [] });
  rmSync(join(botsDir(), "jobs", botId), { recursive: true, force: true });
}

/**
 * The server came back up: a job that was running when it went down has no result coming. Its bot is
 * told once, so the work isn't silently lost.
 */
export function recover() {
  for (const bot of db.listBots()) {
    const lost = runningJobs(bot.id).filter((j) => ![...(live.get(bot.id) ?? [])].some((call) => call.job === j.id));
    for (const job of lost) {
      change(bot.id, job.id, (j) => {
        j.state = "lost";
        j.endedAt = Date.now();
        j.told = true;
      });
      const origin = db.getConversation(job.conversationId)?.botIds.includes(bot.id) ? job.conversationId : svc.directId(bot.id);
      if (!origin) continue;
      const queued = job.followUps.length ? ` You had queued behind it: ${job.followUps.join("; ")}.` : "";
      svc.wakeBot(bot.id, { kind: "note", conversationId: origin, text: `Job ${job.id} (${describe(job)}, for “${job.label}”) was cut off when OpenBuild restarted, so it has no result.${queued} Run it again if it still matters, and tell ${svc.getSettings().user?.name || "the user"} if they're waiting on it; otherwise stay [silent].` });
    }
  }
}

// ------------------------------------------------------------------ the jobs tool

function pick(botId: string, ref: unknown): Job {
  const all = jobsOf(botId);
  const given = String(ref ?? "").trim().replace(/^(?:job\s*)?#?/i, "");
  if (!given) {
    const running = all.filter((j) => j.state === "running");
    if (running.length === 1) return running[0]!;
    throw new svc.BotsError(running.length ? `Say which job: ${running.map((j) => j.id).join(", ")}.` : "You have no job running. jobs with action list shows the latest.");
  }
  const job = all.find((j) => String(j.id) === given);
  if (!job) throw new svc.BotsError(`There's no job ${given}. jobs with action list shows yours.`);
  return job;
}

const line = (j: Job, now: number) =>
  j.state === "running"
    ? `job ${j.id}, running for ${seconds(now - j.startedAt)}: ${describe(j)}, for “${j.label}”${j.followUps.map((f, i) => `\n  then ${i + 1}. ${f}`).join("")}`
    : `job ${j.id}, ${j.state === "done" ? "finished" : j.state === "lost" ? "cut off by a restart" : j.state}${j.endedAt ? ` after ${seconds(j.endedAt - j.startedAt)}` : ""}: ${describe(j)}, for “${j.label}”${j.chars !== undefined ? ` (${j.chars.toLocaleString("en-US")} characters)` : ""}`;

/** The jobs tool: list them, read a result, cancel one or all, or queue a follow-up behind one. */
export function jobsTool(botId: string, p: Record<string, unknown>): unknown {
  const action = String(p.action ?? "list");
  const now = Date.now();
  if (action === "list") {
    const all = jobsOf(botId);
    if (!all.length) return "You have no background jobs.";
    const running = all.filter((j) => j.state === "running");
    const finished = all.filter((j) => j.state !== "running").slice(-6);
    return [running.length ? `Running:\n${running.map((j) => `- ${line(j, now)}`).join("\n")}` : "Nothing is running.", finished.length ? `Latest finished (jobs with action result reads one):\n${finished.map((j) => `- ${line(j, now)}`).join("\n")}` : ""].filter(Boolean).join("\n");
  }
  if (action === "result") {
    const job = pick(botId, p.job);
    if (job.state === "running") return { job: job.id, state: "running", note: `Still running after ${seconds(now - job.startedAt)}. Its result wakes you when it's in.` };
    if (job.state === "cancelled" || job.state === "lost") return { job: job.id, state: job.state, note: job.state === "cancelled" ? "It was cancelled, so it has no result." : "It was cut off by a restart, so it has no result." };
    let text: string;
    try {
      text = readFileSync(resultFile(botId, job.id), "utf8");
    } catch {
      throw new svc.BotsError(`Job ${job.id}'s result isn't kept anymore. Run it again if you still need it.`);
    }
    const offset = Math.max(0, Math.floor(Number(p.offset) || 0));
    const limit = Math.min(RESULT_PAGE, Math.max(1, Math.floor(Number(p.limit) || RESULT_PAGE)));
    const end = Math.min(text.length, offset + limit);
    return { job: job.id, state: job.state, chars: text.length, offset, text: text.slice(offset, end), ...(end < text.length ? { more: `${text.length - end} more characters: pass offset ${end}.` } : {}) };
  }
  if (action === "cancel") {
    if (p.job === "all" || p.all === true) {
      const n = cancelAll(botId);
      return { cancelled: n, note: n ? "Cancelled. None of them will report back." : "Nothing was running." };
    }
    const job = pick(botId, p.job);
    if (job.state !== "running") return { job: job.id, state: job.state, note: "It had already ended, so there was nothing to cancel." };
    change(botId, job.id, (j) => {
      j.state = "cancelled";
      j.endedAt = now;
      j.told = true;
    });
    stop(botId, job);
    hooks.changed(botId);
    const dropped = job.followUps.length ? ` What was queued behind it is dropped too: ${job.followUps.join("; ")}.` : "";
    return { job: job.id, state: "cancelled", note: `${STOPPABLE.has(job.tool) ? "Cancelled: it was stopped, and won't report back." : "Cancelled: it won't report back. What it was doing may still go through, as it couldn't be interrupted."}${dropped}` };
  }
  if (action === "follow_up") {
    const job = pick(botId, p.job);
    if (job.state !== "running") throw new svc.BotsError(`Job ${job.id} has already ended, so there's nothing to queue behind it. Do it now.`);
    if (p.remove !== undefined && p.remove !== null && p.remove !== "") {
      const n = Math.floor(Number(String(p.remove).replace(/^#/, "")));
      if (!job.followUps[n - 1]) throw new svc.BotsError(`Job ${job.id} has no follow-up ${p.remove}.`);
      const after = change(botId, job.id, (j) => void j.followUps.splice(n - 1, 1))!;
      return { job: job.id, follow_ups: after.followUps };
    }
    const text = String(p.text ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    if (!text) throw new svc.BotsError("Say what to do once it's in, in text.");
    if (job.followUps.length >= 8) throw new svc.BotsError(`Job ${job.id} already has 8 follow-ups queued. Remove one first, or fold this into one of them.`);
    const after = change(botId, job.id, (j) => void j.followUps.push(text))!;
    return { job: job.id, follow_ups: after.followUps, note: `Queued. You'll get it back with job ${job.id}'s result. If ${svc.getSettings().user?.name || "the user"} just asked for it, tell them it's noted.` };
  }
  throw new svc.BotsError("action is list, result, cancel or follow_up.");
}
