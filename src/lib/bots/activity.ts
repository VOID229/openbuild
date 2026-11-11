// Who is busy, and where. The sidebar, the chat's header and its list all read from here, so a bot
// never looks busy in one place and idle in another, and work in another chat isn't shown as work here.
import { providerName } from "../models";
import { runtimeName } from "../runtimes";
import type { ThreadRuntime } from "../../../shared/types";
import type { Chat } from "../types";
import type { BotStatus, Conversation } from "./types";

type Statuses = Record<string, BotStatus | undefined>;

/** Busy replying in another chat, with this one's message next in line. Not a group's: it hasn't decided whether that one's its to answer. */
export const holding = (st: BotStatus | undefined, conversationId: string) =>
  !!st && st.state !== "idle" && st.conversationId !== conversationId && !!st.waiting?.includes(conversationId) && !st.undecided?.includes(conversationId);

/**
 * Working, as far as anyone can see. A bot deciding whether a group message is its to answer isn't,
 * anywhere: until it types or picks up a tool, nothing shows of it, not even its mascot.
 */
export const visiblyWorking = (st: BotStatus | undefined) => st?.state === "working" && !st.deciding;

/** Working in this chat, quietly or not. */
export const workingHere = (st: BotStatus | undefined, conversationId: string) => visiblyWorking(st) && st!.conversationId === conversationId;

/**
 * The conversation's bots that are busy, wherever: working in any chat, or typing in this one. Their
 * mascots fidget, in the sidebar and in the chat's header, so a bot busy in a group still looks busy
 * in its own chat. What they're doing, and where, is the chat's to say (see `elsewhere`).
 */
export function busyBots(conversation: Pick<Conversation, "id" | "botIds">, status: Statuses, typing: Record<string, string[] | undefined>): string[] {
  const here = typing[conversation.id] ?? [];
  return conversation.botIds.filter((id) => here.includes(id) || visiblyWorking(status[id]));
}

/** The conversation's bots working in another chat, and which, unless this chat's message is next (that's `holding`). */
export function elsewhere(conversation: Pick<Conversation, "id" | "botIds">, status: Statuses): { botId: string; conversationId?: string }[] {
  return conversation.botIds
    .filter((id) => visiblyWorking(status[id]) && status[id]!.conversationId !== conversation.id && !holding(status[id], conversation.id))
    .map((id) => ({ botId: id, conversationId: status[id]!.conversationId }));
}

/**
 * The bots with a working line in the chat: at work on it, not typing (the dots show that), and not
 * quiet. Quiet work (a reaction it may let be, tidying up after a reply) only animates the mascot.
 */
export function showWorking(conversationId: string, status: Statuses, typing: string[]): string[] {
  return Object.entries(status)
    .filter(([id, st]) => !typing.includes(id) && (holding(st, conversationId) || (workingHere(st, conversationId) && !st!.quiet)))
    .map(([id]) => id);
}

/**
 * The conversation's bots its stop button would stop: at work here or with this chat's message next
 * in line, and in a bot's own chat, at work anywhere. The server stops the same ones (stopConversation).
 */
export function stoppable(conversation: Pick<Conversation, "id" | "botIds" | "kind">, status: Statuses): string[] {
  return conversation.botIds.filter((id) => {
    const st = status[id];
    // One still deciding has nothing to stop yet that anyone can see.
    return visiblyWorking(st) && (conversation.kind === "direct" || st!.conversationId === conversation.id || (!!st!.waiting?.includes(conversation.id) && !st!.undecided?.includes(conversation.id)));
  });
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

/** Whether the bot is acting on this thread right now: in an openbuild call that names it (see BotStatus.thread). */
export function actingOn(st: BotStatus | undefined, threadId: string): boolean {
  return st?.state === "working" && !!st.thread && threadId.startsWith(st.thread);
}

/**
 * How the mascot beside a thread shows it: awake and fidgeting while its bot is acting on the thread
 * (reading it, messaging it, stopping or closing it), and dozing otherwise, however busy the thread is.
 */
export function threadMascot(acting: boolean): { busy: boolean; asleep: boolean } {
  return acting ? { busy: true, asleep: false } : { busy: false, asleep: true };
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
