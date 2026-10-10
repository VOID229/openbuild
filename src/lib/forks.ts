import type { Chat } from "./types";

/** The deepest "fork of a fork" allowed: a 5th opinion. */
export const MAX_FORK_DEPTH = 5;

/** 1 for an ordinary chat, 2 for a "2nd" chat, and so on. Forks without a stored depth are 2nd. */
export function chatDepth(chat: Pick<Chat, "forkOf" | "forkDepth">): number {
  return chat.forkOf ? (chat.forkDepth ?? 2) : 1;
}

/** "2nd", "3rd", "4th", "5th". */
export function ordinal(depth: number): string {
  return depth === 2 ? "2nd" : depth === 3 ? "3rd" : `${depth}th`;
}
