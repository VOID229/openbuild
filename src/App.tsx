import { KeyRound, PanelLeft, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";
import { SyncLockScreen } from "./components/Account";
import { ChatView } from "./components/ChatView";
import { Composer } from "./components/Composer";
import { Lightbox, useLightbox } from "./components/Lightbox";
import { IconButton } from "./components/primitives";
import { SettingsModal } from "./components/Settings";
import { TooltipLayer } from "./components/Tooltip";
import { ProjectHeading } from "./components/Workspace";
import { Sidebar } from "./components/Sidebar";
import { EXTERNAL_VIA } from "../shared/replies";
import { resumeReplies } from "./lib/chat";
import { resumeShells } from "./lib/shell";
import { cloudConfigured, CloudSync } from "./lib/cloud";
import { loadChats } from "./lib/db";
import { isHosted } from "./lib/runtime";
import { composerDevice, ensureSelection, useStore } from "./lib/store";
import { cx } from "./lib/ui";
import { startRouting } from "./lib/routes";
import { initPlugins, PluginSlot } from "./lib/plugins";

function useTheme() {
  const theme = useStore((s) => s.settings.theme);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      // Tints the browser's toolbar / status bar on phones to match the page.
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", dark ? "#1a1a1a" : "#ffffff");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
}

function useFont() {
  const font = useStore((s) => s.settings.font);
  useEffect(() => {
    document.documentElement.dataset.font = font ?? "fun";
  }, [font]);
}

function Home() {
  // The project the composer is set to may live on a paired device: ask that device's Pi, not this one's.
  const deviceId = useStore(composerDevice);
  const pi = useStore((s) => (deviceId ? s.remoteModels[deviceId] : s.detection.pi));
  const openSettings = useStore((s) => s.openSettings);
  // Nothing to build with yet: Pi isn't reachable, or no provider is signed in.
  const setup = pi && pi.status !== "checking" && !pi.models.length;
  return (
    <div className="home">
      <div className="home-center">
        <ProjectHeading />
        <PluginSlot name="home:above-composer" />
        <Composer variant="home" streaming={false} />
        <PluginSlot name="home:below-composer" />
        {setup && (
          <button type="button" className="onboarding" onClick={() => openSettings(pi.status === "error" ? "pi" : "keys")}>
            <KeyRound size={15} />
            {pi.status === "error" ? "Set up Pi to start building" : "Sign in to a model provider to start building"}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Settings, threads and projects, fetched together before the app first renders so it appears in
 * one piece instead of the sidebar filling in afterwards. A slow server doesn't hold it back for
 * long: past the deadline the app renders and whatever's missing fills in when it arrives.
 */
export async function preloadApp() {
  const hydrated = new Promise<void>((resolve) => {
    if (useStore.persist.hasHydrated()) return resolve();
    const off = useStore.persist.onFinishHydration(() => { off(); resolve(); });
  });
  const chats = Promise.all([hydrated, loadChats()]).then(([, chats]) => {
    if (useStore.getState().chatsLoaded) return;
    useStore.getState().setChats(chats);
    // Replies that were still coming in when the app was closed or reloaded.
    resumeReplies();
  }, () => { /* Main keeps retrying and shows the error. */ });
  // Settings → Pi and Settings → Providers open with content, not a spinner.
  void hydrated.then(() => {
    const pi = useStore.getState();
    void Promise.all([pi.loadPiStatus(), pi.loadPiResources(), pi.loadPiProviders()]).catch(() => {});
  });
  const all = Promise.all([hydrated, chats, useStore.getState().loadProjects()]);
  // Devices (and so replies running on them) are known only after projects are loaded.
  void all.then(() => resumeReplies());
  await Promise.race([all, new Promise((r) => setTimeout(r, 3000))]);
}

/** Settings are loaded from the server before the app renders, so nothing acts on the defaults. */
export function App() {
  const [hydrated, setHydrated] = useState(() => useStore.persist.hasHydrated());
  // When the saved settings can't be read, zustand never finishes hydrating and this gate would
  // show nothing at all. Wait, then say what happened instead of leaving a blank page.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (hydrated) return;
    const unsubscribe = useStore.persist.onFinishHydration(() => setHydrated(true));
    if (useStore.persist.hasHydrated()) setHydrated(true);
    const timer = setTimeout(() => setStuck(true), 10_000);
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [hydrated]);
  if (!hydrated) {
    return stuck ? (
      <div className="home">
        <div className="home-center">
          <p>Couldn't load your saved settings from the OpenBuild server. Reload this page to try again.</p>
          <button type="button" className="btn" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    ) : null;
  }
  return <Main />;
}

function Main() {
  useTheme();
  useFont();
  // Plugins load after the app hydrates, so a slow or broken plugin never holds up startup.
  useEffect(() => { initPlugins(); }, []);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const lightboxOpen = useLightbox((s) => s.open);
  const chatsLoaded = useStore((s) => s.chatsLoaded);
  const chat = useStore((s) => s.chats.find((c) => c.id === s.activeChatId));
  const { setSidebarOpen, newChat } = useStore.getState();

  const [loadError, setLoadError] = useState<string>();
  useEffect(() => {
    // Chats come from the local server; keep trying until it answers.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (delay: number) =>
      loadChats().then(
        (chats) => {
          setLoadError(undefined);
          useStore.getState().setChats(chats);
          // Replies that were still coming in when the app was closed or reloaded.
          resumeReplies();
        },
        (err: Error) => {
          console.error("Failed to load chats", err);
          setLoadError(err.message);
          timer = setTimeout(() => load(Math.min(delay * 2, 10_000)), delay);
        },
      );
    // Usually already loaded by preloadApp.
    if (!useStore.getState().chatsLoaded) void load(1000);
    // Projects, and the models Pi can use (cached ones stay usable meanwhile).
    ensureSelection();
    if (!useStore.getState().projectsLoaded) void useStore.getState().loadProjects();
    void useStore.getState().refreshDetection();
    // Re-ask Pi when the tab comes back after a while (a provider signed in elsewhere, new models).
    const STALE = 10 * 60 * 1000;
    const recheck = () => {
      if (document.visibilityState !== "visible") return;
      const { detection, refreshDetection, loadDevices, loadProjects } = useStore.getState();
      const d = detection.pi;
      if (!d || (d.status !== "checking" && Date.now() - (d.checkedAt ?? 0) > STALE)) void refreshDetection();
      // Reload paired devices too, so a device that came online shows its projects again.
      void loadDevices().finally(() => loadProjects());
    };
    const interval = setInterval(recheck, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, []);

  // Discover sessions created/continued in terminals or other Pi clients while this tab is open.
  useEffect(() => {
    if (!chatsLoaded || isHosted()) return;
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      const before = new Map(useStore.getState().chats.map((c) => [c.id, c]));
      try {
        const incoming = await loadChats();
        if (disposed) return;
        const current = useStore.getState().chats;
        const byId = new Map(current.map((c) => [c.id, c]));
        for (const chat of incoming) {
          const original = before.get(chat.id);
          const now = byId.get(chat.id);
          // A local edit, delete or streamed delta happened during the request: leave it alone.
          // Pi running outside OpenBuild only changes here, so keep taking it.
          if (now !== original || now?.messages.some((m) => m.status === "streaming" && m.stream?.via !== EXTERNAL_VIA)) continue;
          // Unchanged chats come back as the same object from the chat cache.
          if (now === chat) continue;
          if (!now || JSON.stringify(now) !== JSON.stringify(chat)) byId.set(chat.id, chat);
        }
        useStore.getState().setChats([...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt));
        // Commands another device started here.
        resumeShells();
      } catch { /* Keep the current view offline; the next poll retries. */ }
      finally { pending = false; }
    };
    const timer = setInterval(() => void refresh(), 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [chatsLoaded]);

  // Global shortcuts:
  //   Cmd/Ctrl+,        open settings (instead of the browser's)
  //   Cmd/Ctrl+B        toggle the sidebar (works everywhere)
  //   Cmd/Ctrl+Shift+O  new thread
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
    document.title = chat ? `${chat.title} · OpenBuild` : "OpenBuild";
  }, [chat?.title]);

  // The server serves the app at every client route, including on reload.
  useEffect(() => {
    if (chatsLoaded) return startRouting({
      getState: useStore.getState,
      setState: useStore.setState,
      subscribe: useStore.subscribe,
      selectChat: useStore.getState().selectChat,
    });
  }, [chatsLoaded]);

  return (
    <>
      <PluginSlot name="app:before" />
      <div className={cx("app", settingsOpen && "app-behind-modal")} inert={settingsOpen || lightboxOpen}>
        <Sidebar />
        <main className={cx("main", !sidebarOpen && "main-full")}>
          <div className={cx("floating-tools", !sidebarOpen && "floating-tools-visible")} inert={sidebarOpen}>
            <IconButton label="Open sidebar" tooltipSide="right" onClick={() => setSidebarOpen(true)}>
              <PanelLeft size={18} />
            </IconButton>
            <IconButton label="New thread" tooltipSide="right" onClick={newChat}>
              <SquarePen size={17} />
            </IconButton>
          </div>
          {!chatsLoaded ? (
            loadError && (
              <div className="home">
                <div className="home-center">
                  <p>
                    {isHosted()
                      ? `Couldn't read your threads from this browser's storage (${loadError}). If private browsing or a privacy setting blocks site storage, turn it off for this site. Retrying…`
                      : `Can't reach the OpenBuild server to load your threads (${loadError}). Retrying…`}
                  </p>
                </div>
              </div>
            )
          ) : chat ? <ChatView key={chat.id} chat={chat} /> : <Home />}
        </main>
      </div>
      <SettingsModal />
      <Lightbox />
      <TooltipLayer />
      <PluginSlot name="app:overlay" />
      {cloudConfigured() && <CloudSync />}
      {cloudConfigured() && <SyncLockScreen />}
    </>
  );
}
