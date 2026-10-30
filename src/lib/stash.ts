// Composer drafts set aside to reuse in any thread. Unlike drafts they don't belong to a chat and
// never expire: one stays, in this browser's IndexedDB, until it's used or removed.
import { create } from "zustand";
import type { Attachment } from "../../shared/types";
import { uid } from "./id";
import { createStore, del, entries, set } from "./kv";

export interface Stashed {
  id: string;
  text: string;
  files: Attachment[];
  createdAt: number;
}

/** Newest first. */
export const useStash = create<{ items: Stashed[] }>(() => ({ items: [] }));

const storage = createStore("openchat-stash", "stash");
/** Changed since the last read began, so a read in progress can't undo them. */
const touched = new Set<string>();

const report = (err: unknown) => console.error("Couldn't save the stash", err);

async function read() {
  touched.clear();
  try {
    const saved = (await entries<string, Stashed>(storage)).map(([, item]) => item).filter((item) => !touched.has(item.id));
    useStash.setState((s) => ({ items: [...s.items.filter((item) => touched.has(item.id)), ...saved].sort((a, b) => b.createdAt - a.createdAt) }));
  } catch (err) {
    console.error("Couldn't restore the stash", err);
  }
}

export const stashReady: Promise<void> = read();

// Another window may have stashed or used something meanwhile.
if (typeof window !== "undefined") window.addEventListener?.("focus", () => void read());

export function addStash(text: string, files: Attachment[]): Stashed {
  const item = { id: uid(), text, files, createdAt: Date.now() };
  touched.add(item.id);
  useStash.setState((s) => ({ items: [item, ...s.items] }));
  void set(item.id, item, storage).catch(report);
  return item;
}

export function removeStash(id: string) {
  touched.add(id);
  useStash.setState((s) => ({ items: s.items.filter((item) => item.id !== id) }));
  void del(id, storage).catch(report);
}

/** What the stash shortcut does for a composer in this state. */
export function stashAction(hasContent: boolean, count: number): "stash" | "use" | "open" | undefined {
  if (hasContent) return "stash";
  if (count > 1) return "open";
  return count === 1 ? "use" : undefined;
}

/** The composer after pasting a stash into it. What was already written stays, ahead of it. */
export function pasteStash(current: { text: string; files: Attachment[] }, item: Stashed) {
  const before = current.text.trim() ? `${current.text}${current.text.endsWith("\n") ? "" : "\n"}` : "";
  const added = item.files.filter((f) => !current.files.some((c) => c.id === f.id || (f.mention && c.mention && c.name === f.name)));
  return { text: before + item.text, files: [...current.files, ...added] };
}
