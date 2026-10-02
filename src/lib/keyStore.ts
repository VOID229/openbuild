// Client side of key storage. The browser never keeps API key secrets: they are sent once to the
// server (PUT /api/keys/:scope), which keeps them in the OS keychain and hands back opaque ids.
import { SEARCH_PROVIDERS, type KeyEdit, type KeyInventory, type PlanId, type SearchProviderId } from "../../shared/types";

export async function fetchKeys(signal?: AbortSignal): Promise<KeyInventory | undefined> {
  try {
    const res = await fetch("/api/keys", { signal });
    return res.ok ? ((await res.json()) as KeyInventory) : undefined;
  } catch {
    return undefined;
  }
}

/** Replace a scope's ordered key list on the server; resolves to the saved ids. */
export async function saveKeys(scope: PlanId | SearchProviderId, keys: KeyEdit[]): Promise<string[]> {
  const res = await fetch(`/api/keys/${scope}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys }),
  });
  const body = await res.json().catch(() => null);
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
