import { AlarmClock, AlarmClockCheck, Bot, CalendarDays, ChartNoAxesColumn, Check, ChevronDown, ChevronRight, Clock, ClockArrowUp, Copy, Ellipsis, FileText, Fingerprint, GitBranch, ExternalLink, FolderX, Layers, ListFilter, Minus, MessageCircle, PanelLeft, Pencil, Pin, PinOff, Plus, RotateCcw, Search, SquareArrowUp, SquareCheck, SquarePen, Trash, X } from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { stopGeneration } from "../lib/chat";
import { removeWorktree } from "../lib/pi";
import { threadPath } from "../lib/routes";
import { mergeRanges, searchChats, type Range, type SearchHit } from "../lib/search";
import { DEFAULT_VIEW, useStore } from "../lib/store";
import { prefetchUsage } from "../lib/usageStats";
import type { Chat } from "../lib/types";
import type { Device } from "../../shared/types";
import { arrowNav, copyText, cx, useDismiss, useMediaQuery, usePresence } from "../lib/ui";
import { Avatar, BrandIcon, OpencodeMark, ClaudeMark, CodexMark, DurableMark, FxMark, IconButton, PiMark, Popover, CursorMark, Spinner } from "./primitives";
import { PluginSlot } from "../lib/plugins";
import { ChoiceField, DateField, TimeField } from "./DateTimeFields";

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

/** Midnight at the start of today. */
const startOfToday = () => new Date().setHours(0, 0, 0, 0);

/** Closed by the user, or a thread from before today that isn't pinned, working, done or woken. */
const isClosed = (chat: Chat, today = startOfToday()) =>
  !!chat.archived || (!chat.pinned && !chat.done && !chat.woke && !isWorking(chat) && chat.updatedAt < today);

/** Closing a thread files it under "Closed" (and unpins it); reopening one puts it back in "Done". */
const closePatch = (chat: Chat, today?: number) =>
  isClosed(chat, today) ? { archived: false, done: true } : { archived: true, done: false, woke: false, snoozedUntil: undefined, pinned: false };

/** Snoozing hides a thread under "Snoozed"; waking it by hand puts it back where it was. */
const snoozePatch = (until: number) => ({ snoozedUntil: until, woke: false });
const wakePatch = { snoozedUntil: undefined };
/** A snooze that runs out on its own surfaces the thread under "Woke", even if it was closed. */
const wokePatch = { snoozedUntil: undefined, woke: true, archived: false };

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

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

/** Start of today, refreshed at midnight so the day's threads roll over into "Closed". */
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

interface RowProps {
  chat: Chat;
  active: boolean;
  hit?: SearchHit;
  renaming: boolean;
  onSelect: (chat: Chat, hit?: SearchHit) => void;
  onMenu: (chatId: string, x: number, y: number, fromButton?: boolean) => void;
  onRenameDone: () => void;
}

/**
 * Long-press on touch screens opens the row's menu. iOS Safari never fires `contextmenu`, and
 * Android fires it too, so whichever comes first opens the menu and the click after it is dropped.
 */
function useLongPress(open: (x: number, y: number) => void) {
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
        timer.current = setTimeout(() => fire(x, y), 450);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 8) cancel();
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

/**
 * The device a row names: a paired device always, this one only once others are paired (otherwise
 * every row would say the same thing). Undefined: no label.
 */
function rowDevice(devices: Device[], deviceId: string | undefined): string | undefined {
  if (deviceId) return devices.find((d) => d.id === deviceId)?.name ?? "unpaired device";
  if (!devices.some((d) => !d.local)) return undefined;
  return devices.find((d) => d.local)?.name;
}

const ChatRow = memo(function ChatRow({ chat, active, hit, renaming, onSelect, onMenu, onRenameDone }: RowProps) {
  const updateChat = useStore((s) => s.updateChat);
  const streaming = chat.messages.at(-1)?.status === "streaming";
  const waiting = isWaiting(chat);
  const closed = isClosed(chat);
  const model = modelOf(chat);
  const runtime = chat.runtime ?? "pi";
  const device = useStore((s) => rowDevice(s.devices, chat.workspace?.deviceId));
  const [draft, setDraft] = useState(chat.title);
  const input = useRef<HTMLInputElement>(null);
  const longPress = useLongPress((x, y) => onMenu(chat.id, x, y));

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
      <button type="button" className="history-title" onClick={() => onSelect(chat, hit)} aria-current={active ? "page" : undefined} title={chat.title}>
        <span className="history-title-line">
          <span className="history-icon" title={model?.name}>
            {model ? <BrandIcon id={model.id} /> : <MessageCircle size={15} />}
          </span>
          <span className="history-title-text">{hit ? <Highlight text={chat.title} ranges={hit.titleRanges} /> : chat.title}</span>
          {chat.subagent && (
            <span className="history-subagent" title="Subagent" aria-label="Subagent">
              <Bot size={13} />
            </span>
          )}
          {hit && isClosed(chat) && <span className="badge">closed</span>}
          <span className="history-status">
            {waiting ? (
              <Spinner size={13} waiting />
            ) : streaming ? (
              <Spinner size={13} />
            ) : chat.snoozedUntil ? (
              <span className="history-snooze" title={`Snoozed until ${new Date(chat.snoozedUntil).toLocaleString()}`}>
                <AlarmClock size={12} />
                {snoozeLabel(chat.snoozedUntil)}
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
              {chat.workspace.projectName}
            </span>
          )}
          {device && (
            <span className="history-device" title={`Runs on ${device}`}>
              @ {device}
            </span>
          )}
          <span className="history-runtime" title={runtime === "opencode" ? "Native OpenCode runtime" : runtime === "claude" ? "Native Claude Code runtime" : runtime === "cursor" ? "Native Cursor runtime" : runtime === "durable" ? "Durable runtime" : runtime === "fx" ? "fx runtime" : runtime === "codex" ? "Native Codex runtime" : "Pi runtime"}>
            {runtime === "opencode" ? <OpencodeMark size={14} /> : runtime === "claude" ? <ClaudeMark size={14} /> : runtime === "cursor" ? <CursorMark size={14} /> : runtime === "durable" ? <DurableMark size={14} /> : runtime === "fx" ? <FxMark size={14} /> : runtime === "codex" ? <CodexMark size={14} /> : <PiMark size={14} />}
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
          <IconButton label="Wake" tooltipSide="top" className="history-action" onClick={() => updateChat(chat.id, wakePatch)}>
            <ClockArrowUp size={14} />
          </IconButton>
        ) : (
          <IconButton
            label={closed ? "Reopen" : "Close"}
            tooltipSide="top"
            className="history-action"
            onClick={() => updateChat(chat.id, closePatch(chat))}
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
function ScrollThumb({ target }: { target: React.RefObject<HTMLElement | null> }) {
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

/** Section whose header toggles its rows with a height animation. */
function Collapsible({ label, open, onToggle, children }: { label: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <section className="history-group">
      <button type="button" className="history-heading history-heading-toggle" aria-expanded={open} onClick={onToggle}>
        {label}
        <ChevronDown size={14} className="history-heading-chevron" />
      </button>
      <div className={cx("collapse", open && "collapse-open")} inert={!open}>
        <div className="collapse-inner">{children}</div>
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
}

/** Delete a thread for good, stopping any reply still running. */
function deleteThread(id: string) {
  stopGeneration(id);
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
  const updateChat = useStore((s) => s.updateChat);
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
          updateChat(chat.id, snoozePatch(until));
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
  onDelete,
  onSnooze,
}: {
  state?: MenuState;
  sidebarRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onRename: (id: string) => void;
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
  const [sub, setSub] = useState<"copy" | "snooze">();
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
  const flyout = (id: "copy" | "snooze", icon: React.ReactNode, label: string, items: React.ReactNode) => (
    <div className="filter-row" onMouseEnter={() => setSub(id)}>
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
      aria-label={`Actions for ${chat.title}`}
      className="popover menu context-menu"
      data-state={visible && pos ? "open" : "closed"}
      style={{ position: "fixed", left: pos?.left ?? state?.x, top: pos?.top ?? state?.y, transformOrigin: pos?.origin }}
      onKeyDown={(e) => arrowNav(e, ":scope > button, :scope > .filter-row > button")}
      onContextMenu={(e) => e.preventDefault()}
      // Like a native menu, a submenu stays open until another item is hovered.
      onMouseOver={(e) => {
        const item = (e.target as Element).closest(".menu-item");
        if (item && !item.closest(".filter-row")) setSub(undefined);
      }}
    >
      <button type="button" role="menuitem" className="menu-item" onClick={act(() => window.open(chatUrl(chat.id), "_blank", "noopener"))}>
        <ExternalLink size={15} /> Open in new tab
      </button>
      <button type="button" role="menuitem" className="menu-item" onClick={act(() => onRename(chat.id))}>
        <Pencil size={15} /> Rename
      </button>
      <button
        type="button"
        role="menuitem"
        className="menu-item"
        onClick={act(() => updateChat(chat.id, closePatch(chat)))}
      >
        {isClosed(chat) ? <SquareArrowUp size={15} /> : <Check size={15} />} {isClosed(chat) ? "Reopen" : "Close"}
      </button>
      {chat.snoozedUntil ? (
        <button type="button" role="menuitem" className="menu-item" onClick={act(() => updateChat(chat.id, wakePatch))}>
          <ClockArrowUp size={15} /> Wake
        </button>
      ) : (
        flyout(
          "snooze",
          <AlarmClock size={15} />,
          "Snooze",
          <>
            {snoozeOptions().map((o) => (
              <button key={o.label} type="button" role="menuitem" className="menu-item" onClick={act(() => updateChat(chat.id, snoozePatch(o.until)))}>
                <span className="menu-item-label">{o.label}</span>
                <span className="menu-item-hint">{o.hint}</span>
              </button>
            ))}
            <div className="menu-sep" />
            <button type="button" role="menuitem" className="menu-item" onClick={act(() => onSnooze(chat.id))}>
              <span className="menu-item-label">Custom…</span>
            </button>
          </>,
        )
      )}
      <button type="button" role="menuitem" className="menu-item" onClick={act(() => updateChat(chat.id, { pinned: !chat.pinned }))}>
        {chat.pinned ? <PinOff size={15} /> : <Pin size={15} />} {chat.pinned ? "Unpin" : "Pin"}
      </button>
      {flyout(
        "copy",
        <Copy size={15} />,
        "Copy",
        <>
          <button type="button" role="menuitem" className="menu-item" onClick={act(() => copyText(chat.id))}>
            <Fingerprint size={15} /> Session ID
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={act(() => copyText(chatMarkdown(chat)))}>
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
  ["all", "All runtimes"],
  ["pi", "Pi"],
  ["durable", "Durable"],
  ["fx", "fx"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  ["claude", "Claude Code"],
  ["opencode", "OpenCode"],
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
    <div className="filter-row" onMouseEnter={() => setSub(id)}>
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
        <ListFilter size={18} />
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
            "Runtime",
            view.runtime === "all" ? "All" : view.runtime === "opencode" ? "OpenCode" : view.runtime === "claude" ? "Claude Code" : view.runtime === "cursor" ? "Cursor" : view.runtime === "durable" ? "Durable" : view.runtime === "fx" ? "fx" : view.runtime === "codex" ? "Codex" : "Pi",
            <>
              <div className="menu-label">Runtime</div>
              {RUNTIME_FILTERS.map(([value, label]) => (
                <button key={value} type="button" role="menuitemradio" aria-checked={view.runtime === value} className="menu-item" onClick={() => setView({ runtime: value })}>
                  {value === "opencode" ? <OpencodeMark size={15} /> : value === "claude" ? <ClaudeMark size={15} /> : value === "cursor" ? <CursorMark size={15} /> : value === "all" ? <Layers size={15} /> : value === "pi" ? <PiMark size={15} /> : value === "fx" ? <FxMark size={15} /> : value === "codex" ? <CodexMark size={15} /> : <DurableMark size={15} />}
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
            onMouseEnter={() => setSub(undefined)}
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
            onMouseEnter={() => setSub(undefined)}
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
              <button type="button" role="menuitem" className="menu-item filter-reset" onMouseEnter={() => setSub(undefined)} onClick={() => setView(DEFAULT_VIEW)}>
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
  const deferredQuery = useDeferredValue(query.trim());
  const [menu, setMenu] = useState<MenuState>();
  const [renamingId, setRenamingId] = useState<string>();
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const [deletingId, setDeletingId] = useState<string>();
  const deleting = useStore((s) => s.chats.find((c) => c.id === deletingId));
  const [snoozingId, setSnoozingId] = useState<string>();
  const snoozing = useStore((s) => s.chats.find((c) => c.id === snoozingId));

  const sections = useStore((s) => s.sections);
  const toggleSection = useStore((s) => s.toggleSection);
  const [closedView, setClosedView] = useState(false);
  const historyRef = useRef<HTMLElement>(null);
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

  const hits = useMemo(() => (deferredQuery ? searchChats(visible, deferredQuery) : []), [visible, deferredQuery]);
  // Snoozed threads leave every other section until they wake.
  const awake = useMemo(() => visible.filter((c) => !c.snoozedUntil), [visible]);
  const snoozed = useMemo(() => visible.filter((c) => c.snoozedUntil).sort((a, b) => a.snoozedUntil! - b.snoozedUntil!), [visible]);
  const pinned = useMemo(() => (view.includePinned ? awake.filter((c) => c.pinned && !c.archived) : []), [awake, view.includePinned]);
  // Pinned threads keep their spot. Everything else that is generating lives in "Working", then
  // stays in "Done" until the user closes it; a snooze that ran out stays in "Woke" the same way.
  // Other threads from today are under "Today", and the rest (closed, or from an earlier day) under "Closed".
  const rest = useMemo(() => awake.filter((c) => !isClosed(c, today) && !(c.pinned && view.includePinned)), [awake, view.includePinned, today]);
  // Subagent threads, when listed, keep to their own section, working or not.
  const subagents = useMemo(() => rest.filter((c) => c.subagent), [rest]);
  const working = useMemo(() => rest.filter((c) => !c.subagent && isWorking(c)), [rest]);
  const woke = useMemo(() => rest.filter((c) => !c.subagent && !isWorking(c) && c.woke), [rest]);
  const done = useMemo(() => rest.filter((c) => !c.subagent && !isWorking(c) && !c.woke && c.done), [rest]);
  const todays = useMemo(() => rest.filter((c) => !c.subagent && !isWorking(c) && !c.woke && !c.done), [rest]);
  const closed = useMemo(() => awake.filter((c) => isClosed(c, today) && !(c.pinned && view.includePinned)), [awake, view.includePinned, today]);

  // Snoozes that run out, now or while the app was closed, wake their threads into "Woke".
  useEffect(() => {
    const next = Math.min(...chats.map((c) => c.snoozedUntil ?? Infinity));
    if (next === Infinity) return;
    const wake = () => {
      for (const c of useStore.getState().chats) if (c.snoozedUntil && c.snoozedUntil <= Date.now()) updateChat(c.id, wokePatch);
    };
    // Timers can't wait longer than about 24 days; the effect re-arms after each wake anyway.
    const timer = setTimeout(wake, Math.min(Math.max(0, next - Date.now()), 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [chats, updateChat]);

  // A reply that finishes while the app is open moves its thread into "Done", reopening it if it was
  // closed. (The server marks replies that finish elsewhere; see server/pi/projection.ts.)
  const workingIds = useRef<Set<string>>(undefined);
  useEffect(() => {
    const now = new Set(chats.filter(isWorking).map((c) => c.id));
    for (const id of workingIds.current ?? []) {
      const c = chats.find((c) => c.id === id);
      if (c && !now.has(id) && (!c.done || c.archived)) updateChat(id, { done: true, archived: false });
    }
    workingIds.current = now;
  }, [chats, updateChat]);
  const filtered = view.models.length > 0 || view.runtime !== "all";

  const usageOpen = useStore((s) => s.usageOpen);
  const setUsageOpen = useStore((s) => s.setUsageOpen);

  // Clearing the search also clears in-chat highlights.
  useEffect(() => {
    if (!query.trim()) setSearchFocus(undefined);
  }, [query, setSearchFocus]);

  const onSelect = useCallback(
    (c: Chat, hit?: SearchHit) => {
      selectChat(c.id);
      if (hit?.snippet) setSearchFocus({ chatId: c.id, messageId: hit.snippet.messageId, words: hit.words });
      if (mobile) setSidebarOpen(false);
    },
    [mobile, selectChat, setSearchFocus, setSidebarOpen],
  );
  const onMenu = useCallback(
    (chatId: string, x: number, y: number, fromButton?: boolean) =>
      setMenu((m) => (fromButton && m?.chatId === chatId ? undefined : { chatId, x, y, end: fromButton })),
    [],
  );
  const onRenameDone = useCallback(() => setRenamingId(undefined), []);

  const row = (c: Chat, hit?: SearchHit) => (
    <ChatRow
      key={c.id}
      chat={c}
      hit={hit}
      active={c.id === activeChatId}
      renaming={renamingId === c.id}
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
              <PanelLeft size={18} />
            </IconButton>
            <span className="wordmark">OpenBuild</span>
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
              <SquarePen size={15} />
            </span>
            New thread
          </button>

          <label className="search">
            <Search size={16} />
            <input
              type="text"
              value={query}
              placeholder="Search threads…"
              aria-label="Search threads"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            />
            {query && (
              <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
                <X size={14} />
              </button>
            )}
          </label>

          <div className="sidebar-divider" />

          <div className="history-wrap">
          <ScrollThumb target={historyRef} />
          <nav ref={historyRef} className="history" aria-label="Thread history">
            {deferredQuery ? (
              <section className="history-group">
                <h3 className="history-heading">{hits.length ? `${hits.length} result${hits.length === 1 ? "" : "s"}` : "Results"}</h3>
                {hits.map((h) => row(h.chat, h))}
                {!hits.length && <p className="history-empty">No threads match “{deferredQuery}”.</p>}
              </section>
            ) : closedView ? (
              <section className="history-group">
                <h3 className="history-heading">{`Closed (${closed.length})`}</h3>
                {closed.map((c) => row(c))}
                {!closed.length && <p className="history-empty">No closed threads.</p>}
              </section>
            ) : (
              <>
                {pinned.length > 0 && (
                  <Collapsible label={`Pinned (${pinned.length})`} open={sections.pinned} onToggle={() => toggleSection("pinned")}>
                    {pinned.map((c) => row(c))}
                  </Collapsible>
                )}
                {subagents.length > 0 && (
                  <Collapsible label={`Subagents (${subagents.length})`} open={sections.subagents} onToggle={() => toggleSection("subagents")}>
                    {subagents.map((c) => row(c))}
                  </Collapsible>
                )}
                {woke.length > 0 && (
                  <Collapsible label={`Woke (${woke.length})`} open={sections.woke} onToggle={() => toggleSection("woke")}>
                    {woke.map((c) => row(c))}
                  </Collapsible>
                )}
                {done.length > 0 && (
                  <Collapsible label={`Done (${done.length})`} open={sections.done} onToggle={() => toggleSection("done")}>
                    {done.map((c) => row(c))}
                  </Collapsible>
                )}
                {working.length > 0 && (
                  <Collapsible label={`Working (${working.length})`} open={sections.working} onToggle={() => toggleSection("working")}>
                    {working.map((c) => row(c))}
                  </Collapsible>
                )}
                {todays.length > 0 && (
                  <Collapsible label={`Today (${todays.length})`} open={sections.today} onToggle={() => toggleSection("today")}>
                    {todays.map((c) => row(c))}
                  </Collapsible>
                )}
                {snoozed.length > 0 && (
                  <Collapsible label={`Snoozed (${snoozed.length})`} open={sections.snoozed} onToggle={() => toggleSection("snoozed")}>
                    {snoozed.map((c) => row(c))}
                  </Collapsible>
                )}
                {filtered && !pinned.length && !subagents.length && !woke.length && !done.length && !working.length && !todays.length && !snoozed.length && !closed.length && (
                  <p className="history-empty">
                    {view.runtime === "all"
                      ? "No threads with the selected models."
                      : `No ${view.runtime === "opencode" ? "OpenCode" : view.runtime === "claude" ? "Claude Code" : view.runtime === "cursor" ? "Cursor" : view.runtime === "pi" ? "Pi" : view.runtime === "fx" ? "fx" : view.runtime === "codex" ? "Codex" : "Durable"} threads${view.models.length ? " with the selected models" : ""}.`}
                  </p>
                )}
                {closed.length > 0 && (
                  <Collapsible label={`Closed (${closed.length})`} open={sections.closed} onToggle={() => toggleSection("closed")}>
                    {closed.map((c) => row(c))}
                  </Collapsible>
                )}
              </>
            )}
          </nav>
          </div>

          <PluginSlot name="sidebar:footer" />

          <div className="settings-row">
            <button type="button" className="settings-btn" onClick={() => openSettings()}>
              <Avatar src={avatar} name={name} size={26} />
              Settings
            </button>
            <button
              type="button"
              className={`usage-toggle${usageOpen ? " active" : ""}`}
              aria-label="Usage"
              aria-pressed={usageOpen}
              data-tooltip="Usage and limits"
              data-tooltip-side="top"
              onPointerEnter={() => prefetchUsage()}
              onFocus={() => prefetchUsage()}
              onClick={() => {
                setUsageOpen(!usageOpen);
                if (mobile && !usageOpen) setSidebarOpen(false);
              }}
            >
              <ChartNoAxesColumn size={18} />
            </button>
            <button
              type="button"
              className={`archive-toggle${closedView ? " active" : ""}`}
              aria-label={closedView ? "Back to threads" : "Show closed threads"}
              aria-pressed={closedView}
              title={closedView ? "Back to threads" : "Closed threads"}
              onClick={() => setClosedView((v) => !v)}
            >
              <SquareCheck size={18} />
            </button>
          </div>
        </div>
      </aside>
      <ChatContextMenu state={menu} sidebarRef={sidebarRef} onClose={closeMenu} onRename={setRenamingId} onDelete={setDeletingId} onSnooze={setSnoozingId} />
      {deleting && <DeleteThreadDialog chat={deleting} onClose={() => setDeletingId(undefined)} />}
      {snoozing && <SnoozeDialog chat={snoozing} onClose={() => setSnoozingId(undefined)} />}
    </>
  );
}
