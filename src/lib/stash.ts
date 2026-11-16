// Composer drafts set aside to reuse in any thread (or, in OpenBots' own stash, any conversation). Unlike
// drafts they don't belong to a chat and never expire: one stays until it's used or removed.
//
// The stash is kept on the server (server/stashes.ts), so every address the app is opened at (a LAN
// IP, a Tailscale name, localhost), every browser and every device sees the same one, across
// restarts and updates. This browser's IndexedDB holds a copy of it and what's waiting to reach the
// server: a stash made or used while the server can't be reached shows at once and is sent when it
// can be, retried until it is. What an older build kept only in IndexedDB is sent over the first
// time each address is opened, once (a stash the server has already, or had and saw used, isn't).
//
// A file the browser was holding for its message (src/lib/localFiles.ts) is sent to the server with
// the stash, so it can be sent from anywhere too.
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { Attachment } from "../../shared/types";
import { capAttached, parseFileRef, stashHeldFiles } from "../../shared/bots";
import { uid } from "./id";
import { createStore, del, entries, set } from "./kv";
import { heldFile, heldKeepers } from "./localFiles";
import { uploadFile } from "./files";
import { config } from "./runtime";

export interface Stashed {
  id: string;
  text: string;
  files: Attachment[];
  createdAt: number;
}

/**
 * A stash as this browser keeps it. `sync`: "synced" is the server's copy, "add" waits to be sent,
 * "gone" was used or removed and waits to be removed there. None: kept by a build from before the
 * server had stashes, sent over once.
 */
type Rec = Stashed & { sync?: "synced" | "add" | "gone" };

export interface StashStore {
  /** Newest first. */
  use: UseBoundStore<StoreApi<{ items: Stashed[] }>>;
  /** Resolves once what this browser kept is showing. */
  ready: Promise<void>;
  add: (text: string, files: Attachment[]) => Stashed;
  remove: (id: string) => void;
  /** Send what's waiting and take the server's stash; resolves when that's done or has failed (and is retried). */
  sync: () => Promise<void>;
}

export interface StashOptions {
  /** Whether there's a server to keep stashes: the hosted website has none, and keeps them in this browser only. */
  serverBacked?: () => Promise<boolean>;
  fetch?: (path: string, init?: RequestInit) => Promise<Response>;
  /** Sync on focus, coming back online, every so often while shown, and after each change. */
  auto?: boolean;
}

const RETRY_MIN = 2000;
const RETRY_MAX = 60_000;
const POLL_EVERY = 30_000;
/** A timer that doesn't hold a script open where there's no page (a test's stand-in window). */
const background = <T>(timer: T): T => ((timer as { unref?: () => void }).unref?.(), timer);

const isStashed = (v: unknown): v is Stashed => {
  const s = v as Stashed;
  return !!s && typeof s.id === "string" && typeof s.text === "string" && Array.isArray(s.files) && typeof s.createdAt === "number";
};

const strip = ({ id, text, files, createdAt }: Rec): Stashed => ({ id, text, files, createdAt });

export function createStash(name: string, remote: "threads" | "bots", options: StashOptions = {}): StashStore {
  const use = create<{ items: Stashed[] }>(() => ({ items: [] }));
  const storage = createStore(name, "stash");
  const serverBacked = options.serverBacked ?? (async () => (await config).mode !== "hosted");
  const request = options.fetch ?? ((path: string, init?: RequestInit) => fetch(path, init));
  const base = `/api/stashes/${remote}`;

  const recs = new Map<string, Rec>();
  /** The order things were stashed in here, for two stashed in the same millisecond. */
  const order = new Map<string, number>();
  let counter = 0;
  /** Changed since the last read of IndexedDB began, so a read in progress can't undo them. */
  const touched = new Set<string>();

  function publish() {
    const items = [...recs.values()].filter((r) => r.sync !== "gone").sort((a, b) => b.createdAt - a.createdAt || (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0)).map(strip);
    use.setState({ items });
  }
  const report = (err: unknown) => console.error("Couldn't save the stash", err);
  function save(rec: Rec) {
    touched.add(rec.id);
    if (!order.has(rec.id)) order.set(rec.id, ++counter);
    recs.set(rec.id, rec);
    void set(rec.id, rec, storage).catch(report);
  }
  function forget(id: string) {
    touched.add(id);
    recs.delete(id);
    void del(id, storage).catch(report);
  }

  /** What this browser kept, under what changed meanwhile. Another tab may have changed it too. */
  async function read() {
    touched.clear();
    try {
      const saved = new Map((await entries<string, Rec>(storage)).filter(([, r]) => isStashed(r)));
      for (const id of [...recs.keys()]) if (!touched.has(id) && !saved.has(id)) recs.delete(id);
      for (const [id, rec] of saved) {
        if (touched.has(id)) continue;
        if (!order.has(id)) order.set(id, ++counter);
        recs.set(id, rec);
      }
      publish();
    } catch (err) {
      console.error("Couldn't restore the stash", err);
    }
  }

  const ready = read();

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await request(base + path, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** Send the server the files this stash carries that only this browser has. One it no longer has can't be sent. */
  async function sendFiles(rec: Rec) {
    for (const f of stashHeldFiles(rec.files)) {
      const url = `/api/stash-files/${encodeURIComponent(f.id)}`;
      const there = await request(url, { method: "HEAD" });
      if (there.ok) continue;
      const file = await heldFile(f.id, { name: f.name, remote: false });
      if (file) await uploadFile(file, url);
    }
  }

  async function pass() {
    await ready;
    if (!(await serverBacked())) return;
    let failed = false;
    for (const rec of [...recs.values()]) {
      if (rec.sync === "synced") continue;
      try {
        if (rec.sync === "gone") {
          await call("DELETE", `/items/${encodeURIComponent(rec.id)}`);
          if (recs.get(rec.id) === rec) forget(rec.id);
          continue;
        }
        await sendFiles(rec);
        const { result } = await call<{ result: "kept" | "deleted" | "duplicate" }>("PUT", `/items/${encodeURIComponent(rec.id)}`, { item: strip(rec), legacy: rec.sync === undefined });
        // Used or removed here meanwhile: that's sent next.
        if (recs.get(rec.id) !== rec) continue;
        // Used elsewhere already, or (brought over from an older build) the server has one just like it.
        if (result === "kept") save({ ...strip(rec), sync: "synced" });
        else if (result === "deleted" || result === "duplicate") forget(rec.id);
        else throw new Error("Unexpected answer");
      } catch {
        failed = true;
      }
    }
    try {
      const { ids } = await call<{ ids: unknown }>("GET", "");
      if (!Array.isArray(ids)) throw new Error("Unexpected answer");
      const listed = new Set(ids);
      for (const rec of [...recs.values()]) if (rec.sync === "synced" && !listed.has(rec.id)) forget(rec.id);
      const lacking = (ids as string[]).filter((id) => !recs.has(id));
      if (lacking.length) {
        const { items } = await call<{ items: unknown[] }>("POST", "/fetch", { ids: lacking });
        for (const item of items ?? []) if (isStashed(item) && !recs.has(item.id)) save({ ...strip(item), sync: "synced" });
      }
    } catch {
      failed = true;
    }
    publish();
    if (failed) retry();
    else delay = RETRY_MIN;
  }

  let running: Promise<void> | undefined;
  let again = false;
  function sync(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await pass();
      } while (again);
    })().finally(() => {
      running = undefined;
    });
    return running;
  }

  let delay = RETRY_MIN;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  function retry() {
    if (!options.auto || retryTimer) return;
    retryTimer = background(setTimeout(() => {
      retryTimer = undefined;
      void sync();
    }, delay));
    delay = Math.min(delay * 2, RETRY_MAX);
  }
  const changed = () => {
    if (options.auto) void sync();
  };

  if (options.auto && typeof window !== "undefined") {
    // Another window, address or device may have stashed or used something meanwhile.
    const refresh = () => void read().then(sync);
    window.addEventListener?.("focus", refresh);
    window.addEventListener?.("online", () => {
      delay = RETRY_MIN;
      refresh();
    });
    document.addEventListener?.("visibilitychange", () => document.visibilityState === "visible" && refresh());
    background(setInterval(() => document.visibilityState === "visible" && void sync(), POLL_EVERY));
    void ready.then(sync);
  }

  // Files waiting to reach the server stay in this browser until they have.
  heldKeepers.add(async () => {
    await ready;
    return [...recs.values()].filter((r) => r.sync !== "synced" && r.sync !== "gone").flatMap((r) => stashHeldFiles(r.files).map((f) => f.id));
  });

  return {
    use,
    ready,
    sync,
    add(text, files) {
      const item: Stashed = { id: uid(), text, files, createdAt: Date.now() };
      save({ ...item, sync: "add" });
      publish();
      changed();
      return item;
    },
    remove(id) {
      // One not read from this browser's storage yet still goes: it's marked here, and the read skips it.
      const rec = recs.get(id) ?? { id, text: "", files: [], createdAt: 0 };
      // Sent even when it never reached the server: its answer may have been all that was lost.
      void serverBacked().then((backed) => {
        if (!backed && recs.get(id)?.sync === "gone") forget(id);
      });
      save({ ...strip(rec), sync: "gone" });
      publish();
      changed();
    },
  };
}

const auto = typeof window !== "undefined" && typeof document !== "undefined";
/** OpenBuild's stash. */
export const threadStash = createStash("openchat-stash", "threads", { auto });
/** OpenBots' own stash, used unless cross-stashing (Settings → General) shares OpenBuild's. */
export const botStash = createStash("openbots-stash", "bots", { auto });
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

/** What the "use last stash" shortcut pastes: the newest stash, or nothing when the stash is empty. */
export function latestStash(items: readonly Stashed[]): Stashed | undefined {
  return items.reduce<Stashed | undefined>((newest, item) => (!newest || item.createdAt > newest.createdAt ? item : newest), undefined);
}

/** What the composer says when the "use last stash" shortcut finds nothing to paste. */
export const EMPTY_STASH_NOTICE = "Nothing in the stash yet.";

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
