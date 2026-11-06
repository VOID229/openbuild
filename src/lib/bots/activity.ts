// Who is busy, and where. The sidebar, the chat's header and its list all read from here, so a bot
// never looks busy in one place and idle in another, and work in another chat isn't shown as work here.
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
