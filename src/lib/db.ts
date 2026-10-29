// Chat persistence. Chats are stored by the local OpenChat server in a database on disk
// (server/storage.ts), not in the browser: browser storage belongs to one origin, so the app on
// another port (or in another browser) used to see a different, older set of chats.
//
// Every change goes through an outbox kept in IndexedDB before it is sent, and leaves it only once
// the server has confirmed the write. If the server is down or restarting, nothing is lost: the
// outbox is retried in the background and on the next load.
//
// Builds before this kept chats in IndexedDB itself; those are imported once per origin.
//
// On the hosted website there is no server storage: chats are kept in this browser's IndexedDB
// (marked persistent, so the browser doesn't evict them), and signing in syncs them to the account.
import { clear, createStore, del, entries, get, set, usingFallbackStorage } from "./kv";
import { EXTERNAL_VIA } from "../../shared/replies";
import { canResume, config, isHosted } from "./runtime";
import type { Chat } from "./types";

const browserChats = createStore("openchat-chats", "chats");

type Op = { op: "put"; chat: Chat; seq: number } | { op: "delete"; seq: number } | { op: "clear"; seq: number };

const outbox = createStore("openchat-outbox", "ops");
/** The outbox key for "delete every chat"; chat ids never collide with it. */
const CLEAR = "*clear*";
const legacy = createStore("openchat", "chats");
const LEGACY_IMPORTED = "openchat-chats-imported";

let seq = Date.now();
/** Successful server PUTs, distinct from merely queued writes (or deletion tombstones). */
const acknowledged = new Map<string, number>();

// The local server's chats, cached in this browser by version (see /api/chats?index). A reload
// reads them from here and downloads only the chats that changed, not every message of every
// thread. Without IndexedDB the cache lives in memory only, for this page load.
type Cached = { v: string; chat: Chat };
const chatCache = createStore("openchat-chat-cache", "chats");
/** Settled chats by id. Unchanged chats keep the same object across loads. */
const cached = new Map<string, Cached>();
let cacheRead: Promise<void> | undefined;
const readCache = () => (cacheRead ??= usingFallbackStorage ? Promise.resolve() : entries<string, Cached>(chatCache).then(
  (rows) => { for (const [id, c] of rows) if (c?.chat && !cached.has(id)) cached.set(id, { v: c.v, chat: settle(c.chat) }); },
  () => {},
));
function remember(id: string, v: string, chat: Chat) {
  cached.set(id, { v, chat: settle(chat) });
  if (!usingFallbackStorage) void set(id, { v, chat }, chatCache).catch(() => {});
}
function forget(id: string) {
  cached.delete(id);
  if (!usingFallbackStorage) void del(id, chatCache).catch(() => {});
}

class Retry extends Error {}

/** The outbox in the order it applies: "delete all" first, since anything else queued came after it. */
const queued = async () => (await entries<string, Op>(outbox)).sort(([a], [b]) => (a === CLEAR ? -1 : b === CLEAR ? 1 : 0));

async function send(id: string, op: Op) {
  let res: Response;
  try {
    if (op.op === "put") {
      res = await fetch(`/api/chats/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(op.chat),
      });
    } else {
      res = await fetch(op.op === "clear" ? "/api/chats" : `/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
    }
  } catch {
    throw new Retry("Server unreachable");
  }
  // 410: the chat was deleted (maybe from another tab); it stays deleted, so the write is done.
  if (res.ok || res.status === 410) {
    // The server's version of what was just written, so the next load doesn't download it again.
    const saved = op.op === "put" && res.ok ? await res.json().catch(() => undefined) as { v?: unknown; chat?: Chat } | undefined : undefined;
    if (op.op === "put" && res.ok) {
      acknowledged.set(id, Math.max(acknowledged.get(id) ?? 0, op.seq));
      if (typeof saved?.v === "string") remember(id, saved.v, saved.chat ?? op.chat);
    }
    return;
  }
  // 5xx, or 404 from a server too old to have /api/chats: keep it and try again later.
  throw res.status >= 500 || res.status === 404 ? new Retry(`HTTP ${res.status}`) : new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
}

let flushing: Promise<boolean> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 1000;

/** Send everything in the outbox. Resolves to true once it is empty. */
function flush(): Promise<boolean> {
  return (flushing ??= (async () => {
    try {
      const ops = await queued();
      let empty = true;
      for (const [id, op] of ops) {
        try {
          await send(id, op);
        } catch (err) {
          empty = false;
          if (err instanceof Retry) {
            schedule();
            return false;
          }
          // Rejected by the server: keep it (nothing is thrown away) and carry on with the rest.
          console.error(`Couldn't save chat ${id}; it stays queued`, err);
          continue;
        }
        // Only drop the entry if no newer change to the same chat arrived meanwhile.
        if ((await get<Op>(id, outbox))?.seq === op.seq) await del(id, outbox);
      }
      retryDelay = 1000;
      return empty;
    } finally {
      flushing = undefined;
    }
  })());
}

function schedule() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void flush();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30_000);
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => void flush());
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void flush());
}

async function enqueue(id: string, op: Op) {
  try {
    await set(id, op, outbox);
  } catch (err) {
    console.error("Couldn't queue chat change locally", err);
    // Still try to send it directly.
    try {
      await send(id, op);
    } catch (e) {
      console.error("Failed to save chat", e);
    }
    return;
  }
  // Writes can come in quick bursts; a running flush picks up the rest after it finishes.
  if (flushing) void flushing.then(() => flush());
  else void flush();
}

/** Move chats this origin kept in IndexedDB (before they were stored on disk) to the server, once. */
async function importLegacy() {
  try {
    if (localStorage.getItem(LEGACY_IMPORTED)) return;
  } catch {
    return;
  }
  let chats: Chat[];
  try {
    chats = (await entries<string, Chat>(legacy)).map(([, c]) => c).filter((c) => c && typeof c.id === "string");
  } catch {
    chats = [];
  }
  if (chats.length) {
    const res = await fetch("/api/chats/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chats }),
    });
    if (!res.ok) throw new Error(`Import failed (HTTP ${res.status})`);
  }
  // The browser copy is left in place as a fallback; it's just never read again.
  try {
    localStorage.setItem(LEGACY_IMPORTED, String(Date.now()));
  } catch {}
}

const settle = (chat: Chat): Chat => ({
  ...chat,
  // A reload mid-generation leaves "streaming" messages behind. Replies still running where this app
  // can reach them are picked back up (chat.ts resumeReplies); the rest are marked stopped.
  // Pi running elsewhere is the server's to judge (it re-reads the transcript).
  messages: chat.messages.map((m) => (m.status === "streaming" && !canResume(m.stream?.via) && m.stream?.via !== EXTERNAL_VIA ? { ...m, status: "stopped" as const } : m)),
});

let loading: Promise<Chat[]> | undefined;
let initialLoad = true;

/** Share in-flight reads, including preload and Main's retry after the preload deadline. */
export function loadChats(): Promise<Chat[]> {
  return loading ??= readChats().then((chats) => {
    initialLoad = false;
    return chats;
  }).finally(() => { loading = undefined; });
}

/** Load every chat from the server. Throws when it can't be reached (the caller retries). */
async function readChats(): Promise<Chat[]> {
  if ((await config).mode === "hosted") {
    // Ask the browser not to clear this site's storage under storage pressure.
    void navigator.storage?.persist?.().catch(() => {});
    return (await entries<string, Chat>(browserChats)).map(([, c]) => settle(c)).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  await flush();
  await importLegacy();
  const [res] = await Promise.all([fetch(initialLoad ? "/api/chats?index&startup" : "/api/chats?index"), readCache()]);
  if (!res.ok) throw new Error(`Couldn't load chats (HTTP ${res.status})`);
  const body = (await res.json()) as { index?: { id: string; v: string }[]; chats?: Chat[] };
  let chats: Map<string, Chat>;
  if (!body.index) {
    // A server from before the index: it sent every chat.
    chats = new Map((body.chats ?? []).map((c) => [c.id, c]));
  } else {
    const stale = body.index.filter((e) => cached.get(e.id)?.v !== e.v).map((e) => e.id);
    if (stale.length) {
      const res = await fetch("/api/chats/fetch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: stale }) });
      if (!res.ok) throw new Error(`Couldn't load chats (HTTP ${res.status})`);
      for (const { v, chat } of (await res.json()).chats as Cached[]) remember(chat.id, v, chat);
    }
    const live = new Set(body.index.map((e) => e.id));
    for (const id of cached.keys()) if (!live.has(id)) forget(id);
    chats = new Map(body.index.flatMap((e) => (cached.has(e.id) ? [[e.id, cached.get(e.id)!.chat] as const] : [])));
  }
  // Changes still waiting in the outbox are newer than what the server has.
  for (const [id, op] of await queued().catch(() => [] as [string, Op][])) {
    if (op.op === "put") chats.set(id, op.chat);
    else if (op.op === "delete") chats.delete(id);
    else chats.clear();
  }
  return [...chats.values()].map((c) => (cached.get(c.id)?.chat === c ? c : settle(c))).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Listeners told about every local chat change (cloud sync uses it); null means "all chats deleted". */
export const chatListeners = new Set<(id: string | null) => void>();
const notify = (id: string | null) => chatListeners.forEach((fn) => fn(id));

const logFailure = (what: string) => (err: unknown) => console.error(`Failed to ${what}`, err);

export function saveChat(chat: Chat) {
  notify(chat.id);
  if (isHosted()) return set(chat.id, chat, browserChats).catch(logFailure("save chat"));
  return enqueue(chat.id, { op: "put", chat, seq: ++seq });
}

/** Admission barrier: the worker must not start until its reply id and workspace are on disk.
 * Unlike saveChat, this waits for the server, not just the browser's durable outbox. */
export async function saveChatBeforeRun(chat: Chat) {
  if (isHosted()) return saveChat(chat);
  notify(chat.id);
  const op: Op = { op: "put", chat, seq: ++seq };
  await enqueue(chat.id, op);
  const failed = () => new Error("Couldn't save this thread to the OpenBuild server. Check your connection and try again.");
  do {
    if (!await flush()) throw failed();
  } while (await get(chat.id, outbox));
  // A deleted chat (410), or a failed direct-send fallback when local storage is unavailable,
  // also empties the outbox. Neither is permission to launch an orphan worker.
  if ((acknowledged.get(chat.id) ?? 0) < op.seq) throw failed();
}

export function deleteChat(id: string) {
  notify(id);
  if (isHosted()) return del(id, browserChats).catch(logFailure("delete chat"));
  return enqueue(id, { op: "delete", seq: ++seq });
}

export async function deleteAllChats() {
  notify(null);
  if (isHosted()) return clear(browserChats).catch(logFailure("delete chats"));
  // Queued changes to individual chats are superseded.
  try {
    for (const [id] of await entries<string, Op>(outbox)) await del(id, outbox);
  } catch {}
  return enqueue(CLEAR, { op: "clear", seq: ++seq });
}
