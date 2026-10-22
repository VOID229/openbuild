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
  /** Per chat, the queued message open in the composer. It keeps its slot, and nothing is sent meanwhile. */
  editing: Record<string, string>;
}

export const useQueue = create<QueueState>(() => ({ queues: {}, editing: {} }));

const EMPTY: Queued[] = [];

export const queueOf = (chatId: string | undefined) => (chatId && useQueue.getState().queues[chatId]) || EMPTY;
export const useQueueOf = (chatId: string | undefined) => useQueue((s) => (chatId && s.queues[chatId]) || EMPTY);

function setQueue(chatId: string, list: Queued[]) {
  useQueue.setState((s) => {
    const { [chatId]: _, ...rest } = s.queues;
    return { queues: list.length ? { ...rest, [chatId]: list } : rest };
  });
}

export function enqueue(chatId: string, item: Queued) {
  setQueue(chatId, [...queueOf(chatId), item]);
}

export function updateQueued(chatId: string, id: string, patch: Pick<Queued, "text" | "files">) {
  setQueue(chatId, queueOf(chatId).map((q) => (q.id === id ? { ...q, ...patch } : q)));
}

export const editingQueued = (chatId: string): string | undefined => useQueue.getState().editing[chatId];
export const useEditingQueued = (chatId: string | undefined) => useQueue((s) => (chatId ? s.editing[chatId] : undefined));

export function setEditingQueued(chatId: string, id: string | undefined) {
  useQueue.setState((s) => {
    const { [chatId]: _, ...rest } = s.editing;
    return { editing: id ? { ...rest, [chatId]: id } : rest };
  });
}

export function removeQueued(chatId: string, id: string) {
  setQueue(chatId, queueOf(chatId).filter((q) => q.id !== id));
}

/** Move a message to position `to` (first is sent first). */
export function moveQueued(chatId: string, id: string, to: number) {
  const list = queueOf(chatId).filter((q) => q.id !== id);
  const item = queueOf(chatId).find((q) => q.id === id);
  if (!item) return;
  list.splice(Math.max(0, Math.min(to, list.length)), 0, item);
  setQueue(chatId, list);
}

/** Put messages back at the front, e.g. ones steered into a reply that ended before Pi read them. */
export function requeue(chatId: string, items: Queued[]) {
  if (items.length) setQueue(chatId, [...items, ...queueOf(chatId).filter((q) => !items.includes(q))]);
}

export function shiftQueue(chatId: string): Queued | undefined {
  const [next, ...rest] = queueOf(chatId);
  if (next) setQueue(chatId, rest);
  return next;
}
