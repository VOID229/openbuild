import { useEffect, useRef, useState, type RefObject } from "react";

export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

/** A duration in its two largest units: "45s", "7m 9s", "1hr 2m", "1d 3hr". */
export function duration(ms: number) {
  const total = Math.max(1, Math.round(ms / 1000));
  const units: [string, number][] = [
    ["d", Math.floor(total / 86400)],
    ["hr", Math.floor(total / 3600) % 24],
    ["m", Math.floor(total / 60) % 60],
    ["s", total % 60],
  ];
  const first = units.findIndex(([, n]) => n > 0);
  return units
    .slice(first, first + 2)
    .filter(([, n]) => n > 0)
    .map(([u, n]) => `${n}${u}`)
    .join(" ");
}

/** Keep an element mounted through its exit transition. `visible` drives the CSS state. */
export function usePresence(open: boolean, exitMs = 180) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(t);
  }, [open, exitMs]);
  return { mounted, visible };
}

/** Close on outside pointerdown or Escape. Escape is captured so parent dialogs stay open. */
export function useDismiss(open: boolean, onClose: () => void, refs: RefObject<HTMLElement | null>[]) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (refs.some((r) => r.current?.contains(t))) return;
      close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close.current();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/**
 * Focus an element inside a popover once it's positioned and visible; `autoFocus` fires while
 * the popover is still hidden for measuring, so the focus would be lost.
 * Skipped on touch screens: focusing a field opens the on-screen keyboard, and on iOS the page
 * shifting under it stops the popover's list from scrolling (same rule as the composer picker).
 */
export function useFocusOnShow(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!window.matchMedia("(pointer: fine)").matches) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [ref]);
}

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API is unavailable on insecure origins (e.g. LAN IPs over http).
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** Arrow-key navigation between focusable items inside a list. */
export function arrowNav(e: React.KeyboardEvent<HTMLElement>, selector = "button:not(:disabled)") {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector));
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "ArrowDown" ? items[Math.min(items.length - 1, i + 1)] : items[Math.max(0, i - 1)];
  next?.focus();
  e.preventDefault();
}
