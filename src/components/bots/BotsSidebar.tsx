// OpenBots' sidebar: pinned bots and groups as big tiles, then every other conversation as a row
// with its latest message, filed under the user's own sections. Closed on a desktop, it narrows to
// a rail of avatars instead of going away.
import { Bell, BellDot, ChevronDown, ChevronRight, Copy, Eye, EyeOff, FolderInput, PanelLeft, Pencil, Pin, PinOff, Plus, Search, Star, Store, Trash, UsersRound, X } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { conversationName, useBots, useRemoteWorkspace } from "../../lib/bots/store";
import { useWorkspace } from "../../lib/bots/workspace";
import type { Conversation } from "../../lib/bots/types";
import type { FriendSummary } from "../../../shared/friends";
import { useStore } from "../../lib/store";
import { backToBotsList, isPhone, openBotsChat, useLongPress } from "../../lib/gestures";
import { arrowNav, canHover, copyText, cx, useDismiss, useMediaQuery, usePresence } from "../../lib/ui";
import { Avatar, IconButton, Popover } from "../primitives";
import { BotsToggle, ScrollThumb } from "../Sidebar";
import { place, type Side } from "../Tooltip";
import { AppsDialog } from "./BotApps";
import { BotsGlyph } from "./BotAvatar";
import { ConfirmDeleteDialog, CreateBotDialog, CreateGroupDialog, NameDialog } from "./BotDialogs";
import { ConversationAvatar, previewOf, shortTime, useBusyBots } from "./common";

type Dialog =
  | { kind: "bot" }
  | { kind: "group"; preset?: string[] }
  | { kind: "rename"; id: string }
  | { kind: "section"; id: string }
  | { kind: "delete"; id: string }
  | { kind: "apps"; app?: string };

interface MenuState {
  id: string;
  x: number;
  y: number;
}

/** Open the new-bot and new-group dialogs from anywhere in OpenBots (the empty chat, the details panel). */
export const openBotsDialog = (d: Dialog) => window.dispatchEvent(new CustomEvent<Dialog>("openbots:dialog", { detail: d }));

interface PeekState {
  id: string;
  side: Side;
  rect: DOMRect;
}

type Peek = (id: string, side: Side) => {
  onPointerEnter: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  onFocus: (e: React.FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
};

const PEEK_DELAY = 450;

/** A hover card for rows and rail avatars, whose names and messages get cut short: the full name and the latest message. */
function usePeek() {
  const [peek, setPeek] = useState<PeekState>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setPeek(undefined);
  }, []);
  useEffect(() => {
    if (!peek) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [peek, hide]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const bind = useCallback<Peek>(
    (id, side) => ({
      onPointerEnter: (e) => {
        if (e.pointerType === "touch") return;
        const el = e.currentTarget;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => el.isConnected && setPeek({ id, side, rect: el.getBoundingClientRect() }), PEEK_DELAY);
      },
      onPointerLeave: hide,
      onPointerDown: hide,
      onFocus: (e) => {
        if (e.currentTarget.matches(":focus-visible")) setPeek({ id, side, rect: e.currentTarget.getBoundingClientRect() });
      },
      onBlur: hide,
    }),
    [hide],
  );
  return { peek, bind, hide };
}

function PeekCard({ peek }: { peek?: PeekState }) {
  const conversation = useBots((s) => s.conversations.find((c) => c.id === peek?.id));
  const bots = useBots((s) => s.bots);
  const typing = useBots((s) => (peek ? (s.typing[peek.id]?.length ?? 0) : 0)) > 0;
  const working = useBusyBots(conversation);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; side: Side }>();
  useLayoutEffect(() => {
    if (!peek || !ref.current) return setPos(undefined);
    setPos(place(peek, ref.current.offsetWidth, ref.current.offsetHeight));
  }, [peek]);
  if (!peek || !conversation) return null;
  const [title, tag] = conversationName(conversation, bots).split(" · ");
  return createPortal(
    <div ref={ref} role="tooltip" className="bots-peek" data-side={pos?.side ?? peek.side} data-state={pos ? "open" : "measuring"} style={{ left: pos?.left ?? 0, top: pos?.top ?? 0 }}>
      <span className="bots-peek-head">
        <ConversationAvatar conversation={conversation} size={18} alive={false} working={working} badge={false} />
        <span className="bots-peek-name">
          {title}
          {tag && <span className="bots-peek-tag"> · {tag}</span>}
        </span>
      </span>
      <span className="bots-peek-preview">{typing ? "typing…" : previewOf(conversation, bots)}</span>
    </div>,
    document.body,
  );
}

/**
 * A sidebar avatar that keeps still unless its bots are at work (then they fidget; in a group, only
 * the members at work, while the rest doze, breathing slowly). Hovering a bot's row, tile or rail
 * button makes its eyes follow the pointer, and nothing more: no hop or smile, no spin when pressed.
 * A group's huddle doesn't react at all.
 */
function SidebarAvatar({ conversation, size }: { conversation: Conversation; size: number }) {
  const typing = useBots((s) => s.typing[conversation.id]?.length ?? 0) > 0;
  const working = useBusyBots(conversation);
  const busy = working.length > 0;
  const ref = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState(false);
  const watches = conversation.kind === "direct";
  useEffect(() => {
    const host = ref.current?.closest("button");
    if (!host || !watches) return setHover(false);
    const enter = (e: PointerEvent) => e.pointerType !== "touch" && setHover(true);
    const leave = () => setHover(false);
    host.addEventListener("pointerenter", enter);
    host.addEventListener("pointerleave", leave);
    return () => {
      host.removeEventListener("pointerenter", enter);
      host.removeEventListener("pointerleave", leave);
    };
  }, [watches]);
  return (
    <span ref={ref} className="bots-sidebar-avatar">
      <ConversationAvatar conversation={conversation} size={size} alive={busy || !watches} busy={busy} working={working} track={hover && watches} mood={typing ? "thinking" : undefined} zzz />
    </span>
  );
}

function useSelect() {
  const mobile = useMediaQuery("(max-width: 768px)");
  return useCallback(
    (id: string) => {
      useBots.getState().select(id);
      // Out of a thread opened from a chat, back to the chats.
      useStore.setState({ botsThread: false });
      if (mobile) openBotsChat();
    },
    [mobile],
  );
}

const Row = memo(function Row({ conversation, active, onMenu, peek, avatar = 36 }: { conversation: Conversation; active: boolean; onMenu: (m: MenuState) => void; peek: Peek; avatar?: number }) {
  const bots = useBots((s) => s.bots);
  const typing = useBots((s) => s.typing[conversation.id]?.length ?? 0) > 0;
  const select = useSelect();
  const longPress = useLongPress((x, y) => onMenu({ id: conversation.id, x, y }));
  const name = conversationName(conversation, bots);
  const [title, tag] = name.split(" · ");
  return (
    <div
      className={cx("bots-row", active && "bots-row-active", conversation.unread && "bots-row-unread")}
      {...longPress.handlers}
      onContextMenu={(e) => {
        e.preventDefault();
        if (longPress.pressing()) return longPress.fire(e.clientX, e.clientY);
        onMenu({ id: conversation.id, x: e.clientX, y: e.clientY });
      }}
    >
      <button type="button" className="bots-row-main" {...peek(conversation.id, "right")} onClick={() => select(conversation.id)} aria-current={active ? "page" : undefined}>
        <SidebarAvatar conversation={conversation} size={avatar} />
        <span className="bots-row-text">
          <span className="bots-row-name">
            <span className="bots-row-title">{title}</span>
            {tag && <span className="bots-row-tag">· {tag}</span>}
          </span>
          <span className={cx("bots-row-preview", typing && "bots-row-typing")}>{typing ? "typing…" : previewOf(conversation, bots)}</span>
        </span>
        <span className="bots-row-side">
          <span className="bots-row-time">{shortTime(conversation.updatedAt)}</span>
          {conversation.unread && <span className="unread-dot" aria-label="Unread" />}
        </span>
      </button>
    </div>
  );
});

const Tile = memo(function Tile({ conversation, active, onMenu }: { conversation: Conversation; active: boolean; onMenu: (m: MenuState) => void }) {
  const bots = useBots((s) => s.bots);
  const select = useSelect();
  const longPress = useLongPress((x, y) => onMenu({ id: conversation.id, x, y }));
  const name = conversationName(conversation, bots);
  return (
    <button
      type="button"
      className={cx("bots-tile", active && "bots-tile-active")}
      aria-current={active ? "page" : undefined}
      onClick={() => select(conversation.id)}
      {...longPress.handlers}
      onContextMenu={(e) => {
        e.preventDefault();
        if (longPress.pressing()) return longPress.fire(e.clientX, e.clientY);
        onMenu({ id: conversation.id, x: e.clientX, y: e.clientY });
      }}
    >
      <span className="bots-tile-avatar">
        {/* A group's huddle is drawn bigger than the box, into the tile's padding, so its members read at a glance. */}
        <SidebarAvatar conversation={conversation} size={conversation.kind === "direct" ? 64 : 80} />
        {conversation.unread && <span className="unread-dot bots-tile-dot" aria-label="Unread" />}
      </span>
      <span className="bots-tile-name">{name}</span>
    </button>
  );
});

/** Who the friends are and whether they're connected, under their chats: one quiet line. */
function FriendsLine({ friends }: { friends: FriendSummary[] }) {
  if (!friends.length) return null;
  return (
    <p className="history-empty bots-friends-line">
      {friends.map((f, i) => (
        <span key={f.id}>
          {i > 0 && ", "}
          <span className={cx("bots-friend-dot", f.status === "online" && "bots-friend-dot-on")} role="img" aria-label={f.status === "online" ? "Connected" : "Not connected"} title={f.status === "online" ? "Connected" : f.status === "refused" ? "Their OpenBuild turned this one away" : "Not connected"} />
          {f.name}
        </span>
      ))}
    </p>
  );
}

function Section({ name, label, count, children }: { name: string; label: string; count?: number; children: React.ReactNode }) {
  const open = !useBots((s) => s.folded.includes(name));
  return (
    <section className="history-group bots-section">
      <button type="button" className="history-heading history-heading-toggle" aria-expanded={open} onClick={() => useBots.getState().toggleFolded(name)}>
        {label}
        {count !== undefined && <span className="bots-section-count">{count}</span>}
        <ChevronDown size={14} className="history-heading-chevron" />
      </button>
      <div className={cx("collapse", open && "collapse-open")} inert={!open}>
        <div className="collapse-inner">{children}</div>
      </div>
    </section>
  );
}

function ConversationMenu({ state, onClose, onDialog }: { state?: MenuState; onClose: () => void; onDialog: (d: Dialog) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef(state);
  if (state) last.current = state;
  const current = last.current;
  const conversation = useBots((s) => s.conversations.find((c) => c.id === current?.id));
  const bot = useBots((s) => (conversation?.kind === "direct" ? s.bots.find((b) => b.id === conversation.botIds[0]) : undefined));
  const sections = useBots((s) => s.sections);
  const open = !!state;
  const { mounted, visible } = usePresence(open, 180);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string }>();
  const [sub, setSub] = useState(false);
  useDismiss(open, onClose, [ref]);

  useLayoutEffect(() => {
    if (!open || !mounted || !state) return;
    setSub(false);
    const el = ref.current;
    const w = el?.offsetWidth ?? 220;
    const h = el?.offsetHeight ?? 300;
    const top = Math.max(8, Math.min(state.y, window.innerHeight - h - 8));
    setPos({ left: Math.max(8, Math.min(state.x, window.innerWidth - w - 8)), top, origin: `${top < state.y ? "bottom" : "top"} left` });
    if (window.matchMedia("(pointer: fine)").matches) el?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, [open, mounted, state]);

  if (!mounted || !conversation) return null;
  const st = useBots.getState();
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const kind = conversation.kind === "direct" ? "bot" : conversation.kind === "group" ? "group" : "side chat";
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Conversation actions"
      className="popover menu context-menu bots-menu"
      data-state={visible && pos ? "open" : "closed"}
      style={{ position: "fixed", left: pos?.left ?? state?.x, top: pos?.top ?? state?.y, transformOrigin: pos?.origin }}
      onKeyDown={(e) => arrowNav(e, ":scope > button, :scope > .filter-row > button")}
      onContextMenu={(e) => e.preventDefault()}
      onMouseOver={(e) => {
        const item = (e.target as Element).closest(".menu-item");
        if (canHover() && item && !item.closest(".filter-row")) setSub(false);
      }}
    >
      <button type="button" role="menuitem" className="menu-item" onClick={act(() => st.togglePin(conversation.id))}>
        {conversation.pinnedAt ? <PinOff size={15} /> : <Pin size={15} />} {conversation.pinnedAt ? "Unpin" : "Pin"}
      </button>
      <div className="filter-row" onMouseEnter={() => canHover() && setSub(true)}>
        <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={sub} className={cx("menu-item", sub && "menu-item-active")} onClick={() => setSub(!sub)}>
          <FolderInput size={15} />
          <span className="menu-item-label">Move to section</span>
          <ChevronRight size={14} className="filter-chevron" />
        </button>
        {sub && (
          <div className="popover menu filter-flyout" data-state="open" role="menu" aria-label="Move to section" onKeyDown={(e) => { e.stopPropagation(); arrowNav(e); }}>
            {sections.map((name) => (
              <button key={name} type="button" role="menuitemradio" aria-checked={conversation.section === name} className="menu-item" onClick={act(() => st.updateConversation(conversation.id, { section: name }))}>
                <span className="menu-item-label">{name}</span>
                {conversation.section === name && <span className="menu-item-hint">Here</span>}
              </button>
            ))}
            {conversation.section && (
              <button type="button" role="menuitem" className="menu-item" onClick={act(() => st.updateConversation(conversation.id, { section: undefined }))}>
                <span className="menu-item-label">Out of “{conversation.section}”</span>
              </button>
            )}
            {(sections.length > 0 || conversation.section) && <div className="menu-sep" />}
            <button type="button" role="menuitem" className="menu-item" onClick={act(() => onDialog({ kind: "section", id: conversation.id }))}>
              <Plus size={15} /> New section…
            </button>
          </div>
        )}
      </div>
      <button type="button" role="menuitem" className="menu-item" onClick={act(() => st.updateConversation(conversation.id, { unread: !conversation.unread }))}>
        {conversation.unread ? <Bell size={15} /> : <BellDot size={15} />} {conversation.unread ? "Mark as read" : "Mark as unread"}
      </button>
      <div className="menu-sep" />
      {conversation.kind !== "side" && (
        <button type="button" role="menuitem" className="menu-item" onClick={act(() => onDialog({ kind: "rename", id: conversation.id }))}>
          <Pencil size={15} /> Rename {kind}
        </button>
      )}
      {bot && !bot.primary && (
        <button type="button" role="menuitem" className="menu-item" onClick={act(() => st.makePrimary(bot.id))}>
          <Star size={15} /> Make primary
        </button>
      )}
      {conversation.kind === "direct" && (
        <button type="button" role="menuitem" className="menu-item" onClick={act(() => onDialog({ kind: "group", preset: conversation.botIds }))}>
          <UsersRound size={15} /> New group with {bot?.name.split(" ·")[0] ?? "this bot"}
        </button>
      )}
      <button type="button" role="menuitem" className="menu-item" onClick={act(() => void copyText(conversation.id))}>
        <Copy size={15} /> Copy conversation ID
      </button>
      <div className="menu-sep" />
      <button type="button" role="menuitem" className="menu-item" onClick={act(() => st.updateConversation(conversation.id, { hidden: !conversation.hidden, pinnedAt: undefined }))}>
        {conversation.hidden ? <Eye size={15} /> : <EyeOff size={15} />} {conversation.hidden ? "Show in sidebar" : "Hide from sidebar"}
      </button>
      <button
        type="button"
        role="menuitem"
        className="menu-item menu-item-danger"
        disabled={bot?.primary}
        title={bot?.primary ? "Make another bot primary first" : undefined}
        onClick={act(() => onDialog({ kind: "delete", id: conversation.id }))}
      >
        <Trash size={15} /> Delete {kind}
      </button>
    </div>
  );
}

function NewMenu({ onDialog, rail }: { onDialog: (d: Dialog) => void; rail?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton ref={anchor} label="New" tooltip={open ? false : "New bot or group"} tooltipSide={rail ? "right" : "bottom"} aria-haspopup="menu" aria-expanded={open} className={rail ? "bots-rail-btn" : undefined} onClick={() => setOpen(!open)}>
        <Plus size={18} />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu bots-new-menu" role="menu" label="New" fixed={rail ? "up" : "down"} align={rail ? "start" : "end"}>
        <div onKeyDown={(e) => arrowNav(e)}>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); onDialog({ kind: "bot" }); }}>
            <BotsGlyph size={16} /> New bot
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); onDialog({ kind: "group" }); }}>
            <UsersRound size={15} /> New group
          </button>
        </div>
      </Popover>
    </>
  );
}

function Dialogs({ dialog, onClose }: { dialog?: Dialog; onClose: () => void }) {
  const conversation = useBots((s) => (dialog && "id" in dialog ? s.conversations.find((c) => c.id === dialog.id) : undefined));
  const bots = useBots((s) => s.bots);
  if (!dialog) return null;
  // Made on a phone, the new chat opens straight away: there's no chat beside the list to see it in.
  const opened = () => {
    if (isPhone()) openBotsChat();
  };
  if (dialog.kind === "bot") return <CreateBotDialog onClose={onClose} onCreated={opened} />;
  if (dialog.kind === "group") return <CreateGroupDialog preset={dialog.preset} onClose={onClose} onCreated={opened} />;
  if (dialog.kind === "apps") return <AppsDialog initial={dialog.app} onClose={onClose} />;
  if (!conversation) return null;
  const st = useBots.getState();
  const name = conversationName(conversation, bots);
  if (dialog.kind === "rename")
    return (
      <NameDialog
        title={conversation.kind === "direct" ? "Rename bot" : "Rename group"}
        initial={conversation.friend ? (conversation.name ?? "") : name}
        action="Rename"
        onClose={onClose}
        onSubmit={(next) => (conversation.kind === "direct" ? st.updateBot(conversation.botIds[0]!, { name: next }, conversation.id) : st.updateConversation(conversation.id, { name: next }))}
      />
    );
  if (dialog.kind === "section")
    return (
      <NameDialog
        title="New section"
        placeholder="Work, Home, Projects…"
        action="Create"
        onClose={onClose}
        onSubmit={(section) => {
          st.addSection(section);
          st.updateConversation(conversation.id, { section, pinnedAt: undefined });
        }}
      />
    );
  return (
    <ConfirmDeleteDialog
      title={`Delete “${name}”?`}
      body={
        conversation.kind === "direct"
          ? "The bot, its memory, routines and conversation are deleted for good. Groups it's in carry on without it."
          : "The conversation is deleted for good. The bots in it stay."
      }
      onClose={onClose}
      onConfirm={() => {
        st.deleteConversation(conversation.id);
        if (isPhone()) backToBotsList();
      }}
    />
  );
}

function Rail({ pinned, rest, activeId, onMenu, onDialog, peek }: { pinned: Conversation[]; rest: Conversation[]; activeId?: string; onMenu: (m: MenuState) => void; onDialog: (d: Dialog) => void; peek: Peek }) {
  const bots = useBots((s) => s.bots);
  const remote = !!useRemoteWorkspace();
  const avatar = useStore((s) => s.settings.profile.avatar);
  const name = useStore((s) => s.settings.profile.name);
  const listRef = useRef<HTMLElement>(null);
  // Which ends of the list have more past them, so they fade out there (bots.css) instead of being cut.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const edges = () => {
      el.toggleAttribute("data-more-above", el.scrollTop > 1);
      el.toggleAttribute("data-more-below", el.scrollHeight - el.clientHeight - el.scrollTop > 1);
    };
    edges();
    el.addEventListener("scroll", edges, { passive: true });
    const resize = new ResizeObserver(edges);
    resize.observe(el);
    return () => {
      el.removeEventListener("scroll", edges);
      resize.disconnect();
    };
  }, [pinned.length, rest.length]);
  const item = (c: Conversation) => (
    <button
      key={c.id}
      type="button"
      className={cx("bots-rail-item", c.id === activeId && "bots-rail-item-active")}
      aria-label={conversationName(c, bots)}
      aria-current={c.id === activeId ? "page" : undefined}
      {...peek(c.id, "right")}
      onClick={() => useBots.getState().select(c.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ id: c.id, x: e.clientX, y: e.clientY });
      }}
    >
      <SidebarAvatar conversation={c} size={40} />
      {c.unread && <span className="unread-dot bots-rail-dot" aria-label="Unread" />}
    </button>
  );
  return (
    <div className="bots-rail-inner">
      <IconButton label="Open sidebar" tooltipSide="right" className="bots-rail-btn" onClick={() => useStore.getState().setBotsSidebarOpen(true)}>
        <PanelLeft size={18} />
      </IconButton>
      <div className="history-wrap">
        <ScrollThumb target={listRef} />
        <nav ref={listRef} className="bots-rail-list" aria-label="Bots">
          {pinned.map(item)}
          {pinned.length > 0 && rest.length > 0 && <div className="bots-rail-sep" />}
          {rest.map(item)}
        </nav>
      </div>
      <div className="bots-rail-foot">
        {!remote && <NewMenu onDialog={onDialog} rail />}
        {!remote && (
          <IconButton label="Marketplace" tooltipSide="right" className="bots-rail-btn" onClick={() => onDialog({ kind: "apps" })}>
            <Store size={18} />
          </IconButton>
        )}
        <BotsToggle />
        <button type="button" className="bots-rail-me" aria-label="Settings" data-tooltip="Settings" data-tooltip-side="right" onClick={() => useStore.getState().openSettings()}>
          <Avatar src={avatar} name={name} size={30} />
        </button>
      </div>
    </div>
  );
}

const NONE: Conversation[] = [];

export function BotsSidebar() {
  const open = useStore((s) => s.botsSidebarOpen);
  const avatar = useStore((s) => s.settings.profile.avatar);
  const profileName = useStore((s) => s.settings.profile.name);
  const mobile = useMediaQuery("(max-width: 768px)");
  const rail = !open && !mobile;
  // Another device's workspace is used, not managed, from here: no new bots, apps or conversation menu.
  const remote = !!useRemoteWorkspace();
  // A workspace that isn't here anymore shows nothing of its own or anyone else's.
  const workspace = useBots((s) => s.workspace);
  const gone = useWorkspace((s) => s.problem?.kind === "gone" && s.problem.workspace === workspace);
  const all = useBots((s) => s.conversations);
  const conversations = gone ? NONE : all;
  const bots = useBots((s) => s.bots);
  const sections = useBots((s) => s.sections);
  const activeId = useBots((s) => s.activeId);
  const [menu, setMenu] = useState<MenuState>();
  const [dialog, setDialog] = useState<Dialog>();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLElement>(null);
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const { peek, bind: bindPeek, hide: hidePeek } = usePeek();
  // The hovered tile or avatar goes away with the layout, without a pointerleave.
  useEffect(() => hidePeek(), [rail, hidePeek]);

  useEffect(() => useBots.getState().ensureSeeded(), []);
  useEffect(() => {
    const on = (e: Event) => setDialog((e as CustomEvent<Dialog>).detail);
    window.addEventListener("openbots:dialog", on);
    return () => window.removeEventListener("openbots:dialog", on);
  }, []);

  const friends = useBots((s) => s.friends);
  const { pinned, rest, filed, side, hidden, shared } = useMemo(() => {
    const byRecent = (a: Conversation, b: Conversation) => b.updatedAt - a.updatedAt;
    const shown = conversations.filter((c) => !c.hidden);
    const listed = shown.filter((c) => !c.pinnedAt && c.kind !== "side").sort(byRecent);
    return {
      pinned: shown.filter((c) => c.pinnedAt).sort((a, b) => a.pinnedAt! - b.pinnedAt!),
      // Chats shared with friends get a section of their own, unless the user filed one elsewhere.
      shared: listed.filter((c) => c.friend && (!c.section || !sections.includes(c.section))),
      rest: listed.filter((c) => !c.friend && (!c.section || !sections.includes(c.section))),
      filed: sections.map((name) => [name, listed.filter((c) => c.section === name)] as const),
      side: shown.filter((c) => !c.pinnedAt && c.kind === "side").sort(byRecent),
      hidden: conversations.filter((c) => c.hidden).sort(byRecent),
    };
  }, [conversations, sections]);

  const q = query.trim().toLowerCase();
  const results = useMemo(
    () => (q ? conversations.filter((c) => conversationName(c, bots).toLowerCase().includes(q) || c.messages.some((m) => m.text.toLowerCase().includes(q))) : []),
    [q, conversations, bots],
  );

  const row = (c: Conversation) => <Row key={c.id} conversation={c} active={c.id === activeId} onMenu={setMenu} peek={bindPeek} avatar={mobile ? 50 : 36} />;
  const touch = useMediaQuery("(pointer: coarse)");

  return (
    <>
      <div className={cx("sidebar-scrim", open && mobile && "sidebar-scrim-visible")} onClick={() => useStore.getState().setBotsSidebarOpen(false)} aria-hidden />
      <aside className={cx("sidebar bots-sidebar", rail ? "bots-sidebar-rail" : open ? "sidebar-open" : "sidebar-closed")} aria-label="OpenBots" aria-hidden={!open && !rail} inert={!open && !rail}>
        {rail ? (
          <Rail pinned={pinned} rest={[...rest, ...shared, ...filed.flatMap(([, list]) => list)].sort((a, b) => b.updatedAt - a.updatedAt)} activeId={activeId} onMenu={setMenu} onDialog={setDialog} peek={bindPeek} />
        ) : (
          <div className="sidebar-inner bots-sidebar-inner">
            <div className="brand-row">
              {/* On a phone the list is a screen of its own, with the search always at hand. */}
              {!mobile && (
                <IconButton label="Close sidebar" onClick={() => useStore.getState().setBotsSidebarOpen(false)}>
                  <PanelLeft size={18} />
                </IconButton>
              )}
              <span className="wordmark bots-wordmark">OpenBots</span>
              {!mobile && (
                <IconButton
                  label="Search"
                  aria-pressed={searching}
                  className={cx(searching && "filter-active")}
                  onClick={() => {
                    setSearching(!searching);
                    setQuery("");
                  }}
                >
                  <Search size={18} />
                </IconButton>
              )}
              {!remote && <NewMenu onDialog={setDialog} />}
            </div>
            {(searching || mobile) && (
              <label className="search bots-search">
                <Search size={16} />
                <input type="text" value={query} placeholder={mobile ? "Search" : "Search bots and messages…"} aria-label="Search bots and messages" autoFocus={!mobile} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (query ? setQuery("") : setSearching(false))} />
                {query && (
                  <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
                    <X size={14} />
                  </button>
                )}
              </label>
            )}
            <div className="history-wrap">
              <ScrollThumb target={listRef} />
              <nav ref={listRef} className="history bots-list" aria-label="Bots and groups">
                {q ? (
                  <section className="history-group">
                    <h3 className="history-heading">{results.length ? `${results.length} result${results.length === 1 ? "" : "s"}` : "Results"}</h3>
                    {results.map(row)}
                    {!results.length && <p className="history-empty">Nothing matches “{query.trim()}”.</p>}
                  </section>
                ) : (
                  <>
                    {pinned.length > 0 && (
                      <div className="bots-tiles">
                        {pinned.map((c) => (
                          <Tile key={c.id} conversation={c} active={c.id === activeId} onMenu={setMenu} />
                        ))}
                      </div>
                    )}
                    <div className="bots-rows">{rest.map(row)}</div>
                    {filed.map(([name, list]) => (
                      <Section key={name} name={name} label={name} count={list.length}>
                        {list.map(row)}
                        {!list.length && <p className="history-empty">{touch ? "Press and hold" : "Right-click"} a bot and pick Move to section.</p>}
                      </Section>
                    ))}
                    {(shared.length > 0 || friends.length > 0) && (
                      <Section name="friends" label="With friends" count={shared.length}>
                        {shared.map(row)}
                        <FriendsLine friends={friends} />
                      </Section>
                    )}
                    {side.length > 0 && (
                      <Section name="side" label="Between bots" count={side.length}>
                        {side.map(row)}
                      </Section>
                    )}
                    {hidden.length > 0 && (
                      <Section name="hidden" label="Hidden" count={hidden.length}>
                        {hidden.map(row)}
                      </Section>
                    )}
                    {!conversations.length && !gone && (
                      <div className="bots-empty-list">
                        <p>No bots yet.</p>
                        {!remote && (
                          <button type="button" className="btn btn-sm" onClick={() => setDialog({ kind: "bot" })}>
                            <Plus size={14} /> New bot
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </nav>
            </div>
            <div className="settings-row">
              <button type="button" className="settings-btn" onClick={() => useStore.getState().openSettings()}>
                <Avatar src={avatar} name={profileName} size={26} />
                <span className="bots-me-name">Settings</span>
              </button>
              {/* The way into the marketplace sits beside the way out, as it does in the rail. */}
              {!remote && (
                <IconButton label="Marketplace" tooltipSide="top" className="bots-apps-btn" onClick={() => setDialog({ kind: "apps" })}>
                  <Store size={19} />
                </IconButton>
              )}
              <BotsToggle />
            </div>
          </div>
        )}
      </aside>
      <PeekCard peek={peek} />
      <ConversationMenu state={remote ? undefined : menu} onClose={closeMenu} onDialog={setDialog} />
      <Dialogs dialog={dialog} onClose={() => setDialog(undefined)} />
    </>
  );
}
