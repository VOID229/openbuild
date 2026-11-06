// One Pi process per bot. It stays up while the bot is in a conversation and exits after it's been
// idle, the same way threads do. Messages that arrive mid-reply are steered in; everything else waits
// and runs when the bot is free. The process loads server/bots/extension.ts, which calls back over
// the unix socket in agent.ts.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appById } from "../../shared/apps";
import { conversationTitle, eventText, mentionName, reactionId, pollVotesVisible, replyBubbles, type BotMessage } from "../../shared/bots";
import { procListeners } from "../computers/index";
import { PiError, PiProcess, type PiRecord } from "../pi/rpc";
import { agentDir, piBin } from "../pi/install";
import { piFlags } from "./extensions";
import { botsDir } from "./db";
import * as db from "./db";
import { agentSocketPath, getFocus, listen, mintToken, revokeToken, setFocus } from "./agent";
import * as svc from "./service";
import { resumeWatches } from "./threads";
import type { Wake } from "./service";
import type { BotStatus } from "../../shared/bots";

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
  /** The model's last call failed (an expired sign-in, say): Pi ends the turn with no text, only this. */
  error?: string;
  /** This attempt ran a tool or wrote text, so trying it again on another model could repeat what it did. */
  acted?: boolean;
  onSettled?: () => void;
  onExit?: (e: Error) => void;
}

const hot = globalThis as {
  openbotsMinds?: Map<string, Mind>;
  openbotsQueue?: Map<string, Wake[]>;
  openbotsTimer?: ReturnType<typeof setInterval>;
  openbotsProc?: boolean;
  openbotsPumping?: Set<string>;
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
  if ((item.kind === "messages" || item.kind === "reaction") && conversationId && conversationId === getFocus(botId) && pumping.has(botId) && mind?.steerable && mind.shown && !mind.proc.exited) {
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
  svc.setStatus(botId, { ...next, waiting: waiting.length ? waiting : undefined });
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
      // One conversation a turn, and each routine alone.
      const turn = first.kind === "routine" ? [first] : jobs.filter((j: Wake) => j.kind !== "routine" && j.conversationId === first.conversationId);
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
 * that can't be used fails the attempt instead of quietly running on another. Resolves to the model's name, when Pi says.
 *
 * A bot with no model of its own runs on Pi's default, or on whatever Pi picks when there's none. Pi
 * keeps the last model in a running process and in a resumed session, so after a fallback that would
 * be the fallback: the model it resolved to is kept (`primary:`), as is the fallback it's on (`fallback:`),
 * and the next primary attempt goes back, or fails rather than carry on on the fallback unannounced.
 */
export async function applyModel(proc: Pick<PiProcess, "send">, botId: string, fallback?: string): Promise<string | undefined> {
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
  return name;
}

/**
 * The models a reply tries, in order: the bot's own (undefined: the default, or Pi's), then its
 * fallbacks. A fallback that repeats one already in the list is skipped.
 */
export function modelChain(botId: string): (string | undefined)[] {
  const bot = db.getBot(botId);
  const primary = bot?.model || svc.getSettings().defaultModel || undefined;
  const seen = new Set(primary ? [primary] : []);
  const rest = (bot?.fallbackModels ?? []).filter((m) => m.includes("/") && !seen.has(m) && (seen.add(m), true));
  return [primary, ...rest];
}

/** A model failed before the reply did anything: no tool ran and no text was written, so another model can take the turn over. */
export class ModelFailure extends PiError {}

/**
 * Try a turn on each model of the chain until one manages it. Only a ModelFailure moves on; anything
 * else (a partial reply, a tool that already ran, a timeout) fails the reply as it is. An attempt calls
 * `switched` once Pi is on its model, which posts the switch to a fallback in the conversation. When
 * every model fails, the error says how each one did.
 */
export async function withFallbacks(
  botId: string,
  conversationId: string | undefined,
  chain: (string | undefined)[],
  attempt: (model: string | undefined, index: number, switched: (name?: string) => void) => Promise<void>,
): Promise<void> {
  const failures: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const switched = (name?: string) => {
      if (i > 0) announceFallback(botId, conversationId, model!, name);
    };
    try {
      await attempt(model, i, switched);
      return;
    } catch (err) {
      if (!(err instanceof ModelFailure) || i === chain.length - 1) {
        if (!failures.length) throw err;
        const last = err instanceof Error ? err.message : String(err);
        throw new PiError(`Every model failed.\n${[...failures, `${model}: ${last}`].join("\n")}`);
      }
      failures.push(`${model ?? "Default model"}: ${err.message.split("\n").pop()!.slice(0, 160)}`);
    }
  }
}

/** "Switched to fallback model GPT 6.1 Sol", with the provider (the account, for a second login) as its detail. */
function announceFallback(botId: string, conversationId: string | undefined, model: string, name?: string) {
  const where = conversationId ?? svc.directId(botId);
  if (!where) return;
  const slash = model.indexOf("/");
  svc.postMessage(where, { id: crypto.randomUUID(), author: botId, at: Date.now(), text: "", event: { kind: "model", text: `Switched to fallback model ${name || model.slice(slash + 1)}`, detail: model.slice(0, slash), model } });
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

export function onRecord(botId: string, mind: Mind, record: PiRecord) {
  if (record.type === "agent_settled") {
    mind.steerable = false;
    mind.onSettled?.();
  }
  if (record.type === "process_exit") mind.onExit?.(new PiError(String(record.message ?? "Pi exited")));
  mind.sent ||= successfulMessageTool(record);
  if (record.type === "tool_execution_start") mind.acted = true;
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
    mind.draft += delta;
    const conversationId = getFocus(botId);
    if (conversationId && !mind.sent && !"[silent]".startsWith(mind.draft.trim().toLowerCase())) {
      setTyping(botId, mind, true);
      svc.setDraft({ conversationId, botId, text: mind.draft.slice(-4000) }, { conversationId, botId });
    }
  }
}

/** What a failed model call says in the chat. A lapsed sign-in leads with the fix, as the chat clips the detail. */
export function modelError(message: unknown): string {
  const text = String(message || "The model returned an error.");
  return /invalid_grant|oauth|refresh token|unauthori[sz]ed|\b401\b|sign.?in|log.?in again|expired/i.test(text)
    ? `The sign-in for this model has expired. Sign in again in Settings → Providers.\n${text}`
    : text;
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
    const images = imagesFor(botId, shown);
    markSeen(botId, shown);
    const m = mind;
    let handled = false;
    await withFallbacks(botId, conversationId, modelChain(botId), async (model, index, switched) => {
      m.sent = false;
      m.acted = false;
      m.error = undefined;
      m.draft = "";
      m.typing = false;
      m.activity = "Thinking";
      // Nothing has happened yet: a model Pi can't switch to, or that it refuses to start, is the next one's turn.
      const untouched = (err: unknown) => (m.proc.exited || m.acted || m.sent ? err : new ModelFailure(err instanceof Error ? err.message : String(err)));
      try {
        const name = await applyModel(m.proc, botId, index ? model : undefined);
        await applyEffort(m.proc, botId);
        switched(name);
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
        if (!settled) return void (handled = true);
      } else await waitSettled(m);
      m.steerable = false;
      if (!m.sent) {
        // The model failed before saying or doing anything: the next one can answer instead.
        if (m.error && !m.acted && !m.proc.exited) throw new ModelFailure(m.error);
        const text = m.draft.trim();
        if (conversationId) {
          for (const part of replyBubbles(text)) {
            svc.postMessage(conversationId, { id: crypto.randomUUID(), author: botId, at: Date.now(), text: part.slice(0, 8000) });
          }
        }
        // Otherwise the reply just never shows up, and the chat looks like it lost the message.
        if (m.error) throw new PiError(m.error);
      }
    });
    if (handled) return;
    for (const [id, seq] of shown) db.setCursor(botId, id, caughtUp(botId, id, seq));
    svc.touchHeartbeat(botId);
    setStatus(botId, { state: "idle" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(botId, { state: "error", error: message, since: Date.now() });
    const where = conversationId ?? svc.directId(botId);
    const last = db.getValue<number>(`told:${botId}`) ?? 0;
    if (where && Date.now() - last > 60_000) {
      db.setValue(`told:${botId}`, Date.now());
      svc.postMessage(where, { id: crypto.randomUUID(), author: botId, at: Date.now(), text: "", event: { kind: "error", text: "Couldn't reply", detail: message.slice(0, 300) } });
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
      parts.push(transcript(job.conversationId, bots, user, botId));
    }
    if (job.text && job.kind !== "messages") parts.push(job.text);
  }
  parts.push("Use send_message to reply (one call per bubble, in this conversation unless you name another). If there's nothing to say, send nothing and end with the plain reply [silent].");
  return parts.filter(Boolean).join("\n\n");
}

export function transcript(conversationId: string, bots: { id: string; name: string }[], user: string, botId: string): string {
  const c = db.getConversation(conversationId);
  if (!c) return "";
  const cursor = db.cursor(botId, conversationId);
  const rows = db.messages(conversationId, 16);
  const name = (author: string) => (author === "me" ? user : author === botId ? "you" : mentionName(bots.find((b) => b.id === author)?.name ?? "Bot"));
  const lines = rows.map((r) => {
    const m = r.message;
    const who = m.author === "me" ? user : mentionName(bots.find((b) => b.id === m.author)?.name ?? "Bot");
    const body = m.event ? `(${eventText(m.event)}${m.event.detail ? `: ${m.event.detail}` : ""})` : m.poll ? pollBody(m, botId, name) : m.text.slice(0, 2000);
    const mark = r.seq > cursor ? "" : " [already seen]";
    const quoted = m.replyTo ? db.getMessage(m.replyTo) : undefined;
    const reply = quoted ? ` (replying to [${quoted.message.id.slice(0, 8)}] ${name(quoted.message.author)}: “${quoted.message.text.slice(0, 200)}”)` : "";
    const list = m.reactions ?? [];
    const number = (id?: string) => list.findIndex((x) => reactionId(x) === id) + 1;
    const reactions = list.length ? `\n  reactions: ${list.map((x, i) => `#${i + 1} ${x.emoji} from ${name(x.by)}${x.to && number(x.to) ? ` → #${number(x.to)}` : ""}`).join(", ")}` : "";
    return `[${m.id.slice(0, 8)}] ${who}${mark}${reply}: ${body}${reactions}`;
  });
  return `Conversation ${conversationId.slice(0, 8)} (${c.kind}, “${conversationTitle(c, bots)}”):\n${c.instructions ? `Group instructions: ${c.instructions}\n` : ""}${lines.join("\n") || "(empty)"}`;
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

function markSeen(botId: string, shown: Map<string, number>) {
  for (const [id, through] of shown) {
    for (const row of db.messagesAfter(id, db.cursor(botId, id), 50)) {
      const m = row.message;
      if (row.seq > through || m.author !== "me" || m.seenBy?.includes(botId)) continue;
      svc.patchMessage(id, m.id, { seenBy: [...(m.seenBy ?? []), botId] });
    }
  }
}

export function startBots() {
  listen();
  svc.setHooks({ wake, stop });
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
