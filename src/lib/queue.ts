import { create } from "zustand";
import type { Attachment } from "../../shared/types";

/** A message written while a reply was still coming in; it's sent once the chat is free. */
export interface Queued {
  id: string;
  text: string;
  files: Attachment[];
}

interface QueueState {
  /** Per chat, oldest first. Kept in memory only, like the replies they wait on. */
  queues: Record<string, Queued[]>;
}

export const useQueue = create<QueueState>(() => ({ queues: {} }));

const EMPTY: Queued[] = [];

export const queueOf = (chatId: string | undefined) => (chatId && useQueue.getState().queues[chatId]) || EMPTY;
export const useQueueOf = (chatId: string | undefined) => useQueue((s) => (chatId && s.queues[chatId]) || EMPTY);

function setQueue(chatId: string, list: Queued[]) {
  useQueue.setState((s) => {
    const { [chatId]: _, ...rest } = s.queues;
    return { queues: list.length ? { ...rest, [chatId]: list } : rest };
  });
}

/** Add at the end, or at `index` (putting back an item that was taken out to edit). */
export function enqueue(chatId: string, item: Queued, index?: number) {
  const list = [...queueOf(chatId)];
  list.splice(index ?? list.length, 0, item);
  setQueue(chatId, list);
}

export function removeQueued(chatId: string, id: string) {
  setQueue(chatId, queueOf(chatId).filter((q) => q.id !== id));
}

export function shiftQueue(chatId: string): Queued | undefined {
  const [next, ...rest] = queueOf(chatId);
  if (next) setQueue(chatId, rest);
  return next;
}
