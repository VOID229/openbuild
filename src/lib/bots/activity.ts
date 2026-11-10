// Who is busy, and where. The sidebar, the chat's header and its list all read from here, so a bot
// never looks busy in one place and idle in another, and work in another chat isn't shown as work here.
import { providerName } from "../models";
import type { ThreadRuntime } from "../../../shared/types";
import type { Chat } from "../types";
import type { BotStatus, Conversation } from "./types";

type Statuses = Record<string, BotStatus | undefined>;

/** Busy replying in another chat, with this one's message next in line. */
export const holding = (st: BotStatus | undefined, conversationId: string) => !!st && st.state !== "idle" && st.conversationId !== conversationId && !!st.waiting?.includes(conversationId);

/** Working in this chat, quietly or not. */
export const workingHere = (st: BotStatus | undefined, conversationId: string) => st?.state === "working" && st.conversationId === conversationId;

/**
 * The conversation's bots that are busy, wherever: working in any chat, or typing in this one. Their
 * mascots fidget, in the sidebar and in the chat's header, so a bot busy in a group still looks busy
 * in its own chat. What they're doing, and where, is the chat's to say (see `elsewhere`).
 */
export function busyBots(conversation: Pick<Conversation, "id" | "botIds">, status: Statuses, typing: Record<string, string[] | undefined>): string[] {
  const here = typing[conversation.id] ?? [];
  return conversation.botIds.filter((id) => here.includes(id) || status[id]?.state === "working");
}

/** The conversation's bots working in another chat, and which, unless this chat's message is next (that's `holding`). */
export function elsewhere(conversation: Pick<Conversation, "id" | "botIds">, status: Statuses): { botId: string; conversationId?: string }[] {
  return conversation.botIds
    .filter((id) => status[id]?.state === "working" && status[id]!.conversationId !== conversation.id && !holding(status[id], conversation.id))
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

/** Where a coding thread a bot started is: replying, blocked on a question for the user, or done. */
export type ThreadActivity = "working" | "waiting" | "idle";

export function threadActivity(chat: Pick<Chat, "messages">): ThreadActivity {
  const last = chat.messages.findLast((m) => m.role === "assistant");
  if (last?.status !== "streaming") return "idle";
  return last.parts?.some((p) => p.type === "ask" && p.answer === undefined) ? "waiting" : "working";
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

const HARNESS: Record<ThreadRuntime, string> = { pi: "Pi", durable: "Durable", fx: "fx", codex: "Codex", cursor: "Cursor", claude: "Claude", opencode: "OpenCode", hermes: "Hermes", grok: "Grok" };

/**
 * The harness a thread runs on and the account or provider behind it, briefly: "Codex · codex2",
 * "Claude · claude2", "Pi · Anthropic". Just the harness when neither is known.
 */
export function threadHarness(chat: Pick<Chat, "runtime" | "runtimeAccount" | "messages">): string {
  const runtime = chat.runtime ?? "pi";
  const model = chat.messages.findLast((m) => m.role === "assistant" && m.model)?.model;
  const provider = runtime === "pi" && model?.plan === "pi" && model.id.includes("/") ? providerName(model.id.split("/")[0]!) : undefined;
  return [HARNESS[runtime] ?? runtime, chat.runtimeAccount?.name ?? provider].filter(Boolean).join(" · ");
}
