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

const reportKey = (range: UsageRange) => `report:${range}`;
const reportUrl = (range: UsageRange) => `/api/usage?range=${range}&tz=${encodeURIComponent(tz())}`;

export const loadReport = (range: UsageRange, force = false, stale = force) => load(reportKey(range), reportUrl(range), force, stale);
export const loadLimits = (force = false) => load("limits", "/api/usage/limits", force);

/** Warm the page before it opens. */
export function prefetchUsage(range: UsageRange = "30d") {
  void loadReport(range);
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

export function useUsageReport(range: UsageRange) {
  useEffect(() => void loadReport(range), [range]);
  const slot = useSlot<UsageReport>(reportKey(range));
  // A source still loading on the server (Cursor's account history): ask again once it's had time.
  const pending = !!slot.data?.pending?.length && !slot.loading;
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => void loadReport(range, false, true), 3000);
    return () => clearTimeout(t);
  }, [pending, range, slot.at]);
  return slot;
}

export function useUsageLimits() {
  useEffect(() => void loadLimits(), []);
  return useSlot<UsageLimitsReport>("limits");
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
