// Key-value storage for the browser: idb-keyval, with a fallback for browsers without IndexedDB.
//
// iOS Lockdown Mode (and some locked-down browsers) remove IndexedDB entirely, so every call into
// idb-keyval would throw "Can't find variable: indexedDB" and the app couldn't load any chats.
// There, stores are kept in localStorage instead, one entry per key. Values that can't be written
// as JSON (a CryptoKey) or that don't fit in localStorage are kept in memory for this page load only.
import * as idb from "idb-keyval";

type Store = idb.UseStore | Fallback;

const hasIndexedDB = (() => {
  try {
    return typeof indexedDB !== "undefined" && !!indexedDB;
  } catch {
    return false;
  }
})();

const storage = (() => {
  try {
    const s = globalThis.localStorage;
    const probe = "openchat-kv-probe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return undefined;
  }
})();

const isCryptoKey = (v: unknown) => typeof CryptoKey !== "undefined" && v instanceof CryptoKey;

class Fallback {
  private memory = new Map<string, unknown>();
  private prefix: string;
  constructor(dbName: string, storeName: string) {
    this.prefix = `openchat-kv:${dbName}/${storeName}:`;
  }

  private storedKeys(): string[] {
    if (!storage) return [];
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith(this.prefix)) keys.push(k.slice(this.prefix.length));
    }
    return keys;
  }

  get(key: string): unknown {
    if (this.memory.has(key)) return this.memory.get(key);
    const raw = storage?.getItem(this.prefix + key);
    if (raw == null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown) {
    this.del(key);
    if (storage && !isCryptoKey(value)) {
      try {
        storage.setItem(this.prefix + key, JSON.stringify(value));
        return;
      } catch {
        // Over quota: keep it for this session rather than lose the change.
      }
    }
    this.memory.set(key, value);
  }

  del(key: string) {
    this.memory.delete(key);
    try {
      storage?.removeItem(this.prefix + key);
    } catch {}
  }

  entries(): [string, unknown][] {
    const keys = new Set([...this.storedKeys(), ...this.memory.keys()]);
    return [...keys].map((k) => [k, this.get(k)] as [string, unknown]).filter(([, v]) => v !== undefined);
  }

  clear() {
    for (const k of this.storedKeys()) this.del(k);
    this.memory.clear();
  }
}

/** True when this browser has no IndexedDB and storage falls back to localStorage. */
export const usingFallbackStorage = !hasIndexedDB;

export function createStore(dbName: string, storeName: string): Store {
  return hasIndexedDB ? idb.createStore(dbName, storeName) : new Fallback(dbName, storeName);
}

const run = async <T>(store: Store, fallback: (f: Fallback) => T, native: (s: idb.UseStore) => Promise<T>): Promise<T> =>
  store instanceof Fallback ? fallback(store) : native(store);

export const get = <T = unknown>(key: string, store: Store) => run(store, (f) => f.get(key) as T | undefined, (s) => idb.get<T>(key, s));

export const set = (key: string, value: unknown, store: Store) => run(store, (f) => f.set(key, value), (s) => idb.set(key, value, s));

export const del = (key: string, store: Store) => run(store, (f) => f.del(key), (s) => idb.del(key, s));

export const clear = (store: Store) => run(store, (f) => f.clear(), (s) => idb.clear(s));

export const entries = <K extends string = string, V = unknown>(store: Store) =>
  run(store, (f) => f.entries() as [K, V][], (s) => idb.entries<K, V>(s));
