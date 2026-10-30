// Device-scoped stale-while-revalidate status, shared by startup and Settings.
import type { RuntimeStatus, ThreadRuntime } from "../../shared/types";
import { runtimeStatuses } from "./pi";

type Statuses = Record<ThreadRuntime, RuntimeStatus>;
type Entry = { at: number; statuses: Statuses };
const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<Statuses>>();
const storageKey = (deviceId?: string) => `openbuild:runtime-status:v1:${deviceId ?? ""}`;
const listeners = new Set<(statuses: Statuses, deviceId?: string) => void>();

export function subscribeRuntimeStatuses(listener: (statuses: Statuses, deviceId?: string) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const ttl = 5 * 60_000;

function entry(deviceId?: string): Entry | undefined {
  const key = deviceId ?? "";
  if (!cache.has(key)) {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(deviceId)) ?? "null");
      if (saved && typeof saved.at === "number" && saved.statuses && ["pi", "durable", "claude", "codex", "cursor", "fx", "opencode"].every((id) => typeof saved.statuses[id]?.installed === "boolean")) cache.set(key, saved);
    } catch { /* Storage may be unavailable; memory caching still works. */ }
  }
  return cache.get(key);
}

export const cachedRuntimeStatuses = (deviceId?: string) => entry(deviceId)?.statuses;

export function loadRuntimeStatuses(fresh = false, deviceId?: string): Promise<Statuses> {
  const key = deviceId ?? "";
  const active = pending.get(key);
  // A manual check must run after an older background probe, not reuse its stale result.
  if (active) return fresh ? active.catch(() => {}).then(() => loadRuntimeStatuses(true, deviceId)) : active;
  const hit = entry(deviceId);
  if (!fresh && hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.statuses);
  const request = runtimeStatuses(fresh, deviceId).then((statuses) => {
    const next = { at: Date.now(), statuses };
    cache.set(key, next);
    try { localStorage.setItem(storageKey(deviceId), JSON.stringify(next)); } catch { /* Best effort. */ }
    for (const listener of listeners) listener(statuses, deviceId);
    return statuses;
  }).finally(() => { if (pending.get(key) === request) pending.delete(key); });
  pending.set(key, request);
  return request;
}

export const preloadRuntimeStatuses = (deviceId?: string) => { void loadRuntimeStatuses(false, deviceId).catch(() => {}); };
