// Touch gestures for phones: holding a row or bubble for its actions, swiping a bubble to reply, and
// dragging panes in from the screen's edge. Everything here starts from a finger, so a mouse in a
// narrow desktop window never sets any of it off.
import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { useBots } from "./bots/store";
import { useStore } from "./store";

const PHONE = "(max-width: 768px)";
export const isPhone = () => window.matchMedia(PHONE).matches;

/** How long a finger rests before it counts as a hold. */
const HOLD_MS = 420;
/** Further than this and a press is a drag, not a tap or a hold. */
const SLOP = 8;

/**
 * A hold opens something right under a finger that's still down, and lifting it would count as a tap
 * on whatever slid in there: a menu's Rename, or its Delete. So that tap goes nowhere.
 */
function ignoreTapOnLift() {
  const swallow = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const lifted = () => {
    clearTimeout(giveUp);
    document.removeEventListener("touchend", lifted, true);
    document.removeEventListener("touchcancel", lifted, true);
    setTimeout(() => document.removeEventListener("click", swallow, true), 400);
  };
  // In case the lift is never seen (the touched element can go away with the finger still on it).
  const giveUp = setTimeout(lifted, 5000);
  document.addEventListener("click", swallow, true);
  document.addEventListener("touchend", lifted, true);
  document.addEventListener("touchcancel", lifted, true);
}

/**
 * Long-press on touch screens opens the row's menu. iOS Safari never fires `contextmenu`, and
 * Android fires it too, so whichever comes first opens the menu and the click after it is dropped.
 */
export function useLongPress(open: (x: number, y: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useRef<{ x: number; y: number }>(undefined);
  const fired = useRef(false);
  const cancel = () => {
    clearTimeout(timer.current);
    start.current = undefined;
  };
  const fire = (x: number, y: number) => {
    cancel();
    if (fired.current) return;
    fired.current = true;
    navigator.vibrate?.(10);
    ignoreTapOnLift();
    open(x, y);
  };
  useEffect(() => cancel, []);
  return {
    pressing: () => !!start.current || fired.current,
    fire,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        fired.current = false;
        if (e.pointerType !== "touch") return;
        const { clientX: x, clientY: y } = e;
        start.current = { x, y };
        timer.current = setTimeout(() => fire(x, y), HOLD_MS);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > SLOP) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onClickCapture: (e: React.MouseEvent) => {
        if (!fired.current) return;
        fired.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
    },
  };
}

/** How far a bubble has to travel, in pixels, before letting go means "reply". */
export const REPLY_AT = 56;
/** The bubble keeps following the finger past that, but ever more reluctantly. */
export const replyDrag = (dx: number) => {
  const pull = Math.max(0, -dx);
  return pull <= REPLY_AT ? pull : REPLY_AT + (pull - REPLY_AT) * 0.25;
};

/** A chat bubble under a finger: hold for actions, swipe left to reply, tap twice to love it. */
export function useBubbleTouch({ onHold, onReply, onDoubleTap }: { onHold?: () => void; onReply?: () => void; onDoubleTap?: () => void }) {
  const press = useRef<{ x: number; y: number; moved: "no" | "swipe" | "scroll"; over: boolean }>(undefined);
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined);
  const held = useRef(false);
  const lastTap = useRef(0);
  const row = useRef<HTMLElement | null>(null);
  const settle = () => {
    clearTimeout(hold.current);
    row.current?.style.removeProperty("--swipe");
    row.current?.removeAttribute("data-swiping");
    row.current?.removeAttribute("data-swipe-ready");
    press.current = undefined;
  };
  useEffect(() => () => clearTimeout(hold.current), []);
  return {
    onTouchStart: (e: React.TouchEvent<HTMLElement>) => {
      if (e.touches.length !== 1) return settle();
      const t = e.touches[0]!;
      row.current = e.currentTarget;
      held.current = false;
      press.current = { x: t.clientX, y: t.clientY, moved: "no", over: false };
      hold.current = setTimeout(() => {
        if (press.current?.moved !== "no" || !onHold) return;
        held.current = true;
        navigator.vibrate?.(10);
        ignoreTapOnLift();
        onHold();
      }, HOLD_MS);
    },
    onTouchMove: (e: React.TouchEvent<HTMLElement>) => {
      const p = press.current;
      if (!p) return;
      const t = e.touches[0]!;
      const dx = t.clientX - p.x;
      const dy = t.clientY - p.y;
      if (p.moved === "no") {
        if (Math.hypot(dx, dy) <= SLOP) return;
        clearTimeout(hold.current);
        p.moved = dx < 0 && Math.abs(dx) > Math.abs(dy) * 1.2 && onReply ? "swipe" : "scroll";
        if (p.moved === "swipe") row.current?.setAttribute("data-swiping", "");
      }
      if (p.moved !== "swipe") return;
      const pull = replyDrag(dx);
      row.current?.style.setProperty("--swipe", `${-pull}px`);
      const over = pull >= REPLY_AT;
      if (over !== p.over) {
        p.over = over;
        if (over) navigator.vibrate?.(8);
        row.current?.toggleAttribute("data-swipe-ready", over);
      }
    },
    onTouchEnd: (e: React.TouchEvent<HTMLElement>) => {
      const p = press.current;
      settle();
      if (held.current) return;
      if (p?.moved === "swipe") {
        if (p.over) onReply?.();
        return;
      }
      if (p?.moved !== "no" || !onDoubleTap || (e.target as Element).closest("button, a, input")) return;
      const now = Date.now();
      if (now - lastTap.current < 300) {
        lastTap.current = 0;
        onDoubleTap();
      } else lastTap.current = now;
    },
    onTouchCancel: settle,
  };
}

// ---------------------------------------------------------------- back, on phones

/** OpenBots screens stacked over its list, as the browser's history knows them. */
type BotsLayer = "chat" | "details";
const layerOf = (state: unknown) => (state as { botsLayer?: BotsLayer } | null)?.botsLayer;

/** Put a screen on the stack, so the browser's back (Safari's edge swipe, Android's button) takes it off again. */
function pushLayer(botsLayer: BotsLayer) {
  if (layerOf(history.state) === botsLayer) return;
  const depth = (history.state as { botsDepth?: number } | null)?.botsDepth ?? 0;
  history.pushState({ ...history.state, botsLayer, botsDepth: depth + 1 }, "", location.href);
}

/** Open a chat from the list on a phone: the list stays underneath, one step back. */
export function openBotsChat() {
  useStore.getState().setBotsSidebarOpen(false);
  if (isPhone()) pushLayer("chat");
}

/** Show a chat's details on a phone. */
export function openBotsDetails() {
  useBots.getState().setDetailsOpen(true);
  if (isPhone()) pushLayer("details");
}

/** One screen back: through the browser's history when that's how the screen arrived. */
export function closeBotsLayer(layer: BotsLayer) {
  if (layerOf(history.state) === layer) return history.back();
  if (layer === "details") useBots.getState().setDetailsOpen(false);
  else useStore.getState().setBotsSidebarOpen(true);
}

/** All the way back to the list, as when the chat that was open has just been deleted. */
export function backToBotsList() {
  const depth = (history.state as { botsDepth?: number } | null)?.botsDepth;
  if (depth) return history.go(-depth);
  useBots.getState().setDetailsOpen(false);
  useStore.getState().setBotsSidebarOpen(true);
}

/** The screens to show for wherever the browser just went back or forward to. */
function followLayer() {
  if (!useStore.getState().botsOpen || !isPhone()) return;
  const layer = layerOf(history.state);
  useBots.getState().setDetailsOpen(layer === "details");
  useStore.getState().setBotsSidebarOpen(!layer);
}

// ---------------------------------------------------------------- dragging panes

/** A finger this close to the left edge can pull a pane. */
const EDGE = 30;

/** Whether letting go here finishes the move rather than falling back: far enough, or thrown. */
export function dragCommits(distance: number, velocity: number, width: number) {
  return distance > width * 0.35 || (distance > 24 && velocity > 0.4);
}

interface Drag {
  /** The pane that follows the finger, and where it rests when the move hasn't happened or has. */
  pane: HTMLElement;
  from: number;
  to: number;
  /** The pane uncovered behind it, which drifts into place more slowly. */
  behind?: { el: HTMLElement; from: number; to: number };
  commit: () => void;
  width: number;
  startX: number;
  startY: number;
  /** Which way the finger has to go. */
  sign: 1 | -1;
  active: boolean;
  lastX: number;
  lastAt: number;
  velocity: number;
}

/** Which pane, if any, a finger coming down here could drag. */
function dragFor(x: number, y: number, target: Element): Drag | undefined {
  const st = useStore.getState();
  // Something's on top of the panes.
  if (st.settingsOpen || document.querySelector("dialog[open], .sheet-root, .popover-portal, .context-menu, .ar-root")) return;
  const width = window.innerWidth;
  const base = { width, startX: x, startY: y, active: false, lastX: x, lastAt: performance.now(), velocity: 0 };
  const edge = x <= EDGE;
  if (st.botsOpen) {
    if (st.botsSidebarOpen || !edge) return;
    const list = document.querySelector<HTMLElement>(".bots-sidebar");
    if (useBots.getState().detailsOpen) {
      const pane = document.querySelector<HTMLElement>(".bots-details");
      return pane ? { ...base, pane, from: 0, to: width, sign: 1, commit: () => closeBotsLayer("details") } : undefined;
    }
    const pane = document.querySelector<HTMLElement>(".main-bots");
    if (!pane) return;
    return { ...base, pane, from: 0, to: width, sign: 1, behind: list ? { el: list, from: -width * 0.28, to: 0 } : undefined, commit: () => closeBotsLayer("chat") };
  }
  const drawer = document.querySelector<HTMLElement>(".sidebar:not(.bots-sidebar)");
  if (!drawer) return;
  const drawerWidth = drawer.offsetWidth || width * 0.84;
  if (st.sidebarOpen) {
    // A closing drag can start anywhere on the drawer or the dimmed page beside it.
    if (!target.closest(".sidebar, .sidebar-scrim")) return;
    return { ...base, width: drawerWidth, pane: drawer, from: 0, to: -drawerWidth, sign: -1, commit: () => st.setSidebarOpen(false) };
  }
  if (!edge) return;
  return { ...base, width: drawerWidth, pane: drawer, from: -drawerWidth, to: 0, sign: 1, commit: () => st.setSidebarOpen(true) };
}

/** Listens on the document for the app's lifetime: drags that move panes, and back and forward through them. */
export function startPaneGestures() {
  let drag: Drag | undefined;
  const place = (d: Drag, progress: number) => {
    d.pane.style.transform = `translateX(${d.from + (d.to - d.from) * progress}px)`;
    d.pane.style.visibility = "visible";
    d.pane.style.opacity = "1";
    if (!d.behind) return;
    d.behind.el.style.transform = `translateX(${d.behind.from + (d.behind.to - d.behind.from) * progress}px)`;
    d.behind.el.style.visibility = "visible";
  };
  const release = (d: Drag) => {
    for (const el of [d.pane, d.behind?.el]) {
      if (!el) continue;
      el.style.removeProperty("transition");
      el.style.removeProperty("transform");
      el.style.removeProperty("visibility");
      el.style.removeProperty("opacity");
    }
  };
  const onStart = (e: TouchEvent) => {
    drag = undefined;
    if (e.touches.length !== 1 || !isPhone()) return;
    const t = e.touches[0]!;
    drag = dragFor(t.clientX, t.clientY, e.target as Element);
  };
  const onMove = (e: TouchEvent) => {
    const d = drag;
    if (!d) return;
    const t = e.touches[0]!;
    const dx = t.clientX - d.startX;
    const dy = t.clientY - d.startY;
    if (!d.active) {
      if (Math.hypot(dx, dy) < SLOP) return;
      // Not this gesture: a scroll, or a swipe the other way.
      if (Math.abs(dy) > Math.abs(dx) || Math.sign(dx) !== d.sign) {
        drag = undefined;
        return;
      }
      d.active = true;
      d.startX = t.clientX;
      d.pane.style.transition = "none";
      if (d.behind) d.behind.el.style.transition = "none";
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
    if (e.cancelable) e.preventDefault();
    const now = performance.now();
    if (now > d.lastAt) d.velocity = ((t.clientX - d.lastX) * d.sign) / (now - d.lastAt);
    d.lastX = t.clientX;
    d.lastAt = now;
    place(d, Math.min(1, Math.max(0, ((t.clientX - d.startX) * d.sign) / d.width)));
  };
  const onEnd = () => {
    const d = drag;
    drag = undefined;
    if (!d?.active) return;
    const distance = (d.lastX - d.startX) * d.sign;
    if (dragCommits(distance, d.velocity, d.width)) flushSync(d.commit);
    // With the inline position gone, the stylesheet's transition carries the pane on from where the finger left it.
    release(d);
  };
  document.addEventListener("touchstart", onStart, { passive: true });
  document.addEventListener("touchmove", onMove, { passive: false });
  document.addEventListener("touchend", onEnd);
  document.addEventListener("touchcancel", onEnd);
  window.addEventListener("popstate", followLayer);
  return () => {
    document.removeEventListener("touchstart", onStart);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onEnd);
    document.removeEventListener("touchcancel", onEnd);
    window.removeEventListener("popstate", followLayer);
  };
}
