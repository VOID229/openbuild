// Client side of key storage.
//
// Local app: the browser never keeps API key secrets. They are sent once to the server
// (PUT /api/keys/:scope), which keeps them in the OS keychain and hands back opaque ids.
//
// Hosted website: there's no server-side storage, so keys stay in this browser (IndexedDB) and are
// attached to each request that needs them; the relay uses them for that request and keeps nothing.
import { createStore, entries, get, set } from "./kv";
import { GITHUB_SCOPE, SEARCH_PROVIDERS, type KeyEdit, type KeyInventory, type PlanId, type SearchProviderId } from "../../shared/types";
import { config } from "./runtime";

interface Entry {
  id: string;
  secret: string;
}
const browserKeys = createStore("openchat-secrets", "keys");

/** Hosted: the secrets for a plan or search provider, in priority order. */
export async function browserSecrets(scope: string): Promise<string[]> {
  return ((await get<Entry[]>(scope, browserKeys).catch(() => undefined)) ?? []).map((e) => e.secret);
}

/** Hosted: one stored secret by its id. */
export async function browserSecretById(scope: string, id: string): Promise<string | undefined> {
  return ((await get<Entry[]>(scope, browserKeys).catch(() => undefined)) ?? []).find((e) => e.id === id)?.secret;
}

async function browserSetKeys(scope: string, edits: KeyEdit[]): Promise<string[]> {
  const current = (await get<Entry[]>(scope, browserKeys)) ?? [];
  const next: Entry[] = [];
  for (const edit of edits) {
    const entry =
      "id" in edit
        ? current.find((e) => e.id === edit.id)
        : (current.find((e) => e.secret === edit.secret.trim()) ?? { id: crypto.randomUUID().replace(/-/g, "").slice(0, 12), secret: edit.secret.trim() });
    if (!entry) throw new Error("Unknown key");
    if (!next.some((e) => e.id === entry.id)) next.push(entry);
  }
  await set(scope, next, browserKeys);
  return next.map((e) => e.id);
}

// A server from before the key vault has no /api/keys and answers 404. That happens when an old
// `bun dev` is still running on this port after an update: say so instead of "Not found".
export const STALE_SERVER = "The OpenChat server on this port is out of date, so it can't save keys. Stop it, run `bun dev` again, and reload this page.";

/** The saved key ids; undefined when the server is unreachable. Throws when the server is too old to have a vault. */
export async function fetchKeys(signal?: AbortSignal): Promise<KeyInventory | undefined> {
  if ((await config).mode === "hosted") {
    const keys: Record<string, string[]> = {};
    for (const [scope, list] of await entries<string, Entry[]>(browserKeys)) if (list.length) keys[scope] = list.map((e) => e.id);
    return { backend: "browser", keys };
  }
  let res: Response;
  try {
    res = await fetch("/api/keys", { signal });
  } catch {
    return undefined;
  }
  if (res.status === 404) throw new Error(STALE_SERVER);
  return res.ok ? ((await res.json().catch(() => undefined)) as KeyInventory | undefined) : undefined;
}

/** Replace a scope's ordered key list on the server; resolves to the saved ids. */
/** Told whenever a scope's saved keys change (account key sync listens). */
export const keyListeners = new Set<(scope: string) => void>();

/** Every saved secret, per scope in priority order. Used only by account key sync, when it's on. */
export async function allSecrets(): Promise<Record<string, string[]>> {
  if ((await config).mode === "hosted") {
    const out: Record<string, string[]> = {};
    for (const [scope, list] of await entries<string, Entry[]>(browserKeys)) if (list.length) out[scope] = list.map((e) => e.secret);
    return out;
  }
  const res = await fetch("/api/keys/secrets");
  if (!res.ok) throw new Error(res.status === 404 ? STALE_SERVER : `Couldn't read keys (HTTP ${res.status})`);
  return ((await res.json()) as { secrets: Record<string, string[]> }).secrets;
}

export async function saveKeys(scope: PlanId | SearchProviderId | typeof GITHUB_SCOPE, keys: KeyEdit[]): Promise<string[]> {
  const ids = await saveKeysTo(scope, keys);
  keyListeners.forEach((fn) => fn(scope));
  return ids;
}

async function saveKeysTo(scope: PlanId | SearchProviderId | typeof GITHUB_SCOPE, keys: KeyEdit[]): Promise<string[]> {
  if ((await config).mode === "hosted") return browserSetKeys(scope, keys);
  const res = await fetch(`/api/keys/${scope}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys }),
  });
  const body = await res.json().catch(() => null);
  if (res.status === 404) throw new Error(STALE_SERVER);
  if (!res.ok) throw new Error(body?.error ?? `Couldn't save the key (HTTP ${res.status})`);
  return body.ids as string[];
}

// ---------------------------------------------------------------------------------------
// One-time migration from builds that kept keys in localStorage.
//
// The old plaintext keys are moved into the server vault. They're held in a temporary backup
// until the server confirms every key is saved, so a failed upload (server down) loses nothing.

const BACKUP = "openchat-legacy-keys";

export type LegacyKeys = Record<string, string[]>;

// Older builds stored a single string per plan before moving to lists; accept both.
const clean = (list: unknown) => (Array.isArray(list) ? list : [list]).filter((k): k is string => typeof k === "string" && !!k.trim());

/** Collect legacy plaintext keys from pre-vault settings (plan keys, and search keys that aren't instance URLs). */
export function stashLegacyKeys(settings: { keys?: Record<string, unknown>; search?: Record<string, unknown> }) {
  const found: LegacyKeys = {};
  for (const [plan, list] of Object.entries(settings.keys ?? {})) if (clean(list).length) found[plan] = clean(list);
  for (const [provider, list] of Object.entries(settings.search ?? {})) {
    if (SEARCH_PROVIDERS[provider as SearchProviderId]?.credential === "key" && clean(list).length) found[provider] = clean(list);
  }
  if (!Object.keys(found).length) return;
  try {
    const prior = readLegacyKeys() ?? {};
    for (const [scope, list] of Object.entries(found)) prior[scope] = [...new Set([...(prior[scope] ?? []), ...list])];
    localStorage.setItem(BACKUP, JSON.stringify(prior));
  } catch {}
}

export function readLegacyKeys(): LegacyKeys | undefined {
  try {
    const raw = localStorage.getItem(BACKUP);
    return raw ? (JSON.parse(raw) as LegacyKeys) : undefined;
  } catch {
    return undefined;
  }
}

export function clearLegacyKeys() {
  try {
    localStorage.removeItem(BACKUP);
  } catch {}
}
