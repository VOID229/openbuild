import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

/**
 * Whether a pointer can rest over things. A tap on a touch screen also fires mouseenter, so a submenu
 * that opened on hover would open and then have its click toggle it straight shut.
 */
export const canHover = () => window.matchMedia("(hover: hover)").matches;

/**
 * Land whatever a change just set moving in the app, so the panes come in at rest. Showing a kept
 * subtree again restarts every entrance animation in it, and the crossfade is the only motion wanted.
 */
function settleMotion() {
  for (const animation of document.getAnimations()) {
    if (!(animation instanceof CSSAnimation || animation instanceof CSSTransition)) continue;
    const effect = animation.effect as KeyframeEffect | null;
    if (effect?.target?.closest(".app") && effect.getComputedTiming().iterations !== Infinity) animation.finish();
  }
}

/** Sent by the search shortcut: the sidebar showing opens its search and puts the cursor in it. */
export const OPEN_SEARCH = "openbuild:open-search";

let entering: ReturnType<typeof setTimeout> | undefined;

/**
 * Switch the sidebar and main pane between OpenBuild and OpenBots. The layout changes at once and the
 * incoming panes fade in (bots.css, .world-enter): no snapshots of the page, nothing else moves.
 */
export function crossfade(update: () => void) {
  flushSync(update);
  settleMotion();
  if (typeof document === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const root = document.documentElement;
  root.classList.remove("world-enter");
  // Restart the fade if a second switch comes before the first has finished.
  void root.offsetWidth;
  root.classList.add("world-enter");
  clearTimeout(entering);
  entering = setTimeout(() => root.classList.remove("world-enter"), 260);
}

/**
 * Follow a resize grip until the drag ends, with `className` on the body meanwhile. The pointer is
 * captured, so fast drags hold. However the drag ends, the class comes off: the grip can leave the
 * page mid-drag, and a release can go unseen (a context menu, the window losing focus), so the end
 * is watched for on the window, and a move with no button down ends it too.
 */
export function trackDrag(e: React.PointerEvent<HTMLElement>, className: string, onMove: (ev: PointerEvent) => void) {
  e.preventDefault();
  const id = e.pointerId;
  e.currentTarget.setPointerCapture(id);
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    if (ev.buttons) onMove(ev);
    else end();
  };
  const finish = (ev: PointerEvent) => {
    if (ev.pointerId === id) end();
  };
  const end = () => {
    window.removeEventListener("pointermove", move, true);
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) window.removeEventListener(type, finish, true);
    window.removeEventListener("blur", end);
    document.body.classList.remove(className);
  };
  document.body.classList.add(className);
  window.addEventListener("pointermove", move, true);
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) window.addEventListener(type, finish, true);
  window.addEventListener("blur", end);
}

/** "just now", "5m ago", "3h ago", "4d ago", then a date. */
export function ago(at: number | undefined): string | undefined {
  if (!at) return undefined;
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  if (minutes < 60 * 24 * 14) return `${Math.round(minutes / 60 / 24)}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

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

function swallowNextClick() {
  const swallow = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener("click", swallow, { capture: true, once: true });
  // A press that became a scroll never clicks, so the next real tap mustn't be eaten.
  setTimeout(() => document.removeEventListener("click", swallow, { capture: true }), 500);
}

/**
 * Close on outside pointerdown or Escape. Escape is captured so parent dialogs stay open. On a touch
 * screen the tap that dismisses does only that, rather than also pressing whatever was under it.
 */
export function useDismiss(open: boolean, onClose: () => void, refs: RefObject<HTMLElement | null>[]) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (refs.some((r) => r.current?.contains(t))) return;
      close.current();
      if (e.pointerType === "touch") swallowNextClick();
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

function readDevicePref(name: string) {
  try {
    return localStorage.getItem(name) === "1";
  } catch {
    return false;
  }
}

/**
 * A boolean UI preference this browser remembers per paired device (localStorage, never synced), so
 * each device keeps its last choice. Pass the device id, or none for this server's own models.
 */
export function useDevicePref(key: string, deviceId?: string): [boolean, (value: boolean) => void] {
  const name = `openchat.pref.${key}.${deviceId ?? "local"}`;
  const [value, setValue] = useState(() => readDevicePref(name));
  // Following a picker to another device shows that device's remembered choice.
  useEffect(() => setValue(readDevicePref(name)), [name]);
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(name, next ? "1" : "0");
      } catch {}
    },
    [name],
  );
  return [value, set];
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

/**
 * The side panel's and file tree's room, which stays taken while they fade out (styles.css: a
 * `--fast` delay on their width) and goes back in one step after. True as soon as `open` is, and
 * false only once that room is back, so what keeps clear of them (the thread, the top-right tools)
 * moves once, with them, instead of a frame ahead.
 */
export function useRoomTaken(open: boolean) {
  const [taken, setTaken] = useState(open);
  useEffect(() => {
    if (open) return setTaken(true);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setTaken(false);
    const fast = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fast")) || 120;
    const timer = setTimeout(() => setTaken(false), fast);
    return () => clearTimeout(timer);
  }, [open]);
  return open || taken;
}

/** Copies `text`, and says whether it made it to the clipboard. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API is unavailable on insecure origins (e.g. LAN IPs over http).
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

/**
 * Arrow-key navigation between focusable items inside a list. `horizontal` also takes ←/→, for a
 * group whose items may sit in a row (radio groups).
 */
export function arrowNav(e: React.KeyboardEvent<HTMLElement>, selector = "button:not(:disabled)", { horizontal = false } = {}) {
  const forward = e.key === "ArrowDown" || (horizontal && e.key === "ArrowRight");
  if (!forward && e.key !== "ArrowUp" && !(horizontal && e.key === "ArrowLeft")) return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector));
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = forward ? items[Math.min(items.length - 1, i + 1)] : items[Math.max(0, i - 1)];
  next?.focus();
  e.preventDefault();
}
