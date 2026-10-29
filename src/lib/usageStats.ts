// The usage page's data (server/usage/): shown at once from the last copy this browser saw, then
// refreshed in the background. Opening the page (or hovering its button) starts the request.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { UsageLimitsReport, UsageRange, UsageReport } from "../../shared/usage";

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const STORE_KEY = "openbuild-usage-v1";
/** Younger than this, a cached copy isn't asked for again. */
const FRESH_MS = 30_000;

interface Slot<T> {
  data?: T;
  at: number;
  loading: boolean;
  error?: string;
  promise?: Promise<void>;
}

const slots = new Map<string, Slot<unknown>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// Restore what the last visit saw, so the page opens with numbers instead of a spinner.
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, { data: unknown; at: number }>;
  for (const [k, v] of Object.entries(saved)) slots.set(k, { data: v.data, at: v.at, loading: false });
} catch {}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const out: Record<string, { data: unknown; at: number }> = {};
    for (const [k, s] of slots) if (s.data) out[k] = { data: s.data, at: s.at };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(out));
    } catch {}
  }, 500);
}

/** `force`: ask the server to re-read too; `stale`: just skip this browser's copy. */
function load(key: string, url: string, force = false, stale = force) {
  const slot = (slots.get(key) ?? { at: 0, loading: false }) as Slot<unknown>;
  slots.set(key, slot);
  if (slot.promise) return slot.promise;
  if (!stale && slot.data && Date.now() - slot.at < FRESH_MS) return Promise.resolve();
  slot.loading = true;
  slot.error = undefined;
  emit();
  slot.promise = fetch(force ? `${url}${url.includes("?") ? "&" : "?"}fresh=1` : url)
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      slot.data = body;
      slot.at = Date.now();
      persist();
    })
    .catch((err: Error) => {
      slot.error = err.message === "Failed to fetch" ? "Couldn't reach the OpenBuild server." : err.message;
    })
    .finally(() => {
      slot.loading = false;
      slot.promise = undefined;
      emit();
    });
  return slot.promise;
}

/** "all" (every machine added up), "local", or a paired device's id. */
export type UsageScope = string;
const reportKey = (range: UsageRange, machine: UsageScope) => `report:${machine}:${range}`;
const reportUrl = (range: UsageRange, machine: UsageScope) => `/api/usage?range=${range}&tz=${encodeURIComponent(tz())}&machine=${encodeURIComponent(machine)}`;

export const loadReport = (range: UsageRange, machine: UsageScope = "all", force = false, stale = force) => load(reportKey(range, machine), reportUrl(range, machine), force, stale);
export const loadLimits = (force = false) => load("limits", "/api/usage/limits", force);

/** Warm the page before it opens. */
export function prefetchUsage(range: UsageRange = "30d") {
  void loadReport(range, "all");
  void loadLimits();
}

function useSlot<T>(key: string) {
  const version = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => {
      const s = slots.get(key);
      return s ? `${s.at}:${s.loading}:${s.error ?? ""}` : "";
    },
  );
  void version;
  const s = slots.get(key) as Slot<T> | undefined;
  return { data: s?.data, loading: !!s?.loading, error: s?.error, at: s?.at ?? 0 };
}

export function useUsageReport(range: UsageRange, machine: UsageScope) {
  useEffect(() => void loadReport(range, machine), [range, machine]);
  const slot = useSlot<UsageReport>(reportKey(range, machine));
  // Keep visible numbers live without activity notices. Incomplete history gets faster polls;
  // hidden tabs do no polling, and failed machines remain stopped until explicit refresh.
  const pending = !!slot.data?.pending?.length || !!slot.data?.machines?.some((m) => m.status === "pending");
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "hidden") void loadReport(range, machine, false, true);
    };
    const t = setInterval(refresh, pending ? 3000 : 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [pending, range, machine]);
  return slot;
}

export function useUsageLimits() {
  useEffect(() => void loadLimits(), []);
  const slot = useSlot<UsageLimitsReport>("limits");
  const pending = !!slot.data?.machines?.some((m) => m.status === "pending");
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "hidden") void load("limits", "/api/usage/limits", false, true);
    };
    const t = setInterval(refresh, pending ? 3000 : 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [pending]);
  return slot;
}

/** Re-renders every `ms`, for countdowns. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
