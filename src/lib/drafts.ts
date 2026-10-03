// Unsent composer text and attachments, one per chat (NEW_CHAT for the new-chat screen). Kept in
// this browser's IndexedDB only, never synced. Switching chats keeps every draft; after a reload,
// drafts last edited more than DRAFT_TTL ago are dropped.
import type { Attachment } from "../../shared/types";
import { createStore, del, entries, set } from "./kv";

export interface Draft {
  text: string;
  files: Attachment[];
  updatedAt: number;
}

export const NEW_CHAT = "new";
const DRAFT_TTL = 5 * 60_000;
const SAVE_DELAY = 400;

const store = createStore("openchat-drafts", "drafts");
const drafts = new Map<string, Draft>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Resolves once the drafts saved before this page load are available. */
export const draftsReady: Promise<void> = (async () => {
  try {
    const now = Date.now();
    for (const [key, d] of await entries<string, Draft>(store)) {
      if (drafts.has(key)) continue;
      if (now - d.updatedAt < DRAFT_TTL) drafts.set(key, d);
      else void del(key, store).catch(() => {});
    }
  } catch {}
})();

export const getDraft = (key: string) => drafts.get(key);

function write(key: string) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  const d = drafts.get(key);
  void (d ? set(key, d, store) : del(key, store)).catch(() => {});
}

export function saveDraft(key: string, text: string, files: Attachment[]) {
  if (text.trim() || files.length) drafts.set(key, { text, files, updatedAt: Date.now() });
  else drafts.delete(key);
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => write(key), SAVE_DELAY));
}

if (typeof window !== "undefined") {
  // Don't lose the last keystrokes when the tab closes or reloads.
  window.addEventListener("pagehide", () => [...timers.keys()].forEach(write));
}
