// Dragging chats around OpenBots' sidebar with a mouse or pen: above or below another (a line shows
// where), onto a pinned tile (the two swap), onto a group (add the bot to it, or swap, as Settings →
// Bots says or the small menu that asks), or onto a section's heading (first in it). A press that
// doesn't move is still a click, and one that dragged never is. Touch keeps its scrolling and press
// and hold; the chat's menu and Alt+arrow keys move chats there instead.
//
// Nothing moves until the drop: the lines and rings are drawn on the chats where they are, and the
// list is re-rendered in its new order only once it's dropped. So the page's order, which ⌥1–9
// numbers (switchKeys.tsx), is always what's on the screen.
import { ArrowLeftRight, UsersRound } from "lucide-react";
import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BotGroupDrop } from "../../lib/types";
import type { Conversation } from "../../lib/bots/types";
import type { ListKey } from "../../lib/bots/sidebarOrder";
import { conversationName, useBots } from "../../lib/bots/store";
import { arrowNav, useDismiss, usePresence } from "../../lib/ui";
import { ConversationAvatar } from "./common";

/** Where the pointer is: against a chat (`onto` only for a tile, or a group the dragged bot can join), or a section's heading. */
export type Hit = { id: string; place: "before" | "after" | "onto" } | { list: ListKey };

interface Options {
  list: React.RefObject<HTMLElement | null>;
  enabled: boolean;
  /** Whether this chat can be picked up (it's in a list chats are moved in). */
  canDrag: (id: string) => boolean;
  /** Whether a drop of `dragId` on `id` could add a bot to a group, which gives a row a middle to drop onto. */
  joinable: (dragId: string, id: string) => boolean;
  /** Whether dropping there would do anything, so only those show where it goes. */
  valid: (dragId: string, hit: Hit) => boolean;
  onStart: () => void;
  onDrop: (dragId: string, hit: Hit, at: { x: number; y: number }) => void;
}

/** How far a press moves before it's a drag and not a click. */
const SLOP = 5;
/** How near the list's ends the pointer scrolls it. */
const EDGE = 40;

let active = false;
/** A chat is being dragged (hover cards wait until it's dropped). */
export const isDragging = () => active;

/** Which part of a tile or row the pointer is over, as a drop. */
function hitOn(el: HTMLElement, x: number, y: number, joinable: boolean): Hit {
  const id = el.dataset.dragId!;
  const r = el.getBoundingClientRect();
  if (el.dataset.dragKind === "tile") {
    const f = (x - r.left) / r.width;
    return { id, place: f < 0.3 ? "before" : f > 0.7 ? "after" : "onto" };
  }
  const f = (y - r.top) / r.height;
  if (joinable) return { id, place: f < 0.25 ? "before" : f > 0.75 ? "after" : "onto" };
  return { id, place: f < 0.5 ? "before" : "after" };
}

export function useSidebarDrag(options: Options) {
  const opts = useRef(options);
  opts.current = options;
  const [dragging, setDragging] = useState<string>();
  const ghost = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const { list, enabled } = options;
  // Where the pointer already is, as soon as it shows.
  useLayoutEffect(() => {
    if (dragging && ghost.current) ghost.current.style.transform = `translate(${pointer.current.x + 14}px, ${pointer.current.y + 10}px)`;
  }, [dragging]);

  useEffect(() => {
    const nav = list.current;
    if (!nav || !enabled) return;
    let press: { id: string; el: HTMLElement; x: number; y: number; pointer: number } | undefined;
    let started = false;
    let point = { x: 0, y: 0 };
    let shown: { el: HTMLElement; hit: Hit } | undefined;
    let frame = 0;

    const mark = (next?: { el: HTMLElement; hit: Hit }) => {
      const place = next && ("list" in next.hit ? "into" : next.hit.place);
      if (shown && (shown.el !== next?.el || shown.el.dataset.drop !== place)) delete shown.el.dataset.drop;
      if (next) next.el.dataset.drop = place;
      shown = next;
    };
    const locate = () => {
      if (!press) return;
      const { x, y } = point;
      const at = document.elementFromPoint(x, y);
      let next: { el: HTMLElement; hit: Hit } | undefined;
      if (at && nav.contains(at)) {
        const item = at.closest<HTMLElement>("[data-drag-id]");
        const section = at.closest<HTMLElement>("[data-drop-list]");
        if (item) next = { el: item, hit: hitOn(item, x, y, opts.current.joinable(press.id, item.dataset.dragId!)) };
        // A section takes a drop on its heading, or anywhere in it while it has no chats.
        else if (section && (at.closest(".history-heading") || !section.querySelector("[data-drag-id]"))) next = { el: section, hit: { list: section.dataset.dropList as ListKey } };
      }
      mark(next && opts.current.valid(press.id, next.hit) ? next : undefined);
    };
    const place = () => {
      pointer.current = point;
      if (ghost.current) ghost.current.style.transform = `translate(${point.x + 14}px, ${point.y + 10}px)`;
    };
    // Held near an end of the list, it scrolls that way, faster the nearer.
    const scroll = () => {
      const r = nav.getBoundingClientRect();
      const dy = point.y < r.top + EDGE ? -(r.top + EDGE - point.y) : point.y > r.bottom - EDGE ? point.y - (r.bottom - EDGE) : 0;
      if (dy) {
        const before = nav.scrollTop;
        nav.scrollTop += Math.max(-14, Math.min(14, Math.round(dy / 3)));
        if (nav.scrollTop !== before) locate();
      }
      frame = requestAnimationFrame(scroll);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      cancelAnimationFrame(frame);
      if (started) {
        if (press?.el.isConnected) delete press.el.dataset.dragging;
        mark(undefined);
        document.documentElement.classList.remove("bots-drag-active");
        try {
          nav.releasePointerCapture(press!.pointer);
        } catch {}
        active = false;
        setDragging(undefined);
        // The press ends in a click on what was picked up: that's not a click.
        const swallow = (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      }
      press = undefined;
      started = false;
    };
    const begin = () => {
      started = true;
      active = true;
      press!.el.dataset.dragging = "";
      document.documentElement.classList.add("bots-drag-active");
      window.getSelection()?.removeAllRanges();
      try {
        nav.setPointerCapture(press!.pointer);
      } catch {}
      opts.current.onStart();
      setDragging(press!.id);
      frame = requestAnimationFrame(scroll);
    };
    const move = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.pointer) return;
      // The button came up somewhere this didn't hear of.
      if (!e.buttons) return cancel();
      point = { x: e.clientX, y: e.clientY };
      if (!started) {
        if (Math.hypot(point.x - press.x, point.y - press.y) < SLOP) return;
        begin();
      }
      e.preventDefault();
      place();
      locate();
    };
    const up = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.pointer) return;
      const drop = started && shown ? { id: press.id, hit: shown.hit } : undefined;
      point = { x: e.clientX, y: e.clientY };
      stop();
      if (drop) opts.current.onDrop(drop.id, drop.hit, point);
    };
    const cancel = () => stop();
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !started) return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    const down = (e: PointerEvent) => {
      if (press || e.button !== 0 || e.pointerType === "touch" || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const el = (e.target as Element).closest<HTMLElement>("[data-drag-id]");
      if (!el || !nav.contains(el) || !opts.current.canDrag(el.dataset.dragId!)) return;
      press = { id: el.dataset.dragId!, el, x: e.clientX, y: e.clientY, pointer: e.pointerId };
      point = { x: e.clientX, y: e.clientY };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", key, true);
    };
    // The browser's own drag (of an image, a selection) would take the pointer away.
    const native = (e: DragEvent) => e.preventDefault();
    nav.addEventListener("pointerdown", down);
    nav.addEventListener("dragstart", native);
    return () => {
      nav.removeEventListener("pointerdown", down);
      nav.removeEventListener("dragstart", native);
      cancel();
    };
  }, [list, enabled]);

  return { dragging, ghost };
}

/** What follows the pointer while a chat is dragged: its avatar and name, small. */
export const DragGhost = forwardRef<HTMLDivElement, { id?: string }>(function DragGhost({ id }, ref) {
  const conversation = useBots((s) => s.conversations.find((c) => c.id === id));
  const bots = useBots((s) => s.bots);
  if (!id || !conversation) return null;
  return createPortal(
    // Drawn afresh, not cloned, and outside the sidebar: nothing in it is a chat ⌥1–9 counts (switchKeys.tsx) or a place to drop.
    <div ref={ref} className="bots-drag-ghost" aria-hidden inert>
      <ConversationAvatar conversation={conversation} size={20} still badge={false} lineup />
      <span className="bots-drag-ghost-name">{conversationName(conversation, bots).split(" · ")[0]}</span>
    </div>,
    document.body,
  );
});

export interface GroupDropState {
  /** The bot's own chat, dropped. */
  id: string;
  groupId: string;
  x: number;
  y: number;
}

/** Asked when a bot is dropped on a group: add it to the group, or swap their places. Either can be remembered. */
export function GroupDropMenu({ state, canSwap, onClose, onPick }: { state?: GroupDropState; canSwap: boolean; onClose: () => void; onPick: (choice: Exclude<BotGroupDrop, "ask">, remember: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef(state);
  if (state) last.current = state;
  const current = last.current;
  const drag = useBots((s) => s.conversations.find((c) => c.id === current?.id));
  const group = useBots((s) => s.conversations.find((c) => c.id === current?.groupId));
  const bots = useBots((s) => s.bots);
  const open = !!state;
  const { mounted, visible } = usePresence(open, 180);
  const [pos, setPos] = useState<{ left: number; top: number }>();
  const [remember, setRemember] = useState(false);
  useDismiss(open, onClose, [ref]);

  useLayoutEffect(() => {
    if (!open || !mounted || !state) return;
    setRemember(false);
    const el = ref.current;
    const w = el?.offsetWidth ?? 240;
    const h = el?.offsetHeight ?? 150;
    setPos({ left: Math.max(8, Math.min(state.x, window.innerWidth - w - 8)), top: Math.max(8, Math.min(state.y, window.innerHeight - h - 8)) });
    el?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, [open, mounted, state]);

  if (!mounted || !drag || !group) return null;
  const name = (c: Conversation) => conversationName(c, bots).split(" · ")[0];
  const pick = (choice: Exclude<BotGroupDrop, "ask">) => () => onPick(choice, remember);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Drop ${name(drag)} on ${name(group)}`}
      className="popover menu context-menu bots-menu bots-drop-menu"
      data-state={visible && pos ? "open" : "closed"}
      style={{ position: "fixed", left: pos?.left ?? state?.x, top: pos?.top ?? state?.y, transformOrigin: "top left" }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          return onClose();
        }
        arrowNav(e, "button:not(:disabled), input");
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button type="button" role="menuitem" className="menu-item" onClick={pick("add")}>
        <UsersRound size={15} />
        <span className="menu-item-label">
          Add {name(drag)} to {name(group)}
        </span>
      </button>
      <button type="button" role="menuitem" className="menu-item" disabled={!canSwap} onClick={pick("swap")}>
        <ArrowLeftRight size={15} />
        <span className="menu-item-label">Swap places</span>
      </button>
      <div className="menu-sep" />
      <label className="confirm-skip bots-drop-remember">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember my choice
      </label>
    </div>
  );
}
