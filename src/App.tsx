import { KeyRound, PanelLeft, SquarePen } from "lucide-react";
import { useEffect, useRef } from "react";
import { ChatView } from "./components/ChatView";
import { Composer } from "./components/Composer";
import { IconButton } from "./components/primitives";
import { SettingsModal } from "./components/Settings";
import { TooltipLayer } from "./components/Tooltip";
import { Sidebar } from "./components/Sidebar";
import { loadChats } from "./lib/db";
import { ensureSelection, useStore } from "./lib/store";
import { cx } from "./lib/ui";

function useTheme() {
  const theme = useStore((s) => s.settings.theme);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
}

function Home() {
  const hasKeys = useStore((s) => Object.keys(s.settings.keys).length > 0);
  const openSettings = useStore((s) => s.openSettings);
  return (
    <div className="home">
      <div className="home-center">
        <h1 className="home-title">What's on your mind?</h1>
        <Composer variant="home" streaming={false} />
        {!hasKeys && (
          <button type="button" className="onboarding" onClick={() => openSettings("keys")}>
            <KeyRound size={15} />
            Add your Opencode API key to start chatting
          </button>
        )}
      </div>
    </div>
  );
}

export function App() {
  useTheme();
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const chatsLoaded = useStore((s) => s.chatsLoaded);
  const chat = useStore((s) => s.chats.find((c) => c.id === s.activeChatId));
  const { setSidebarOpen, newChat } = useStore.getState();

  useEffect(() => {
    void loadChats().then((chats) => useStore.getState().setChats(chats));
    // Re-detect models for saved keys (cached results stay usable meanwhile).
    ensureSelection();
    void useStore.getState().refreshDetection();
  }, []);

  // Global shortcuts:
  //   Cmd/Ctrl+,        open settings (instead of the browser's)
  //   Cmd/Ctrl+B        toggle the sidebar (works everywhere)
  //   Cmd/Ctrl+Shift+O  new chat
  //   /                 focus chat search (or the composer when the sidebar is collapsed)
  //   Enter             focus the composer (sidebar open)
  // "/" and Enter only apply when not typing in a field and not in Settings; Enter also leaves
  // focused buttons/links alone so they still activate.
  useEffect(() => {
    const focusComposer = () => document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (e.metaKey || e.ctrlKey) {
        const key = e.key.toLowerCase();
        if (e.key === "," && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          st.openSettings();
        } else if (key === "b" && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          st.setSidebarOpen(!st.sidebarOpen);
        } else if (e.shiftKey && key === "o") {
          e.preventDefault();
          newChat();
        }
        return;
      }
      if (e.altKey || e.isComposing || st.settingsOpen) return;
      if (e.key !== "/" && e.key !== "Enter") return;
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      // Leave Enter alone on buttons/links/menu items so they still activate.
      const onControl = !!el && el !== document.body && !!el.closest("button, a[href], [role='menuitem'], [role='option'], [role='tab'], [role='switch']");
      if (typing || (e.key === "Enter" && onControl)) return;
      if (e.key === "/") {
        e.preventDefault();
        if (st.sidebarOpen) document.querySelector<HTMLInputElement>(".search input")?.focus();
        else focusComposer();
      } else if (st.sidebarOpen) {
        e.preventDefault();
        focusComposer();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [newChat]);

  useEffect(() => {
    document.title = chat ? `${chat.title} · OpenChat` : "OpenChat";
  }, [chat?.title]);

  // Keep the URL (#/c/<id>) and the active chat in sync, so chats can be opened in new tabs
  // and the back/forward buttons work.
  const activeChatId = useStore((s) => s.activeChatId);
  const routed = useRef(false);
  useEffect(() => {
    if (!chatsLoaded) return;
    const fromHash = () => {
      const id = /^#\/c\/(.+)$/.exec(location.hash)?.[1];
      const st = useStore.getState();
      if (id && st.chats.some((c) => c.id === id)) st.selectChat(id);
      else st.newChat();
    };
    fromHash();
    routed.current = true;
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [chatsLoaded]);
  useEffect(() => {
    if (!routed.current) return;
    const id = useStore.getState().activeChatId;
    const hash = id ? `#/c/${id}` : "";
    if (location.hash !== hash) history.pushState(null, "", hash || location.pathname + location.search);
  }, [activeChatId]);

  return (
    <>
      <div className={cx("app", settingsOpen && "app-behind-modal")} inert={settingsOpen}>
        <Sidebar />
        <main className={cx("main", !sidebarOpen && "main-full")}>
          <div className={cx("floating-tools", !sidebarOpen && "floating-tools-visible")} inert={sidebarOpen}>
            <IconButton label="Open sidebar" tooltipSide="right" onClick={() => setSidebarOpen(true)}>
              <PanelLeft size={18} />
            </IconButton>
            <IconButton label="New chat" tooltipSide="right" onClick={newChat}>
              <SquarePen size={17} />
            </IconButton>
          </div>
          {!chatsLoaded ? null : chat ? <ChatView key={chat.id} chat={chat} /> : <Home />}
        </main>
      </div>
      <SettingsModal />
      <TooltipLayer />
    </>
  );
}
