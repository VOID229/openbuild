import { ArrowDown, ArrowUpRight, GitFork, Lightbulb, Zap } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { regenerate } from "../lib/chat";
import { chatDepth, ordinal } from "../lib/forks";
import { fold } from "../lib/search";
import { fastTarget, findModel, isFastModel, qualityTarget } from "../lib/models";
import { useStore } from "../lib/store";
import type { Chat, ModelRef } from "../lib/types";
import { cx, usePresence } from "../lib/ui";
import { Composer } from "./Composer";
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

type ThinkAction = { kind: "harder" | "faster"; target: ModelRef; targetName: string };

/**
 * Think harder: after a fast model finishes, resend the turn to a higher-quality model.
 * Think faster: while a higher-quality model is working, cancel and resend to a fast model.
 */
function useThinkAction(chat: Chat): ThinkAction | undefined {
  const detection = useStore((s) => s.detection);
  const settings = useStore((s) => s.settings);
  const last = chat.messages.at(-1);
  if (!last || last.role !== "assistant" || !last.model) return;
  const fast = isFastModel(last.model, settings);
  const streaming = last.status === "streaming";
  let kind: ThinkAction["kind"] | undefined;
  if (streaming && !fast) kind = "faster";
  else if (!streaming && fast && last.status !== "error" && last.content.trim()) kind = "harder";
  if (!kind) return;
  const target = kind === "faster" ? fastTarget(detection, settings, last.model.plan) : qualityTarget(detection, settings, last.model.plan);
  if (!target || (target.id === last.model.id && target.plan === last.model.plan)) return;
  return { kind, target, targetName: findModel(detection, target)?.name ?? target.id };
}

/** Dock row above the composer: think harder / think faster. */
function ThinkButton({ chat }: { chat: Chat }) {
  const action = useThinkAction(chat);
  const last = chat.messages.at(-1);
  const shown = useRef(action);
  if (action) shown.current = action;
  const { mounted, visible } = usePresence(!!action, 180);
  // Keep the think button's content while it fades out.
  const a = action ?? shown.current;
  if (!mounted) return null;
  return (
    <div className="think-row" data-state={visible ? "open" : "closed"}>
      {a && (
        <button
          type="button"
          className="think-btn"
          data-tooltip={`${a.kind === "harder" ? "Resend to" : "Cancel and resend to"} ${a.targetName}`}
          data-tooltip-side="top"
          onClick={() => regenerate(chat.id, last!.id, a.target)}
        >
          {a.kind === "harder" ? <Lightbulb size={16} /> : <Zap size={16} />}
          {a.kind === "harder" ? "think harder" : "think faster"}
        </button>
      )}
    </div>
  );
}

/** Shown on "2nd" chats: links back to the original chat and the reply that was re-answered. */
function ForkBanner({ chat }: { chat: Chat }) {
  const original = useStore((s) => s.chats.find((c) => c.id === chat.forkOf));
  const { selectChat } = useStore.getState();
  const depth = chatDepth(chat);
  return (
    <div className="fork-banner">
      <span className="badge badge-second">{ordinal(depth)}</span>
      {original ? (
        <>
          <span>{depth === 2 ? "Second opinion of" : `${ordinal(depth)} opinion of`}</span>
          <button
            type="button"
            className="fork-link"
            data-tooltip="Open the original chat at the forked reply"
            data-tooltip-side="bottom"
            onClick={() => selectChat(original.id)}
          >
            <GitFork size={13} />
            <span>{original.title}</span>
            <ArrowUpRight size={13} />
          </button>
        </>
      ) : (
        <span>Second opinion of a chat that was deleted</span>
      )}
    </div>
  );
}

export function ChatView({ chat }: { chat: Chat }) {
  const autoScroll = useStore((s) => s.settings.autoScroll);
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  // Attached: following the bottom. Any manual scroll up detaches; scrolling all the way down reattaches.
  const stick = useRef(true);
  const lastTop = useRef(0);
  const glideFrame = useRef(0);
  const touchY = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const last = chat.messages.at(-1);
  const streaming = last?.status === "streaming";
  const userCount = chat.messages.filter((m) => m.role === "user").length;

  const gap = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop;

  const detach = () => {
    stick.current = false;
    cancelAnimationFrame(glideFrame.current);
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

  // Opening a chat starts at the latest message.
  useLayoutEffect(() => {
    cancelAnimationFrame(glideFrame.current);
    stick.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    lastTop.current = el?.scrollTop ?? 0;
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
      glide();
    }
    prevUsers.current = userCount;
  }, [userCount]);

  // Follow output while attached (only when auto scroll is enabled).
  useEffect(() => {
    const el = inner.current;
    if (!el || !autoScroll) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) glide();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [autoScroll]);

  const onScroll = () => {
    const el = scroller.current!;
    const g = gap(el);
    // Our own scrolling only ever moves down, and content shrinking clamps us to the bottom,
    // so moving up while short of the bottom means the user scrolled (scrollbar, keys, wheel, touch).
    if (g <= 2) stick.current = true;
    else if (el.scrollTop < lastTop.current) detach();
    lastTop.current = el.scrollTop;
    setAtBottom(g < 72 || (autoScroll && stick.current));
  };

  return (
    <div className="chat">
      <div
        ref={scroller}
        className="messages"
        onScroll={onScroll}
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
          {chat.forkOf && <ForkBanner chat={chat} />}
          {chat.messages.map((m, i) => {
            const next = chat.messages[i + 1];
            const pending = m.role === "user" && next?.role === "assistant" && next.status === "streaming" && i + 2 === chat.messages.length;
            return <MessageItem key={m.id} message={m} chatId={chat.id} isLast={i === chat.messages.length - 1} streamingReplyId={pending ? next.id : undefined} />;
          })}
        </div>
      </div>
      <div className="dock">
        <button
          type="button"
          className={cx("scroll-down", !atBottom && "scroll-down-visible")}
          aria-label="Scroll to latest"
          tabIndex={atBottom ? -1 : 0}
          onClick={() => {
            stick.current = true;
            glide();
          }}
        >
          <ArrowDown size={16} />
        </button>
        <ThinkButton chat={chat} />
        <Composer variant="dock" chatId={chat.id} streaming={streaming} />
      </div>
    </div>
  );
}
