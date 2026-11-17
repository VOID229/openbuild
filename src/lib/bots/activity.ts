// Who is busy, and where. The sidebar, the chat's header and its list all read from here, so a bot
// never looks busy in one place and idle in another, and work in another chat isn't shown as work here.
import { providerName } from "../models";
import { runtimeName } from "../runtimes";
import type { ThreadRuntime } from "../../../shared/types";
import type { Chat } from "../types";
import { betweenTurns, ROUTINE_START, statusLine, TYPING, WORKING_PHRASES, WRITING_REPLY } from "../../../shared/bots";
import type { Bot, BotStatus, Conversation } from "./types";

type Statuses = Record<string, BotStatus | undefined>;

/**
 * Busy replying in another chat, with this one's message next in line. Not a group's that doesn't name
 * it (BotStatus.undecided): it hasn't decided whether that one's its to answer.
 */
export const holding = (st: BotStatus | undefined, conversationId: string) =>
  !!st && st.state !== "idle" && st.conversationId !== conversationId && !!st.waiting?.includes(conversationId) && !st.undecided?.includes(conversationId);

/**
 * Working, as far as anyone can see. A bot deciding whether a group message is its to answer isn't,
 * anywhere: until it types or picks up a tool, nothing shows of it, not even its mascot.
 */
export const visiblyWorking = (st: BotStatus | undefined) => st?.state === "working" && !st.deciding;

/**
 * Plain working words (WORKING_PHRASES), or no line at all: the model is working out what to do, with
 * nothing of its own to name.
 */
export const plainWork = (line: string | undefined) => !line?.trim() || (WORKING_PHRASES as readonly string[]).includes(line.trim());

/**
 * What the app keeps of a working bot's status between updates (the store's `shown`, kept by
 * `trackShown`): the last line it named this spell of work, and since when its status has been plain
 * words. Every place a bot shows at work (the chat's row, the header, the sidebar) reads this one
 * record, so none of them can show it as three dots while another shows its mascot.
 */
export interface Shown {
  /** The last line of its own it showed: kept while its status is plain words, so a gap between steps still says what it's on. */
  line?: string;
  /** This device's clock when its status turned to plain words (or the server's `since`, if earlier). */
  plainSince?: number;
}

/** How long plain words have to stand before a bot shows as three dots, ms: a step over in a moment doesn't set it going back and forth. */
export const DOTS_SETTLE = 350;
/** The longest it stays three dots, ms: after that its mascot comes back, with the plain words beside it. */
export const DOTS_MAX = 2400;

/** At work where it shows, on plain words, and not typing: the only state that can show as dots. */
const plainNow = (st: BotStatus | undefined, typing: boolean) => !typing && visiblyWorking(st) && !st!.quiet && plainWork(statusLine(st));

/**
 * Bring `shown` up to date with the bots' statuses: keep each working bot's last line of its own, and
 * when its status turned plain. Returns `prev` itself when nothing changed.
 */
export function trackShown(prev: Record<string, Shown>, status: Record<string, BotStatus | undefined>, now: number): Record<string, Shown> {
  let next: Record<string, Shown> | undefined;
  const put = (id: string, value: Shown | undefined) => {
    const was = prev[id];
    if (was?.line === value?.line && was?.plainSince === value?.plainSince) return;
    next ??= { ...prev };
    if (value) next[id] = value;
    else delete next[id];
  };
  for (const id of new Set([...Object.keys(prev), ...Object.keys(status)])) {
    const st = status[id];
    if (st?.state !== "working") {
      put(id, undefined);
      continue;
    }
    // Between turns, waiting on jobs or threads: its line is its own, and none of it carries into the next turn.
    if (betweenTurns(st)) {
      put(id, {});
      continue;
    }
    const was = prev[id];
    const line = statusLine(st);
    const plain = plainWork(line);
    // "Writing a reply" is over once the message is out: it's never the line a gap keeps.
    const own = !plain && line !== WRITING_REPLY && line !== TYPING ? line : was?.line;
    const since = plain && !st.quiet && !st.deciding ? (was?.plainSince ?? Math.min(now, st.since ?? now)) : undefined;
    put(id, own === undefined && since === undefined ? {} : { ...(own !== undefined && { line: own }), ...(since !== undefined && { plainSince: since }) });
  }
  return next ?? prev;
}

/**
 * Where a bot on plain words is with them: `settling` for the moment before it turns into dots, `dots`
 * while it is three dots, `words` once that's been long enough and its mascot is back with the plain
 * words. Undefined when it isn't on plain words with nothing else to say: it shows its mascot and its
 * line. A bot that has named a step this spell keeps that line instead of ever turning into dots.
 */
export type PlainPhase = "settling" | "dots" | "words";
export function plainPhase(st: BotStatus | undefined, shown: Shown | undefined, typing: boolean, now: number): PlainPhase | undefined {
  if (!plainNow(st, typing) || shown?.line || shown?.plainSince === undefined) return undefined;
  const t = now - shown.plainSince;
  return t < DOTS_SETTLE ? "settling" : t < DOTS_SETTLE + DOTS_MAX ? "dots" : "words";
}

/** When `plainPhase` next changes by itself (with no new status), on this device's clock. */
export function plainPhaseEnds(st: BotStatus | undefined, shown: Shown | undefined, typing: boolean, now: number): number | undefined {
  const phase = plainPhase(st, shown, typing, now);
  if (phase === "settling") return shown!.plainSince! + DOTS_SETTLE;
  if (phase === "dots") return shown!.plainSince! + DOTS_SETTLE + DOTS_MAX;
  return undefined;
}

/** The line a working bot shows: its status's, or while that's plain words, the last line it named. */
export const shownLine = (st: BotStatus | undefined, shown: Shown | undefined) => {
  const line = statusLine(st);
  return plainWork(line) && shown?.line ? shown.line : line;
};

/** Typing in any chat. */
export const typingAnywhere = (typing: Record<string, string[] | undefined>, botId: string) => Object.values(typing).some((ids) => ids?.includes(botId));

/** Reading something right now (BotStatus.reading): its mascot reads, line by line, wherever it shows. */
export const reading = (st: BotStatus | undefined) => visiblyWorking(st) && !!st!.reading;

/**
 * The chat that stands for the bot, busy anywhere and showing where: its own chat, or the group it's
 * pointed at (Bot.target, BotStatus.home). Its own chat then shows only its work there, as a group does.
 */
export const homeHere = (conversation: Pick<Conversation, "id" | "kind">, st: BotStatus | undefined) => (st?.home ? st.home === conversation.id : conversation.kind === "direct");

/** Working in this chat, quietly or not. */
export const workingHere = (st: BotStatus | undefined, conversationId: string) => visiblyWorking(st) && st!.conversationId === conversationId;

/**
 * The conversation's bots that are busy, as it shows them: their mascots fidget (or, busy elsewhere,
 * are calmer: `awayIn`), in the sidebar, the chat's header and its members, and in a group the rest
 * doze. A bot's own chat is the bot itself: busy in any chat, it's busy there too, and the chat says
 * what it's doing where (`elsewhere`). A group or side chat shows only what's its own: a member typing
 * or at work there, holding on with a message there that names it next in line, or busy elsewhere on
 * its account (`awayIn`). Busy in a chat that has nothing to do with this one, it dozes here.
 */
export function busyBots(conversation: Pick<Conversation, "id" | "botIds" | "kind">, status: Statuses, typing: Record<string, string[] | undefined>): string[] {
  const here = typing[conversation.id] ?? [];
  return conversation.botIds.filter((id) => {
    const st = status[id];
    if (here.includes(id)) return true;
    if (homeHere(conversation, st)) return visiblyWorking(st);
    return workingHere(st, conversation.id) || holding(st, conversation.id) || awayIn(conversation, st);
  });
}

/**
 * In a turn in another chat, as this one sees it. Not when this chat's message is next: then it's
 * holding on here (`holding`). Nor between turns, only waiting on the jobs or threads it started
 * (BotStatus.jobs, .threads): it's free, and that wait shows in the chat it's for. Its mascot plays a
 * calmer routine here (BotAvatar's `away`), and this chat says what it's doing there (`awayLines`).
 */
export const awayFrom = (st: BotStatus | undefined, conversationId: string) => visiblyWorking(st) && !betweenTurns(st) && st!.conversationId !== conversationId && !holding(st, conversationId);

/**
 * Away from this chat (`awayFrom`) in a way it shows: from the bot's own chat, at work anywhere else;
 * from a group or side chat, only on that chat's account (BotStatus.from: a handoff from there, a post
 * about it, a side chat opened from there). Work on anything else shows nothing there.
 */
export const awayIn = (conversation: Pick<Conversation, "id" | "kind">, st: BotStatus | undefined) =>
  awayFrom(st, conversation.id) && (homeHere(conversation, st) || st!.from === conversation.id);

/** The conversation's bots at work in another chat in a way it shows (`awayIn`), and where, but not one typing here. */
export function elsewhere(conversation: Pick<Conversation, "id" | "botIds" | "kind">, status: Statuses, typing: Record<string, string[] | undefined> = {}): { botId: string; conversationId?: string }[] {
  const here = typing[conversation.id] ?? [];
  return conversation.botIds.filter((id) => !here.includes(id) && awayIn(conversation, status[id])).map((id) => ({ botId: id, conversationId: status[id]!.conversationId }));
}

/** What `awayLines` needs to know of the chats and bots the viewer can see. */
export interface AwayKnown {
  conversations: Pick<Conversation, "id" | "kind" | "name" | "botIds" | "hidden" | "huddle">[];
  bots: Pick<Bot, "id" | "name">[];
  typing?: Record<string, string[] | undefined>;
  /** The bot's `shown` (trackShown): its last line of its own, kept through plain words. */
  shown?: Shown;
}

/** The last resort, which every place fits: where isn't said, nor what. */
export const AWAY_PRIVATE = "busy in another chat";
const AWAY_SHORT = "busy elsewhere";

/** A bot's name as a sentence says it: without its " · tag". */
const botName = (bots: Pick<Bot, "id" | "name">[], id: string) => bots.find((b) => b.id === id)?.name.split(" ·")[0] ?? "a deleted bot";

/** Names as a sentence lists them: "Pip", "Pip and Tally", "Pip, Tally and Scout". */
const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""));

/** Where a group is, after "in": "the OpenBuild Dev group", or "the Release chat" for a name that already says what it is. */
function groupPlace(name: string | undefined): string {
  const n = (name?.trim() || "Untitled group").replace(/^the\s+/i, "");
  return /\b(?:group|chat|team)$/i.test(n) ? `the ${n}` : `the ${n} group`;
}

/** A status line as the middle of a sentence: "Running the tests" → "running the tests", keeping "PR", "CI" and the like. */
function midSentence(line: string): string {
  const text = line.trim().replace(/[.…]+$/, "");
  return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/** A step as something a bot is doing: "running the tests", or for a line that isn't one, "working on PR review". */
function doing(line: string): string {
  const text = midSentence(line);
  return /^\S+ing\b/i.test(text) ? text : `working on ${text}`;
}

/**
 * What a bot busy in another chat is doing there, in words for this chat (`viewedId`), as phrases that
 * follow "Scout is …": the most exact first, then shorter ones, for the place showing it to take the
 * first that fits (FitText). A name is only ever dropped whole, for "another group" and the like.
 *
 * What it's doing is the turn's live step there, as that chat's own working row says it, or what kind
 * of thing it is: writing a message ("posting in…", "messaging Pip"), a routine, plain work. Where is
 * the place by a name the viewer knows: a group's name, "its chat with you", the bots in a side chat
 * ("talking with Pip and Tally"). Work that came from this chat (a handoff, or a post about it, or a
 * side chat opened from here: BotStatus.from) says so: "posting about this in…". A chat the viewer
 * can't see (hidden, or not theirs) shows neither its name nor what's going on there: only that it's
 * busy in another chat.
 */
export function awayLines(viewedId: string, botId: string, st: BotStatus | undefined, known: AwayKnown): string[] {
  const there = known.conversations.find((c) => c.id === st?.conversationId);
  if (!st || !there || there.hidden) return [AWAY_PRIVATE];
  const fromHere = st.from === viewedId || there.huddle?.from === viewedId;
  const line = shownLine(st, known.shown);
  const writing = line === WRITING_REPLY || line === TYPING || !!known.typing?.[there.id]?.includes(botId);
  const routine = !writing && !!st.routine && (plainWork(line) || line === ROUTINE_START);
  const plain = !writing && !routine && plainWork(line);
  const step = writing || routine || plain ? undefined : doing(line);
  /** What it's doing, the exact way first and then the plain one, before where. */
  const acts = (generic: string, here: boolean): string[] => {
    if (routine) return [`running its “${st.routine!.trim()}” routine`, "running a routine"];
    if (step) return [`${step}${here ? " for this" : ""}`, generic];
    return [generic];
  };
  const out: string[] = [];
  const add = (...lines: string[]) => {
    for (const l of lines) if (!out.includes(l)) out.push(l);
  };
  // Said as about this chat first, when it is, and then without that, where it's too long to fit.
  for (const here of fromHere ? [true, false] : [false]) {
    if (there.kind === "group") {
      const named = `in ${groupPlace(there.name)}`;
      const anon = "in another group";
      const [exact, generic] = writing ? [`posting${here ? " about this" : ""}`] : acts(here ? "working on this" : "doing something", here);
      add(`${exact} ${named}`, `${exact} ${anon}`);
      if (generic) add(`${generic} ${named}`, `${generic} ${anon}`);
    } else if (there.kind === "direct") {
      const [exact, generic] = writing ? ["messaging you"] : acts(here ? "working on this" : "doing something", here);
      add(writing ? exact! : `${exact} in its chat with you`);
      if (generic) add(`${generic} in its chat with you`);
    } else {
      const others = there.botIds.filter((id) => id !== botId);
      const one = others.length === 1;
      const names = listed(others.map((id) => botName(known.bots, id)));
      const about = here ? " about this" : "";
      const talking = `talking with ${names}${about}`;
      if (writing && one) add(`messaging ${names}${about}`);
      else if (step || routine) {
        const [exact] = acts("", here);
        add(`${exact} ${one ? `in its chat with ${names}` : `in a side chat with ${names}`}`);
      }
      add(talking);
      if (!one) add(`talking with ${others.length} bots${about}`);
      add(`in a side chat${about}`);
    }
  }
  add(AWAY_SHORT);
  return out;
}

/** The phrases of `awayLines` said of the bot by name, for a chat with several: "Scout is running the tests in…". */
export const awayOf = (name: string, lines: string[]) => lines.map((l) => `${name.split(" ·")[0]} is ${l}`);

/** Or as a line of its own, for the bot's own chat: "Running the tests in…". */
export const awayAlone = (lines: string[]) => lines.map((l) => l[0]!.toUpperCase() + l.slice(1));

/**
 * The bots with a working line in the chat: at work on it, not typing ("Typing…" shows that), and not
 * quiet. Quiet work (a reaction it may let be, tidying up after a reply) only animates the mascot.
 */
export function showWorking(conversationId: string, status: Statuses, typing: string[]): string[] {
  return Object.entries(status)
    .filter(([id, st]) => !typing.includes(id) && (holding(st, conversationId) || (workingHere(st, conversationId) && !st!.quiet)))
    .map(([id]) => id);
}

/** What a bot says in a chat while it finishes replying in another. Stable per chat, so it doesn't flicker. */
const HOLDING = ["Hold on a second", "Finishing up something", "One moment, wrapping something up", "Be right with you"];
export function holdingLine(conversationId: string, botId: string): string {
  let hash = 0;
  for (const ch of conversationId + botId) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return HOLDING[Math.abs(hash) % HOLDING.length]!;
}

/**
 * A bot's working line in a chat: the live step its status names, or that it's holding on while it
 * finishes elsewhere. Never empty and never a bare "Thinking" (statusLine).
 */
export function workingLine(conversationId: string, botId: string, st: BotStatus | undefined, shown?: Shown): string {
  return holding(st, conversationId) ? holdingLine(conversationId, botId) : shownLine(st, shown);
}

/**
 * The bot the header's line is about: one at work here (not quietly), else one holding on with this
 * chat's message next. Undefined when none is.
 */
export function liveBot(conversation: Pick<Conversation, "id" | "botIds">, status: Statuses): string | undefined {
  return conversation.botIds.find((id) => workingHere(status[id], conversation.id) && !status[id]!.quiet) ?? conversation.botIds.find((id) => holding(status[id], conversation.id));
}

/**
 * What a chat's bots are up to right now, in one line: under its name in the header. One of them
 * typing here says so, then the line of one at work here (as its working row says it), then one
 * holding on. Undefined when there's nothing to say: quiet work shows only in the mascot.
 */
export function liveLine(conversation: Pick<Conversation, "id" | "botIds">, status: Statuses, typing: string[] | undefined, shown: Record<string, Shown | undefined> = {}): string | undefined {
  if (typing?.length) return TYPING;
  const id = liveBot(conversation, status);
  return id ? workingLine(conversation.id, id, status[id], shown[id]) : undefined;
}

/**
 * The conversation's bots its stop button would stop: at work here or with this chat's message next
 * in line, and in a bot's own chat, at work anywhere. The server stops the same ones (stopConversation).
 */
export function stoppable(conversation: Pick<Conversation, "id" | "botIds" | "kind">, status: Statuses): string[] {
  return conversation.botIds.filter((id) => {
    const st = status[id];
    // One still deciding has nothing to stop yet that anyone can see, nor one only waiting on threads: they're the threads' to stop.
    return visiblyWorking(st) && !(st!.threads && !st!.jobs) && (homeHere(conversation, st) || st!.conversationId === conversation.id || (!!st!.waiting?.includes(conversation.id) && !st!.undecided?.includes(conversation.id)));
  });
}

/**
 * What the sidebar says of a conversation in place of its last message while one of its bots is between
 * turns waiting on OpenBuild threads it started or wrote to from there (BotStatus.threads): the same
 * line as the chat's working row and its header.
 */
export function waitingOnThreadsLine(conversation: Pick<Conversation, "id" | "botIds">, status: Statuses): string | undefined {
  const id = conversation.botIds.find((id) => !!status[id]?.threads && workingHere(status[id], conversation.id));
  return id ? statusLine(status[id]) : undefined;
}

/** Where a coding thread a bot started is: replying, blocked on a question for the user, or done. */
export type ThreadActivity = "working" | "waiting" | "idle";

export function threadActivity(chat: Pick<Chat, "messages">): ThreadActivity {
  const last = chat.messages.findLast((m) => m.role === "assistant");
  if (last?.status !== "streaming") return "idle";
  return last.parts?.some((p) => p.type === "ask" && p.answer === undefined) ? "waiting" : "working";
}

/**
 * The bot that started this thread from this conversation, if one did: the thread says so itself
 * (`startedBy`), and older ones by the conversation's "Started a thread" line.
 */
export function threadStarter(conversation: Pick<Conversation, "id" | "messages">, chat: Pick<Chat, "id" | "startedBy">): string | undefined {
  if (chat.startedBy) return chat.startedBy.conversation === conversation.id ? chat.startedBy.bot : undefined;
  return conversation.messages.find((m) => m.event?.kind === "thread" && m.event.text === "Started a thread" && m.event.threadId === chat.id)?.author;
}

/**
 * What the conversation's details list under Threads: the threads its bots started from it, while
 * they're still going (waiting for an answer counts). A finished one drops off.
 */
export function runningThreads(conversation: Pick<Conversation, "id" | "messages">, chats: Chat[]): { chat: Chat; bot: string }[] {
  const started = new Map<string, string>();
  for (const m of conversation.messages) if (m.event?.kind === "thread" && m.event.text === "Started a thread" && m.event.threadId) started.set(m.event.threadId, m.author);
  return chats.flatMap((chat) => {
    const bot = chat.startedBy ? (chat.startedBy.conversation === conversation.id ? chat.startedBy.bot : undefined) : started.get(chat.id);
    return bot && threadActivity(chat) !== "idle" ? [{ chat, bot }] : [];
  });
}

/**
 * Where a link in a conversation to one of its threads opens it: in the details' Threads tab while it's
 * listed there, else over OpenBots. A thread that hasn't reached this tab yet but that a bot here just
 * started (its "Started a thread" line came first) is still running, so it goes to the panel too.
 */
export function threadOpensIn(conversation: Pick<Conversation, "id" | "kind" | "messages">, chats: Chat[], threadId: string): "details" | "over" {
  if (conversation.kind === "side") return "over";
  const chat = chats.find((c) => c.id === threadId);
  if (!chat) return threadStarter(conversation, { id: threadId }) ? "details" : "over";
  return threadStarter(conversation, chat) && threadActivity(chat) !== "idle" ? "details" : "over";
}

/** Who serves a native harness's models when its thread doesn't say otherwise. */
const SERVED_BY: Partial<Record<ThreadRuntime, string>> = { codex: "openai", claude: "anthropic", cursor: "cursor", grok: "xai", fx: "vercel", opencode: "opencode", hermes: "hermes" };
/** Opencode's own plans, which Pi threads can run on too. */
const OPENCODE_PLANS = new Set(["go", "plus", "black", "zen"]);

/**
 * The provider behind a thread's model, as a provider id ProviderIcon and providerName know: the one in
 * a Pi model's id ("openrouter/kimi-k3" → "openrouter"), the one an OpenCode, fx or Hermes model names
 * after its harness ("opencode/anthropic/claude-…" → "anthropic"), else whoever serves that harness's
 * models (Codex → OpenAI, Claude Code → Anthropic). Undefined for a Pi thread that hasn't answered yet.
 */
export function threadProvider(chat: Pick<Chat, "runtime" | "messages">): string | undefined {
  const runtime = chat.runtime ?? "pi";
  const model = chat.messages.findLast((m) => m.model)?.model;
  if (model) {
    const parts = model.id.split("/");
    if (OPENCODE_PLANS.has(model.plan)) return "opencode";
    if (model.plan === "pi") return parts.length > 1 ? parts[0] : undefined;
    // fx's own name for the Vercel AI Gateway ("fx/gateway/openai/gpt-5").
    if (model.plan === "fx" && parts[1] === "gateway") return "vercel";
    if ((model.plan === "opencode" || model.plan === "fx" || model.plan === "hermes") && parts.length > 2) return parts[1];
  }
  return SERVED_BY[runtime];
}

/**
 * What a thread runs on, for the two marks beside it in the details' Threads tab: its harness, named with
 * the account it signed in as ("Codex · codex2"), and the provider behind its model with that one's name.
 */
export function threadBrands(chat: Pick<Chat, "runtime" | "runtimeAccount" | "messages">): { runtime: ThreadRuntime; harness: string; provider?: { id: string; name: string } } {
  const runtime = chat.runtime ?? "pi";
  const provider = threadProvider(chat);
  return {
    runtime,
    harness: [runtimeName(runtime), chat.runtimeAccount?.name].filter(Boolean).join(" · "),
    provider: provider ? { id: provider, name: providerName(provider) } : undefined,
  };
}
