// Unsent composer text and attachments, one per chat (NEW_CHAT for the new-chat screen). Saved in
// this browser's IndexedDB as you type, so they survive switching chats, reloads and quitting, and
// (when signed in) synced to your other devices: uploaded once typing pauses, fetched by the others
// when the app opens or comes back into view (cloud/sync.ts). Drafts last edited more than
// DRAFT_TTL ago are dropped on load; the sync server deletes its copies on the same schedule.
//
// Attachments are stored apart from the draft ("draftfile:<id>"), so editing the text never
// writes or uploads an image again.
import type { Attachment } from "../../shared/types";
import { DRAFT_TTL } from "../../shared/drafts";
import { createStore, del, entries, set } from "./kv";

/** A draft as stored and synced. */
export interface StoredDraft {
  text: string;
  fileIds: string[];
  updatedAt: number;
}

export interface Draft {
  text: string;
  files: Attachment[];
}

export const NEW_CHAT = "new";
const SAVE_DELAY = 400;

const store = createStore("openchat-drafts", "drafts");
/** By record key: "draft:<chat id>" and "draftfile:<attachment id>". */
const drafts = new Map<string, StoredDraft>();
const files = new Map<string, Attachment>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const draftKey = (key: string) => `draft:${key}`;
const fileKey = (id: string) => `draftfile:${id}`;
const fresh = (d: StoredDraft) => Date.now() - d.updatedAt < DRAFT_TTL;

/** Told about every local change, by record key (cloud sync uses it). */
export const draftListeners = new Set<(record: string) => void>();
/** Told when a draft changes from elsewhere (another device), by chat key. */
const remoteListeners = new Set<(key: string) => void>();
export function onRemoteDraft(fn: (key: string) => void) {
  remoteListeners.add(fn);
  return () => void remoteListeners.delete(fn);
}

/** Resolves once the drafts saved before this page load are available. */
export const draftsReady: Promise<void> = (async () => {
  try {
    const saved = await entries<string, unknown>(store);
    for (const [k, v] of saved) {
      if (k.startsWith("draftfile:")) files.set(k.slice(10), v as Attachment);
      else if (k.startsWith("draft:") && fresh(v as StoredDraft)) drafts.set(k.slice(6), v as StoredDraft);
    }
    // Drop expired drafts, attachments no draft uses anymore, and anything else left in the store.
    const used = new Set([...drafts.values()].flatMap((d) => d.fileIds));
    for (const id of files.keys()) if (!used.has(id)) files.delete(id);
    for (const [k] of saved) {
      const keep = k.startsWith("draftfile:") ? files.has(k.slice(10)) : k.startsWith("draft:") && drafts.has(k.slice(6));
      if (!keep) void del(k, store).catch(() => {});
    }
  } catch {}
})();

/** Write a record to IndexedDB shortly (debounced while typing). */
function persist(record: string) {
  clearTimeout(timers.get(record));
  timers.set(record, setTimeout(() => write(record), SAVE_DELAY));
}

function write(record: string) {
  clearTimeout(timers.get(record));
  timers.delete(record);
  const value = record.startsWith("draftfile:") ? files.get(record.slice(10)) : drafts.get(record.slice(6));
  void (value ? set(record, value, store) : del(record, store)).catch(() => {});
}

export function getDraft(key: string): Draft | undefined {
  const d = drafts.get(key);
  return d && { text: d.text, files: d.fileIds.map((id) => files.get(id)).filter((f): f is Attachment => !!f) };
}

export function saveDraft(key: string, text: string, list: Attachment[]) {
  const prev = drafts.get(key);
  const ids = list.map((f) => f.id);
  const empty = !text.trim() && !list.length;
  if (prev ? prev.text === text && prev.fileIds.join() === ids.join() : empty) return;
  const changed: string[] = [];
  for (const f of list) {
    if (files.has(f.id)) continue;
    files.set(f.id, f);
    changed.push(fileKey(f.id));
  }
  if (empty) drafts.delete(key);
  else drafts.set(key, { text, fileIds: ids, updatedAt: Date.now() });
  changed.push(draftKey(key));
  // Attachments removed from this draft and used by no other one. (The synced copies expire.)
  const used = new Set([...drafts.values()].flatMap((d) => d.fileIds));
  for (const id of prev?.fileIds ?? []) {
    if (used.has(id)) continue;
    files.delete(id);
    persist(fileKey(id));
  }
  for (const record of changed) {
    persist(record);
    draftListeners.forEach((fn) => fn(record));
  }
}

// ---------------------------------------------------------------- for cloud sync

/** The current value of a draft record, or undefined when there is none. */
export function draftRecord(record: string): StoredDraft | Attachment | undefined {
  if (record.startsWith("draftfile:")) return files.get(record.slice(10));
  const d = drafts.get(record.slice(6));
  return d && fresh(d) ? d : undefined;
}

/**
 * Apply a draft record from another device (undefined: it was sent or cleared there, at `clearedAt`).
 * Either replaces this device's draft only if it's newer. Returns whether anything changed.
 */
export async function applyDraftRecord(record: string, value: StoredDraft | Attachment | undefined, clearedAt = Infinity): Promise<boolean> {
  await draftsReady;
  if (record.startsWith("draftfile:")) {
    if (!value) return false;
    // Kept even before a draft refers to it: the draft may simply arrive later.
    const id = record.slice(10);
    files.set(id, value as Attachment);
    persist(record);
    for (const [key, d] of drafts) if (d.fileIds.includes(id)) remoteListeners.forEach((fn) => fn(key));
    return true;
  }
  const key = record.slice(6);
  const local = drafts.get(key);
  const remote = value as StoredDraft | undefined;
  if (remote) {
    if (!fresh(remote) || (local && local.updatedAt >= remote.updatedAt)) return false;
    drafts.set(key, remote);
  } else {
    if (!local || local.updatedAt > clearedAt) return false;
    drafts.delete(key);
  }
  persist(record);
  remoteListeners.forEach((fn) => fn(key));
  return true;
}

if (typeof window !== "undefined") {
  // Don't lose the last keystrokes when the tab closes or reloads.
  window.addEventListener("pagehide", () => [...timers.keys()].forEach(write));
}
