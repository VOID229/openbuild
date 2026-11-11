import { historyAtHand, loadChatHistory, prefetchHistory } from "../lib/db";
import { isHosted } from "../lib/runtime";
import { AlarmClock, AlarmClockCheck, ArrowLeft, BatteryWarning, Bot, CalendarDays, ChartNoAxesColumn, Check, ChevronDown, ChevronRight, Clock, ClockArrowUp, Copy, Ellipsis, FileText, Fingerprint, GitBranch, ExternalLink, FolderX, Layers, Minus, MessageCircle, Pencil, Pin, PinOff, Plus, RefreshCw, RotateCcw, Search, SquareArrowUp, SquareCheck, SquarePen, Trash, X } from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { adoptHistory, stopGeneration } from "../lib/chat";
import { regenerateTitle, threadTranscript } from "../lib/naming";
import { harnessSession, removeWorktree } from "../lib/pi";
import { runtimeName } from "../lib/runtimes";
import { threadPath } from "../lib/routes";
import { mergeRanges, searchChats, type Range, type SearchHit } from "../lib/search";
import { DEFAULT_VIEW, useStore } from "../lib/store";
import { OPEN_SEARCH } from "../lib/ui";
import { useScrollRestore } from "../lib/scrollRestore";
import { PullRequestBadge } from "./PullRequestBadge";
import { usePanel } from "../lib/panel";
import { refreshTerminal } from "../lib/terminal";
import { prefetchUsage } from "../lib/usageStats";
import type { Chat } from "../lib/types";
import type { Device } from "../../shared/types";
import { limitReason } from "../../shared/usage";
import { EXTERNAL_VIA } from "../../shared/replies";
import { useLongPress } from "../lib/gestures";
import { arrowNav, canHover, copyText, crossfade, cx, useDismiss, useMediaQuery, usePresence } from "../lib/ui";
import { Avatar, BrandIcon, GrokMark, HermesMark, OpencodeMark, ClaudeMark, CodexMark, DurableMark, FxMark, IconButton, PiMark, Popover, CursorMark, Spinner } from "./primitives";
import { PluginSlot } from "../lib/plugins";
import { FilterIcon, PanelIcon, SearchIcon } from "./HeaderIcons";
import { ChoiceField, DateField, TimeField } from "./DateTimeFields";
import { BotsGlyph } from "./bots/BotAvatar";
import { clock } from "../lib/clock";

// Flip a submenu to open upward when it would run off the bottom of the window and there's more room above.
function fitFlyout(el: HTMLElement | null) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const row = el.parentElement!.getBoundingClientRect();
  if (rect.bottom > window.innerHeight - 8 && row.bottom - rect.height >= 8) el.classList.add("filter-flyout-up");
}

/** The model of the chat's latest reply. */
const modelOf = (chat: Chat) => chat.messages.findLast((m) => m.role === "assistant" && m.model)?.model;

/** The chat's latest reply (commands the user ran may come after it). */
const lastReply = (chat: Chat) => chat.messages.findLast((m) => m.role === "assistant");

/** A chat whose latest reply is still being generated. */
const isWorking = (chat: Chat) => lastReply(chat)?.status === "streaming";

/** Working, but blocked on a question from an extension: not generating, not done. */
const isWaiting = (chat: Chat) => {
  const last = lastReply(chat);
  return last?.status === "streaming" && !!last.parts?.some((p) => p.type === "ask" && p.answer === undefined);
};

/** Why the chat's latest reply was cut off by a usage limit or an empty balance, if it was. */
const limitOf = (chat: Chat) => {
  const last = lastReply(chat);
  return last?.status === "error" ? limitReason(last.error) : undefined;
};

/** Midnight at the start of today. */
const startOfToday = () => new Date().setHours(0, 0, 0, 0);

/**
 * Closed by the user, or a thread that isn't pinned, working, done or woken. A subagent thread or one
 * cut off by a usage limit keeps its own section until the day is over.
 */
const isClosed = (chat: Chat, today = startOfToday()) =>
  !!chat.archived ||
  (!chat.pinned && !chat.done && !chat.woke && !isWorking(chat) && (chat.updatedAt < today || (!chat.subagent && !limitOf(chat))));

/** Closing a thread files it under "Closed" (and unpins it); reopening one puts it back in "Done". */
const closePatch = (chat: Chat, today?: number) =>
  isClosed(chat, today)
    // Reopening a thread its merge closed keeps it open: the merge won't close it again.
    ? { archived: false, done: true, closedAt: undefined, ...(chat.autoClosedAt ? { autoClosedAt: undefined, autoCloseOptOut: true } : {}) }
    // The server removes its worktree a day from now, if the user has that on (server/closedWorktrees.ts).
    : { archived: true, done: false, woke: false, snoozedUntil: undefined, pinned: false, closedAt: Date.now() };

/** Snoozing hides a thread under "Snoozed"; waking it by hand puts it back where it was. */
const snoozePatch = (until: number) => ({ snoozedUntil: until, woke: false });
const wakePatch = { snoozedUntil: undefined };
/** A snooze that runs out on its own surfaces the thread under "Woke", even if it was closed. */
const wokePatch = { snoozedUntil: undefined, woke: true, archived: false };


/** When a snooze ends, as briefly as it reads: "18:00" today, "Mon 9:00" this week, else "Nov 3, 9:00". */
function snoozeLabel(t: number) {
  const day = new Date(t).setHours(0, 0, 0, 0);
  const today = startOfToday();
  if (day === today) return clock(t);
  if (day - today < 7 * DAY) return `${new Date(t).toLocaleDateString([], { weekday: "short" })} ${clock(t)}`;
  return `${new Date(t).toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock(t)}`;
}

/** The snooze menu's presets, each with the time it ends. */
function snoozeOptions(now = new Date()) {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    return d.setHours(hour, 0, 0, 0);
  };
  const options = [
    { label: "In 1 hour", until: now.getTime() + 60 * 60 * 1000 },
    { label: "In 3 hours", until: now.getTime() + 3 * 60 * 60 * 1000 },
  ].map((o) => ({ ...o, hint: clock(o.until) }));
  if (now.getHours() < 18) options.push({ label: "This evening", until: at(0, 18), hint: clock(at(0, 18)) });
  options.push({ label: "Tomorrow", until: at(1, 9), hint: clock(at(1, 9)) });
  const monday = at((8 - now.getDay()) % 7 || 7, 9);
  options.push({ label: "Next week", until: monday, hint: `${new Date(monday).toLocaleDateString([], { weekday: "short" })} ${clock(monday)}` });
  return options;
}

/** Start of today, refreshed at midnight so the day's subagent and limited threads roll over into "Closed". */
function useToday() {
  const [today, setToday] = useState(startOfToday);
  useEffect(() => {
    const timer = setTimeout(() => setToday(startOfToday()), today + DAY - Date.now() + 1000);
    return () => clearTimeout(timer);
  }, [today]);
  return today;
}

const DAY = 24 * 60 * 60 * 1000;

const chatUrl = threadPath;

/** The thread as one Markdown document: its title, then each message under its author. */
function chatMarkdown(chat: Chat) {
  const fence = (text: string, lang = "") => {
    const ticks = "`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((t) => t.length + 1)));
    return `${ticks}${lang}\n${text.replace(/\n+$/, "")}\n${ticks}`;
  };
  const blocks = [`# ${chat.title}`];
  for (const m of chat.messages) {
    if (m.role === "shell" && m.shell) blocks.push(`## Shell\n\n${fence(`$ ${m.shell.command}${m.shell.output ? `\n${m.shell.output}` : ""}`, "sh")}`);
    else if (m.content.trim()) blocks.push(`## ${m.role === "user" ? "User" : (m.model?.name ?? "Assistant")}\n\n${m.content.trim()}`);
  }
  return blocks.join("\n\n") + "\n";
}

function Highlight({ text, ranges }: { text: string; ranges: Range[] }) {
  if (!ranges.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  mergeRanges(ranges).forEach((r, i) => {
    if (r.start > at) parts.push(text.slice(at, r.start));
    parts.push(<mark key={i}>{text.slice(r.start, r.end)}</mark>);
    at = r.end;
  });
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * The open thread's pull request in the side panel's pull requests tab. The panel follows the thread
 * (refreshTerminal), so it's moved to the thread just opened first, or the tab would open on the last
 * one's folder.
 */
function showPullRequest(number: number) {
  refreshTerminal();
  usePanel.getState().openPulls(number);
}

interface RowProps {
  chat: Chat;
  active: boolean;
  hit?: SearchHit;
  renaming: boolean;
  regenerating: boolean;
  /** `then`: what to do once the thread is open, as showing its pull request. */
  onSelect: (chat: Chat, hit?: SearchHit, then?: () => void) => void;
  onMenu: (chatId: string, x: number, y: number, fromButton?: boolean, snooze?: boolean) => void;
  onRenameDone: () => void;
}

/**
 * The device a row names: a paired device always, this one only once others are paired (otherwise
 * every row would say the same thing). Undefined: no label.
 */
function rowDevice(devices: Device[], deviceId: string | undefined): string | undefined {
  if (deviceId) return devices.find((d) => d.id === deviceId)?.name ?? "unpaired device";
  if (!devices.some((d) => !d.local)) return undefined;
  return devices.find((d) => d.local)?.name;
}

const GENERATING_TITLE = "Generating title";

/** A thread's title; the one a model just wrote wipes in over the placeholder it replaces. */
function RowTitle({ title, titling }: { title: string; titling: boolean }) {
  const [wasTitling, setWasTitling] = useState(titling);
  const [revealing, setRevealing] = useState(false);
  if (titling !== wasTitling) {
    setWasTitling(titling);
    setRevealing(!titling);
  }
  if (titling) return <span className="history-title-text history-title-generating">{GENERATING_TITLE}</span>;
  if (!revealing) return <span className="history-title-text">{title}</span>;
  return (
    <span className="history-title-text history-title-reveal">
      <span className="history-title-new" onAnimationEnd={() => setRevealing(false)}>
        {title}
      </span>
      <span className="history-title-old" aria-hidden>
        {GENERATING_TITLE}
      </span>
    </span>
  );
}

type RowMotion = "close" | "snooze" | "open";

/** How long a row takes to play out, and to settle in; both match the row-* animations in styles.css. */
const ROW_OUT_MS = 180;
const ROW_IN_MS = 240;

/** Threads on their way out of the list, so a quick second action doesn't pick or move them again. */
const moving = new Set<string>();
/** Threads about to land in a new section, and how they left the old one. Their rows play it as they mount. */
const landing = new Map<string, RowMotion>();

const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** What closes up behind a row: its whole section, if the row is all that keeps the section on screen. */
function foldTarget(row: HTMLElement) {
  const section = row.closest<HTMLElement>(".history-group");
  return section && row.closest(".collapse") && section.querySelectorAll(".history-row").length === 1 ? section : row;
}

function fold(target: HTMLElement, direction: "in" | "out") {
  target.style.overflow = "hidden";
  target.style.setProperty("--fold-height", `${target.getBoundingClientRect().height}px`);
  target.dataset.fold = direction;
}

function unfold(target: HTMLElement) {
  target.style.removeProperty("overflow");
  target.style.removeProperty("--fold-height");
  delete target.dataset.fold;
}

function expectLanding(id: string, motion: RowMotion) {
  if (calm()) return;
  landing.set(id, motion);
  // The store update renders before the next frame; a row that doesn't mount by then isn't on screen.
  requestAnimationFrame(() => landing.delete(id));
}

/** Plays a thread's row out, then runs `commit` to file it elsewhere, where its row plays back in. */
function moveThread(id: string, motion: RowMotion, commit: () => void) {
  if (moving.has(id)) return;
  const row = document.querySelector<HTMLElement>(`.history-row[data-thread="${CSS.escape(id)}"]`);
  // Search results keep listing a thread wherever it's filed, so there it doesn't go anywhere.
  if (row?.closest(".history-results")) return commit();
  if (!row || calm()) {
    expectLanding(id, motion);
    return commit();
  }
  const target = foldTarget(row);
  moving.add(id);
  row.dataset.leave = motion;
  fold(target, "out");
  setTimeout(() => {
    moving.delete(id);
    expectLanding(id, motion);
    commit();
    // Only still on screen if the thread stayed put, or the list kept the section.
    requestAnimationFrame(() => {
      delete row.dataset.leave;
      unfold(target);
    });
  }, ROW_OUT_MS);
}

function playLanding(row: HTMLElement, motion: RowMotion) {
  const section = row.closest<HTMLElement>(".history-group");
  const heading = row.closest(".collapse:not(.collapse-open)") ? section?.querySelector<HTMLElement>(".history-heading") : undefined;
  const target = foldTarget(row);
  row.dataset.enter = motion;
  // In a collapsed section the row can't be seen arriving, so its heading marks the spot.
  if (heading) heading.dataset.landed = "";
  if (!heading || target !== row) fold(target, "in");
  setTimeout(() => {
    delete row.dataset.enter;
    if (heading) delete heading.dataset.landed;
    unfold(target);
  }, ROW_IN_MS);
}

const ChatRow = memo(function ChatRow({ chat, active, hit, renaming, regenerating, onSelect, onMenu, onRenameDone }: RowProps) {
  const updateChat = useStore((s) => s.updateChat);
  const titling = useStore((s) => s.titling.has(chat.id)) && !chat.titleSource;
  const streaming = chat.messages.at(-1)?.status === "streaming";
  const waiting = isWaiting(chat);
  const limit = limitOf(chat);
  const closed = isClosed(chat);
  const model = modelOf(chat);
  const runtime = chat.runtime ?? "pi";
  const device = useStore((s) => rowDevice(s.devices, chat.workspace?.deviceId));
  const [draft, setDraft] = useState(chat.title);
  const input = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const longPress = useLongPress((x, y) => onMenu(chat.id, x, y));
  // Pointing at a row (or pressing it) starts loading its history, so the click doesn't wait for it.
  // A brief pause first, so a pointer passing over the list doesn't fetch every thread on its way.
  const intent = useRef<ReturnType<typeof setTimeout>>(undefined);
  const prefetch = () => !active && prefetchHistory(chat);
  const soon = () => {
    clearTimeout(intent.current);
    intent.current = setTimeout(prefetch, 80);
  };
  useEffect(() => () => clearTimeout(intent.current), []);

  useLayoutEffect(() => {
    const motion = landing.get(chat.id);
    if (!motion || !rowRef.current) return;
    landing.delete(chat.id);
    playLanding(rowRef.current, motion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (!renaming) return;
    setDraft(chat.title);
    input.current?.focus();
    input.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming]);

  const commit = () => {
    const title = draft.trim();
    if (title && title !== chat.title) updateChat(chat.id, { title, titleSource: "user" });
    onRenameDone();
  };

  if (renaming)
    return (
      <div className="history-row history-row-renaming">
        <input
          ref={input}
          className="history-rename"
          value={draft}
          aria-label="Thread title"
          maxLength={120}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              e.stopPropagation();
              onRenameDone();
            }
          }}
        />
      </div>
    );

  return (
    <div
      ref={rowRef}
      data-thread={chat.id}
      className={cx("history-row", active && "history-row-active")}
      {...longPress.handlers}
      onContextMenu={(e) => {
        e.preventDefault();
        if (longPress.pressing()) return longPress.fire(e.clientX, e.clientY);
        // Keyboard-invoked context menus report (0, 0); anchor to the row instead.
        if (e.clientX === 0 && e.clientY === 0) {
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(chat.id, r.left + 24, r.bottom);
        } else onMenu(chat.id, e.clientX, e.clientY);
      }}
    >
      <button
        type="button"
        className="history-title"
        onClick={() => onSelect(chat, hit)}
        onPointerEnter={soon}
        onPointerLeave={() => clearTimeout(intent.current)}
        onPointerDown={prefetch}
        onFocus={soon}
        aria-current={active ? "page" : undefined}
        title={titling ? undefined : chat.title}
      >
        <span className="history-title-line">
          {hit ? (
            <span className="history-title-text">
              <Highlight text={chat.title} ranges={hit.titleRanges} />
            </span>
          ) : (
            <RowTitle title={chat.title} titling={titling} />
          )}
          {chat.subagent && (
            <span className="history-subagent" title="Subagent" aria-label="Subagent">
              <Bot size={13} />
            </span>
          )}
          {hit && isClosed(chat) && <span className="badge">closed</span>}
          <span className="history-status">
            {waiting ? (
              <Spinner size={13} waiting />
            ) : streaming || regenerating ? (
              <Spinner size={13} />
            ) : chat.snoozedUntil ? (
              <span className="history-snooze" title={`Snoozed until ${new Date(chat.snoozedUntil).toLocaleString()}`}>
                <AlarmClock size={12} />
                {snoozeLabel(chat.snoozedUntil)}
              </span>
            ) : limit ? (
              <span className="history-limit" title={limit === "credits" ? "Out of credits" : "Usage limit reached"} aria-label={limit === "credits" ? "Out of credits" : "Usage limit reached"}>
                <BatteryWarning size={13} />
              </span>
            ) : chat.unread ? (
              <span className="unread-dot" aria-label="New reply" />
            ) : chat.woke ? (
              <span className="history-woke" title="Snooze ended" aria-label="Snooze ended">
                <AlarmClockCheck size={13} />
              </span>
            ) : null}
          </span>
        </span>
        {/* Only search results show a body line: the text that matched. */}
        {hit?.snippet && (
          <span className="history-snippet">
            <Highlight text={hit.snippet.text} ranges={hit.snippet.ranges} />
          </span>
        )}
        <span className="history-meta">
          {chat.workspace?.projectName && (
            <span className="history-proj" title={chat.workspace.worktree ? `${chat.workspace.projectName} · ${chat.workspace.branch}` : chat.workspace.projectName}>
              <span className="history-proj-name">{chat.workspace.projectName}</span>
              {/* Branch naming leaves the checkout path stable for running sessions. */}
              {chat.workspace.worktree && (
                <span className="history-worktree">
                  <GitBranch size={12} />
                  <span>{chat.workspace.branch?.replace(/^openbuild\//, "") || chat.workspace.cwd.split(/[\\/]/).pop()}</span>
                </span>
              )}
            </span>
          )}
          {device && (
            <span className="history-device" title={`Runs on ${device}`}>
              @ {device}
            </span>
          )}
          {chat.pullRequest && <PullRequestBadge pr={chat.pullRequest} onOpen={chat.workspace?.cwd ? () => onSelect(chat, hit, () => showPullRequest(chat.pullRequest!.number)) : undefined} />}
          <span className="history-runtime" title={`${runtime === "hermes" ? "Hermes harness" : runtime === "grok" ? "Native Grok harness" : runtime === "opencode" ? "Native OpenCode harness" : runtime === "claude" ? "Native Claude Code harness" : runtime === "cursor" ? "Native Cursor harness" : runtime === "durable" ? "Durable harness" : runtime === "fx" ? "fx harness" : runtime === "codex" ? "Native Codex harness" : "Pi harness"}${model ? ` · ${model.name}` : ""}`}>
            {runtime === "hermes" ? <HermesMark size={14} /> : runtime === "grok" ? <GrokMark size={14} /> : runtime === "opencode" ? <OpencodeMark size={14} /> : runtime === "claude" ? <ClaudeMark size={14} /> : runtime === "cursor" ? <CursorMark size={14} /> : runtime === "durable" ? <DurableMark size={14} /> : runtime === "fx" ? <FxMark size={14} /> : runtime === "codex" ? <CodexMark size={14} /> : <PiMark size={14} />}
          </span>
        </span>
      </button>
      <span className="history-actions">
        <IconButton
          label={chat.pinned ? "Unpin" : "Pin"}
          tooltipSide="top"
          className="history-action"
          onClick={() => updateChat(chat.id, { pinned: !chat.pinned })}
        >
          {chat.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </IconButton>
        {chat.snoozedUntil ? (
          <IconButton label="Wake" tooltipSide="top" className="history-action" onClick={() => wakeThread(chat.id)}>
            <ClockArrowUp size={14} />
          </IconButton>
        ) : (
          <IconButton
            label="Snooze"
            tooltipSide="top"
            aria-haspopup="menu"
            className="history-action"
            // As with the ⋯ button: a second click toggles the menu closed rather than reopening it.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onMenu(chat.id, r.right, r.bottom + 4, true, true);
            }}
          >
            <AlarmClock size={14} />
          </IconButton>
        )}
        {!chat.snoozedUntil && (
          <IconButton
            label={closed ? "Reopen" : "Close"}
            tooltipSide="top"
            className="history-action"
            onClick={() => toggleClosed(chat)}
          >
            {closed ? <SquareArrowUp size={14} /> : <Check size={14} />}
          </IconButton>
        )}
        {/* Touch screens only: opens the same menu as right-click / long-press. */}
        <IconButton
          label="More actions"
          tooltip={false}
          aria-haspopup="menu"
          className="history-action history-more"
          // Keep the menu's outside-tap dismiss (and the row's long-press) from seeing this tap,
          // so tapping again toggles the menu closed instead of closing and reopening it.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(chat.id, r.right, r.bottom + 4, true);
          }}
        >
          <Ellipsis size={16} />
        </IconButton>
      </span>
    </div>
  );
});

/** Thin overlay scrollbar for `target`: fades in as it scrolls, and out a second after the last scroll.
 * The native one can stay stuck on screen when a trackpad scroll is stopped dead, with no momentum phase. */
export function ScrollThumb({ target }: { target: React.RefObject<HTMLElement | null> }) {
  const thumb = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = target.current;
    const bar = thumb.current;
    if (!el || !bar) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let drag: { y: number; top: number; scale: number } | undefined;
    const size = () => {
      const height = Math.max(24, (el.clientHeight * el.clientHeight) / el.scrollHeight);
      return { height, travel: el.clientHeight - height, range: el.scrollHeight - el.clientHeight };
    };
    const hide = () => {
      if (!drag && !bar.matches(":hover")) bar.classList.remove("scroll-thumb-on");
    };
    const onScroll = () => {
      const { height, travel, range } = size();
      if (range <= 0) return bar.classList.remove("scroll-thumb-on");
      bar.style.height = `${height}px`;
      bar.style.transform = `translateY(${(el.scrollTop / range) * travel}px)`;
      bar.classList.add("scroll-thumb-on");
      clearTimeout(timer);
      timer = setTimeout(hide, 1000);
    };
    const onDown = (e: PointerEvent) => {
      const { travel, range } = size();
      drag = { y: e.clientY, top: el.scrollTop, scale: range / travel };
      bar.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      if (drag) el.scrollTop = drag.top + (e.clientY - drag.y) * drag.scale;
    };
    const onUp = () => {
      drag = undefined;
      clearTimeout(timer);
      timer = setTimeout(hide, 1000);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    bar.addEventListener("pointerdown", onDown);
    bar.addEventListener("pointermove", onMove);
    bar.addEventListener("pointerup", onUp);
    bar.addEventListener("pointercancel", onUp);
    bar.addEventListener("pointerleave", onUp);
    return () => {
      clearTimeout(timer);
      el.removeEventListener("scroll", onScroll);
      bar.removeEventListener("pointerdown", onDown);
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", onUp);
      bar.removeEventListener("pointercancel", onUp);
      bar.removeEventListener("pointerleave", onUp);
    };
  }, [target]);
  return <div ref={thumb} className="scroll-thumb" aria-hidden />;
}

/** How long a section takes to fold shut; matches .collapse in styles.css. */
const COLLAPSE_MS = 260;

/**
 * Section whose header toggles its rows. A shut section has no rows at all, except for a moment
 * while it folds shut: "Closed" is most threads, and its rows were most of what a page load
 * built (thousands of icons) for a list nobody could see.
 */
function Collapsible({ label, open, onToggle, chats, row, bottom }: { label: string; open: boolean; onToggle: () => void; chats: Chat[]; row: (c: Chat) => React.ReactNode; bottom?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  // Decided while rendering, so the render that shuts it still has the rows to fold away.
  const [wasOpen, setWasOpen] = useState(open);
  const [folding, setFolding] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    setFolding(!open);
  }
  useEffect(() => {
    if (!folding) return;
    const timer = setTimeout(() => setFolding(false), COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [folding]);
  const rows = open || folding;
  // A thread filed into the shut section has no row to arrive in, so the heading marks the spot, and
  // a section that only now has a thread folds in (as playLanding does for a row in a shut section).
  useLayoutEffect(() => {
    if (rows || !ref.current) return;
    const landed = chats.filter((c) => landing.delete(c.id));
    if (!landed.length) return;
    const section = ref.current;
    const heading = section.querySelector<HTMLElement>(".history-heading")!;
    heading.dataset.landed = "";
    if (chats.length === 1) fold(section, "in");
    setTimeout(() => {
      delete heading.dataset.landed;
      unfold(section);
    }, ROW_IN_MS);
  }, [chats, rows]);
  return (
    <section ref={ref} className={cx("history-group", bottom && "history-group-bottom")}>
      <button type="button" className="history-heading history-heading-toggle" aria-expanded={open} onClick={onToggle}>
        {label}{" "}
        <span className="history-count">{chats.length}</span>
        <ChevronDown size={12} className="history-heading-chevron" />
      </button>
      <div className={cx("collapse", open && "collapse-open")} inert={!open}>
        <div className="collapse-inner">{rows && chats.map((c) => row(c))}</div>
      </div>
    </section>
  );
}

interface MenuState {
  chatId: string;
  x: number;
  y: number;
  /** Opened from the row's ⋯ button: right-align the menu under it. */
  end?: boolean;
  /** Opened from the row's snooze button: just the snooze options. */
  snooze?: boolean;
}

/** Delete a thread for good, stopping any reply still running. */
/** Rows the sidebar lists, top to bottom; kept current by Sidebar. */
let threadOrder: string[] = [];

/** Before the open thread leaves the list: move to the row that takes its place, or the one above if it was last. */
function leaveThread(id: string) {
  const s = useStore.getState();
  if (s.activeChatId !== id) return;
  const order = threadOrder.filter((t) => t === id || !moving.has(t));
  const at = order.indexOf(id);
  const next = at < 0 ? order[0] : (order[at + 1] ?? order[at - 1]);
  // Over OpenBots or Usage, change the thread underneath without bringing OpenBuild forward.
  // A thread opened inside OpenBots goes back to the bot chat rather than on to the next thread.
  if (s.botsOpen || s.usageOpen) useStore.setState({ activeChatId: next, searchFocus: undefined, botsThread: false });
  else if (next) s.selectChat(next);
  else s.newChat();
}

// Closed elsewhere (its pull request merged, or another tab or device closed it) while it's open
// here: move on as closing it here would. Closing it here leaves it first, so it isn't open by then.
useStore.subscribe((s, prev) => {
  const id = s.activeChatId;
  if (!id || id !== prev.activeChatId || s.chats === prev.chats) return;
  const was = prev.chats.find((c) => c.id === id);
  if (was && !was.archived && s.chats.find((c) => c.id === id)?.archived) leaveThread(id);
});

function toggleClosed(chat: Chat) {
  const closed = isClosed(chat);
  if (moving.has(chat.id)) return;
  if (!closed) leaveThread(chat.id);
  const commit = () => useStore.getState().updateChat(chat.id, closePatch(chat));
  // A thread pinned from "Closed" stays in "Pinned" when it reopens.
  if (closed && chat.pinned) commit();
  else moveThread(chat.id, closed ? "open" : "close", commit);
}

function snoozeThread(id: string, until: number) {
  if (moving.has(id)) return;
  leaveThread(id);
  moveThread(id, "snooze", () => useStore.getState().updateChat(id, snoozePatch(until)));
}

function wakeThread(id: string) {
  moveThread(id, "open", () => useStore.getState().updateChat(id, wakePatch));
}

function deleteThread(id: string) {
  stopGeneration(id);
  leaveThread(id);
  useStore.getState().removeChat(id);
}

function DeleteThreadDialog({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const updateSettings = useStore((s) => s.updateSettings);
  const [skipNextTime, setSkipNextTime] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-labelledby="thread-delete-title"
      aria-describedby="thread-delete-description"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="thread-delete-title">Delete “{chat.title}”?</h2>
      <p id="thread-delete-description">This permanently deletes the thread and its messages. It can't be undone.</p>
      <label className="confirm-skip">
        <input type="checkbox" checked={skipNextTime} onChange={(e) => setSkipNextTime(e.target.checked)} />
        Don't ask again
      </label>
      <div className="confirm-actions">
        <button type="button" className="btn btn-sm" onClick={onClose} autoFocus>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={() => {
            if (skipNextTime) updateSettings({ confirmDelete: false });
            deleteThread(chat.id);
            onClose();
          }}
        >
          <Trash size={14} /> Delete
        </button>
      </div>
    </dialog>
  );
}

const SNOOZE_UNITS = {
  minutes: { label: "Minutes", ms: 60_000 },
  hours: { label: "Hours", ms: 60 * 60_000 },
  days: { label: "Days", ms: DAY },
  weeks: { label: "Weeks", ms: 7 * DAY },
};

/** Snooze a thread until a time, or for a length of time, of the user's choosing. */
function SnoozeDialog({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<"date" | "duration">("date");
  const [day, setDay] = useState(() => startOfToday() + DAY);
  const [time, setTime] = useState(9 * 60);
  const [amount, setAmount] = useState(2);
  const [unit, setUnit] = useState<keyof typeof SNOOZE_UNITS>("hours");
  const until = mode === "date" ? new Date(day).setHours(Math.floor(time / 60), time % 60, 0, 0) : Date.now() + amount * SNOOZE_UNITS[unit].ms;
  const valid = until > Date.now();
  const now = new Date();

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog snooze-dialog"
      aria-labelledby="thread-snooze-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          snoozeThread(chat.id, until);
          onClose();
        }}
      >
        <h2 id="thread-snooze-title">Snooze “{chat.title}”</h2>
        <p>It moves to Snoozed and comes back under Woke at this time.</p>
        <div className="segmented snooze-mode" role="radiogroup" aria-label="Snooze until">
          {(
            [
              ["date", "Date and time"],
              ["duration", "Duration"],
            ] as const
          ).map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={mode === value} className="segment" onClick={() => setMode(value)}>
              {label}
            </button>
          ))}
        </div>
        {mode === "date" ? (
          <div className="snooze-fields">
            <div className="snooze-field">
              <span className="snooze-label">Date</span>
              <DateField label="Date" value={day} min={Date.now()} onChange={setDay} />
            </div>
            <div className="snooze-field">
              <span className="snooze-label">Time</span>
              <TimeField label="Time" value={time} min={day === startOfToday() ? now.getHours() * 60 + now.getMinutes() + 1 : 0} onChange={setTime} />
            </div>
          </div>
        ) : (
          <div className="snooze-fields">
            <div className="snooze-field">
              <span className="snooze-label">Snooze for</span>
              <div className="input snooze-stepper">
                <button type="button" aria-label="Less" disabled={amount <= 1} onClick={() => setAmount((n) => Math.max(1, n - 1))}>
                  <Minus size={15} />
                </button>
                <input
                  type="number"
                  inputMode="numeric"
                  aria-label="Snooze for"
                  min={1}
                  value={amount || ""}
                  onChange={(e) => setAmount(Math.max(0, Math.floor(Number(e.target.value)) || 0))}
                  autoFocus
                />
                <button type="button" aria-label="More" onClick={() => setAmount((n) => n + 1)}>
                  <Plus size={15} />
                </button>
              </div>
            </div>
            <div className="snooze-field">
              <span className="snooze-label">Unit</span>
              <ChoiceField
                label="Unit"
                value={unit}
                options={Object.entries(SNOOZE_UNITS).map(([value, { label }]) => ({ value: value as keyof typeof SNOOZE_UNITS, label }))}
                onChange={setUnit}
              />
            </div>
          </div>
        )}
        <div className="snooze-when">{valid ? `Wakes ${snoozeLabel(until)}` : "Pick a time in the future."}</div>
        <div className="confirm-actions">
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={!valid}>
            <AlarmClock size={14} /> Snooze
          </button>
        </div>
      </form>
    </dialog>
  );
}

function ChatContextMenu({
  state,
  sidebarRef,
  onClose,
  onRename,
  onRegenerate,
  onDelete,
  onSnooze,
}: {
  state?: MenuState;
  sidebarRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onRename: (id: string) => void;
  onRegenerate: (id: string) => void;
  onDelete: (id: string) => void;
  /** Opens the custom snooze time picker. */
  onSnooze: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef(state);
  if (state) last.current = state;
  const current = last.current;
  const chat = useStore((s) => s.chats.find((c) => c.id === current?.chatId));
  const { updateChat } = useStore.getState();
  const open = !!state;
  const { mounted, visible } = usePresence(open, 180);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string }>();
  const [sub, setSub] = useState<"rename" | "copy" | "snooze">();
  const [nativeSession, setNativeSession] = useState<{ threadId: string; id: string | null }>();
  const HarnessMark = { pi: PiMark, durable: DurableMark, fx: FxMark, codex: CodexMark, cursor: CursorMark, claude: ClaudeMark, opencode: OpencodeMark, grok: GrokMark, hermes: HermesMark }[chat?.runtime ?? "pi"];
  useEffect(() => {
    setNativeSession(undefined);
    if (!open || !chat || sub !== "copy") return;
    let cancelled = false;
    const threadId = chat.id;
    void harnessSession(threadId, chat.workspace?.deviceId).then(
      (session) => { if (!cancelled) setNativeSession({ threadId, id: session.id }); },
      () => { if (!cancelled) setNativeSession({ threadId, id: null }); },
    );
    return () => { cancelled = true; };
  }, [open, sub, chat?.id, chat?.workspace?.deviceId]);
  useDismiss(open, onClose, [ref]);

  useLayoutEffect(() => {
    if (!open || !mounted || !state) return;
    setSub(undefined);
    const el = ref.current;
    const w = el?.offsetWidth ?? 220;
    const h = el?.offsetHeight ?? 220;
    const x = state.end ? state.x - w : state.x;
    const top = Math.max(8, Math.min(state.y, window.innerHeight - h - 8));
    // Grow out of the point it was opened from: the ⋯ button's corner, or the cursor / finger.
    const origin = `${top < state.y ? "bottom" : "top"} ${state.end ? "right" : "left"}`;
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - w - 8)), top, origin });
    // Touch screens skip this: iOS paints the focused item as highlighted, which reads as a flicker.
    if (window.matchMedia("(pointer: fine)").matches) el?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, [open, mounted, state]);

  useEffect(() => {
    if (!open) return;
    const close = () => onClose();
    const onScroll = (event: Event) => {
      const target = event.target;
      const sidebar = sidebarRef.current;
      // Streaming output scrolls the conversation. Only scrolling the sidebar or
      // its ancestors can move the thread the menu was opened from.
      if (target === document || (sidebar && target instanceof Node && (sidebar.contains(target) || target.contains(sidebar)))) close();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, onClose, sidebarRef]);

  if (!mounted || !chat) return null;
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const snoozeItems = (
    <>
      {snoozeOptions().map((o) => (
        <button key={o.label} type="button" role="menuitem" className="menu-item" onClick={act(() => snoozeThread(chat.id, o.until))}>
          <span className="menu-item-label">{o.label}</span>
          <span className="menu-item-hint">{o.hint}</span>
        </button>
      ))}
      <div className="menu-sep" />
      <button type="button" role="menuitem" className="menu-item" onClick={act(() => onSnooze(chat.id))}>
        <span className="menu-item-label">Custom…</span>
      </button>
    </>
  );
  const flyout = (id: "rename" | "copy" | "snooze", icon: React.ReactNode, label: string, items: React.ReactNode) => (
    <div className="filter-row" onMouseEnter={() => canHover() && setSub(id)}>
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={sub === id}
        className={cx("menu-item", sub === id && "menu-item-active")}
        onClick={() => setSub(sub === id ? undefined : id)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight") return;
          e.preventDefault();
          setSub(id);
          requestAnimationFrame(() => e.currentTarget.parentElement?.querySelector<HTMLElement>(".filter-flyout button")?.focus());
        }}
      >
        {icon}
        <span className="menu-item-label">{label}</span>
        <ChevronRight size={14} className="filter-chevron" />
      </button>
      {sub === id && (
        <div
          ref={fitFlyout}
          className="popover menu filter-flyout"
          data-state="open"
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            e.stopPropagation();
            arrowNav(e);
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              setSub(undefined);
              (e.currentTarget.parentElement?.firstElementChild as HTMLElement | null)?.focus();
            }
          }}
        >
          {items}
        </div>
      )}
    </div>
  );
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={current?.snooze ? `Snooze ${chat.title}` : `Actions for ${chat.title}`}
      className="popover menu context-menu"
      data-state={visible && pos ? "open" : "closed"}
      style={{ position: "fixed", left: pos?.left ?? state?.x, top: pos?.top ?? state?.y, transformOrigin: pos?.origin }}
      onKeyDown={(e) => arrowNav(e, ":scope > button, :scope > .filter-row > button")}
      onContextMenu={(e) => e.preventDefault()}
      // Like a native menu, a submenu stays open until another item is hovered.
      onMouseOver={(e) => {
        const item = (e.target as Element).closest(".menu-item");
        if (canHover() && item && !item.closest(".filter-row")) setSub(undefined);
      }}
    >
      {current?.snooze ? snoozeItems : <>
      <button type="button" role="menuitem" className="menu-item" onClick={act(() => window.open(chatUrl(chat.id), "_blank", "noopener"))}>
        <ExternalLink size={15} /> Open in new tab
      </button>
      <button type="button" role="menuitem" className="menu-item" onClick={act(() => updateChat(chat.id, { pinned: !chat.pinned }))}>
        {chat.pinned ? <PinOff size={15} /> : <Pin size={15} />} {chat.pinned ? "Unpin" : "Pin"}
      </button>
      <button
        type="button"
        role="menuitem"
        className="menu-item"
        onClick={act(() => toggleClosed(chat))}
      >
        {isClosed(chat) ? <SquareArrowUp size={15} /> : <Check size={15} />} {isClosed(chat) ? "Reopen" : "Close"}
      </button>
      {chat.snoozedUntil ? (
        <button type="button" role="menuitem" className="menu-item" onClick={act(() => wakeThread(chat.id))}>
          <ClockArrowUp size={15} /> Wake
        </button>
      ) : (
        flyout(
          "snooze",
          <AlarmClock size={15} />,
          "Snooze",
          snoozeItems,
        )
      )}
      {flyout(
        "rename",
        <Pencil size={15} />,
        "Rename",
        <>
          <button type="button" role="menuitem" className="menu-item" onClick={act(() => onRename(chat.id))}>
            <Pencil size={15} /> Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={!chat.historyDeferred && !threadTranscript(chat)}
            title={chat.historyDeferred || threadTranscript(chat) ? undefined : "This thread has no messages yet"}
            onClick={act(() => onRegenerate(chat.id))}
          >
            <RefreshCw size={15} /> Regenerate
          </button>
        </>,
      )}
      {flyout(
        "copy",
        <Copy size={15} />,
        "Copy",
        <>
          <button type="button" role="menuitem" className="menu-item" onClick={act(() => copyText(chat.id))}>
            <Fingerprint size={15} /> Thread ID
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={nativeSession?.threadId !== chat.id || !nativeSession.id}
            onClick={act(() => { if (nativeSession?.threadId === chat.id && nativeSession.id) void copyText(nativeSession.id); })}
          >
            <HarnessMark size={15} /> {runtimeName(chat.runtime ?? "pi")} {chat.runtime === "codex" ? "thread" : "session"} ID
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={act(() => loadChatHistory(chat).then(full => copyText(chatMarkdown(full))))}>
            <FileText size={15} /> As Markdown
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={!chat.workspace?.branch}
            title={chat.workspace?.branch ? undefined : "This thread has no git branch"}
            onClick={act(() => copyText(chat.workspace!.branch!))}
          >
            <GitBranch size={15} /> Branch
          </button>
        </>,
      )}
      {chat.workspace?.worktree && (
        <button
          type="button"
          role="menuitem"
          className="menu-item"
          onClick={act(() => {
            const ws = chat.workspace!;
            if (!window.confirm(`Remove the worktree for ${ws.branch}? Its branch is deleted too if it was merged.`)) return;
            removeWorktree(ws.cwd).catch((err: Error) => {
              if (/uncommitted/.test(err.message) && window.confirm(`${err.message}. Remove it anyway, discarding them?`)) return removeWorktree(ws.cwd, true);
              window.alert(err.message);
            });
          })}
        >
          <FolderX size={15} /> Remove worktree
        </button>
      )}
      <div className="menu-sep" />
      <button
        type="button"
        role="menuitem"
        className="menu-item menu-item-danger"
        onClick={act(() => (useStore.getState().settings.confirmDelete === false ? deleteThread(chat.id) : onDelete(chat.id)))}
      >
        <Trash size={15} /> Delete
      </button>
      </>}
    </div>
  );
}

/** Switch the sidebar and main pane over to OpenBots, and back. */
export function toggleBots() {
  crossfade(() => {
    const st = useStore.getState();
    const open = st.botsOpen;
    st.setBotsOpen(!open);
    // On a phone the sidebar is a drawer and the toggle sits in it, so the other drawer takes its place.
    if (window.innerWidth <= 768) {
      st.setSidebarOpen(open);
      st.setBotsSidebarOpen(!open);
    }
  });
}

/**
 * Take the thread open inside OpenBots out to OpenBuild, as it is. The thread's pane is the same one
 * on both sides, so only the sidebars swap: its scroll, draft and panels stay put.
 */
export function expandBotsThread() {
  crossfade(() => {
    const st = useStore.getState();
    st.setBotsOpen(false);
    // On a phone the sidebar is a drawer, which would cover the thread just opened out.
    if (window.innerWidth <= 768) st.setSidebarOpen(false);
  });
}

/** The footer button for that switch: OpenBots' puff to go in, a back arrow to leave. */
export function BotsToggle() {
  const open = useStore((s) => s.botsOpen);
  return (
    <button
      type="button"
      className="bots-toggle"
      aria-label={open ? "Back to threads" : "OpenBots"}
      data-tooltip={open ? "Back to threads" : "OpenBots"}
      data-tooltip-side="top"
      onClick={toggleBots}
    >
      {open ? <ArrowLeft size={19} /> : <BotsGlyph size={19} />}
    </button>
  );
}

/** The side the switch last showed lit, whichever sidebar showed it: the next one slides on from there. */
let switchShown: boolean | undefined;

/**
 * OpenBuild or OpenBots, as two pills in the middle of either sidebar's header: the one you're in is
 * lit, the other takes you across. Each sidebar has its own copy, in the same place, and only the one
 * on screen runs its effects (the other is in a hidden Activity), so the copy coming in slides its
 * light over from where the one going out left it: one switch, to the eye.
 */
export function ModeSwitch() {
  const bots = useStore((s) => s.botsOpen);
  const light = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const from = switchShown;
    switchShown = bots;
    if (from === undefined || from === bots || !light.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const across = "translateX(calc(100% + 2px))";
    light.current.animate([{ transform: from ? across : "translateX(0)" }, { transform: bots ? across : "translateX(0)" }], {
      duration: 320,
      easing: "cubic-bezier(0.32, 0.72, 0, 1)",
    });
  }, [bots]);
  return (
    <div className={cx("mode-switch", bots && "mode-switch-bots")} role="group" aria-label="Threads or bots">
      <span ref={light} className="mode-light" aria-hidden />
      <button type="button" className={cx("mode-pill", !bots && "mode-pill-on")} aria-pressed={!bots} onClick={() => bots && toggleBots()}>
        Build
      </button>
      <button type="button" className={cx("mode-pill", bots && "mode-pill-on")} aria-pressed={bots} onClick={() => !bots && toggleBots()}>
        Bots
      </button>
    </div>
  );
}

/** Models that replied in any chat, for the model filter. */
function useChatModels() {
  const chats = useStore((s) => s.chats);
  return useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of chats) for (const m of c.messages) if (m.model && !seen.has(m.model.id)) seen.set(m.model.id, m.model.name);
    return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [chats]);
}

type Sub = "sort" | "model" | "runtime";

/** Runtime choices in the filter menu, where Pi keeps its own name. */
const RUNTIME_FILTERS = [
  ["all", "All harnesses"],
  ["pi", "Pi"],
  ["durable", "Durable"],
  ["fx", "fx"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  ["claude", "Claude Code"],
  ["opencode", "OpenCode"],
  ["hermes", "Hermes"],
  ["grok", "Grok"],
] as const;

function FilterMenu() {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<Sub>();
  const anchor = useRef<HTMLButtonElement>(null);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const models = useChatModels();
  const active =
    view.sort !== DEFAULT_VIEW.sort ||
    view.models.length > 0 ||
    view.includePinned !== DEFAULT_VIEW.includePinned ||
    view.subagents !== DEFAULT_VIEW.subagents ||
    view.runtime !== DEFAULT_VIEW.runtime;
  const close = () => {
    setOpen(false);
    setSub(undefined);
  };

  const modelLabel =
    view.models.length === 0
      ? "All"
      : view.models.length === 1
        ? (models.find((m) => m.id === view.models[0])?.name ?? "1 model")
        : `${view.models.length} models`;

  const toggleModel = (id: string) =>
    setView({ models: view.models.includes(id) ? view.models.filter((m) => m !== id) : [...view.models, id] });

  // A row that opens a flyout on hover, click, or ArrowRight.
  const row = (id: Sub, label: string, value: string, flyout: React.ReactNode) => (
    <div className="filter-row" onMouseEnter={() => canHover() && setSub(id)}>
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={sub === id}
        className={cx("menu-item", sub === id && "menu-item-active")}
        onClick={() => setSub(sub === id ? undefined : id)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            setSub(id);
            requestAnimationFrame(() => e.currentTarget.parentElement?.querySelector<HTMLElement>(".filter-flyout button")?.focus());
          }
        }}
      >
        <span className="menu-item-label">{label}</span>
        <span className="filter-value">{value}</span>
        <ChevronRight size={14} className="filter-chevron" />
      </button>
      {sub === id && (
        <div
          ref={fitFlyout}
          className="popover menu filter-flyout"
          data-state="open"
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            arrowNav(e);
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              setSub(undefined);
              (e.currentTarget.parentElement?.firstElementChild as HTMLElement | null)?.focus();
            }
          }}
        >
          {flyout}
        </div>
      )}
    </div>
  );

  return (
    <div className="picker">
      <IconButton
        ref={anchor}
        label="Filter threads"
        aria-expanded={open}
        aria-haspopup="menu"
        tooltip={open ? false : "Sort and filter"}
        className={cx(active && "filter-active")}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <FilterIcon />
        {active && <span className="filter-dot" aria-hidden />}
      </IconButton>
      <Popover open={open} onClose={close} anchor={anchor} className="menu filter-menu drop-down" role="menu" label="Sort and filter threads" fixed="down">
        <div onKeyDown={(e) => arrowNav(e, ":scope > .filter-row > button, :scope > .filter-toggle, :scope > .filter-reset")}>
          {row(
            "sort",
            "Sort",
            view.sort === "updated" ? "Last updated" : "Created",
            <>
              <div className="menu-label">Sort</div>
              {(
                [
                  ["updated", "Last updated", Clock],
                  ["created", "Created", CalendarDays],
                ] as const
              ).map(([value, label, Icon]) => (
                <button key={value} type="button" role="menuitemradio" aria-checked={view.sort === value} className="menu-item" onClick={() => setView({ sort: value })}>
                  <Icon size={15} />
                  <span className="menu-item-label">{label}</span>
                  {view.sort === value && <Check size={15} className="menu-check" />}
                </button>
              ))}
            </>,
          )}
          {row(
            "model",
            "Model",
            modelLabel,
            <>
              <div className="menu-label">Model</div>
              <button type="button" role="menuitemcheckbox" aria-checked={!view.models.length} className="menu-item" onClick={() => setView({ models: [] })}>
                <MessageCircle size={15} />
                <span className="menu-item-label">All models</span>
                {!view.models.length && <Check size={15} className="menu-check" />}
              </button>
              {models.length > 0 && <div className="menu-sep" />}
              <div className="filter-flyout-list">
                {models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={view.models.includes(m.id)}
                    className="menu-item"
                    onClick={() => toggleModel(m.id)}
                  >
                    <BrandIcon id={m.id} />
                    <span className="menu-item-label">{m.name}</span>
                    {view.models.includes(m.id) && <Check size={15} className="menu-check" />}
                  </button>
                ))}
              </div>
            </>,
          )}
          {row(
            "runtime",
            "Harness",
            view.runtime === "all" ? "All" : view.runtime === "hermes" ? "Hermes" : view.runtime === "grok" ? "Grok" : view.runtime === "opencode" ? "OpenCode" : view.runtime === "claude" ? "Claude Code" : view.runtime === "cursor" ? "Cursor" : view.runtime === "durable" ? "Durable" : view.runtime === "fx" ? "fx" : view.runtime === "codex" ? "Codex" : "Pi",
            <>
              <div className="menu-label">Harness</div>
              {RUNTIME_FILTERS.map(([value, label]) => (
                <button key={value} type="button" role="menuitemradio" aria-checked={view.runtime === value} className="menu-item" onClick={() => setView({ runtime: value })}>
                  {value === "hermes" ? <HermesMark size={15} /> : value === "grok" ? <GrokMark size={15} /> : value === "opencode" ? <OpencodeMark size={15} /> : value === "claude" ? <ClaudeMark size={15} /> : value === "cursor" ? <CursorMark size={15} /> : value === "all" ? <Layers size={15} /> : value === "pi" ? <PiMark size={15} /> : value === "fx" ? <FxMark size={15} /> : value === "codex" ? <CodexMark size={15} /> : <DurableMark size={15} />}
                  <span className="menu-item-label">{label}</span>
                  {view.runtime === value && <Check size={15} className="menu-check" />}
                </button>
              ))}
            </>,
          )}
          <div className="menu-sep" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={view.includePinned}
            className="menu-item filter-toggle"
            onMouseEnter={() => canHover() && setSub(undefined)}
            onClick={() => setView({ includePinned: !view.includePinned })}
          >
            <span className="menu-item-label">Include pinned</span>
            <span className="toggle toggle-sm" aria-hidden data-on={view.includePinned}>
              <span className="toggle-knob" />
            </span>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={view.subagents}
            className="menu-item filter-toggle"
            onMouseEnter={() => canHover() && setSub(undefined)}
            onClick={() => setView({ subagents: !view.subagents })}
          >
            <span className="menu-item-label">Show subagents</span>
            <span className="toggle toggle-sm" aria-hidden data-on={view.subagents}>
              <span className="toggle-knob" />
            </span>
          </button>
          {active && (
            <>
              <div className="menu-sep" />
              <button type="button" role="menuitem" className="menu-item filter-reset" onMouseEnter={() => canHover() && setSub(undefined)} onClick={() => setView(DEFAULT_VIEW)}>
                <RotateCcw size={15} />
                <span className="menu-item-label">Reset</span>
              </button>
            </>
          )}
        </div>
      </Popover>
    </div>
  );
}

/**
 * The threads working now, and those that stopped since `before` and move into "Done", reopening if
 * closed. (The server marks replies that finish elsewhere; see server/pi/projection.ts.) A discovered
 * thread whose native runtime finished is left where the server files it: under Closed.
 */
export function finishedWork(before: Map<string, boolean> | undefined, chats: Chat[]): { working: Map<string, boolean>; done: string[] } {
  const working = new Map(chats.filter(isWorking).map((c) => [c.id, !!c.imported && lastReply(c)?.stream?.via === EXTERNAL_VIA]));
  const done: string[] = [];
  for (const [id, discovered] of before ?? []) {
    const c = chats.find((c) => c.id === id);
    if (c && !discovered && !working.has(id) && (!c.done || c.archived)) done.push(id);
  }
  return { working, done };
}

export function Sidebar() {
  const sidebarRef = useRef<HTMLElement>(null);
  const open = useStore((s) => s.sidebarOpen);
  const chats = useStore((s) => s.chats);
  const activeChatId = useStore((s) => s.activeChatId);
  const avatar = useStore((s) => s.settings.profile.avatar);
  const name = useStore((s) => s.settings.profile.name);
  const { setSidebarOpen, newChat, selectChat, openSettings, setSearchFocus } = useStore.getState();
  const mobile = useMediaQuery("(max-width: 768px)");
  const [query, setQuery] = useState("");
  // The search is behind a button, as in OpenBots: open while it's wanted, always on a phone.
  const [searching, setSearching] = useState(false);
  const searchField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const open = () => {
      setSearching(true);
      requestAnimationFrame(() => searchField.current?.focus());
    };
    window.addEventListener(OPEN_SEARCH, open);
    return () => window.removeEventListener(OPEN_SEARCH, open);
  }, []);
  const deferredQuery = useDeferredValue(query.trim());
  const [menu, setMenu] = useState<MenuState>();
  const [renamingId, setRenamingId] = useState<string>();
  const [regenerating, setRegenerating] = useState<ReadonlySet<string>>(new Set());
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const [deletingId, setDeletingId] = useState<string>();
  const deleting = useStore((s) => s.chats.find((c) => c.id === deletingId));
  const [snoozingId, setSnoozingId] = useState<string>();
  const snoozing = useStore((s) => s.chats.find((c) => c.id === snoozingId));

  const sections = useStore((s) => s.sections);
  const toggleSection = useStore((s) => s.toggleSection);
  const [closedView, setClosedView] = useState(false);
  const historyRef = useRef<HTMLElement>(null);
  // A reload keeps the list where it was (search results start at the top).
  useScrollRestore(historyRef, deferredQuery ? undefined : closedView ? "threads:closed" : "threads");
  const updateChat = useStore((s) => s.updateChat);
  const today = useToday();

  const view = useStore((s) => s.view);

  // Model, runtime, subagent and sort filters from the filter menu and the runtime switch. A pinned or open subagent thread stays listed.
  const visible = useMemo(() => {
    const shown = view.subagents ? chats : chats.filter((c) => !c.subagent || c.pinned || c.id === activeChatId);
    const byRuntime = view.runtime === "all" ? shown : shown.filter((c) => (c.runtime ?? "pi") === view.runtime);
    const byModel = view.models.length
      ? byRuntime.filter((c) => c.messages.some((m) => m.model && view.models.includes(m.model.id)))
      : byRuntime;
    return view.sort === "created" ? [...byModel].sort((a, b) => b.createdAt - a.createdAt) : byModel;
  }, [chats, view.models, view.sort, view.subagents, view.runtime, activeChatId]);

  const [remoteHits, setRemoteHits] = useState<{ query: string; hits: SearchHit[] }>();
  useEffect(() => {
    if (!deferredQuery || isHosted()) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      void fetch("/api/chats/search", { method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ query: deferredQuery }) })
        .then(r => { if (!r.ok) throw new Error("Search failed"); return r.json(); })
        .then(body => setRemoteHits({ query: deferredQuery, hits: body.hits }))
        .catch(() => {});
    }, 250);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [deferredQuery, chats]);
  const hits = useMemo(() => {
    if (!deferredQuery) return [];
    const local = searchChats(visible, deferredQuery);
    if (remoteHits?.query !== deferredQuery) return local;
    const shown = new Map(visible.map(c => [c.id, c]));
    const merged = new Map(remoteHits.hits.filter(h => shown.has(h.chat.id)).map(h => [h.chat.id, { ...h, chat: shown.get(h.chat.id)! }]));
    for (const hit of local) merged.set(hit.chat.id, hit);
    return [...merged.values()].sort((a, b) => b.score - a.score || b.chat.updatedAt - a.chat.updatedAt);
  }, [visible, deferredQuery, remoteHits]);
  // Snoozed threads leave every other section until they wake.
  const awake = useMemo(() => visible.filter((c) => !c.snoozedUntil), [visible]);
  const snoozed = useMemo(() => visible.filter((c) => c.snoozedUntil).sort((a, b) => a.snoozedUntil! - b.snoozedUntil!), [visible]);
  // Closing a thread unpins it, so a closed thread that is pinned was pinned from search or "Closed": it belongs here.
  const pinned = useMemo(() => (view.includePinned ? awake.filter((c) => c.pinned) : []), [awake, view.includePinned]);
  // Pinned threads keep their spot. A thread blocked on a question from the user lives in "Attention".
  // One cut off by a usage limit or an empty balance lives in "Limits", not "Done": its work isn't finished.
  // Everything else that is generating lives in "Working", then
  // stays in "Done" until the user closes it; a snooze that ran out stays in "Woke" the same way.
  // The rest are under "Closed".
  const rest = useMemo(() => awake.filter((c) => !isClosed(c, today) && !(c.pinned && view.includePinned)), [awake, view.includePinned, today]);
  // Subagent threads, when listed, keep to their own section, working or not.
  const subagents = useMemo(() => rest.filter((c) => c.subagent), [rest]);
  const attention = useMemo(() => rest.filter((c) => !c.subagent && isWaiting(c)), [rest]);
  const working = useMemo(() => rest.filter((c) => !c.subagent && isWorking(c) && !isWaiting(c)), [rest]);
  const limits = useMemo(() => rest.filter((c) => !c.subagent && limitOf(c)), [rest]);
  const woke = useMemo(() => rest.filter((c) => !c.subagent && !isWorking(c) && !limitOf(c) && c.woke), [rest]);
  const done = useMemo(() => rest.filter((c) => !c.subagent && !isWorking(c) && !limitOf(c) && !c.woke && c.done), [rest]);
  const closed = useMemo(() => awake.filter((c) => isClosed(c, today) && !(c.pinned && view.includePinned)), [awake, view.includePinned, today]);

  // What's on screen, in order. Collapsed sections don't count, unless the open thread is in one.
  useEffect(() => {
    const listed = deferredQuery
      ? hits.map((h) => h.chat)
      : closedView
        ? closed
        : (
            [
              [pinned, sections.pinned],
              [attention, sections.attention],
              [limits, sections.limits],
              [subagents, sections.subagents],
              [woke, sections.woke],
              [done, sections.done],
              [working, sections.working],
              [snoozed, sections.snoozed],
              [closed, sections.closed],
            ] as const
          ).flatMap(([list, open]) => (open || list.some((c) => c.id === activeChatId) ? list : []));
    threadOrder = listed.map((c) => c.id);
  });

  // Snoozes that run out, now or while the app was closed, wake their threads into "Woke".
  useEffect(() => {
    const next = Math.min(...chats.map((c) => c.snoozedUntil ?? Infinity));
    if (next === Infinity) return;
    const wake = () => {
      for (const c of useStore.getState().chats) {
        if (!c.snoozedUntil || c.snoozedUntil > Date.now()) continue;
        expectLanding(c.id, "open");
        updateChat(c.id, wokePatch);
      }
    };
    // Timers can't wait longer than about 24 days; the effect re-arms after each wake anyway.
    const timer = setTimeout(wake, Math.min(Math.max(0, next - Date.now()), 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [chats, updateChat]);

  // A reply that finishes while the app is open moves its thread into "Done" (see finishedWork).
  const workingIds = useRef<Map<string, boolean>>(undefined);
  useEffect(() => {
    const { working, done } = finishedWork(workingIds.current, chats);
    for (const id of done) updateChat(id, { done: true, archived: false });
    workingIds.current = working;
  }, [chats, updateChat]);
  const filtered = view.models.length > 0 || view.runtime !== "all";

  const usageOpen = useStore((s) => s.usageOpen);
  const setUsageOpen = useStore((s) => s.setUsageOpen);

  // Clearing the search also clears in-chat highlights.
  useEffect(() => {
    if (!query.trim()) setSearchFocus(undefined);
  }, [query, setSearchFocus]);

  const onSelect = useCallback(
    (c: Chat, hit?: SearchHit, then?: () => void) => {
      const open = () => {
        // Prefetched while the row was pointed at: it opens with its messages, not "Loading thread…".
        const full = historyAtHand(c);
        if (full) adoptHistory(c, full);
        selectChat(c.id);
        if (hit?.snippet) setSearchFocus({ chatId: c.id, messageId: hit.snippet.messageId, words: hit.words });
        then?.();
      };
      if (!mobile) return open();
      // The drawer answers the tap first: it slides on the compositor while the thread renders behind
      // it, instead of sitting still until a long thread has finished.
      flushSync(() => setSidebarOpen(false));
      requestAnimationFrame(() => setTimeout(open));
    },
    [mobile, selectChat, setSearchFocus, setSidebarOpen],
  );
  const onMenu = useCallback(
    (chatId: string, x: number, y: number, fromButton?: boolean, snooze?: boolean) =>
      setMenu((m) => (fromButton && m?.chatId === chatId && !m.snooze === !snooze ? undefined : { chatId, x, y, end: fromButton, snooze })),
    [],
  );
  const onRenameDone = useCallback(() => setRenamingId(undefined), []);
  const onRegenerate = useCallback((id: string) => {
    setRegenerating((ids) => new Set(ids).add(id));
    void regenerateTitle(id).then((ok) => {
      setRegenerating((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
      if (!ok) window.alert("Couldn't regenerate the title. Check the text generation models in Settings.");
    });
  }, []);

  const row = (c: Chat, hit?: SearchHit) => (
    <ChatRow
      key={c.id}
      chat={c}
      hit={hit}
      active={c.id === activeChatId}
      renaming={renamingId === c.id}
      regenerating={regenerating.has(c.id)}
      onRenameDone={onRenameDone}
      onMenu={onMenu}
      onSelect={onSelect}
    />
  );

  return (
    <>
      <div className={cx("sidebar-scrim", open && mobile && "sidebar-scrim-visible")} onClick={() => setSidebarOpen(false)} aria-hidden />
      <aside ref={sidebarRef} className={cx("sidebar", open ? "sidebar-open" : "sidebar-closed")} aria-hidden={!open} inert={!open}>
        <div className="sidebar-inner">
          <div className="brand-row">
            <IconButton label="Close sidebar" tooltip="Close sidebar" onClick={() => setSidebarOpen(false)}>
              <PanelIcon />
            </IconButton>
            {mobile ? <span className="wordmark">OpenBuild</span> : <ModeSwitch />}
            {!mobile && (
              <IconButton
                label="Search"
                aria-pressed={searching}
                className={cx(searching && "filter-active")}
                // Keeps focus in the field, so pressing this to close it isn't first a blur that closes
                // it and then a click that opens it again.
                onMouseDown={(e) => searching && e.preventDefault()}
                onClick={() => {
                  setSearching(!searching);
                  setQuery("");
                }}
              >
                <SearchIcon />
              </IconButton>
            )}
            <FilterMenu />
          </div>
          <PluginSlot name="sidebar:header" />

          <button
            type="button"
            className="new-chat"
            onClick={() => {
              newChat();
              if (mobile) setSidebarOpen(false);
            }}
          >
            <span className="new-chat-icon">
              <SquarePen size={16} />
            </span>
            New thread
          </button>

          {(searching || mobile) && (
            <label className="search">
              <Search size={14} />
              <input
                ref={searchField}
                type="text"
                value={query}
                placeholder="Search threads…"
                aria-label="Search threads"
                autoFocus={!mobile}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && (query ? setQuery("") : setSearching(false))}
                // Clicking away from an empty search closes it; with something typed, it stays.
                onBlur={(e) => {
                  if (!mobile && !e.currentTarget.value.trim() && !e.currentTarget.closest(".search")?.contains(e.relatedTarget)) setSearching(false);
                }}
              />
              {query && (
                // Clearing it leaves you in it, to type again; clicking away from it empty then closes it.
                <button
                  type="button"
                  className="search-clear"
                  aria-label="Clear search"
                  onClick={() => {
                    setQuery("");
                    searchField.current?.focus();
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </label>
          )}

          <div className="sidebar-divider" />

          <div className="history-wrap">
          <ScrollThumb target={historyRef} />
          <nav ref={historyRef} className="history" aria-label="Thread history">
            {deferredQuery ? (
              <section className="history-group history-results">
                <h3 className="history-heading">{hits.length ? <>Results{" "}<span className="history-count">{hits.length}</span></> : "Results"}</h3>
                {hits.map((h) => row(h.chat, h))}
                {!hits.length && <p className="history-empty">No threads match “{deferredQuery}”.</p>}
              </section>
            ) : closedView ? (
              <section className="history-group">
                <h3 className="history-heading">Closed{" "}<span className="history-count">{closed.length}</span></h3>
                {closed.map((c) => row(c))}
                {!closed.length && <p className="history-empty">No closed threads.</p>}
              </section>
            ) : (
              <>
                {pinned.length > 0 && (
                  <Collapsible label="Pinned" open={sections.pinned} onToggle={() => toggleSection("pinned")} chats={pinned} row={row} />
                )}
                {attention.length > 0 && (
                  <Collapsible label="Attention" open={sections.attention} onToggle={() => toggleSection("attention")} chats={attention} row={row} />
                )}
                {limits.length > 0 && (
                  <Collapsible label="Limits" open={sections.limits} onToggle={() => toggleSection("limits")} chats={limits} row={row} />
                )}
                {subagents.length > 0 && (
                  <Collapsible label="Subagents" open={sections.subagents} onToggle={() => toggleSection("subagents")} chats={subagents} row={row} />
                )}
                {woke.length > 0 && (
                  <Collapsible label="Woke" open={sections.woke} onToggle={() => toggleSection("woke")} chats={woke} row={row} />
                )}
                {done.length > 0 && (
                  <Collapsible label="Done" open={sections.done} onToggle={() => toggleSection("done")} chats={done} row={row} />
                )}
                {working.length > 0 && (
                  <Collapsible label="Working" open={sections.working} onToggle={() => toggleSection("working")} chats={working} row={row} />
                )}
                {snoozed.length > 0 && (
                  <Collapsible label="Snoozed" open={sections.snoozed} onToggle={() => toggleSection("snoozed")} chats={snoozed} row={row} />
                )}
                {filtered && !pinned.length && !attention.length && !limits.length && !subagents.length && !woke.length && !done.length && !working.length && !snoozed.length && !closed.length && (
                  <p className="history-empty">
                    {view.runtime === "all"
                      ? "No threads with the selected models."
                      : `No ${view.runtime === "hermes" ? "Hermes" : view.runtime === "grok" ? "Grok" : view.runtime === "opencode" ? "OpenCode" : view.runtime === "claude" ? "Claude Code" : view.runtime === "cursor" ? "Cursor" : view.runtime === "pi" ? "Pi" : view.runtime === "fx" ? "fx" : view.runtime === "codex" ? "Codex" : "Durable"} threads${view.models.length ? " with the selected models" : ""}.`}
                  </p>
                )}
                {closed.length > 0 && (
                  <Collapsible label="Closed" open={sections.closed} onToggle={() => toggleSection("closed")} chats={closed} row={row} bottom />
                )}
              </>
            )}
          </nav>
          </div>

          <PluginSlot name="sidebar:footer" />

          <div className="settings-row">
            <button type="button" className="settings-btn" onClick={() => openSettings()}>
              <Avatar src={avatar} name={name} size={22} />
              Settings
            </button>
            <button
              type="button"
              className={`usage-toggle${usageOpen ? " active" : ""}`}
              aria-label="Usage"
              aria-current={usageOpen ? "page" : undefined}
              data-tooltip="Usage and limits"
              data-tooltip-side="top"
              onPointerEnter={() => prefetchUsage()}
              onFocus={() => prefetchUsage()}
              // A page with its own way back, not a switch: it opens Usage (on a phone, over the list).
              onClick={() => setUsageOpen(true)}
            >
              <ChartNoAxesColumn size={16} />
            </button>
            <button
              type="button"
              className={`archive-toggle${closedView ? " active" : ""}`}
              aria-label={closedView ? "Back to threads" : "Only show closed threads"}
              aria-pressed={closedView}
              data-tooltip={closedView ? "Back to threads" : "Only show closed threads"}
              data-tooltip-side="top"
              onClick={() => setClosedView((v) => !v)}
            >
              <SquareCheck size={16} />
            </button>
            {/* On a desktop the header's switch does this; a phone's drawer keeps its wordmark. */}
            {mobile && <BotsToggle />}
          </div>
        </div>
      </aside>
      <ChatContextMenu state={menu} sidebarRef={sidebarRef} onClose={closeMenu} onRename={setRenamingId} onRegenerate={onRegenerate} onDelete={setDeletingId} onSnooze={setSnoozingId} />
      {deleting && <DeleteThreadDialog chat={deleting} onClose={() => setDeletingId(undefined)} />}
      {snoozing && <SnoozeDialog chat={snoozing} onClose={() => setSnoozingId(undefined)} />}
    </>
  );
}
