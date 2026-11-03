// OpenBots' sidebar: pinned bots and groups as big tiles, then every other conversation as a row
// with its latest message, filed under the user's own sections. Closed on a desktop, it narrows to
// a rail of avatars instead of going away.
import { Bell, BellDot, ChevronDown, ChevronRight, Copy, Eye, EyeOff, FolderInput, PanelLeft, Pencil, Pin, PinOff, Plus, Search, Star, Trash, UsersRound, X } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { conversationName, useBots } from "../../lib/bots/store";
import type { Conversation } from "../../lib/bots/types";
import { useStore } from "../../lib/store";
import { arrowNav, copyText, cx, useDismiss, useMediaQuery, usePresence } from "../../lib/ui";
import { Avatar, IconButton, Popover } from "../primitives";
import { BotsToggle, ScrollThumb } from "../Sidebar";
import { BotsGlyph } from "./BotAvatar";
import { ConfirmDeleteDialog, CreateBotDialog, CreateGroupDialog, NameDialog } from "./BotDialogs";
import { ConversationAvatar, previewOf, shortTime } from "./common";

type Dialog =
  | { kind: "bot" }
  | { kind: "group"; preset?: string[] }
  | { kind: "rename"; id: string }
  | { kind: "section"; id: string }
  | { kind: "delete"; id: string };

interface MenuState {
  id: string;
  x: number;
  y: number;
}

/** Open the new-bot and new-group dialogs from anywhere in OpenBots (the empty chat, the details panel). */
export const openBotsDialog = (d: Dialog) => window.dispatchEvent(new CustomEvent<Dialog>("openbots:dialog", { detail: d }));

function useSelect() {
  const mobile = useMediaQuery("(max-width: 768px)");
  return useCallback(
    (id: string) => {
      useBots.getState().select(id);
      if (mobile) useStore.getState().setBotsSidebarOpen(false);
    },
    [mobile],
  );
}

const Row = memo(function Row({ conversation, active, onMenu }: { conversation: Conversation; active: boolean; onMenu: (m: MenuState) => void }) {
  const bots = useBots((s) => s.bots);
  const typing = useBots((s) => s.typing[conversation.id]?.length ?? 0) > 0;
  const select = useSelect();
  const name = conversationName(conversation, bots);
  const [title, tag] = name.split(" · ");
  return (
    <div
      className={cx("bots-row", active && "bots-row-active", conversation.unread && "bots-row-unread")}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ id: conversation.id, x: e.clientX, y: e.clientY });
      }}
    >
      <button type="button" className="bots-row-main" onClick={() => select(conversation.id)} aria-current={active ? "page" : undefined}>
        <ConversationAvatar conversation={conversation} size={36} mood={typing ? "thinking" : undefined} />
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
  const typing = useBots((s) => s.typing[conversation.id]?.length ?? 0) > 0;
  const select = useSelect();
  const name = conversationName(conversation, bots);
  return (
    <button
      type="button"
      className={cx("bots-tile", active && "bots-tile-active")}
      aria-current={active ? "page" : undefined}
      title={name}
      onClick={() => select(conversation.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ id: conversation.id, x: e.clientX, y: e.clientY });
      }}
    >
      <span className="bots-tile-avatar">
        <ConversationAvatar conversation={conversation} size={64} lively playful={conversation.kind === "direct"} mood={typing ? "thinking" : undefined} />
        {conversation.unread && <span className="unread-dot bots-tile-dot" aria-label="Unread" />}
      </span>
      <span className="bots-tile-name">{name}</span>
    </button>
  );
});

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
        if (item && !item.closest(".filter-row")) setSub(false);
      }}
    >
      <button type="button" role="menuitem" className="menu-item" onClick={act(() => st.togglePin(conversation.id))}>
        {conversation.pinnedAt ? <PinOff size={15} /> : <Pin size={15} />} {conversation.pinnedAt ? "Unpin" : "Pin"}
      </button>
      <div className="filter-row" onMouseEnter={() => setSub(true)}>
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
  if (dialog.kind === "bot") return <CreateBotDialog onClose={onClose} />;
  if (dialog.kind === "group") return <CreateGroupDialog preset={dialog.preset} onClose={onClose} />;
  if (!conversation) return null;
  const st = useBots.getState();
  const name = conversationName(conversation, bots);
  if (dialog.kind === "rename")
    return (
      <NameDialog
        title={conversation.kind === "direct" ? "Rename bot" : "Rename group"}
        initial={name}
        action="Rename"
        onClose={onClose}
        onSubmit={(next) => (conversation.kind === "direct" ? st.updateBot(conversation.botIds[0]!, { name: next }) : st.updateConversation(conversation.id, { name: next }))}
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
      onConfirm={() => st.deleteConversation(conversation.id)}
    />
  );
}

function Rail({ pinned, rest, activeId, onMenu, onDialog }: { pinned: Conversation[]; rest: Conversation[]; activeId?: string; onMenu: (m: MenuState) => void; onDialog: (d: Dialog) => void }) {
  const bots = useBots((s) => s.bots);
  const avatar = useStore((s) => s.settings.profile.avatar);
  const name = useStore((s) => s.settings.profile.name);
  const listRef = useRef<HTMLElement>(null);
  const item = (c: Conversation) => (
    <button
      key={c.id}
      type="button"
      className={cx("bots-rail-item", c.id === activeId && "bots-rail-item-active")}
      aria-label={conversationName(c, bots)}
      aria-current={c.id === activeId ? "page" : undefined}
      data-tooltip={conversationName(c, bots)}
      data-tooltip-side="right"
      onClick={() => useBots.getState().select(c.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ id: c.id, x: e.clientX, y: e.clientY });
      }}
    >
      <ConversationAvatar conversation={c} size={40} />
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
        <NewMenu onDialog={onDialog} rail />
        <BotsToggle />
        <button type="button" className="bots-rail-me" aria-label="Settings" data-tooltip="Settings" data-tooltip-side="right" onClick={() => useStore.getState().openSettings()}>
          <Avatar src={avatar} name={name} size={30} />
        </button>
      </div>
    </div>
  );
}

export function BotsSidebar() {
  const open = useStore((s) => s.botsSidebarOpen);
  const avatar = useStore((s) => s.settings.profile.avatar);
  const profileName = useStore((s) => s.settings.profile.name);
  const mobile = useMediaQuery("(max-width: 768px)");
  const rail = !open && !mobile;
  const conversations = useBots((s) => s.conversations);
  const bots = useBots((s) => s.bots);
  const sections = useBots((s) => s.sections);
  const activeId = useBots((s) => s.activeId);
  const [menu, setMenu] = useState<MenuState>();
  const [dialog, setDialog] = useState<Dialog>();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLElement>(null);
  const closeMenu = useCallback(() => setMenu(undefined), []);

  useEffect(() => useBots.getState().ensureSeeded(), []);
  useEffect(() => {
    const on = (e: Event) => setDialog((e as CustomEvent<Dialog>).detail);
    window.addEventListener("openbots:dialog", on);
    return () => window.removeEventListener("openbots:dialog", on);
  }, []);

  const { pinned, rest, filed, side, hidden } = useMemo(() => {
    const byRecent = (a: Conversation, b: Conversation) => b.updatedAt - a.updatedAt;
    const shown = conversations.filter((c) => !c.hidden);
    const listed = shown.filter((c) => !c.pinnedAt && c.kind !== "side").sort(byRecent);
    return {
      pinned: shown.filter((c) => c.pinnedAt).sort((a, b) => a.pinnedAt! - b.pinnedAt!),
      rest: listed.filter((c) => !c.section || !sections.includes(c.section)),
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

  const row = (c: Conversation) => <Row key={c.id} conversation={c} active={c.id === activeId} onMenu={setMenu} />;

  return (
    <>
      <div className={cx("sidebar-scrim", open && mobile && "sidebar-scrim-visible")} onClick={() => useStore.getState().setBotsSidebarOpen(false)} aria-hidden />
      <aside className={cx("sidebar bots-sidebar", rail ? "bots-sidebar-rail" : open ? "sidebar-open" : "sidebar-closed")} aria-label="OpenBots" aria-hidden={!open && !rail} inert={!open && !rail}>
        {rail ? (
          <Rail pinned={pinned} rest={[...rest, ...filed.flatMap(([, list]) => list)].sort((a, b) => b.updatedAt - a.updatedAt)} activeId={activeId} onMenu={setMenu} onDialog={setDialog} />
        ) : (
          <div className="sidebar-inner bots-sidebar-inner">
            <div className="brand-row">
              <IconButton label="Close sidebar" onClick={() => useStore.getState().setBotsSidebarOpen(false)}>
                <PanelLeft size={18} />
              </IconButton>
              <span className="wordmark bots-wordmark">OpenBots</span>
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
              <NewMenu onDialog={setDialog} />
            </div>
            {searching && (
              <label className="search bots-search">
                <Search size={16} />
                <input type="text" value={query} placeholder="Search bots and messages…" aria-label="Search bots and messages" autoFocus onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (query ? setQuery("") : setSearching(false))} />
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
                        {!list.length && <p className="history-empty">Right-click a bot and pick Move to section.</p>}
                      </Section>
                    ))}
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
                    {!conversations.length && (
                      <div className="bots-empty-list">
                        <p>No bots yet.</p>
                        <button type="button" className="btn btn-sm" onClick={() => setDialog({ kind: "bot" })}>
                          <Plus size={14} /> New bot
                        </button>
                      </div>
                    )}
                  </>
                )}
              </nav>
            </div>
            <div className="settings-row">
              <button type="button" className="settings-btn" onClick={() => useStore.getState().openSettings()}>
                <Avatar src={avatar} name={profileName} size={26} />
                <span className="bots-me-name">{profileName || "Settings"}</span>
              </button>
              <BotsToggle />
            </div>
          </div>
        )}
      </aside>
      <ConversationMenu state={menu} onClose={closeMenu} onDialog={setDialog} />
      <Dialogs dialog={dialog} onClose={() => setDialog(undefined)} />
    </>
  );
}
