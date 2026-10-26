import { ArrowDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fold } from "../lib/search";
import { useStore } from "../lib/store";
import type { Chat } from "../lib/types";
import { cx } from "../lib/ui";
import { Composer } from "./Composer";
import { PluginSlot } from "../lib/plugins";
import { MessageItem } from "./MessageItem";

/** Highlight every occurrence of `words` inside `root` using the CSS Custom Highlight API. */
function highlightWords(root: HTMLElement, words: string[]) {
  const registry = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)?.highlights;
  if (!registry || typeof Highlight === "undefined" || !words.length) return;
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = fold(node.textContent ?? "");
    for (const w of words) {
      for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + w.length)) {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + w.length);
        ranges.push(r);
      }
    }
  }
  registry.set("search", new Highlight(...ranges));
  return () => void registry.delete("search");
}

/** Something the reader can see, and where it sits on screen: the first element at or below a line
 *  across the view, as deep as the elements straddling that line go (but not into a body folding
 *  shut, which is going away). With its path from its block of a Pi reply, to find its stand-in
 *  when the reply is redrawn folded. */
type Anchor = { el: Element; top: number; message?: string; block?: string; path: number[] };

/** Lines across the view, as fractions of its height, that anchors are taken at. */
const PROBES = [0, 0.25, 0.5, 0.75];

function findAnchor(scroller: HTMLElement, root: HTMLElement, probe: number): Anchor | undefined {
  const view = scroller.getBoundingClientRect();
  const edge = view.top + view.height * probe;
  let node: Element = root;
  for (;;) {
    const next = [...node.children].find((c) => {
      const r = c.getBoundingClientRect();
      return r.height > 0 && r.bottom > edge;
    });
    if (!next) break;
    node = next;
    if (next.getBoundingClientRect().top >= edge || (next as HTMLElement).dataset.fold === "closing") break;
  }
  if (node === root) return;
  const path: number[] = [];
  let block: Element | null = node;
  while (block && !block.hasAttribute("data-block") && block !== root) {
    path.unshift([...block.parentElement!.children].indexOf(block));
    block = block.parentElement;
  }
  const inBlock = block && block !== root;
  return {
    el: node,
    top: node.getBoundingClientRect().top - view.top,
    message: inBlock ? (block!.closest("[data-message-id]")?.getAttribute("data-message-id") ?? undefined) : undefined,
    block: inBlock ? block!.getAttribute("data-block")! : undefined,
    path: inBlock ? path : [],
  };
}

/** The anchor's element now: itself, or when its reply was redrawn, the same place in the new one. */
function resolveAnchor(a: Anchor, root: HTMLElement): Element | undefined {
  if (a.el.isConnected) return a.el;
  if (a.block === undefined) return;
  const msg = root.querySelector(`[data-message-id="${a.message}"]`);
  let node = msg?.querySelector(`[data-block="${a.block}"]`) ?? undefined;
  for (const i of a.path) {
    const child: Element | undefined = node?.children[i];
    if (!child) break;
    node = child;
  }
  return node;
}

/** Where the reader left each thread, to put them back there on returning: following the bottom, or
 *  the message at the top of the view and how far down it they were. A message rather than a scroll
 *  offset, so whatever was opened above it closing on the way back can't move them. */
type Place = { stick: true } | { stick: false; message: string; offset: number };
const places = new Map<string, Place>();

export function ChatView({ chat }: { chat: Chat }) {
  const autoScroll = useStore((s) => s.settings.autoScroll);
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  // Room kept below the thread so a fold shutting near the end doesn't drag the view down with it.
  const spacer = useRef<HTMLDivElement>(null);
  const slack = useRef(0);
  const anchors = useRef<Anchor[]>([]);
  // Attached: following the bottom. Any manual scroll up detaches; scrolling all the way down reattaches.
  const stick = useRef(true);
  const lastTop = useRef(0);
  // Where holding the view last put it, so its scroll event isn't taken for the reader's.
  const moved = useRef(-1);
  const glideFrame = useRef(0);
  const touchY = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  // Commands the user ran can come after a reply that's still going.
  const streaming = chat.messages.findLast((m) => m.role === "assistant")?.status === "streaming";
  const userCount = chat.messages.filter((m) => m.role !== "assistant").length;

  const gap = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop;

  const setSlack = (px: number) => {
    slack.current = px;
    if (spacer.current) spacer.current.style.height = px ? `${px}px` : "";
  };

  /** Take anchors where the reader is now. `keep`: the one just held, which stays first (aiming for
   *  the same spot, so rounding never adds up) while it's in view, so a fold doesn't hand the view
   *  over to whatever it uncovers above. */
  const capture = (keep?: Anchor) => {
    const el = scroller.current;
    const root = inner.current;
    if (!el || !root) return;
    const view = el.getBoundingClientRect();
    const r = keep?.el.getBoundingClientRect();
    const kept = keep && r && r.bottom > view.top && r.top < view.bottom ? [keep] : [];
    const found = [...kept, ...PROBES.map((y) => findAnchor(el, root, y)).filter((a): a is Anchor => !!a)];
    anchors.current = found.filter((a, i) => found.findIndex((b) => b.el === a.el) === i);
  };

  /** Following new output at the bottom; otherwise the view is held still. */
  const following = () => autoScroll && stick.current;

  const detach = () => {
    if (following()) capture();
    stick.current = false;
    cancelAnimationFrame(glideFrame.current);
  };

  // The reader scrolled by `delta`. Mid-fold, the anchors just move with the view: measuring now
  // would read this frame's fold before holding has corrected for it.
  const scrolled = (delta: number) => {
    if (!scroller.current?.querySelector("[data-fold]")) return capture();
    for (const a of anchors.current) a.top -= delta;
  };

  // While not following the bottom, nothing but the reader moves the view: when something folds or
  // unfolds (or anything else changes size), put what they were looking at back where it was.
  // Held by the first thing in view that's staying; if all of it is folding away, by where that starts.
  const hold = () => {
    const el = scroller.current;
    const root = inner.current;
    if (!el || !root) return;
    const live = anchors.current.map((a) => ({ a, now: resolveAnchor(a, root) })).filter((x): x is { a: Anchor; now: Element } => !!x.now);
    const held = live.find((x) => !x.now.closest('[data-fold="closing"]')) ?? live[0];
    if (held) {
      const shift = held.now.getBoundingClientRect().top - el.getBoundingClientRect().top - held.a.top;
      if (Math.abs(shift) >= 0.5) {
        const top = el.scrollTop + shift;
        // Content shrinking away below can't pull the view down: hold the room it took.
        const content = el.scrollHeight - slack.current;
        setSlack(Math.max(0, Math.ceil(top + el.clientHeight - content)));
        el.scrollTop = top;
        lastTop.current = el.scrollTop;
        moved.current = el.scrollTop;
      }
    }
    capture(held && { ...held.a, el: held.now });
  };

  // Room no longer on screen goes, so it can't be scrolled into.
  const trimSlack = (el: HTMLElement) => {
    if (!slack.current) return;
    const content = el.scrollHeight - slack.current;
    setSlack(Math.max(0, Math.min(slack.current, Math.ceil(el.scrollTop + el.clientHeight - content))));
  };

  // Ease toward the bottom a frame at a time, retargeting as output grows; stops the moment we detach.
  const glide = () => {
    cancelAnimationFrame(glideFrame.current);
    const step = () => {
      const el = scroller.current;
      if (!el || !stick.current) return;
      const g = gap(el);
      if (g <= 1) return;
      const before = el.scrollTop;
      el.scrollTop += Math.max(1, Math.ceil(g * 0.2));
      if (el.scrollTop > before) glideFrame.current = requestAnimationFrame(step);
    };
    glideFrame.current = requestAnimationFrame(step);
  };

  useEffect(() => () => cancelAnimationFrame(glideFrame.current), []);

  const remember = () => {
    const el = scroller.current;
    const root = inner.current;
    if (!el || !root) return;
    if (following() || gap(el) <= 2) return void places.set(chat.id, { stick: true });
    const top = el.getBoundingClientRect().top;
    const msg = [...root.querySelectorAll(":scope > [data-message-id]")].find((m) => m.getBoundingClientRect().bottom > top);
    if (!msg) return;
    places.set(chat.id, { stick: false, message: msg.getAttribute("data-message-id")!, offset: top - msg.getBoundingClientRect().top });
  };

  // Opening a chat starts where the reader left it, or at the latest message.
  useLayoutEffect(() => {
    cancelAnimationFrame(glideFrame.current);
    stick.current = true;
    setSlack(0);
    const el = scroller.current;
    if (!el) return;
    const place = places.get(chat.id);
    const msg = place && !place.stick ? inner.current?.querySelector<HTMLElement>(`[data-message-id="${place.message}"]`) : null;
    if (place && !place.stick && msg) {
      stick.current = false;
      const offset = Math.min(place.offset, msg.offsetHeight);
      el.scrollTop = msg.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop + offset;
      moved.current = el.scrollTop;
      capture();
      setAtBottom(gap(el) < 72);
    } else el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, [chat.id]);

  // Opened from a search result: bring the matching message into view and highlight the matched words.
  const searchFocus = useStore((s) => (s.searchFocus?.chatId === chat.id ? s.searchFocus : undefined));
  useEffect(() => {
    if (!searchFocus) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-message-id="${searchFocus.messageId}"]`);
    if (!el) return;
    detach();
    el.scrollIntoView({ block: "center" });
    el.classList.remove("msg-flash");
    void el.offsetWidth;
    el.classList.add("msg-flash");
    return highlightWords(scroller.current!, searchFocus.words);
  }, [searchFocus]);

  // With auto scroll on, sending a message reattaches and brings it into view.
  const prevUsers = useRef(userCount);
  useEffect(() => {
    if (autoScroll && userCount > prevUsers.current) {
      stick.current = true;
      setSlack(0);
      glide();
    }
    prevUsers.current = userCount;
  }, [userCount]);

  // Follow output while attached (only when auto scroll is enabled); otherwise hold the view still.
  // Runs after layout and before paint, so a held view never visibly jumps.
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const view = scroller.current;
      if (!view) return;
      // New output fills the room first.
      trimSlack(view);
      if (!following()) hold();
      else if (view.querySelector("[data-fold]")) {
        // A fold moving (a finished reply folding its work) keeps the bottom pinned exactly, before
        // it paints, rather than gliding a frame behind.
        cancelAnimationFrame(glideFrame.current);
        view.scrollTop = view.scrollHeight;
        lastTop.current = view.scrollTop;
      } else glide();
    });
    ro.observe(el);
    // The view itself changing size is the screen, not the thread: a phone's keyboard taking the
    // bottom half, or the composer growing under a long draft. Following readers go to the new
    // bottom straight away, a frame behind the keyboard at most, instead of gliding after it.
    const screen = new ResizeObserver(() => {
      const view = scroller.current;
      if (!view || !following()) return;
      cancelAnimationFrame(glideFrame.current);
      view.scrollTop = view.scrollHeight;
      lastTop.current = view.scrollTop;
    });
    screen.observe(el.parentElement!);
    return () => {
      ro.disconnect();
      screen.disconnect();
    };
  }, [autoScroll]);

  const onScroll = () => {
    const el = scroller.current!;
    const g = gap(el);
    // Holding the view still moved it, not the reader: it can land on the bottom without them going there.
    const ours = Math.abs(el.scrollTop - moved.current) < 1;
    moved.current = -1;
    const delta = el.scrollTop - lastTop.current;
    lastTop.current = el.scrollTop;
    const wasFollowing = following();
    // Our own scrolling only ever moves down, and content shrinking clamps us to the bottom,
    // so moving up while short of the bottom means the user scrolled (scrollbar, keys, wheel, touch).
    if (g <= 2 && !ours) stick.current = true;
    else if (delta < 0) detach();
    if (!ours && !wasFollowing && !following()) scrolled(delta);
    trimSlack(el);
    setAtBottom(g < 72 || (autoScroll && stick.current));
    remember();
  };

  return (
    <div className="chat">
      <PluginSlot name="chat:header" context={{ chat }} />
      <div
        ref={scroller}
        className="messages"
        onScroll={onScroll}
        // Opening or closing anything is reading, not new output: the view stays put. Detach before
        // the disclosure changes layout so neither a pending glide nor the ResizeObserver can pull
        // the reader to the bottom (including keyboard-generated clicks).
        onClickCapture={(e) => {
          if ((e.target as Element).closest("[aria-expanded]:not([aria-haspopup])")) detach();
        }}
        // Detach on intent, before the browser's own smooth scroll starts, so following never fights it.
        onWheel={(e) => {
          if (e.deltaY < 0) detach();
        }}
        onTouchStart={(e) => {
          touchY.current = e.touches[0]!.clientY;
        }}
        onTouchMove={(e) => {
          const y = e.touches[0]!.clientY;
          if (y > touchY.current) detach();
          touchY.current = y;
        }}
        onKeyDown={(e) => {
          if (["ArrowUp", "PageUp", "Home"].includes(e.key) || (e.key === " " && e.shiftKey)) detach();
        }}
      >
        <div ref={inner} className="messages-inner">
          <PluginSlot name="chat:before-messages" context={{ chat }} />
          {chat.messages.map((m, i) => (
            <MessageItem key={m.id} message={m} chatId={chat.id} isLast={i === chat.messages.length - 1} />
          ))}
        </div>
        <div ref={spacer} aria-hidden />
      </div>
      <div className="dock">
        <button
          type="button"
          className={cx("scroll-down", !atBottom && "scroll-down-visible")}
          aria-label="Scroll to latest"
          tabIndex={atBottom ? -1 : 0}
          onClick={() => {
            stick.current = true;
            setSlack(0);
            glide();
          }}
        >
          <ArrowDown size={16} />
        </button>
        <Composer variant="dock" chatId={chat.id} streaming={streaming} />
      </div>
    </div>
  );
}
