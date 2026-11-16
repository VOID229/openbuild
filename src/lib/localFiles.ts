// Files attached to a message that hasn't been sent yet.
//
// Attaching reads nothing and sends nothing: the browser keeps the File (a reference to it on disk),
// here in memory, and for files up to HOLD_CAP also in IndexedDB so a reload still has them. A larger
// one would be written to disk a second time by the browser, so it only lasts as long as the page.
// The file is uploaded when its message is sent (`uploadHeld`), to the machine that turn runs on.
//
// A file in a stash is also kept on the server (src/lib/stash.ts): a browser that doesn't hold it
// (another address, another device, or long after) gets it from there.
import { useSyncExternalStore } from "react";
import type { StoredFile } from "../../shared/attachments";
import { AttachmentError, uploadFile } from "./files";
import { createStore, del, entries, get, set, usingFallbackStorage } from "./kv";
import { isHosted } from "./runtime";

export const HOLD_CAP = 200 * 1024 * 1024;
/** A file nobody sent in this long is taken for abandoned (its draft or stash is long gone). */
const HOLD_FOR_MS = 14 * 24 * 60 * 60 * 1000;

type Kept = { file: File; at: number };
const store = createStore("openbuild-held-files", "files");
const held = new Map<string, File>();

export function holdFile(id: string, file: File) {
  held.set(id, file);
  if (!usingFallbackStorage && file.size <= HOLD_CAP) void set(id, { file, at: Date.now() } satisfies Kept, store).catch(() => {});
}

async function keptHere(id: string): Promise<File | undefined> {
  const here = held.get(id);
  if (here) return here;
  if (usingFallbackStorage) return undefined;
  const kept = await get<Kept>(id, store).catch(() => undefined);
  if (kept?.file) held.set(id, kept.file);
  return kept?.file;
}

const stashedUrl = (id: string) => `/api/stash-files/${encodeURIComponent(id)}`;

/**
 * The file attached under this id, if this browser still has it, or (`remote`, the default) the
 * server has it from a stash. One from the server is held here from then on, like one attached here.
 */
export async function heldFile(id: string, { name, remote = true }: { name?: string; remote?: boolean } = {}): Promise<File | undefined> {
  const here = await keptHere(id);
  if (here || !remote || isHosted()) return here;
  const res = await fetch(stashedUrl(id)).catch(() => undefined);
  if (!res?.ok) return undefined;
  const blob = await res.blob();
  const file = new File([blob], name ?? "file", { type: res.headers.get("content-type") ?? blob.type });
  holdFile(id, file);
  return file;
}

/** Whether `heldFile` would find the file: asks the server whether it has it, without downloading it. */
export async function hasHeldFile(id: string): Promise<boolean> {
  if (await keptHere(id)) return true;
  if (isHosted()) return false;
  return !!(await fetch(stashedUrl(id), { method: "HEAD" }).then((r) => r.ok, () => false));
}

/** Ask which held files must stay whatever their age (a stash's, not yet on the server). */
export const heldKeepers = new Set<() => Promise<string[]>>();

export function releaseFile(id: string) {
  held.delete(id);
  if (!usingFallbackStorage) void del(id, store).catch(() => {});
}

/** Once per page load: drop what was kept for messages that were never sent, unless a stash still needs it here. */
export async function sweepHeldFiles(now = Date.now()) {
  if (usingFallbackStorage) return;
  const saved = await entries<string, Kept>(store).catch(() => []);
  const answers = await Promise.all([...heldKeepers].map((ask) => ask().catch(() => undefined)));
  // A keeper that couldn't say what it needs: nothing is dropped this time rather than chance it.
  if (answers.includes(undefined)) return;
  const keep = new Set(answers.flat() as string[]);
  for (const [id, kept] of saved) if (!keep.has(id) && (!kept?.at || now - kept.at > HOLD_FOR_MS)) void del(id, store).catch(() => {});
}

// ---------------------------------------------------------------- uploads under way

const sent = new Map<string, number>();
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Bytes of this file sent so far while it uploads; undefined when it isn't uploading. */
export const useUploadProgress = (id: string) => useSyncExternalStore(subscribe, () => sent.get(id), () => undefined);

const flying = new Map<string, Promise<StoredFile>>();
/** Uploads that finished on this page: a message sent again (its send failed after its files arrived) doesn't need the file back. */
const arrived = new Map<string, StoredFile>();

/**
 * Upload a held file to `url` (its message is being sent), once however many callers ask. The held
 * copy is dropped when it's there; a failed upload keeps it, so sending again can try again.
 */
export function uploadHeld(file: { id: string; name: string }, url: string, signal?: AbortSignal): Promise<StoredFile> {
  const key = `${file.id}\n${url}`;
  const there = arrived.get(key);
  if (there) return Promise.resolve(there);
  let going = flying.get(key);
  if (!going) {
    going = (async () => {
      const blob = await heldFile(file.id, { name: file.name });
      if (!blob) throw new AttachmentError(`${file.name} isn't on this device anymore. Attach it again.`);
      sent.set(file.id, 0);
      tell();
      try {
        const saved = await uploadFile(blob, url, (n) => (sent.set(file.id, n), tell()), signal);
        releaseFile(file.id);
        arrived.set(key, saved);
        return saved;
      } finally {
        sent.delete(file.id);
        tell();
        flying.delete(key);
      }
    })();
    flying.set(key, going);
  }
  return going;
}

if (typeof window !== "undefined") void sweepHeldFiles();
