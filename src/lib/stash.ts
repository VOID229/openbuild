// Composer drafts set aside to reuse in any thread (or, in OpenBots' own stash, any conversation). Unlike
// drafts they don't belong to a chat and never expire: one stays, in this browser's IndexedDB, until it's used or removed.
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { Attachment } from "../../shared/types";
import { capAttached, parseFileRef } from "../../shared/bots";
import { uid } from "./id";
import { createStore, del, entries, set } from "./kv";

export interface Stashed {
  id: string;
  text: string;
  files: Attachment[];
  createdAt: number;
}

export interface StashStore {
  /** Newest first. */
  use: UseBoundStore<StoreApi<{ items: Stashed[] }>>;
  ready: Promise<void>;
  add: (text: string, files: Attachment[]) => Stashed;
  remove: (id: string) => void;
}

const report = (err: unknown) => console.error("Couldn't save the stash", err);

function createStash(name: string): StashStore {
  const use = create<{ items: Stashed[] }>(() => ({ items: [] }));
  const storage = createStore(name, "stash");
  /** Changed since the last read began, so a read in progress can't undo them. */
  const touched = new Set<string>();

  async function read() {
    touched.clear();
    try {
      const saved = (await entries<string, Stashed>(storage)).map(([, item]) => item).filter((item) => !touched.has(item.id));
      use.setState((s) => ({ items: [...s.items.filter((item) => touched.has(item.id)), ...saved].sort((a, b) => b.createdAt - a.createdAt) }));
    } catch (err) {
      console.error("Couldn't restore the stash", err);
    }
  }

  // Another window may have stashed or used something meanwhile.
  if (typeof window !== "undefined") window.addEventListener?.("focus", () => void read());

  return {
    use,
    ready: read(),
    add(text, files) {
      const item = { id: uid(), text, files, createdAt: Date.now() };
      touched.add(item.id);
      use.setState((s) => ({ items: [item, ...s.items] }));
      void set(item.id, item, storage).catch(report);
      return item;
    },
    remove(id) {
      touched.add(id);
      use.setState((s) => ({ items: s.items.filter((item) => item.id !== id) }));
      void del(id, storage).catch(report);
    },
  };
}

/** OpenBuild's stash. */
export const threadStash = createStash("openchat-stash");
/** OpenBots' own stash, used unless cross-stashing (Settings → General) shares OpenBuild's. */
export const botStash = createStash("openbots-stash");
export const botStashOf = (crossStash: boolean | undefined) => (crossStash ? threadStash : botStash);

export const useStash = threadStash.use;
export const stashReady = threadStash.ready;
export const addStash = threadStash.add;
export const removeStash = threadStash.remove;

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

/** What a bot message or composer carries (image data URLs, and files as their references) as stash attachments. */
export function imageFiles(images: string[]): Attachment[] {
  return images.map((dataUrl) => {
    const file = parseFileRef(dataUrl);
    // A file stays on its workspace's server: the reference is all that travels, where a data URL would be.
    if (file) return { id: uid(), name: file.name, mime: file.mime || "application/octet-stream", dataUrl, size: file.size };
    return { id: uid(), name: "Image", mime: /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? "image/jpeg", dataUrl, size: Math.round((dataUrl.length * 3) / 4) };
  });
}

/**
 * A bot composer after pasting a stash into it. OpenBots takes text, a few images and the files that
 * were uploaded for bots; anything else a shared OpenBuild stash carries (documents, mentioned files,
 * files kept for a thread's machine) is counted in `left`.
 */
export function pasteBotStash(current: { text: string; images: string[] }, item: Stashed) {
  const { text } = pasteStash({ text: current.text, files: [] }, item);
  const fresh = item.files.filter((f) => !f.mention && (f.mime.startsWith("image/") || parseFileRef(f.dataUrl)) && f.dataUrl && !current.images.includes(f.dataUrl)).map((f) => f.dataUrl);
  const images = capAttached([...current.images, ...fresh]);
  const left = item.files.filter((f) => !f.mention).length - (images.length - current.images.length);
  return { text, images, left };
}
