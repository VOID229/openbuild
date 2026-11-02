import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createStore, del, entries, get, set } from "./kv";
import type { Attachment } from "../../shared/types";

/** A message written while a reply was still coming in; it's sent once the chat is free. */
export interface Queued {
  id: string;
  text: string;
  files: Attachment[];
}

interface QueueState {
  /** Per chat, oldest first. Saved locally so a reload doesn't forget unsent actions. */
  queues: Record<string, Queued[]>;
  /** Handed to Pi but not yet acknowledged by the reply's steer event (also replayed on resume). */
  steering: Record<string, Queued[]>;
  /** Per chat, the queued message open in the composer. It keeps its slot, and nothing is sent meanwhile. */
  editing: Record<string, string>;
}

const saved = createStore("openchat-queue", "queue");
let hydrated = false;
const changedBeforeHydration = new Set<string>();
const legacy = createStore("openchat-queues", "queues");
let resolveReady!: () => void;
export const queuesReady = new Promise<void>((resolve) => { resolveReady = resolve; });
export const queueIsReady = () => hydrated;
export const useQueue = create<QueueState>()(persist(() => ({ queues: {}, steering: {}, editing: {} }), {
  name: "queue",
  storage: createJSONStorage(() => ({
    getItem: async (key) => {
      const current = await get<string>(key, saved);
      if (current != null) return current;
      const queues = Object.fromEntries(await entries<string, Queued[]>(legacy));
      return JSON.stringify({ state: { queues, steering: {} }, version: 0 });
    },
    setItem: (key, value) => set(key, value, saved).catch((err) => console.error("Couldn't save queued actions", err)),
    removeItem: (key) => del(key, saved),
  })),
  partialize: ({ queues, steering }) => ({ queues, steering }),
  onRehydrateStorage: () => (_state, error) => {
    hydrated = true;
    resolveReady();
    if (error) console.error("Couldn't load queued actions", error);
  },
  merge: (persisted, current) => {
    const previous = persisted as Partial<QueueState> | undefined;
    const merge = (a: Record<string, Queued[]> = {}, b: Record<string, Queued[]>) => Object.fromEntries(
      [...new Set([...Object.keys(a), ...Object.keys(b)])].map((id) => [id, [...new Map([...(a[id] ?? []), ...(b[id] ?? [])].map((q) => [q.id, q])).values()]]),
    );
    const steering = merge(previous?.steering, current.steering);
    const queues = merge(previous?.queues, current.queues);
    for (const id of changedBeforeHydration) queues[id] = (current.queues as Record<string, Queued[]>)[id] ?? [];
    for (const id of Object.keys(queues)) {
      const pending = new Set(steering[id]?.map((q) => q.id));
      queues[id] = queues[id]!.filter((q) => !pending.has(q.id));
    }
    return { ...current, queues, steering };
  },
}));

const EMPTY: Queued[] = [];

export const queueOf = (chatId: string | undefined) => (chatId && useQueue.getState().queues[chatId]) || EMPTY;
export const useQueueOf = (chatId: string | undefined) => useQueue((s) => (chatId && s.queues[chatId]) || EMPTY);

function setQueue(chatId: string, list: Queued[]) {
  if (!hydrated) changedBeforeHydration.add(chatId);
  useQueue.setState((s) => {
    const { [chatId]: _, ...rest } = s.queues;
    return { queues: list.length ? { ...rest, [chatId]: list } : rest };
  });
}

export function clearQueue(chatId?: string) {
  useQueue.setState((s) => {
    if (!chatId) return { queues: {}, steering: {}, editing: {} };
    const { [chatId]: _queue, ...queues } = s.queues;
    const { [chatId]: _steers, ...steering } = s.steering;
    const { [chatId]: _editing, ...editing } = s.editing;
    return { queues, steering, editing };
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
  if (!items.length) return;
  const ids = new Set(items.map((q) => q.id));
  useQueue.setState((s) => ({
    queues: { ...s.queues, [chatId]: [...new Map(items.map((q) => [q.id, q])).values(), ...queueOf(chatId).filter((q) => !ids.has(q.id))] },
    steering: { ...s.steering, [chatId]: (s.steering[chatId] ?? []).filter((q) => !ids.has(q.id)) },
  }));
}

export const steeringOf = (chatId: string): Queued[] => useQueue.getState().steering[chatId] ?? EMPTY;

/** Keep an unsent action durable until the stream confirms Pi read it. */
export function stageSteer(chatId: string, item: Queued) {
  useQueue.setState((s) => ({
    queues: { ...s.queues, [chatId]: queueOf(chatId).filter((q) => q.id !== item.id) },
    steering: { ...s.steering, [chatId]: [...steeringOf(chatId), item] },
  }));
}

export function consumeSteer(chatId: string, id: string) {
  useQueue.setState((s) => ({ steering: { ...s.steering, [chatId]: steeringOf(chatId).filter((q) => q.id !== id) } }));
}

export function shiftQueue(chatId: string): Queued | undefined {
  const [next, ...rest] = queueOf(chatId);
  if (next) setQueue(chatId, rest);
  return next;
}

export const queuesLoaded = queueIsReady;
export const useSteeringOf = (chatId: string | undefined) => useQueue((s) => (chatId && s.steering[chatId]) || EMPTY);
export function setSteering(chatId: string, list: Queued[]) {
 useQueue.setState((s) => { const { [chatId]: _, ...rest } = s.steering; return { steering: list.length ? { ...rest, [chatId]: list } : rest }; });
}
