// One Pi process per bot. It stays up while the bot is in a conversation and exits after it's been
// idle, the same way threads do. Messages that arrive mid-reply are steered in; everything else waits
// and runs when the bot is free. The process loads server/bots/extension.ts, which calls back over
// the unix socket in agent.ts.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appById } from "../../shared/apps";
import { botModelChain, conversationTitle, eventDetail, eventText, MODEL_SIGN_IN, mentionName, reactionId, pollVotesVisible, replyBubbles, shownReplyError, type BotMessage } from "../../shared/bots";
import { procListeners } from "../computers/index";
import { PiError, PiProcess, type PiRecord } from "../pi/rpc";
import { agentDir, piBin } from "../pi/install";
import { listModels, onModelsForgotten } from "../pi/sessions";
import { piFlags } from "./extensions";
import { botsDir } from "./db";
import * as db from "./db";
import { agentSocketPath, getFocus, listen, mintToken, revokeToken, setFocus } from "./agent";
import * as svc from "./service";
import { resumeWatches } from "./threads";
import type { Wake } from "./service";
import type { BotStatus, PiSetup } from "../../shared/bots";

const IDLE = 20 * 60 * 1000;

interface Mind {
  proc: PiProcess;
  token: string;
  /** The extensions it started with. */
  loaded: string;
  busy: boolean;
  /** The bot already wrote to the chat this run, so leftover assistant text isn't posted too. */
  sent: boolean;
  draft: string;
  /** Writing a message right now: the chat shows it typing. */
  typing: boolean;
  /**
   * Keep the chat clear unless it starts typing (see BotStatus.quiet): a turn for reactions only
   * ("reaction", until it writes), or just after a message ("sent", until it picks up real work).
   */
  quiet: false | "reaction" | "sent";
  activity: string;
  /** Between handing Pi the prompt and it settling: a message now can be steered into the turn. */
  steerable?: boolean;
  /** Per conversation, the last message this turn has put in front of the bot, images and all. */
  shown?: Map<string, number>;
  /** The last scoped group steer on its way: resolves to whether Pi took it. */
  steering?: Promise<boolean>;
  /** Group requests steered into this turn's current attempt. */
  steered?: Wake[];
  /** The model's last call failed (an expired sign-in, say): Pi ends the turn with no text, only this. */
  error?: string;
  /** This attempt ran a tool or wrote text, so trying it again on another model could repeat what it did. */
  acted?: boolean;
  /** Tells of the attempt's model once it takes the turn on: its first text or tool, or settling without either. */
  onCommit?: () => void;
  onSettled?: () => void;
  onExit?: (e: Error) => void;
}

const hot = globalThis as {
  openbotsMinds?: Map<string, Mind>;
  openbotsQueue?: Map<string, Wake[]>;
  openbotsTimer?: ReturnType<typeof setInterval>;
  openbotsProc?: boolean;
  openbotsPumping?: Set<string>;
  openbotsModelsWatch?: () => void;
};
const minds = (hot.openbotsMinds ??= new Map());
const queue = (hot.openbotsQueue ??= new Map());
const pumping = (hot.openbotsPumping ??= new Set<string>());

export function busy(botId: string): boolean {
  return pumping.has(botId) || (queue.get(botId)?.length ?? 0) > 0;
}

export function wake(botId: string, item: Wake) {
  const mind = minds.get(botId);
  // Only a message in the conversation it's working in joins the current turn. Everything else gets a
  // turn of its own, so a routine actually runs and its replies land in its own conversation.
  const conversationId = item.conversationId;
  const group = db.getConversation(conversationId ?? "")?.kind === "group";
  // A user request routed to this bot in the group it's working in joins the turn, scoped to that request alone.
  if (group && item.kind === "messages" && item.messageIds?.length && mind && steerableIn(botId, mind, conversationId!) && !waitsBehind(botId, conversationId!)) {
    steerAssigned(botId, mind, item);
    return;
  }
  // Other group wakes queue: an unscoped steer could expose user requests assigned to other bots.
  if (!group && !item.messageIds && (item.kind === "messages" || item.kind === "reaction") && conversationId && conversationId === getFocus(botId) && pumping.has(botId) && mind?.steerable && mind.shown && !mind.proc.exited) {
    const shown = mind.shown;
    // What this turn hasn't seen yet, screenshots included: they'd otherwise never reach the bot.
    const from = Math.max(db.cursor(botId, conversationId), shown.get(conversationId) ?? 0);
    const through = db.latestSeq(conversationId);
    const text = render([item], botId);
    const images = imagesBetween(conversationId, from, through);
    shown.set(conversationId, through);
    if (item.kind === "messages") {
      mind.quiet = false;
      show(botId, mind);
    }
    void mind.proc
      // The turn's end moves the cursor, so a steer that failed before this one isn't skipped past.
      .send({ type: "steer", message: text, ...(images.length ? { images } : {}) }, 15_000)
      .catch(() => {
        // Not delivered: the turn's end leaves these unread, so the next turn picks them up.
        shown.set(conversationId, Math.min(shown.get(conversationId) ?? from, from));
        enqueue(botId, item);
      });
    return;
  }
  enqueue(botId, item);
}

function steerableIn(botId: string, mind: Mind, conversationId: string): boolean {
  return conversationId === getFocus(botId) && pumping.has(botId) && !!mind.steerable && !!mind.shown && !mind.proc.exited;
}

/** An earlier request for this group is still waiting its turn: a later one doesn't jump ahead of it. */
function waitsBehind(botId: string, conversationId: string): boolean {
  return (queue.get(botId) ?? []).some((j: Wake) => j.kind === "messages" && j.conversationId === conversationId && j.messageIds);
}

/**
 * Steers exactly the requests a wake assigns into the live turn: their lines and their images, nothing
 * else from the transcript. Steers go one after another, so one that fails sends those behind it to the
 * queue too, in order. Nothing moves the cursor: what the bot was shown is still the turn's start.
 */
function steerAssigned(botId: string, mind: Mind, item: Wake) {
  const conversationId = item.conversationId!;
  const ids = item.messageIds!;
  const prior = mind.steering;
  const turn = mind.shown;
  const attempt = (async () => {
    if (prior && !(await prior)) return false;
    // The turn this was meant for may have ended while an earlier steer was on its way.
    if (mind.shown !== turn || !steerableIn(botId, mind, conversationId)) return false;
    const images = ids.flatMap((id) => {
      const row = db.getMessage(id);
      return row?.conversationId === conversationId ? imagesBetween(conversationId, row.seq - 1, row.seq) : [];
    }).slice(-IMAGE_LIMIT);
    mind.quiet = false;
    show(botId, mind);
    const took = await mind.proc.send<{ disposition?: string } | undefined>({ type: "steer", message: steerNote(conversationId, botId, ids), ...(images.length ? { images } : {}) }, 15_000);
    return took?.disposition ?? "queued";
  })().catch(() => undefined);
  mind.steering = attempt.then((disposition) => !!disposition);
  void attempt.then((disposition) => {
    if (!disposition) return enqueue(botId, item);
    // A model that fails before acting hands the turn to the next one, whose prompt doesn't have these.
    // One an extension handled is done with.
    if (disposition !== "handled" && mind.shown === turn) (mind.steered ??= []).push(item);
    markSeen(botId, new Map(), new Set(ids));
  });
}

function enqueue(botId: string, item: Wake) {
  const list = queue.get(botId) ?? [];
  list.push(item);
  queue.set(botId, list);
  // Busy in another chat: that one shows it holding on until its turn comes.
  const now = svc.getStatus(botId);
  if (pumping.has(botId) && now && now.state !== "idle") setStatus(botId, now);
  void pump(botId);
}

/** Conversations whose messages wait for the bot to finish elsewhere. Reactions and routines don't need an answer shown. */
export function waitingIn(botId: string): string[] {
  const focus = getFocus(botId);
  const ids: string[] = (queue.get(botId) ?? []).filter((j: Wake) => j.kind === "messages" && j.conversationId && j.conversationId !== focus).map((j: Wake) => j.conversationId!);
  return [...new Set(ids)];
}

function setStatus(botId: string, next: BotStatus) {
  const waiting = next.state === "idle" ? [] : waitingIn(botId);
  // A message waiting in the chat it's working in isn't quiet work: the chat shows it busy until it gets there.
  const owed = !!next.quiet && (queue.get(botId) ?? []).some((j: Wake) => j.kind === "messages" && j.conversationId === next.conversationId);
  svc.setStatus(botId, { ...next, quiet: owed ? undefined : next.quiet, waiting: waiting.length ? waiting : undefined });
}

async function pump(botId: string) {
  if (pumping.has(botId)) return;
  pumping.add(botId);
  const mind = minds.get(botId);
  if (mind) mind.busy = true;
  try {
    while (queue.get(botId)?.length) {
      const jobs = queue.get(botId)!;
      const first = jobs[0]!;
      // Keep assigned deliveries separate from context-only wakes, even in the same group.
      const turn = first.kind === "routine" ? [first] : jobs.filter((j: Wake) => j.kind !== "routine" && j.conversationId === first.conversationId && !!j.messageIds === !!first.messageIds);
      queue.set(botId, jobs.filter((j: Wake) => !turn.includes(j)));
      await run(botId, turn);
    }
  } finally {
    pumping.delete(botId);
    const current = minds.get(botId);
    if (current) current.busy = false;
    if (queue.get(botId)?.length) void pump(botId);
  }
}

export function stop(botId: string) {
  const mind = minds.get(botId);
  if (!mind) return;
  revokeToken(mind.token);
  mind.proc.close();
  minds.delete(botId);
  queue.delete(botId);
}

function sessionDir() {
  const dir = join(botsDir(), "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
function workDir(botId: string) {
  const dir = join(botsDir(), "minds", botId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function ensureMind(botId: string): Promise<Mind> {
  const existing = minds.get(botId);
  // The user changed which extensions bots load. Only ever reached between turns, and the session carries on.
  if (existing && !existing.proc.exited && existing.loaded !== JSON.stringify(piFlags())) {
    revokeToken(existing.token);
    existing.proc.close();
    minds.delete(botId);
  } else if (existing && !existing.proc.exited) return existing;
  if (!piBin()) throw new PiError("Pi isn't installed. Install it in Settings → Pi.");
  const token = mintToken(botId);
  const flags = piFlags();
  const proc = new PiProcess(
    ["--session-dir", sessionDir(), "--session-id", botId, ...flags],
    workDir(botId),
    { OPENBOTS_SOCKET: agentSocketPath(), OPENBOTS_TOKEN: token, OPENBOTS_BOT: botId },
  );
  const mind: Mind = { proc, token, loaded: JSON.stringify(flags), busy: true, sent: false, draft: "", typing: false, quiet: false, activity: "Thinking" };
  proc.on((record) => onRecord(botId, mind, record));
  minds.set(botId, mind);
  return mind;
}

/** Pi's own default, from its settings. A resumed session keeps its last model, so this has to be asked for. */
function piDefaultModel(): string | undefined {
  try {
    const { defaultProvider, defaultModel } = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8"));
    return defaultProvider && defaultModel ? `${defaultProvider}/${defaultModel}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Put a bot's Pi on its model before a run, or on `fallback` when that's the one being tried. A model
 * that can't be used fails the attempt instead of quietly running on another. Resolves to the model Pi is on, with its name when Pi says.
 *
 * A bot with no model of its own runs on Pi's default, or on whatever Pi picks when there's none. Pi
 * keeps the last model in a running process and in a resumed session, so after a fallback that would
 * be the fallback: the model it resolved to is kept (`primary:`), as is the fallback it's on (`fallback:`),
 * and the next primary attempt goes back, or fails rather than carry on on the fallback unannounced.
 */
export async function applyModel(proc: Pick<PiProcess, "send">, botId: string, fallback?: string): Promise<{ model?: string; name?: string }> {
  const chosen = fallback || db.getBot(botId)?.model || svc.getSettings().defaultModel;
  const onFallback = db.getValue<string | null>(`fallback:${botId}`) || undefined;
  const state = await proc.send<{ model?: { provider: string; id: string; name?: string } }>({ type: "get_state" });
  let current = state.model ? `${state.model.provider}/${state.model.id}` : undefined;
  let name = state.model?.name;
  const wanted = chosen ? [chosen] : [...new Set([piDefaultModel(), db.getValue<string>(`primary:${botId}`)].filter((m): m is string => !!m?.includes("/")))];
  for (const model of wanted) {
    if (current === model) break;
    const slash = model.indexOf("/");
    try {
      const set = await proc.send<{ name?: string } | undefined>({ type: "set_model", provider: model.slice(0, slash), modelId: model.slice(slash + 1) }, 20_000);
      current = model;
      name = set?.name;
      break;
    } catch (err) {
      // Pi's default can come from an extension bots don't load. Nobody picked it for this bot, so the next candidate, or Pi's own pick, will do.
      if (chosen) throw err;
    }
  }
  if (fallback) db.setValue(`fallback:${botId}`, fallback);
  else {
    if (!chosen && onFallback && current === onFallback) throw new PiError(`Couldn't switch back from fallback model ${onFallback} to the default model.`);
    db.setValue(`fallback:${botId}`, null);
    if (!chosen && current) db.setValue(`primary:${botId}`, current);
  }
  return { model: current, name };
}

/** The models a reply tries, in order: see botModelChain. */
export function modelChain(botId: string): (string | undefined)[] {
  return botModelChain(db.getBot(botId), svc.getSettings());
}

/** A reply failed on the model's side: the provider's error, which the server log keeps and the chat doesn't show. */
export class ProviderError extends PiError {}

/** A model failed before the reply did anything: no tool ran and no text was written, so another model can take the turn over. */
export class ModelFailure extends ProviderError {}

/**
 * Try a turn on each model of the chain until one manages it. Only a ModelFailure moves on; anything
 * else (a partial reply, a tool that already ran, a timeout) fails the reply as it is. An attempt calls
 * `ran` once its model has taken the turn on (it wrote, ran a tool or settled), with the model Pi is on
 * and its name, which posts a change of model in the conversation (see noteRan). When every model
 * fails, the error says how each one did, for the server log.
 */
export async function withFallbacks(
  botId: string,
  conversationId: string | undefined,
  chain: (string | undefined)[],
  attempt: (model: string | undefined, index: number, ran: (on: { model?: string; name?: string }) => void) => Promise<void>,
): Promise<void> {
  const failures: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    let noted = false;
    const ran = (on: { model?: string; name?: string }) => {
      if (noted) return;
      noted = true;
      noteRan(botId, conversationId, chain, i, { model: on.model ?? model, name: on.name });
    };
    try {
      await attempt(model, i, ran);
      return;
    } catch (err) {
      if (!(err instanceof ModelFailure) || i === chain.length - 1) {
        if (!failures.length) throw err;
        const last = err instanceof Error ? err.message : String(err);
        throw new ProviderError(`Every model failed.\n${[...failures, `${model}: ${last}`].join("\n")}`);
      }
      failures.push(`${model ?? "Default model"}: ${err.message.split("\n").pop()!.slice(0, 160)}`);
    }
  }
}

/**
 * The model a bot's replies last ran on, and its place in the chain, are kept (`ran:`) so the chat
 * hears only of a change: a fallback taking over, or a model higher up coming back, both "Switched to
 * GPT 6.1 Sol". A reply that tried the primary, saw it fail and ended up on the same fallback as last
 * time says nothing, and a model that failed is never named. The provider (the account, for a second
 * login) is the detail only when another model in the chain has the same id, to tell the two apart.
 */
function noteRan(botId: string, conversationId: string | undefined, chain: (string | undefined)[], index: number, on: { model?: string; name?: string }) {
  const last = db.getValue<{ model?: string; index: number } | null>(`ran:${botId}`) ?? undefined;
  db.setValue(`ran:${botId}`, { model: on.model, index });
  if (last?.model === on.model) return;
  const recovered = !!last && last.index > index;
  if (index === 0 && !recovered) return;
  const where = conversationId ?? svc.directId(botId);
  if (!where || !on.model) return;
  const slash = on.model.indexOf("/");
  const id = on.model.slice(slash + 1);
  const twin = chain.some((m) => m && m !== on.model && m.slice(m.indexOf("/") + 1) === id);
  svc.postMessage(where, { id: crypto.randomUUID(), author: botId, at: Date.now(), text: "", event: { kind: "model", text: `Switched to ${on.name || id}`, ...(twin ? { detail: on.model.slice(0, slash) } : {}), model: on.model } });
}

/** Our extension returns a posted message id only after the service actually accepted it. */
export function successfulMessageTool(record: PiRecord): boolean {
  return record.type === "tool_execution_end"
    && (record.toolName === "send_message" || record.toolName === "question" || record.toolName === "poll")
    && !record.isError && !record.result?.isError
    && typeof record.result?.details?.id === "string" && !!record.result.details.id;
}

export async function applyEffort(proc: Pick<PiProcess, "send">, botId: string) {
  const effort = db.getBot(botId)?.effort;
  if (!effort) return;
  const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (!order.includes(effort)) throw new PiError(`Unknown bot effort: ${effort}`);
  const { levels } = await proc.send<{ levels: string[] }>({ type: "get_available_thinking_levels" });
  const supported = levels.filter((level) => order.includes(level));
  const level = supported.includes(effort) ? effort : supported.sort((a, b) => Math.abs(order.indexOf(a) - order.indexOf(effort)) - Math.abs(order.indexOf(b) - order.indexOf(effort)))[0];
  if (level) await proc.send({ type: "set_thinking_level", level });
}

/** Tools that put words in the chat: while they're being written, the bot is typing. */
const WRITING = new Set(["send_message", "question", "poll"]);

function show(botId: string, mind: Mind, activity?: string) {
  if (activity) mind.activity = activity;
  setStatus(botId, { state: "working", activity: mind.activity, conversationId: getFocus(botId), quiet: !!mind.quiet || undefined, since: Date.now() });
}

function setTyping(botId: string, mind: Mind, on: boolean) {
  if (mind.typing === on) return;
  mind.typing = on;
  const conversationId = getFocus(botId);
  if (conversationId) svc.setTyping(conversationId, botId, on);
}

function commit(mind: Mind) {
  const told = mind.onCommit;
  mind.onCommit = undefined;
  told?.();
}

export function onRecord(botId: string, mind: Mind, record: PiRecord) {
  if (record.type === "agent_settled") {
    mind.steerable = false;
    mind.onSettled?.();
  }
  if (record.type === "process_exit") mind.onExit?.(new PiError(String(record.message ?? "Pi exited")));
  mind.sent ||= successfulMessageTool(record);
  if (record.type === "tool_execution_start") mind.acted = true;
  if (mind.acted) commit(mind);
  const ended = record.type === "message_end" ? record.message : undefined;
  if (ended?.role === "assistant") mind.error = ended.stopReason === "error" ? modelError(ended.errorMessage) : ended.stopReason === "aborted" ? mind.error : undefined;
  const tool = String(record.toolName ?? "");
  if (record.type === "tool_execution_start") {
    mind.draft = "";
    const conversationId = getFocus(botId);
    if (conversationId) svc.setDraft(undefined, { conversationId, botId });
    if (WRITING.has(tool)) setTyping(botId, mind, true);
    else if (tool !== "react") {
      setTyping(botId, mind, false);
      // Work after a message is still work: the chat shows it, as the sidebar does.
      if (mind.quiet === "sent") mind.quiet = false;
      show(botId, mind, activityFor(tool, record.args));
    }
  }
  if (record.type === "tool_execution_end" && WRITING.has(tool)) {
    // Sent. Whatever it does next stays out of the chat until it types again or picks up real work.
    setTyping(botId, mind, false);
    mind.quiet = "sent";
    show(botId, mind, "Thinking");
  }
  const ev = record.type === "message_update" ? record.assistantMessageEvent : undefined;
  if (ev?.type === "toolcall_start" && WRITING.has(String(ev.toolName ?? ""))) setTyping(botId, mind, true);
  const delta = ev?.type === "text_delta" ? String(ev.delta ?? "") : "";
  if (delta) {
    mind.acted = true;
    commit(mind);
    mind.draft += delta;
    const conversationId = getFocus(botId);
    if (conversationId && !mind.sent && !"[silent]".startsWith(mind.draft.trim().toLowerCase())) {
      setTyping(botId, mind, true);
      svc.setDraft({ conversationId, botId, text: mind.draft.slice(-4000) }, { conversationId, botId });
    }
  }
}

/** What a failed model call says. A lapsed sign-in leads with the fix, which is all the chat shows of it. */
export function modelError(message: unknown): string {
  const text = String(message || "The model returned an error.");
  return /invalid_grant|oauth|refresh token|unauthori[sz]ed|\b401\b|sign.?in|log.?in again|expired/i.test(text)
    ? `${MODEL_SIGN_IN}\n${text}`
    : text;
}

/** A provider's error with anything that looks like a key or token taken out, for the server log. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 [redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]")
    .replace(/\b(?:sk|pk|rk|xai|gsk|ghp|gho|ghs|github_pat)[-_][\w-]{8,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]");
}

const base = (path: unknown) => String(path ?? "").split("/").filter(Boolean).pop()?.slice(0, 40);

/** The status the bot wrote for this call: one short line, or nothing usable. */
function ownStatus(value: unknown) {
  const line = typeof value === "string" ? value.split("\n")[0]!.replace(/\s+/g, " ").trim().replace(/[.…]+$/, "") : "";
  if (!line) return undefined;
  const short = line.length > 50 ? `${line.slice(0, 49).trimEnd()}…` : line;
  return short[0]!.toUpperCase() + short.slice(1);
}

export function activityFor(tool: string, args: unknown): string {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const own = ownStatus(a.status);
  if (own) return own;
  if (tool === "bash") return "Running a command";
  if (tool === "openbuild") return a.action === "start" ? "Starting a thread" : a.action === "merge" ? "Merging a pull request" : "Checking on threads";
  if (tool === "process") return a.action === "start" ? "Starting a program" : "Checking on a program";
  if (tool === "browser") {
    if (a.action === "open") {
      const host = (() => {
        try {
          return new URL(String(a.url)).hostname.replace(/^www\./, "");
        } catch {
          return "";
        }
      })();
      return host ? `Opening ${host}` : "Opening a page";
    }
    if (a.action === "screenshot") return "Taking a screenshot";
    if (a.action === "type") return "Filling something in";
    if (a.action === "click") return "Clicking around";
    return "Browsing";
  }
  if (tool === "read") return base(a.path) ? `Reading ${base(a.path)}` : "Reading a file";
  if (tool === "write") return base(a.path) ? `Writing ${base(a.path)}` : "Writing a file";
  if (tool === "edit") return base(a.path) ? `Editing ${base(a.path)}` : "Editing a file";
  if (tool === "vote_poll") return "Voting in the poll";
  if (tool === "remember") return "Making a note";
  if (tool === "forget") return "Forgetting something";
  if (tool === "search") return "Looking back through chats";
  if (tool === "bot_web_search") return "Searching the web";
  if (tool === "apps") return a.action === "skill" ? "Reading up on how to do it" : "Looking through apps";
  if (tool === "use_app") return `Using ${appById(String(a.app ?? ""))?.name ?? "an app"}`;
  if (tool === "routine") return "Sorting out a routine";
  if (tool === "ask_bot") return "Asking another bot";
  if (tool === "manage_bot") return "Tending to the other bots";
  return "Thinking";
}

async function run(botId: string, all: Wake[]) {
  const jobs = all.filter((j) => !j.reaction || stillReacted(j.reaction));
  if (!jobs.length) return;
  const conversationId = jobs.find((j) => j.conversationId)?.conversationId ?? svc.directId(botId);
  // A reaction may well get no answer, so the chat shows nothing unless the bot starts typing.
  const quiet = jobs.every((j) => j.kind === "reaction");
  setFocus(botId, conversationId);
  setStatus(botId, { state: "working", conversationId, activity: "Thinking", quiet: quiet || undefined, since: Date.now() });
  let mind: Mind | undefined;
  try {
    mind = await ensureMind(botId);
    mind.busy = true;
    mind.quiet = quiet && "reaction";
    // The transcript is read now, so anything later is the next steer's or turn's to show.
    const shown = new Map<string, number>();
    for (const job of jobs) if (job.conversationId) shown.set(job.conversationId, db.latestSeq(job.conversationId));
    mind.shown = shown;
    const message = render(jobs, botId);
    if (!message.trim()) return;
    const assigned = db.getConversation(conversationId!)?.kind === "group" || jobs.every(j => j.messageIds)
      ? new Set(jobs.flatMap(j => j.messageIds ?? [])) : undefined;
    const images = assigned ? [...assigned].flatMap(id => {
      const row = db.getMessage(id);
      return row ? imagesBetween(conversationId!, row.seq - 1, row.seq) : [];
    }).slice(-IMAGE_LIMIT) : imagesFor(botId, shown);
    markSeen(botId, shown, assigned);
    const m = mind;
    let handled = false;
    await withFallbacks(botId, conversationId, modelChain(botId), async (model, index, ran) => {
      m.onCommit = undefined;
      m.sent = false;
      m.acted = false;
      m.error = undefined;
      m.draft = "";
      m.typing = false;
      m.activity = "Thinking";
      // Steered into an attempt whose model failed before acting: answered in a turn of their own, not lost.
      if (m.steered?.length) {
        await m.steering;
        // Pi keeps the steers it never read for the next prompt, which would answer them a second time.
        await m.proc.send({ type: "clear_queue" }, 30_000);
        for (const job of m.steered.splice(0)) enqueue(botId, job);
      }
      // Nothing has happened yet: a model Pi can't switch to, or that it refuses to start, is the next one's turn.
      const untouched = (err: unknown) => (m.proc.exited || m.acted || m.sent ? err : new ModelFailure(err instanceof Error ? err.message : String(err)));
      try {
        const on = await applyModel(m.proc, botId, index ? model : undefined);
        await applyEffort(m.proc, botId);
        // The switch is told once the model has taken the turn on, so a model that fails first isn't.
        m.onCommit = () => ran(on);
      } catch (err) {
        throw untouched(err);
      }
      let settled = false;
      m.onSettled = () => {
        settled = true;
      };
      m.steerable = true;
      // Pi refusing the prompt (no key for this model, say) ran nothing. One that went unanswered may still be running, so it isn't tried again.
      const accepted = await m.proc.send({ type: "prompt", message, ...(images.length ? { images } : {}) }, 60_000).catch((err) => {
        throw /didn't answer .* in time/.test(String((err as Error)?.message)) ? err : untouched(err);
      });
      if ((accepted as { disposition?: string })?.disposition === "handled" || settled) {
        if (!settled) return void (handled = true, commit(m));
      } else await waitSettled(m);
      m.steerable = false;
      if (!m.sent) {
        // The model failed before saying or doing anything: the next one can answer instead.
        if (m.error && !m.acted && !m.proc.exited) throw new ModelFailure(m.error);
        if (!m.error) commit(m);
        const text = m.draft.trim();
        if (conversationId) {
          for (const part of replyBubbles(text)) {
            svc.postMessage(conversationId, { id: crypto.randomUUID(), author: botId, at: Date.now(), text: part.slice(0, 8000) });
          }
        }
        // Otherwise the reply just never shows up, and the chat looks like it lost the message.
        if (m.error) throw new ProviderError(m.error);
      }
    });
    if (handled) return;
    for (const [id, seq] of shown) db.setCursor(botId, id, caughtUp(botId, id, seq));
    svc.touchHeartbeat(botId);
    setStatus(botId, { state: "idle" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The provider's errors, each fallback's included, are for the log. The chat says only that it
    // couldn't reply, how to sign in again, or one of OpenBuild's own reasons; whatever it leaves out is logged.
    const provider = err instanceof ProviderError;
    setStatus(botId, { state: "error", error: message, provider: provider || undefined, since: Date.now() });
    const detail = shownReplyError(message, provider);
    if (provider || detail !== message.trim()) console.warn(`[bots] ${botId} couldn't reply:`, redactSecrets(message));
    const where = conversationId ?? svc.directId(botId);
    const last = db.getValue<number>(`told:${botId}`) ?? 0;
    if (where && Date.now() - last > 60_000) {
      db.setValue(`told:${botId}`, Date.now());
      svc.postMessage(where, { id: crypto.randomUUID(), author: botId, at: Date.now(), text: "", event: { kind: "error", text: "Couldn't reply", ...(detail ? { detail } : {}) } });
    }
    if (mind?.proc.exited) {
      revokeToken(mind.token);
      minds.delete(botId);
    }
  } finally {
    if (mind) {
      mind.typing = false;
      mind.steerable = false;
      mind.shown = undefined;
      mind.steered = undefined;
      mind.onCommit = undefined;
    }
    if (conversationId) {
      svc.setTyping(conversationId, botId, false);
      svc.setDraft(undefined, { conversationId, botId });
    }
    setFocus(botId, undefined);
  }
}

function stillReacted({ messageId, emoji, by, to }: NonNullable<Wake["reaction"]>) {
  return !!db.getMessage(messageId)?.message.reactions?.some((r) => r.by === by && r.emoji === emoji && r.to === to);
}

function waitSettled(mind: Mind): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mind.proc.close();
      reject(new PiError("The reply took too long and was stopped."));
    }, 15 * 60 * 1000);
    timer.unref?.();
    mind.onSettled = () => (clearTimeout(timer), resolve());
    mind.onExit = (e) => (clearTimeout(timer), reject(e));
  });
}

function render(jobs: Wake[], botId: string): string {
  const bots = db.listBots();
  const user = svc.getSettings().user?.name || "User";
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const job of jobs) {
    if (job.conversationId && !seen.has(job.conversationId)) {
      seen.add(job.conversationId);
      const scoped = jobs.filter(j => j.conversationId === job.conversationId);
      const assigned = scoped.every(j => j.messageIds) ? scoped.flatMap(j => j.messageIds!) : undefined;
      parts.push(transcript(job.conversationId, bots, user, botId, assigned));
    }
    if (job.text && job.kind !== "messages") parts.push(job.text);
  }
  parts.push("Use send_message to reply (one call per bubble, in this conversation unless you name another). If there's nothing to say, send nothing and end with the plain reply [silent].");
  return parts.filter(Boolean).join("\n\n");
}

export function transcript(conversationId: string, bots: { id: string; name: string }[], user: string, botId: string, assigned?: string[]): string {
  const c = db.getConversation(conversationId);
  if (!c) return "";
  const rows = db.messages(conversationId, 16);
  // A wake that waited its turn can target a message older than the history window or cursor.
  for (const id of assigned ?? []) {
    const row = db.getMessage(id);
    if (row?.conversationId === conversationId && !rows.some(r => r.message.id === id)) rows.push(row);
  }
  rows.sort((a, b) => a.seq - b.seq);
  const lines = rows.map(line(c, bots, user, botId, assigned));
  return `Conversation ${conversationId.slice(0, 8)} (${c.kind}, “${conversationTitle(c, bots)}”):\n${c.instructions ? `Group instructions: ${c.instructions}\n` : ""}${lines.join("\n") || "(empty)"}`;
}

/** A group request steered into a live turn: only its own lines, with a word on what to do with them. */
export function steerNote(conversationId: string, botId: string, ids: string[]): string {
  const c = db.getConversation(conversationId);
  if (!c) return "";
  const bots = db.listBots();
  const rows = ids.flatMap((id) => {
    const row = db.getMessage(id);
    return row?.conversationId === conversationId ? [row] : [];
  });
  const lines = rows.sort((a, b) => a.seq - b.seq).map(line(c, bots, svc.getSettings().user?.name || "User", botId, ids, " [new, for you]"));
  return `New in conversation ${conversationId.slice(0, 8)} (“${conversationTitle(c, bots)}”) while you were working:\n${lines.join("\n")}\nFold it into what you're doing. If a quick reply or reaction would help, send one; otherwise carry on.`;
}

function line(c: db.StoredConversation, bots: { id: string; name: string }[], user: string, botId: string, assigned?: string[], forYou = " [assigned request: answer this]") {
  const cursor = db.cursor(botId, c.id);
  const name = (author: string) => (author === "me" ? user : author === botId ? "you" : mentionName(bots.find((b) => b.id === author)?.name ?? "Bot"));
  return (r: { seq: number; message: BotMessage }) => {
    const m = r.message;
    const who = m.author === "me" ? user : mentionName(bots.find((b) => b.id === m.author)?.name ?? "Bot");
    const text = m.event && eventText(m.event);
    const detail = m.event && eventDetail(m.event);
    // "Wrote a prompt in" runs straight into the thread's title; other details follow a colon.
    const body = m.event ? `(${text}${detail ? `${text!.endsWith(" in") ? " " : ": "}${detail}` : ""})` : m.poll ? pollBody(m, botId, name) : m.text.slice(0, 2000);
    // Unscoped group wakes may react to bots/events, never adopt user requests assigned elsewhere.
    const mark = assigned ? (assigned.includes(m.id) ? forYou : " [context only: do not answer]")
      : c.kind === "group" && m.author === "me" ? " [context only: do not answer]"
      : r.seq > cursor ? "" : " [already seen]";
    const quoted = m.replyTo ? db.getMessage(m.replyTo) : undefined;
    const reply = quoted ? ` (replying to [${quoted.message.id.slice(0, 8)}] ${name(quoted.message.author)}: “${quoted.message.text.slice(0, 200)}”)` : "";
    const list = m.reactions ?? [];
    const number = (id?: string) => list.findIndex((x) => reactionId(x) === id) + 1;
    const reactions = list.length ? `\n  reactions: ${list.map((x, i) => `#${i + 1} ${x.emoji} from ${name(x.by)}${x.to && number(x.to) ? ` → #${number(x.to)}` : ""}`).join(", ")}` : "";
    return `[${m.id.slice(0, 8)}] ${who}${mark}${reply}: ${body}${reactions}`;
  };
}

/** A poll in the transcript: its options, who picked what if this bot may know yet, and whether it still has to vote. */
function pollBody(m: BotMessage, botId: string, name: (author: string) => string): string {
  const poll = m.poll!;
  const visible = pollVotesVisible(poll, botId);
  const options = poll.options.map((o) => {
    const by = visible ? poll.votes.filter((v) => v.keys.includes(o.key)).map((v) => name(v.by)) : [];
    return `\n  ${o.key}) ${o.label}${by.length ? ` (${by.join(", ")})` : ""}`;
  });
  const hidden = visible ? "" : "\n  Answers stay hidden until you've voted or it closes.";
  const owed = !poll.closedAt && m.author !== botId && !poll.votes.some((v) => v.by === botId);
  return `Poll${poll.closedAt ? " (closed)" : ""}, ${poll.multiple ? "pick any" : "pick one"}: “${poll.question}”${options.join("")}${hidden}${owed ? "\n  You haven't voted. Use vote_poll." : ""}`;
}

const IMAGE_LIMIT = 4;

/** The newest images the user attached after `from`, up to `through`, as Pi takes them. */
function imagesBetween(conversationId: string, from: number, through: number): { type: "image"; data: string; mimeType: string }[] {
  const out = [];
  for (const row of db.messagesAfter(conversationId, from, 50)) {
    if (row.seq > through || row.message.author !== "me") continue;
    for (const url of row.message.images ?? []) {
      const m = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(url);
      if (m) out.push({ type: "image" as const, mimeType: m[1]!, data: m[2]!.replace(/\s/g, "") });
    }
  }
  return out.slice(-IMAGE_LIMIT);
}

function imagesFor(botId: string, shown: Map<string, number>) {
  for (const [id, through] of shown) {
    const images = imagesBetween(id, db.cursor(botId, id), through);
    if (images.length) return images;
  }
  return [];
}

/** How far the bot has read once a turn ends: past its own replies, but not up to a message it never saw. */
export function caughtUp(botId: string, conversationId: string, shown: number): number {
  const missed = db.messagesAfter(conversationId, shown, 500).find((r) => r.message.author !== botId);
  return missed ? missed.seq - 1 : db.latestSeq(conversationId);
}

function markSeen(botId: string, shown: Map<string, number>, assigned?: Set<string>) {
  if (assigned) {
    for (const id of assigned) {
      const row = db.getMessage(id);
      if (row && row.message.author === "me" && !row.message.seenBy?.includes(botId)) svc.patchMessage(row.conversationId, id, { seenBy: [...(row.message.seenBy ?? []), botId] });
    }
    return;
  }
  for (const [id, through] of shown) {
    for (const row of db.messagesAfter(id, db.cursor(botId, id), 50)) {
      const m = row.message;
      if (row.seq > through || m.author !== "me" || m.seenBy?.includes(botId)) continue;
      svc.patchMessage(id, m.id, { seenBy: [...(m.seenBy ?? []), botId] });
    }
  }
}

/** What Pi still needs before bots can run on it: to be installed, then a provider with models. */
export async function piSetup(fresh: boolean): Promise<PiSetup | undefined> {
  if (!piBin()) return { need: "missing" };
  const { models } = await listModels(fresh);
  return models.length ? undefined : { need: "no-provider" };
}

export function startBots() {
  listen();
  svc.setHooks({ wake, stop });
  svc.setPiCheck(piSetup);
  // Pi installed, or a provider signed in: a welcome waiting on it can go ahead.
  hot.openbotsModelsWatch?.();
  hot.openbotsModelsWatch = onModelsForgotten(() => {
    if (svc.piSetup()) void svc.greetOnFirstOpen();
  });
  resumeWatches();
  if (!hot.openbotsProc) {
    hot.openbotsProc = true;
    procListeners.add((computerId, proc, tail) => {
      if (!db.getBot(computerId)) return;
      wake(computerId, {
        kind: "note",
        conversationId: svc.directId(computerId),
        text: `A process on your computer finished: ${proc.name || proc.command} (exit ${proc.exitCode ?? "?"}).\n${tail.slice(-2000)}\nTell the user if it matters.`,
      });
    });
  }
  if (hot.openbotsTimer) clearInterval(hot.openbotsTimer);
  hot.openbotsTimer = setInterval(() => {
    try {
      svc.tick(busy);
    } catch (err) {
      // A stale record or a failed wake must not escape the interval and crash the server.
      console.error("[bots] scheduler failed:", err);
    }
    for (const [id, mind] of minds) {
      if (!mind.busy && (mind.proc.exited || Date.now() - mind.proc.lastUsed > IDLE)) stop(id);
    }
  }, 15_000);
  hot.openbotsTimer.unref?.();
}
