// One Pi process per bot. It stays up while the bot is in a conversation and exits after it's been
// idle, the same way threads do. Messages that arrive mid-reply are steered in; everything else waits
// and runs when the bot is free. The process loads server/bots/extension.ts, which calls back over
// the unix socket in agent.ts.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appById } from "../../shared/apps";
import { conversationTitle, firstName, reactionId, pollVotesVisible, replyBubbles, type BotMessage } from "../../shared/bots";
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
  /** Keep the chat clear unless it starts typing (see BotStatus.quiet). */
  quiet: boolean;
  activity: string;
  /** The model's last call failed (an expired sign-in, say): Pi ends the turn with no text, only this. */
  error?: string;
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
  if ((item.kind === "messages" || item.kind === "reaction") && item.conversationId === getFocus(botId) && pumping.has(botId) && mind && !mind.proc.exited) {
    const text = render([item], botId);
    if (item.kind === "messages") {
      mind.quiet = false;
      show(botId, mind);
    }
    void mind.proc
      .send({ type: "steer", message: text }, 15_000)
      .then(() => {
        if (item.conversationId) db.setCursor(botId, item.conversationId, db.latestSeq(item.conversationId));
      })
      .catch(() => enqueue(botId, item));
    return;
  }
  enqueue(botId, item);
}

function enqueue(botId: string, item: Wake) {
  const list = queue.get(botId) ?? [];
  list.push(item);
  queue.set(botId, list);
  void pump(botId);
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

/** Put a bot's Pi on its model before a run. A model that can't be used fails the reply instead of quietly running on another. */
export async function applyModel(proc: Pick<PiProcess, "send">, botId: string) {
  const chosen = db.getBot(botId)?.model || svc.getSettings().defaultModel;
  const model = chosen || piDefaultModel();
  if (!model?.includes("/")) return;
  const slash = model.indexOf("/");
  const provider = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  const state = await proc.send<{ model?: { provider: string; id: string } }>({ type: "get_state" });
  if (state.model?.provider === provider && state.model?.id === modelId) return;
  // Pi's default can come from an extension bots don't load. Nobody picked it for this bot, so Pi's next best will do.
  await proc.send({ type: "set_model", provider, modelId }, 20_000).catch((err) => {
    if (chosen) throw err;
  });
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
  svc.setStatus(botId, { state: "working", activity: mind.activity, conversationId: getFocus(botId), quiet: mind.quiet || undefined, since: Date.now() });
}

function setTyping(botId: string, mind: Mind, on: boolean) {
  if (mind.typing === on) return;
  mind.typing = on;
  const conversationId = getFocus(botId);
  if (conversationId) svc.setTyping(conversationId, botId, on);
}

export function onRecord(botId: string, mind: Mind, record: PiRecord) {
  if (record.type === "agent_settled") mind.onSettled?.();
  if (record.type === "process_exit") mind.onExit?.(new PiError(String(record.message ?? "Pi exited")));
  mind.sent ||= successfulMessageTool(record);
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
      show(botId, mind, activityFor(tool, record.args));
    }
  }
  if (record.type === "tool_execution_end" && WRITING.has(tool)) {
    // Sent. Whatever it does next stays out of the chat until it types again or picks up real work.
    setTyping(botId, mind, false);
    mind.quiet = true;
    show(botId, mind, "Thinking");
  }
  const ev = record.type === "message_update" ? record.assistantMessageEvent : undefined;
  if (ev?.type === "toolcall_start" && WRITING.has(String(ev.toolName ?? ""))) setTyping(botId, mind, true);
  const delta = ev?.type === "text_delta" ? String(ev.delta ?? "") : "";
  if (delta) {
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

export function activityFor(tool: string, args: unknown): string {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
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
  svc.setStatus(botId, { state: "working", conversationId, activity: "Thinking", quiet: quiet || undefined, since: Date.now() });
  setFocus(botId, conversationId);
  let mind: Mind | undefined;
  try {
    mind = await ensureMind(botId);
    mind.busy = true;
    mind.sent = false;
    mind.error = undefined;
    mind.draft = "";
    mind.typing = false;
    mind.quiet = quiet;
    mind.activity = "Thinking";
    const message = render(jobs, botId);
    if (!message.trim()) return;
    await applyModel(mind.proc, botId);
    await applyEffort(mind.proc, botId);
    const images = imagesFor(jobs, botId);
    markSeen(botId, jobs);
    let settled = false;
    mind.onSettled = () => {
      settled = true;
    };
    const accepted = await mind.proc.send({ type: "prompt", message, ...(images.length ? { images } : {}) }, 60_000);
    if ((accepted as { disposition?: string })?.disposition === "handled" || settled) {
      if (!settled) return;
    } else await waitSettled(mind);
    if (!mind.sent) {
      const text = mind.draft.trim();
      if (conversationId) {
        for (const part of replyBubbles(text)) {
          svc.postMessage(conversationId, { id: crypto.randomUUID(), author: botId, at: Date.now(), text: part.slice(0, 8000) });
        }
      }
      // Otherwise the reply just never shows up, and the chat looks like it lost the message.
      if (mind.error) throw new PiError(mind.error);
    }
    for (const job of jobs) if (job.conversationId) db.setCursor(botId, job.conversationId, db.latestSeq(job.conversationId));
    svc.touchHeartbeat(botId);
    svc.setStatus(botId, { state: "idle" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    svc.setStatus(botId, { state: "error", error: message, since: Date.now() });
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
    if (mind) mind.typing = false;
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
  const name = (author: string) => (author === "me" ? user : author === botId ? "you" : firstName(bots.find((b) => b.id === author)?.name ?? "Bot"));
  const lines = rows.map((r) => {
    const m = r.message;
    const who = m.author === "me" ? user : firstName(bots.find((b) => b.id === m.author)?.name ?? "Bot");
    const body = m.event ? `(${m.event.text}${m.event.detail ? `: ${m.event.detail}` : ""})` : m.poll ? pollBody(m, botId, name) : m.text.slice(0, 2000);
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

function imagesFor(jobs: Wake[], botId: string): { type: "image"; data: string; mimeType: string }[] {
  for (const job of jobs) {
    if (!job.conversationId) continue;
    const cursor = db.cursor(botId, job.conversationId);
    const rows = db.messagesAfter(job.conversationId, cursor, 20);
    const mine = rows.filter((r) => r.message.author === "me" && r.message.images?.length).at(-1);
    if (!mine) continue;
    const out = [];
    for (const url of mine.message.images!.slice(0, 4)) {
      const m = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(url);
      if (m) out.push({ type: "image" as const, mimeType: m[1]!, data: m[2]!.replace(/\s/g, "") });
    }
    if (out.length) return out;
  }
  return [];
}

function markSeen(botId: string, jobs: Wake[]) {
  for (const job of jobs) {
    if (!job.conversationId) continue;
    const cursor = db.cursor(botId, job.conversationId);
    for (const row of db.messagesAfter(job.conversationId, cursor, 50)) {
      const m = row.message;
      if (m.author !== "me" || m.seenBy?.includes(botId)) continue;
      svc.patchMessage(job.conversationId, m.id, { seenBy: [...(m.seenBy ?? []), botId] });
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
