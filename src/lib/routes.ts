import type { SettingsSection } from "./store";

const sections: readonly SettingsSection[] = ["security", "account", "profile", "general", "shortcuts", "pi", "keys", "projects", "search", "appearance", "notifications"];

export const threadPath = (id: string) => `/thread-${encodeURIComponent(id)}`;

type Route = { threadId?: string; section?: SettingsSection; usage?: true };

export function readRoute(pathname: string, hash = ""): Route {
  try {
    // Keep bookmarks from the old hash router working.
    const legacy = /^#\/c\/(.+)$/.exec(hash);
    if (legacy) return { threadId: decodeURIComponent(legacy[1]!) };
    const path = pathname.replace(/\/+$/, "");
    const thread = /^\/thread-([^/]+)$/.exec(path);
    if (thread) return { threadId: decodeURIComponent(thread[1]!) };
    if (path === "/usage") return { usage: true };
    const settings = /^\/settings(?:\/([^/]+))?$/.exec(path);
    if (settings) {
      const section = settings[1] ?? "profile";
      return { section: sections.includes(section as SettingsSection) ? section as SettingsSection : "profile" };
    }
  } catch {
    // Malformed percent escapes are an invalid route, not a startup failure.
  }
  return {};
}

interface RouteState {
  activeChatId?: string;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  usageOpen?: boolean;
  chats: { id: string }[];
}
interface RouteStore {
  getState(): RouteState;
  selectChat(id: string): void;
  setState(patch: Pick<RouteState, "activeChatId" | "settingsOpen" | "settingsSection" | "usageOpen"> & { searchFocus?: undefined }): void;
  subscribe(listener: () => void): () => void;
}
type Browser = Pick<Window, "location" | "history" | "addEventListener" | "removeEventListener">;

/** Start only after threads load, so a deep link isn't mistaken for a deleted thread. */
export function startRouting(store: RouteStore, browser: Browser = window): () => void {
  const { location, history } = browser;
  let applying = false;
  const pathFor = (state: RouteState) => state.settingsOpen
    ? `/settings/${state.settingsSection}`
    : state.usageOpen ? "/usage" : state.activeChatId ? threadPath(state.activeChatId) : "/new";
  const write = (replace: boolean) => {
    const state = store.getState();
    const url = pathFor(state) + location.search;
    const context = { threadId: state.activeChatId };
    if (replace) history.replaceState(context, "", url);
    else if (location.pathname + location.search + location.hash !== url) history.pushState(context, "", url);
    else if (history.state?.threadId !== state.activeChatId) history.replaceState(context, "", url);
  };
  const read = () => {
    const route = readRoute(location.pathname, location.hash);
    const id = route.threadId ?? (route.section ? history.state?.threadId : undefined);
    const state = store.getState();
    const chat = state.chats.find((c) => c.id === id);
    applying = true;
    try {
      if (chat) store.selectChat(chat.id); // Also clears the thread’s unread marker.
      store.setState({
        activeChatId: chat?.id,
        settingsOpen: !!route.section,
        settingsSection: route.section ?? state.settingsSection,
        usageOpen: !!route.usage,
        searchFocus: undefined,
      });
    } finally {
      applying = false;
    }
    // Canonicalize old, unknown and deleted-thread URLs without adding a history entry.
    write(true);
  };
  read();
  const unsubscribe = store.subscribe(() => { if (!applying) write(false); });
  browser.addEventListener("popstate", read);
  browser.addEventListener("hashchange", read);
  return () => {
    unsubscribe();
    browser.removeEventListener("popstate", read);
    browser.removeEventListener("hashchange", read);
  };
}
