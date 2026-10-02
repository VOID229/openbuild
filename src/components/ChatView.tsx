import { ArrowDown, Lightbulb, Zap } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { regenerate } from "../lib/chat";
import { fastTarget, findModel, isFastModel, qualityTarget } from "../lib/models";
import { useStore } from "../lib/store";
import type { Chat, ModelRef } from "../lib/types";
import { cx, usePresence } from "../lib/ui";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";

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

function ThinkButton({ chat }: { chat: Chat }) {
  const action = useThinkAction(chat);
  const shown = useRef(action);
  if (action) shown.current = action;
  const { mounted, visible } = usePresence(!!action, 180);
  const a = action ?? shown.current;
  if (!mounted || !a) return null;
  const last = chat.messages.at(-1)!;
  return (
    <div className="think-row" data-state={visible ? "open" : "closed"}>
      <button
        type="button"
        className="think-btn"
        data-tooltip={`${a.kind === "harder" ? "Resend to" : "Cancel and resend to"} ${a.targetName}`}
        data-tooltip-side="top"
        onClick={() => regenerate(chat.id, last.id, a.target)}
      >
        {a.kind === "harder" ? <Lightbulb size={16} /> : <Zap size={16} />}
        {a.kind === "harder" ? "think harder" : "think faster"}
      </button>
    </div>
  );
}

export function ChatView({ chat }: { chat: Chat }) {
  const autoScroll = useStore((s) => s.settings.autoScroll);
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const last = chat.messages.at(-1);
  const streaming = last?.status === "streaming";
  const userCount = chat.messages.filter((m) => m.role === "user").length;

  const toBottom = (behavior: ScrollBehavior = "auto") => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  };

  // Opening a chat starts at the latest message.
  useLayoutEffect(() => {
    stick.current = true;
    toBottom();
  }, [chat.id]);

  // A newly sent message always scrolls into view.
  const prevUsers = useRef(userCount);
  useEffect(() => {
    if (userCount > prevUsers.current) {
      stick.current = true;
      toBottom("smooth");
    }
    prevUsers.current = userCount;
  }, [userCount]);

  // Follow streaming output while pinned to the bottom (when auto scroll is enabled).
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (autoScroll && stick.current) toBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [autoScroll]);

  const onScroll = () => {
    const el = scroller.current!;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
    stick.current = bottom;
    setAtBottom(bottom);
  };

  return (
    <div className="chat">
      <div
        ref={scroller}
        className="messages"
        onScroll={onScroll}
        onWheel={(e) => {
          if (e.deltaY < 0) stick.current = false;
        }}
      >
        <div ref={inner} className="messages-inner">
          {chat.messages.map((m, i) => (
            <MessageItem key={m.id} message={m} chatId={chat.id} isLast={i === chat.messages.length - 1} />
          ))}
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
            toBottom("smooth");
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
