// Cloud sync engine: keeps this device's chats, settings and profile in step with the account.
//
// The local copy (on disk via the OpenChat server) stays the source the app reads from; sync runs
// alongside it:
//   - Pull: a live Convex subscription to "changes since <cursor>" delivers other devices' writes
//     within moments of them happening. Only changed records travel, never the whole account.
//   - Push: a local change marks its record dirty; dirty records are encrypted and written shortly
//     after. The dirty set is saved, so changes made offline or before a reload still go out.
//   - Conflicts: each write says which version it was based on. If another device got there first,
//     the write is refused, that version arrives through the subscription, the two are merged
//     (chats: messages from both sides), and the merge is written.
//
// Records: "chat:<id>", "settings" (see syncedSettings), "profile" (name, bio, picture, ...) and,
// only when "Sync API keys" is on, "keys" (the secrets for each plan and search provider).
//
// Composer drafts ("draft:<chat id>", "draftfile:<attachment id>", see ../drafts) go their own way,
// since they change as you type: the device writing one uploads it once typing pauses (or right
// away when you leave the tab), and the others get it live through a subscription that reads
// nothing but drafts (sync.liveDrafts), so a draft write wakes each device once. Attachments never
// change, so they're fetched once, only by devices that don't have them yet.
import type { ConvexReactClient } from "convex/react";
import { createStore, del, get, set } from "../kv";
import { create } from "zustand";
import { api } from "../../../convex/_generated/api";
import { chatListeners } from "../db";
import { applyDraftRecord, draftListeners, draftRecord, type StoredDraft } from "../drafts";
import { isDraftRecord } from "../../../shared/drafts";
import { allSecrets, keyListeners, saveKeys } from "../keyStore";
import { useStore } from "../store";
import { PLANS, SEARCH_PROVIDERS, type PlanId, type SearchProviderId } from "../../../shared/types";
import type { Attachment } from "../../../shared/types";
import type { Chat, Message, Profile, Settings } from "../types";
import { open, seal } from "./crypto";

/** Encrypted records bigger than this go to file storage instead of the database. */
const INLINE_LIMIT = 700 * 1024;
const PAGE = 25;
const PUSH_DELAY = 150;
const PARALLEL = 6;
/** Drafts are uploaded once typing pauses this long (or when you leave the tab). */
const DRAFT_PUSH_DELAY = 2000;
const DRAFT_RETRY = 10_000;

export type CloudStatus = "off" | "locked" | "connecting" | "syncing" | "synced" | "offline" | "error";

/** Sync status for the UI. */
export const useCloud = create<{ status: CloudStatus; error?: string; lastSync?: number; pending: number }>(() => ({ status: "off", pending: 0 }));

// ------------------------------------------------------------------ local bookkeeping

const db = createStore("openchat-cloud", "kv");

interface SyncState {
  /** Highest seq applied from the server. */
  cursor: number;
  /** Seq of the version of each record this device has. */
  known: Record<string, number>;
  /** Records changed here and not yet written. */
  dirty: string[];
  /** Local data has been offered to the account (done once, after the first full download). */
  initialized: boolean;
  /**
   * The account holds a key snapshot this device has already merged with. Until then (sync just
   * turned on, or a new device) incoming keys are merged with this device's instead of replacing them.
   */
  keysJoined?: boolean;
}

/** A draft from liveDrafts. Attachments come as keys only. */
interface LiveDraft {
  key: string;
  at: number;
  deleted: boolean;
  iv?: ArrayBuffer;
  data?: ArrayBuffer;
  url?: string | null;
}

const isDraftFile = (key: string) => key.startsWith("draftfile:");
/** Attachments before drafts, so a draft's pictures are there when its text shows up. */
const filesFirst = (a: string, b: string) => Number(isDraftFile(b)) - Number(isDraftFile(a));

export const keyStorageId = (scope: string) => `${scope}|dataKey`;
export const loadDataKey = (scope: string) => get<CryptoKey>(keyStorageId(scope), db).catch(() => undefined);
export const saveDataKey = (scope: string, key: CryptoKey) => set(keyStorageId(scope), key, db);
/** Forget this device's sync state and key for an account (sign out). Local chats are untouched. */
export async function forgetAccount(scope: string) {
  await del(keyStorageId(scope), db).catch(() => {});
  await del(`${scope}|state`, db).catch(() => {});
}

// ------------------------------------------------------------------ what gets synced

/**
 * Settings that follow the account. Left out: API key ids and search config (they belong to this
 * machine's keychain), the profile (its own record), and the selected model, which depends on the
 * machine's keys: syncing it would make devices with different keys keep overriding each other.
 */
type SyncedSettings = Omit<Settings, "keys" | "search" | "profile" | "selection">;

function syncedSettings(s: Settings): SyncedSettings {
  const { keys: _k, search: _s, profile: _p, selection: _sel, ...rest } = s;
  return rest;
}

type KeySnapshot = Record<string, string[]>;

const isKeyScope = (s: string): s is PlanId | SearchProviderId =>
  s in PLANS || (s in SEARCH_PROVIDERS && SEARCH_PROVIDERS[s as SearchProviderId].credential === "key");

/** Scopes with keys, in a stable order. Empty when key sync is off. */
async function keySnapshot(enabled: boolean): Promise<KeySnapshot> {
  if (!enabled) return {};
  const all = await allSecrets();
  return Object.fromEntries(Object.keys(all).filter((s) => isKeyScope(s) && all[s]!.length).sort().map((s) => [s, all[s]!]));
}

const chatKey = (id: string) => `chat:${id}`;
const chatIdOf = (key: string) => (key.startsWith("chat:") ? key.slice(5) : undefined);

/** Combine two versions of a chat: messages from both (by id), metadata from `preferred`. */
export function mergeChats(preferred: Chat, other: Chat): Chat {
  const byId = new Map<string, Message>();
  for (const m of other.messages) byId.set(m.id, m);
  for (const m of preferred.messages) {
    const o = byId.get(m.id);
    // Prefer the finished version of a reply over one still streaming.
    byId.set(m.id, o && m.status === "streaming" && o.status !== "streaming" ? o : m);
  }
  const order = new Map([...other.messages, ...preferred.messages].map((m, i) => [m.id, i]));
  const messages = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || order.get(a.id)! - order.get(b.id)!);
  return { ...other, ...preferred, messages, updatedAt: Math.max(preferred.updatedAt, other.updatedAt) };
}

// ------------------------------------------------------------------ engine

interface RemoteRecord {
  key: string;
  seq: number;
  deleted: boolean;
  iv?: ArrayBuffer;
  data?: ArrayBuffer;
  url: string | null;
}

export class SyncEngine {
  private state!: SyncState;
  private dirty = new Set<string>();
  /** Bumped on each local change, so a push knows whether the record changed while it was in flight. */
  private version = new Map<string, number>();
  /** Last value written or received, per record, to tell real changes from echoes. */
  private lastJson = new Map<string, string>();
  /** Records whose write was refused; retried once the newer version has been pulled. */
  private conflicts = new Set<string>();
  private applying = false;
  private importingKeys = false;
  private stopped = false;
  private pullChain: Promise<void> = Promise.resolve();
  private unwatch?: () => void;
  private pushTimer?: ReturnType<typeof setTimeout>;
  private pushing?: Promise<void>;
  private retryDelay = 1000;
  private cleanups: (() => void)[] = [];
  private caughtUp = false;
  private draftQueue = new Set<string>();
  private draftTimer?: ReturnType<typeof setTimeout>;
  private draftPushing?: Promise<void>;
  private draftChain: Promise<void> = Promise.resolve();

  constructor(
    private client: ConvexReactClient,
    private scope: string,
    private key: CryptoKey,
  ) {}

  async start() {
    const saved = await get<SyncState>(`${this.scope}|state`, db).catch(() => undefined);
    this.state = saved ?? { cursor: 0, known: {}, dirty: [], initialized: false };
    // Drafts queued by an older version, when they went through records, take the draft path now.
    for (const k of this.state.dirty) (isDraftRecord(k) ? this.draftQueue : this.dirty).add(k);
    if (this.stopped) return;

    const s = useStore.getState();
    this.lastJson.set("settings", JSON.stringify(syncedSettings(s.settings)));
    this.lastJson.set("profile", JSON.stringify(s.settings.profile));

    const onChat = (id: string | null) => {
      if (this.applying) return;
      if (id === null) for (const k of Object.keys(this.state.known)) chatIdOf(k) && this.markDirty(k);
      else this.markDirty(chatKey(id));
    };
    chatListeners.add(onChat);
    this.cleanups.push(() => chatListeners.delete(onChat));

    const onDraft = (record: string) => {
      this.draftQueue.add(record);
      this.scheduleDraftPush(DRAFT_PUSH_DELAY);
    };
    draftListeners.add(onDraft);
    this.cleanups.push(() => draftListeners.delete(onDraft));
    // Leaving the tab (likely for another device) sends a pending draft right away.
    const onVisibility = () => document.visibilityState === "hidden" && void this.pushDrafts();
    document.addEventListener("visibilitychange", onVisibility);
    this.cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));
    this.watchDrafts();

    const onKeys = () => !this.importingKeys && useStore.getState().settings.syncApiKeys && this.markDirty("keys");
    keyListeners.add(onKeys);
    this.cleanups.push(() => keyListeners.delete(onKeys));

    this.cleanups.push(
      useStore.subscribe((st, prev) => {
        if (this.applying || st.settings === prev.settings) return;
        // Turning key sync on uploads the keys; turning it off replaces the synced copy with nothing.
        if (!!st.settings.syncApiKeys !== !!prev.settings.syncApiKeys) this.markDirty("keys");
        const settings = JSON.stringify(syncedSettings(st.settings));
        if (settings !== this.lastJson.get("settings")) this.markDirty("settings", 500);
        const profile = JSON.stringify(st.settings.profile);
        if (profile !== this.lastJson.get("profile")) this.markDirty("profile", 500);
      }),
    );

    this.cleanups.push(
      this.client.subscribeToConnectionState((c) => {
        if (this.stopped) return;
        if (!c.isWebSocketConnected) useCloud.setState({ status: c.hasEverConnected ? "offline" : "connecting" });
        else this.updateStatus();
      }),
    );
    const onOnline = () => this.schedulePush(0);
    window.addEventListener("online", onOnline);
    this.cleanups.push(() => window.removeEventListener("online", onOnline));

    useCloud.setState({ status: "syncing", error: undefined });
    this.watch();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.draftTimer);
    this.unwatch?.();
    clearTimeout(this.pushTimer);
    this.cleanups.forEach((fn) => fn());
    useCloud.setState({ status: "off", pending: 0 });
  }

  private persist() {
    this.state.dirty = [...this.dirty];
    void set(`${this.scope}|state`, this.state, db).catch(() => {});
  }

  private markDirty(key: string, delay = PUSH_DELAY) {
    this.dirty.add(key);
    this.version.set(key, (this.version.get(key) ?? 0) + 1);
    this.persist();
    this.updateStatus();
    this.schedulePush(delay);
  }

  private updateStatus() {
    if (this.stopped) return;
    const pending = this.dirty.size;
    const conn = this.client.connectionState();
    if (!conn.isWebSocketConnected) return useCloud.setState({ pending, status: conn.hasEverConnected ? "offline" : "connecting" });
    if (useCloud.getState().status === "error" && pending) return useCloud.setState({ pending });
    const busy = pending > 0 || !this.caughtUp;
    useCloud.setState({ pending, status: busy ? "syncing" : "synced", error: undefined, ...(busy ? {} : { lastSync: Date.now() }) });
  }

  private fail(err: unknown) {
    console.error("[sync]", err);
    useCloud.setState({ status: "error", error: (err as Error).message ?? String(err) });
  }

  // ---------------------------------------------------------------- pull

  private watch() {
    if (this.stopped) return;
    this.unwatch?.();
    const since = this.state.cursor;
    const w = this.client.watchQuery(api.sync.changes, { since });
    const take = () => {
      let page: RemoteRecord[] | undefined;
      try {
        page = w.localQueryResult() as RemoteRecord[] | undefined;
      } catch (err) {
        return this.fail(err);
      }
      if (!page) return;
      this.pullChain = this.pullChain.then(() => this.applyPage(page, since)).catch((err) => this.fail(err));
    };
    this.unwatch = w.onUpdate(take);
    take();
  }

  private async applyPage(page: RemoteRecord[], since: number) {
    if (this.stopped || since !== this.state.cursor) return; // A stale subscription.
    for (const r of page) await this.applyRecord(r);
    if (page.length) {
      this.state.cursor = Math.max(this.state.cursor, ...page.map((r) => r.seq));
      this.persist();
      this.watch();
    }
    if (page.length < PAGE && !this.caughtUp) {
      this.caughtUp = true;
      if (!this.state.initialized) this.offerLocalData();
    }
    if (this.conflicts.size) {
      this.conflicts.clear();
      this.schedulePush(0);
    }
    this.updateStatus();
  }

  /** After the first full download: upload what this device has that the account doesn't. */
  private offerLocalData() {
    for (const chat of useStore.getState().chats) if (this.state.known[chatKey(chat.id)] === undefined) this.dirty.add(chatKey(chat.id));
    // A fresh device takes the account's settings; a fresh account takes this device's.
    for (const k of ["settings", "profile", "keys"]) if (this.state.known[k] === undefined) this.dirty.add(k);
    this.state.initialized = true;
    this.persist();
    this.schedulePush(0);
  }

  private async applyRecord(r: RemoteRecord) {
    if ((this.state.known[r.key] ?? 0) >= r.seq) return; // Already have it (often our own write).
    this.state.known[r.key] = r.seq;
    if (r.key === "keys" && r.deleted) return;
    const id = chatIdOf(r.key);

    if (r.deleted) {
      if (isDraftRecord(r.key)) return this.applyDraft(r.key, undefined);
      this.dirty.delete(r.key);
      this.lastJson.delete(r.key);
      if (id && useStore.getState().chats.some((c) => c.id === id)) this.apply(() => useStore.getState().removeChat(id));
      return;
    }

    let iv = r.iv;
    let data = r.data;
    if (r.url) {
      const res = await fetch(r.url);
      if (!res.ok) throw new Error(`Couldn't download a synced item (HTTP ${res.status})`);
      data = await res.arrayBuffer();
    }
    if (!iv || !data) return;
    const value = await open<unknown>(this.key, r.key, iv, data);
    if (isDraftRecord(r.key)) return this.applyDraft(r.key, value as StoredDraft);
    const json = JSON.stringify(value);
    this.lastJson.set(r.key, json);
    const isDirty = this.dirty.has(r.key);

    if (id) {
      const remote = value as Chat;
      const local = useStore.getState().chats.find((c) => c.id === id);
      const streaming = local?.messages.some((m) => m.status === "streaming");
      // Local edits not yet written (or a reply still arriving) are merged in, and the merge is written back.
      const next = local && (isDirty || streaming) ? mergeChats(local, remote) : remote;
      this.apply(() => useStore.getState().upsertChat(next));
      if (local && isDirty) this.schedulePush(0);
    } else if (r.key === "settings" && !isDirty) {
      const remote = value as SyncedSettings;
      this.apply(() => useStore.getState().updateSettings(remote));
      this.lastJson.set("settings", JSON.stringify(syncedSettings(useStore.getState().settings)));
    } else if (r.key === "keys" && (!isDirty || !this.state.keysJoined)) {
      // Before joining, even a pending local upload merges rather than overwrites the account's keys.
      await this.importKeys(value as KeySnapshot);
    } else if (r.key === "profile" && !isDirty) {
      this.apply(() => useStore.getState().updateProfile({ avatar: undefined, ...(value as Profile) }));
      this.lastJson.set("profile", JSON.stringify(useStore.getState().settings.profile));
    }
  }

  /** A draft written to records by an older version on another device: the newer edit wins. */
  private async applyDraft(key: string, value: StoredDraft | undefined) {
    if (value || !this.draftQueue.has(key)) await applyDraftRecord(key, value);
  }

  // ---------------------------------------------------------------- drafts

  private scheduleDraftPush(delay: number) {
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => void this.pushDrafts(), delay);
  }

  /** Upload the drafts changed here. */
  private pushDrafts(): Promise<void> {
    clearTimeout(this.draftTimer);
    if (this.stopped || !this.state?.initialized || !this.draftQueue.size) return Promise.resolve();
    if (this.draftPushing) return this.draftPushing.then(() => this.pushDrafts());
    const batch = [...this.draftQueue].sort(filesFirst);
    this.draftQueue.clear();
    this.draftPushing = (async () => {
      try {
        while (batch.length) {
          await this.pushDraft(batch[0]!);
          batch.shift();
        }
      } catch (err) {
        console.warn("[sync] couldn't save a draft; retrying", err);
        for (const key of batch) this.draftQueue.add(key);
        this.scheduleDraftPush(DRAFT_RETRY);
      } finally {
        this.draftPushing = undefined;
      }
    })();
    return this.draftPushing;
  }

  private async pushDraft(key: string) {
    const value = draftRecord(key);
    if (!value) {
      // A removed attachment just expires; a cleared draft is cleared on the other devices too.
      if (!isDraftFile(key)) await this.client.mutation(api.sync.putDraft, { key, at: Date.now(), deleted: true });
      return;
    }
    const draft = isDraftFile(key) ? undefined : (value as StoredDraft);
    const at = draft?.updatedAt ?? Date.now();
    // Writing a draft keeps its attachments from expiring on the server while it's still being edited.
    const touch = draft?.fileIds.map((id) => `draftfile:${id}`);
    const { iv, data } = await seal(this.key, key, value);
    if (data.byteLength > INLINE_LIMIT) {
      const url = await this.client.mutation(api.sync.uploadUrl, {});
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: data });
      if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status})`);
      const { storageId } = (await res.json()) as { storageId: string };
      await this.client.mutation(api.sync.putDraft, { key, at, deleted: false, iv, file: storageId as never, touch });
    } else {
      await this.client.mutation(api.sync.putDraft, { key, at, deleted: false, iv, data, touch });
    }
  }

  /** Other devices' drafts, live. */
  private watchDrafts() {
    const w = this.client.watchQuery(api.sync.liveDrafts, {});
    const take = () => {
      let list: LiveDraft[] | undefined;
      try {
        list = w.localQueryResult();
      } catch (err) {
        return console.warn("[sync] couldn't load drafts", err);
      }
      if (!list) return;
      for (const d of list) {
        if (isDraftFile(d.key)) continue;
        this.draftChain = this.draftChain.then(() => this.applyLiveDraft(d)).catch((err) => console.warn("[sync] couldn't apply a draft", err));
      }
    };
    this.cleanups.push(w.onUpdate(take));
    take();
  }

  private async applyLiveDraft(d: LiveDraft) {
    if (this.stopped) return;
    if (d.deleted) return void (await applyDraftRecord(d.key, undefined, d.at));
    // Already have it, or edited here since.
    const local = draftRecord(d.key) as StoredDraft | undefined;
    if (local && local.updatedAt >= d.at) return;
    const value = await this.download<StoredDraft>(d.key, d);
    if (!value) return;
    // Its pictures first, so they're there when the text shows up.
    for (const id of value.fileIds) {
      const key = `draftfile:${id}`;
      if (draftRecord(key)) continue;
      const file = await this.client.query(api.sync.draftFile, { key });
      const attachment = file && (await this.download<Attachment>(key, file));
      if (attachment) await applyDraftRecord(key, attachment);
    }
    await applyDraftRecord(d.key, value);
  }

  private async download<T>(key: string, d: { iv?: ArrayBuffer; data?: ArrayBuffer; url?: string | null }): Promise<T | undefined> {
    let data = d.data;
    if (d.url) {
      const res = await fetch(d.url);
      if (!res.ok) throw new Error(`Couldn't download a draft (HTTP ${res.status})`);
      data = await res.arrayBuffer();
    }
    return d.iv && data ? open<T>(this.key, key, d.iv, data) : undefined;
  }

  /**
   * Take the account's keys. The first snapshot after joining is merged with this device's keys (and
   * the merge written back); after that the account's snapshot is the truth, so removals sync too.
   * An empty snapshot means key sync is off: nothing here is touched.
   */
  private async importKeys(remote: KeySnapshot) {
    if (!Object.keys(remote).length) {
      this.state.keysJoined = false;
      this.persist();
      return;
    }
    const merge = !this.state.keysJoined;
    const local = await allSecrets();
    let changed = false;
    let mergedDiffers = false;
    this.importingKeys = true;
    try {
      for (const scope of new Set([...Object.keys(remote), ...Object.keys(local)])) {
        if (!isKeyScope(scope)) continue;
        const theirs = (remote[scope] ?? []).filter((k) => typeof k === "string" && k.trim());
        const mine = local[scope] ?? [];
        const next = merge ? [...new Set([...theirs, ...mine])] : theirs;
        if (merge && next.length !== theirs.length) mergedDiffers = true;
        if (next.length === mine.length && next.every((k, i) => k === mine[i])) continue;
        await saveKeys(scope, next.map((secret) => ({ secret })));
        changed = true;
      }
    } finally {
      this.importingKeys = false;
    }
    this.state.keysJoined = true;
    this.persist();
    if (mergedDiffers) this.markDirty("keys", 0);
    if (changed) void useStore.getState().syncKeys().then(() => useStore.getState().refreshDetection());
  }

  /** Change local state without it counting as a local change. */
  private apply(fn: () => void) {
    this.applying = true;
    try {
      fn();
    } finally {
      this.applying = false;
    }
  }

  // ---------------------------------------------------------------- push

  private schedulePush(delay = PUSH_DELAY) {
    if (this.stopped || !this.state?.initialized) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.push(), delay);
  }

  private push(): Promise<void> {
    if (this.pushing) return this.pushing.then(() => this.push());
    this.pushing = (async () => {
      try {
        const queue = [...this.dirty].filter((k) => !this.conflicts.has(k));
        const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
          for (let k = queue.shift(); k !== undefined && !this.stopped; k = queue.shift()) await this.pushRecord(k);
        });
        await Promise.all(workers);
        this.retryDelay = 1000;
        this.updateStatus();
      } catch (err) {
        this.fail(err);
        this.schedulePush(this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
      } finally {
        this.pushing = undefined;
      }
    })();
    return this.pushing;
  }

  private async current(key: string): Promise<unknown | undefined> {
    const s = useStore.getState();
    if (key === "keys") return keySnapshot(!!s.settings.syncApiKeys);
    const id = chatIdOf(key);
    if (id) return s.chats.find((c) => c.id === id);
    if (key === "settings") return syncedSettings(s.settings);
    if (key === "profile") return s.settings.profile;
    return undefined;
  }

  private async pushRecord(key: string) {
    const version = this.version.get(key);
    const value = await this.current(key);
    const base = this.state.known[key] ?? 0;
    const json = value === undefined ? undefined : JSON.stringify(value);

    let result: { seq: number; conflict?: true; deleted?: true };
    if (value === undefined) {
      if (!base) result = { seq: 0 }; // Never synced: nothing to delete.
      else result = await this.client.mutation(api.sync.put, { key, base, deleted: true });
    } else {
      const { iv, data } = await seal(this.key, key, value);
      if (data.byteLength > INLINE_LIMIT) {
        const url = await this.client.mutation(api.sync.uploadUrl, {});
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: data });
        if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status})`);
        const { storageId } = (await res.json()) as { storageId: string };
        result = await this.client.mutation(api.sync.put, { key, base, deleted: false, iv, file: storageId as never });
      } else {
        result = await this.client.mutation(api.sync.put, { key, base, deleted: false, iv, data });
      }
    }

    if (result.conflict) {
      // Someone else wrote it first. Their version comes through the subscription and is merged;
      // retry after that (right away if it has already arrived).
      if ((this.state.known[key] ?? 0) >= result.seq) this.schedulePush();
      else this.conflicts.add(key);
      return;
    }
    if (result.deleted) {
      // Deleted on another device: deletion wins.
      this.state.known[key] = Math.max(this.state.known[key] ?? 0, result.seq);
      this.dirty.delete(key);
      const id = chatIdOf(key);
      if (id) this.apply(() => useStore.getState().removeChat(id));
      this.persist();
      return;
    }
    if (result.seq) this.state.known[key] = Math.max(this.state.known[key] ?? 0, result.seq);
    if (key === "keys") this.state.keysJoined = !!value && Object.keys(value).length > 0;
    if (json === undefined) this.lastJson.delete(key);
    else this.lastJson.set(key, json);
    if (this.version.get(key) === version) this.dirty.delete(key);
    else this.schedulePush();
    this.persist();
  }
}
