// Where the page's lists were scrolled to, kept for the tab's session so a reload lands where the
// reader was rather than at the top. Only the first showing after a load is put back: within a
// session each list keeps its own behaviour. (The thread keeps its own place: ChatView.)
import { useLayoutEffect, type RefObject } from "react";

const KEY = "openbuild:scroll";
/** How long a list may take to grow tall enough (its rows arriving) before it's left where it is. */
const SETTLE_MS = 4000;

const saved = new Map<string, number>(
  (() => {
    try {
      return Object.entries(JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Record<string, number>).filter(([, top]) => Number.isFinite(top));
    } catch {
      return [];
    }
  })(),
);
/** Lists already put back (or shown) since the page loaded. */
const restored = new Set<string>();

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(Object.fromEntries(saved)));
    } catch {
      // Storage blocked or full: lists just start at the top.
    }
  });
}

/**
 * Puts the list in `ref` back where it was before the page reloaded, waiting (a few seconds at most)
 * for its rows to make it tall enough, and stopping the moment the reader scrolls it themselves.
 * `key` names the list; undefined while it shouldn't be remembered.
 */
export function useScrollRestore(ref: RefObject<HTMLElement | null>, key: string | undefined) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !key) return;
    const target = restored.has(key) ? undefined : saved.get(key);
    restored.add(key);
    let frame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      for (const type of ["wheel", "touchstart", "pointerdown", "keydown"] as const) el.removeEventListener(type, stop);
    };
    // Kept as it goes, so a list hidden when the page is left (OpenBots over the threads) still counts.
    const track = () => {
      if (el.scrollTop > 0) saved.set(key, el.scrollTop);
      else saved.delete(key);
    };
    el.addEventListener("scroll", track, { passive: true });
    if (target) {
      const until = performance.now() + SETTLE_MS;
      const put = () => {
        el.scrollTop = target;
        if (Math.abs(el.scrollTop - target) > 1 && performance.now() < until) frame = requestAnimationFrame(put);
        else stop();
      };
      for (const type of ["wheel", "touchstart", "pointerdown", "keydown"] as const) el.addEventListener(type, stop, { passive: true });
      put();
    }
    return () => {
      stop();
      el.removeEventListener("scroll", track);
    };
  }, [ref, key]);
}
