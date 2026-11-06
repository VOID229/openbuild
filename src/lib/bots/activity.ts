// Who is at work in a conversation. The sidebar, the chat's header and its list all read from here,
// so a bot never looks busy in one place and idle in another. Work in another chat isn't work here.
import type { BotStatus, Conversation } from "./types";

type Statuses = Record<string, BotStatus | undefined>;

/** Busy replying in another chat, with this one's message next in line. */
export const holding = (st: BotStatus | undefined, conversationId: string) => !!st && st.state !== "idle" && st.conversationId !== conversationId && !!st.waiting?.includes(conversationId);

/** Working in this chat, quietly or not. */
export const workingHere = (st: BotStatus | undefined, conversationId: string) => st?.state === "working" && st.conversationId === conversationId;

/**
 * The conversation's bots at work on it: working in it (quietly too), typing in it, or finishing
 * elsewhere with its message next. These animate, in the sidebar and in the chat's header.
 */
export function atWork(conversation: Pick<Conversation, "id" | "botIds">, status: Statuses, typing: Record<string, string[] | undefined>): string[] {
  const here = typing[conversation.id] ?? [];
  return conversation.botIds.filter((id) => here.includes(id) || workingHere(status[id], conversation.id) || holding(status[id], conversation.id));
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
