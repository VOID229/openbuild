import { Archive, ArchiveRestore, Bot, CalendarDays, Check, ChevronDown, ChevronRight, Clock, Copy, Ellipsis, FileText, Fingerprint, GitBranch, ExternalLink, FolderX, Layers, ListFilter, MessageCircle, PanelLeft, Pencil, Pin, PinOff, RotateCcw, Search, ShieldHalf, SquarePen, Trash, X } from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { stopGeneration } from "../lib/chat";
import { removeWorktree } from "../lib/pi";
import { threadPath } from "../lib/routes";
import { mergeRanges, searchChats, type Range, type SearchHit } from "../lib/search";
import { DEFAULT_VIEW, useStore } from "../lib/store";
import type { Chat } from "../lib/types";
import { arrowNav, copyText, cx, useDismiss, useMediaQuery, usePresence } from "../lib/ui";
import { Avatar, BrandIcon, IconButton, PiMark, Popover, Spinner } from "./primitives";
import { PluginSlot } from "../lib/plugins";

const DAY = 24 * 60 * 60 * 1000;

/** Recent chats split into the static date sections. */
function bucketChats(chats: Chat[], field: "updatedAt" | "createdAt") {
  const today = new Date().setHours(0, 0, 0, 0);
  const buckets: { label: string; chats: Chat[] }[] = [
    { label: "Today", chats: [] },
    { label: "Yesterday", chats: [] },
    { label: "Last 7 days", chats: [] },
    { label: "Older", chats: [] },
  ];
  for (const c of chats) {
    const t = c[field];
    buckets[t >= today ? 0 : t >= today - DAY ? 1 : t >= today - 7 * DAY ? 2 : 3]!.chats.push(c);
  }
  return buckets.filter((b) => b.chats.length);
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

const ChatRow = memo(function ChatRow({ chat, active, hit, renaming, onSelect, onMenu, onRenameDone }: RowProps) {
  const updateChat = useStore((s) => s.updateChat);
  const streaming = chat.messages.at(-1)?.status === "streaming";
  const waiting = isWaiting(chat);
  const model = modelOf(chat);
  const runtime = chat.runtime ?? "pi";
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
          {hit && chat.archived && <span className="badge">archived</span>}
          <span className="history-status">
            {waiting ? (
              <Spinner size={13} waiting />
            ) : streaming ? (
              <Spinner size={13} />
            ) : chat.unread ? (
              <span className="unread-dot" aria-label="New reply" />
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
          <span className="history-runtime" title={runtime === "durable" ? "Durable runtime" : "Pi runtime"}>
            {runtime === "durable" ? <ShieldHalf size={12} /> : <PiMark size={12} />}
          </span>
          {chat.workspace?.projectName && (
            <span className="history-proj" title={chat.workspace.worktree ? `${chat.workspace.projectName} · ${chat.workspace.branch}` : chat.workspace.projectName}>
              {chat.workspace.projectName}
            </span>
          )}
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
        <IconButton
          label={chat.archived ? "Unarchive" : "Archive"}
          tooltipSide="top"
          className="history-action"
          onClick={() => updateChat(chat.id, { archived: !chat.archived, pinned: chat.archived ? chat.pinned : false })}
        >
          {chat.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        </IconButton>
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

function ChatContextMenu({ state, onClose, onRename }: { state?: MenuState; onClose: () => void; onRename: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef(state);
  if (state) last.current = state;
  const current = last.current;
  const chat = useStore((s) => s.chats.find((c) => c.id === current?.chatId));
  const { updateChat, removeChat } = useStore.getState();
  const open = !!state;
  const { mounted, visible } = usePresence(open, 180);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string }>();
  const [confirm, setConfirm] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  useDismiss(open, onClose, [ref]);

  useLayoutEffect(() => {
    if (!open || !mounted || !state) return;
    setConfirm(false);
    setCopyOpen(false);
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
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, onClose]);

  if (!mounted || !chat) return null;
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
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
      // Like a native menu, the Copy submenu stays open until another item is hovered.
      onMouseOver={(e) => {
        const item = (e.target as Element).closest(".menu-item");
        if (item && !item.closest(".filter-row")) setCopyOpen(false);
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
        onClick={act(() => updateChat(chat.id, { archived: !chat.archived, pinned: chat.archived ? chat.pinned : false }))}
      >
        {chat.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />} {chat.archived ? "Unarchive" : "Archive"}
      </button>
      <button type="button" role="menuitem" className="menu-item" onClick={act(() => updateChat(chat.id, { pinned: !chat.pinned }))}>
        {chat.pinned ? <PinOff size={15} /> : <Pin size={15} />} {chat.pinned ? "Unpin" : "Pin"}
      </button>
      <div className="filter-row" onMouseEnter={() => setCopyOpen(true)}>
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={copyOpen}
          className={cx("menu-item", copyOpen && "menu-item-active")}
          onClick={() => setCopyOpen(!copyOpen)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight") return;
            e.preventDefault();
            setCopyOpen(true);
            requestAnimationFrame(() => e.currentTarget.parentElement?.querySelector<HTMLElement>(".filter-flyout button")?.focus());
          }}
        >
          <Copy size={15} />
          <span className="menu-item-label">Copy</span>
          <ChevronRight size={14} className="filter-chevron" />
        </button>
        {copyOpen && (
          <div
            className="popover menu filter-flyout"
            data-state="open"
            role="menu"
            aria-label="Copy"
            onKeyDown={(e) => {
              e.stopPropagation();
              arrowNav(e);
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                setCopyOpen(false);
                (e.currentTarget.parentElement?.firstElementChild as HTMLElement | null)?.focus();
              }
            }}
          >
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
          </div>
        )}
      </div>
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
        className={cx("menu-item menu-item-danger", confirm && "menu-item-confirm")}
        onClick={() => {
          if (!confirm) return setConfirm(true);
          stopGeneration(chat.id);
          removeChat(chat.id);
          onClose();
        }}
      >
        <Trash size={15} /> {confirm ? "Click again to delete" : "Delete"}
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
            view.runtime === "all" ? "All" : view.runtime === "durable" ? "Durable" : "Pi",
            <>
              <div className="menu-label">Runtime</div>
              {RUNTIME_FILTERS.map(([value, label]) => (
                <button key={value} type="button" role="menuitemradio" aria-checked={view.runtime === value} className="menu-item" onClick={() => setView({ runtime: value })}>
                  {value === "all" ? <Layers size={15} /> : value === "pi" ? <PiMark size={15} /> : <ShieldHalf size={15} />}
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

  const sections = useStore((s) => s.sections);
  const toggleSection = useStore((s) => s.toggleSection);
  const [archiveView, setArchiveView] = useState(false);

  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);

  // Model, runtime, subagent and sort filters from the filter menu and the runtime switch. A pinned or open subagent thread stays listed.
  const visible = useMemo(() => {
    const shown = view.subagents ? chats : chats.filter((c) => !c.subagent || c.pinned || c.id === activeChatId);
    const byRuntime = view.runtime === "all" ? shown : shown.filter((c) => (c.runtime ?? "pi") === view.runtime);
    const byModel = view.models.length
      ? byRuntime.filter((c) => c.messages.some((m) => m.model && view.models.includes(m.model.id)))
      : byRuntime;
    return view.sort === "created" ? [...byModel].sort((a, b) => b.createdAt - a.createdAt) : byModel;
  }, [chats, view.models, view.sort, view.subagents, view.runtime, activeChatId]);
  const field = view.sort === "created" ? "createdAt" : "updatedAt";

  const hits = useMemo(() => (deferredQuery ? searchChats(visible, deferredQuery) : []), [visible, deferredQuery]);
  const pinned = useMemo(() => (view.includePinned ? visible.filter((c) => c.pinned && !c.archived) : []), [visible, view.includePinned]);
  // Pinned threads keep their spot; everything else that is still generating lives in "Working"
  // (and moves to "Today" once its reply finishes).
  const rest = useMemo(() => visible.filter((c) => !c.archived && !(c.pinned && view.includePinned)), [visible, view.includePinned]);
  // Subagent threads, when listed, keep to their own section, working or not.
  const subagents = useMemo(() => rest.filter((c) => c.subagent), [rest]);
  const working = useMemo(() => rest.filter((c) => !c.subagent && isWorking(c)), [rest]);
  const buckets = useMemo(() => bucketChats(rest.filter((c) => !c.subagent && !isWorking(c)), field), [rest, field]);
  const archived = useMemo(() => visible.filter((c) => c.archived), [visible]);
  const filtered = view.models.length > 0 || view.runtime !== "all";

  // The bottom-right runtime switch cycles Pi → Durable → both.
  const nextRuntime = view.runtime === "all" ? "pi" : view.runtime === "pi" ? "durable" : "all";
  const runtimeLabel = view.runtime === "all" ? "All runtimes" : view.runtime === "pi" ? "Pi only" : "Durable only";
  const nextRuntimeLabel = nextRuntime === "all" ? "all runtimes" : nextRuntime === "pi" ? "Pi only" : "Durable only";

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
      <aside className={cx("sidebar", open ? "sidebar-open" : "sidebar-closed")} aria-hidden={!open} inert={!open}>
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

          <nav className="history" aria-label="Thread history">
            {deferredQuery ? (
              <section className="history-group">
                <h3 className="history-heading">{hits.length ? `${hits.length} result${hits.length === 1 ? "" : "s"}` : "Results"}</h3>
                {hits.map((h) => row(h.chat, h))}
                {!hits.length && <p className="history-empty">No threads match “{deferredQuery}”.</p>}
              </section>
            ) : archiveView ? (
              <section className="history-group">
                <h3 className="history-heading">{`Archived (${archived.length})`}</h3>
                {archived.map((c) => row(c))}
                {!archived.length && <p className="history-empty">No archived threads.</p>}
              </section>
            ) : (
              <>
                {pinned.length > 0 && (
                  <Collapsible label="Pinned" open={sections.pinned} onToggle={() => toggleSection("pinned")}>
                    {pinned.map((c) => row(c))}
                  </Collapsible>
                )}
                {subagents.length > 0 && (
                  <section className="history-group">
                    <h3 className="history-heading">Subagents</h3>
                    {subagents.map((c) => row(c))}
                  </section>
                )}
                {working.length > 0 && (
                  <section className="history-group">
                    <h3 className="history-heading">Working</h3>
                    {working.map((c) => row(c))}
                  </section>
                )}
                {buckets.map((b) => (
                  <section key={b.label} className="history-group">
                    <h3 className="history-heading">{b.label}</h3>
                    {b.chats.map((c) => row(c))}
                  </section>
                ))}
                {filtered && !pinned.length && !subagents.length && !working.length && !buckets.length && !archived.length && (
                  <p className="history-empty">
                    {view.runtime === "all"
                      ? "No threads with the selected models."
                      : `No ${view.runtime === "pi" ? "Pi" : "Durable"} threads${view.models.length ? " with the selected models" : ""}.`}
                  </p>
                )}
                {archived.length > 0 && (
                  <Collapsible label={`Archived (${archived.length})`} open={sections.archived} onToggle={() => toggleSection("archived")}>
                    {archived.map((c) => row(c))}
                  </Collapsible>
                )}
              </>
            )}
          </nav>

          <PluginSlot name="sidebar:footer" />

          <div className="settings-row">
            <button type="button" className="settings-btn" onClick={() => openSettings()}>
              <Avatar src={avatar} name={name} size={26} />
              Settings
            </button>
            <button
              type="button"
              className={`runtime-toggle${view.runtime === "all" ? "" : " active"}`}
              aria-label={`Runtime filter: ${runtimeLabel}. Show ${nextRuntimeLabel}.`}
              title={`Runtime: ${runtimeLabel} — click for ${nextRuntimeLabel}`}
              onClick={() => setView({ runtime: nextRuntime })}
            >
              {view.runtime === "durable" ? (
                <ShieldHalf size={18} />
              ) : view.runtime === "pi" ? (
                <PiMark size={18} />
              ) : (
                <span className="runtime-both" aria-hidden>
                  <PiMark size={11} />
                  <ShieldHalf size={12} />
                </span>
              )}
            </button>
            <button
              type="button"
              className={`archive-toggle${archiveView ? " active" : ""}`}
              aria-label={archiveView ? "Back to threads" : "Show archived threads"}
              aria-pressed={archiveView}
              title={archiveView ? "Back to threads" : "Archived threads"}
              onClick={() => setArchiveView((v) => !v)}
            >
              <Archive size={18} />
            </button>
          </div>
        </div>
      </aside>
      <ChatContextMenu state={menu} onClose={closeMenu} onRename={setRenamingId} />
    </>
  );
}
