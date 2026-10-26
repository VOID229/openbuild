import { useEffect, useState } from "react";
import { isHosted } from "./runtime";
import { useStore } from "./store";

// Noticing that the server now serves a newer app than this tab is running, e.g. after a pull and
// restart while the tab stayed open, and that a newer Pi is out. Only this tab's own server is
// asked; it's the one that checks npm for Pi.
//
// A production build names its script after its content (/chunk-<hash>.js), so a different name
// means different code. Dev builds get a new name on every start and update themselves (HMR), so
// they're left alone.

const CHECK_EVERY = 60_000;

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

/** True once the server serves a different build than the one running here. */
export function useUpdateAvailable(enabled = true): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const running = buildPath(document.querySelector('script[type="module"][src]')?.getAttribute("src"), location.href);
    if (!enabled || !running || available) return;
    let pending = false;
    const check = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const res = await fetch("/", { cache: "no-store" });
        const served = res.ok ? buildOf(await res.text(), location.href) : undefined;
        if (served && served !== running) setAvailable(true);
      } catch { /* The server is down or restarting; the next check sees it. */ }
      finally { pending = false; }
    };
    const timer = setInterval(() => void check(), CHECK_EVERY);
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    addEventListener("online", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      removeEventListener("online", onVisible);
    };
  }, [enabled, available]);
  return available;
}

const PI_CHECK_EVERY = 30 * 60_000;

/** A newer Pi release for this computer, once its status shows one (the server asks npm hourly). */
export function usePiUpdate(enabled = true): string | undefined {
  const status = useStore((s) => s.piCache.status);
  useEffect(() => {
    if (!enabled || isHosted()) return;
    let last = Date.now();
    const check = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < PI_CHECK_EVERY) return;
      last = Date.now();
      void useStore.getState().loadPiStatus().catch(() => {});
    };
    const timer = setInterval(check, PI_CHECK_EVERY);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [enabled]);
  return enabled && !isHosted() && status?.updateAvailable ? status.latest : undefined;
}
