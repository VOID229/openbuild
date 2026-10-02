import { Menu, PanelLeft, Search, Settings2, SquarePen, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { stopAllGenerations, stopGeneration } from "../lib/chat";
import { useStore } from "../lib/store";
import type { Chat } from "../lib/types";
import { arrowNav, cx, useMediaQuery } from "../lib/ui";
import { Avatar, IconButton, Popover } from "./primitives";

const DAY = 24 * 60 * 60 * 1000;

function groupChats(chats: Chat[]) {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const groups: { label: string; chats: Chat[] }[] = [];
  const bucket = (t: number) =>
    t >= startOfToday ? "Today" : t >= startOfToday - DAY ? "Yesterday" : t >= startOfToday - 7 * DAY ? "Previous 7 days" : t >= startOfToday - 30 * DAY ? "Previous 30 days" : "Older";
  for (const chat of chats) {
    const label = bucket(chat.updatedAt);
    const group = groups.at(-1)?.label === label ? groups.at(-1)! : (groups.push({ label, chats: [] }), groups.at(-1)!);
    group.chats.push(chat);
  }
  return groups;
}

function ChatRow({ chat, active, onSelect }: { chat: Chat; active: boolean; onSelect: () => void }) {
  const removeChat = useStore((s) => s.removeChat);
  const [confirm, setConfirm] = useState(false);
  const streaming = chat.messages.at(-1)?.status === "streaming";
  return (
    <div className={cx("history-row", active && "history-row-active")} onMouseLeave={() => setConfirm(false)}>
      <button type="button" className="history-title" onClick={onSelect} aria-current={active ? "page" : undefined} title={chat.title}>
        {streaming && <span className="live-dot" aria-label="Generating" />}
        <span>{chat.title}</span>
      </button>
      <button
        type="button"
        className={cx("history-delete", confirm && "history-delete-confirm")}
        aria-label={confirm ? `Confirm delete ${chat.title}` : `Delete ${chat.title}`}
        onClick={() => {
          if (!confirm) return setConfirm(true);
          stopGeneration(chat.id);
          removeChat(chat.id);
        }}
        onBlur={() => setConfirm(false)}
      >
        {confirm ? "Delete" : <Trash2 size={14} />}
      </button>
    </div>
  );
}

function SidebarMenu() {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const { newChat, openSettings, removeAllChats } = useStore.getState();
  const hasChats = useStore((s) => s.chats.length > 0);
  const close = () => {
    setOpen(false);
    setConfirm(false);
  };
  return (
    <div className="picker">
      <IconButton ref={anchor} label="Menu" aria-expanded={open} aria-haspopup="menu" tooltip={open ? false : "Menu"} onClick={() => (open ? close() : setOpen(true))}>
        <Menu size={18} />
      </IconButton>
      <Popover open={open} onClose={close} anchor={anchor} className="menu sidebar-menu drop-down" role="menu" label="Menu" fixed>
        <div onKeyDown={(e) => arrowNav(e)}>
          <button type="button" role="menuitem" className="menu-item" onClick={() => (newChat(), close())}>
            <SquarePen size={15} /> New chat
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => (openSettings(), close())}>
            <Settings2 size={15} /> Settings
          </button>
          <div className="menu-sep" />
          <button
            type="button"
            role="menuitem"
            className={cx("menu-item menu-item-danger", confirm && "menu-item-confirm")}
            disabled={!hasChats}
            onClick={() => {
              if (!confirm) return setConfirm(true);
              stopAllGenerations();
              removeAllChats();
              close();
            }}
          >
            <Trash2 size={15} /> {confirm ? "Click again to delete all" : "Delete all chats"}
          </button>
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
  const { setSidebarOpen, newChat, selectChat, openSettings } = useStore.getState();
  const mobile = useMediaQuery("(max-width: 768px)");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)));
  }, [chats, query]);
  const groups = useMemo(() => groupChats(filtered), [filtered]);

  const afterNavigate = () => mobile && setSidebarOpen(false);

  return (
    <>
      <div className={cx("sidebar-scrim", open && mobile && "sidebar-scrim-visible")} onClick={() => setSidebarOpen(false)} aria-hidden />
      <aside className={cx("sidebar", open ? "sidebar-open" : "sidebar-closed")} aria-hidden={!open} inert={!open}>
        <div className="sidebar-inner">
          <div className="brand-row">
            <IconButton label="Close sidebar" tooltip="Close sidebar" onClick={() => setSidebarOpen(false)}>
              <PanelLeft size={18} />
            </IconButton>
            <span className="wordmark">OpenChat</span>
            <SidebarMenu />
          </div>

          <button
            type="button"
            className="new-chat"
            onClick={() => {
              newChat();
              afterNavigate();
            }}
          >
            <span className="new-chat-icon">
              <SquarePen size={15} />
            </span>
            New chat
          </button>

          <label className="search">
            <Search size={16} />
            <input
              type="text"
              value={query}
              placeholder="Search your chats..."
              aria-label="Search your chats"
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

          <nav className="history" aria-label="Chat history">
            {groups.map((g) => (
              <section key={g.label} className="history-group">
                <h3>{g.label}</h3>
                {g.chats.map((c) => (
                  <ChatRow
                    key={c.id}
                    chat={c}
                    active={c.id === activeChatId}
                    onSelect={() => {
                      selectChat(c.id);
                      afterNavigate();
                    }}
                  />
                ))}
              </section>
            ))}
            {query && !filtered.length && <p className="history-empty">No chats match “{query}”.</p>}
          </nav>

          <button type="button" className="settings-btn" onClick={() => openSettings()}>
            <Avatar src={avatar} size={26} />
            Settings
          </button>
        </div>
      </aside>
    </>
  );
}
