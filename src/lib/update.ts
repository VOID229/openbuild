import { useCallback, useEffect, useState } from "react";
import type { ThreadRuntime } from "../../shared/types";
import { isHosted } from "./runtime";
import { cachedRuntimeStatuses, loadRuntimeStatuses, subscribeRuntimeStatuses } from "./runtimeStatus";
import { UPDATABLE_RUNTIMES } from "./runtimes";

// Noticing that the server now serves a newer app than this tab is running, e.g. after a pull and
// restart while the tab stayed open, and that newer runtimes are out. Only this tab's own server
// is asked; it's the one that checks the registries.
//
// A production build names its script after its content (/chunk-<hash>.js), so a different name
// means different code. Dev builds get a new name on every start and update themselves (HMR), so
// they're left alone.

const CHECK_EVERY = 60_000;
/** After a failed check: coming back to a tab during a restart must still find the new build. */
const RETRY_EVERY = 2_000;

/** A production build's script path, e.g. "/chunk-z4krfn4n.js"; undefined for anything else. */
export function buildPath(src: string | null | undefined, base: string): string | undefined {
  if (!src) return undefined;
  const path = new URL(src, base).pathname;
  return /^\/chunk-[^/]+\.js$/.test(path) ? path : undefined;
}

/** The build a served page loads. */
export function buildOf(html: string, base: string): string | undefined {
  const tag = /<script\b[^>]*\btype="module"[^>]*>/.exec(html)?.[0];
  return buildPath(tag && /\bsrc="([^"]+)"/.exec(tag)?.[1], base);
}

/** Calls `onNewer` when the server serves a different build than `running`. Returns a stop function. */
export function watchBuild(running: string, onNewer: () => void, retryEvery = RETRY_EVERY): () => void {
  let pending = false;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    if (pending || document.visibilityState !== "visible") return;
    pending = true;
    clearTimeout(retry);
    let answered = false;
    try {
      const res = await fetch("/", { cache: "no-store" });
      answered = res.ok;
      const served = res.ok ? buildOf(await res.text(), location.href) : undefined;
      if (served && served !== running) onNewer();
    } catch { /* The server is down or restarting; the retry sees it. */ }
    finally { pending = false; }
    if (!answered && !stopped) retry = setTimeout(() => void check(), retryEvery);
  };
  const timer = setInterval(() => void check(), CHECK_EVERY);
  const onVisible = () => void check();
  document.addEventListener("visibilitychange", onVisible);
  addEventListener("online", onVisible);
  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(retry);
    document.removeEventListener("visibilitychange", onVisible);
    removeEventListener("online", onVisible);
  };
}

/** True once the server serves a different build than the one running here. */
export function useUpdateAvailable(enabled = true): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const running = buildPath(document.querySelector('script[type="module"][src]')?.getAttribute("src"), location.href);
    if (!enabled || !running || available) return;
    return watchBuild(running, () => setAvailable(true));
  }, [enabled, available]);
  return available;
}

const RUNTIME_CHECK_EVERY = 10 * 60_000;

export interface RuntimeUpdate {
  runtime: ThreadRuntime;
  version: string;
}

/**
 * Newer releases of the runtimes picked in Settings → Notifications (the server asks their
 * registries at most hourly; this only asks it every ten minutes, and stops while hidden).
 */
export function useRuntimeUpdates(enabled = true, only?: ThreadRuntime[]): RuntimeUpdate[] {
  const [statuses, setStatuses] = useState(() => cachedRuntimeStatuses());
  useEffect(() => {
    if (!enabled || isHosted()) return;
    const unsubscribe = subscribeRuntimeStatuses((next, deviceId) => {
      if (deviceId === undefined) setStatuses(next);
    });
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await loadRuntimeStatuses();
        if (!cancelled) setStatuses(next);
      } catch { /* The server is down or restarting; the next check sees it. */ }
    };
    void load();
    const timer = setInterval(() => void load(), RUNTIME_CHECK_EVERY);
    const onVisible = () => void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
  if (!enabled || isHosted()) return [];
  return UPDATABLE_RUNTIMES.filter((runtime) => !only || only.includes(runtime)).flatMap((runtime) => {
    const status = statuses?.[runtime];
    return status?.updateAvailable && status.latest ? [{ runtime, version: status.latest }] : [];
  });
}

/** Release availability for this server, separate from the tab's bundle reload notice. */
export function useReleaseUpdate(enabled = true) {
  const [release, setRelease] = useState<{ track?: string; latest?: string; available?: boolean; restart?: { pending: boolean; head?: string; error?: string } }>();
  const refresh = useCallback(async () => {
    const res = await fetch("/api/releases");
    if (res.ok) setRelease(await res.json());
  }, []);
  useEffect(() => {
    if (!enabled || isHosted()) return;
    let pending = false;
    const check = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try { await refresh(); }
      catch { /* Retry when online or on the next interval. */ }
      finally { pending = false; }
    };
    void check();
    const timer = setInterval(() => void check(), RUNTIME_CHECK_EVERY);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", check); window.removeEventListener("online", check); };
  }, [enabled, refresh]);
  return { release: enabled && (release?.available || release?.restart?.pending) ? release : undefined, refresh };
}
