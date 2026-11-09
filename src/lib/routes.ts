import type { SettingsSection } from "./store";

const sections: readonly SettingsSection[] = ["security", "account", "profile", "general", "bots", "shortcuts", "pi", "keys", "projects", "search", "appearance", "notifications"];

export const threadPath = (id: string) => `/thread-${encodeURIComponent(id)}`;

type Route = { threadId?: string; section?: SettingsSection; usage?: true; bots?: true };

export function readRoute(pathname: string, hash = ""): Route {
  try {
    // Keep bookmarks from the old hash router working.
    const legacy = /^#\/c\/(.+)$/.exec(hash);
    if (legacy) return { threadId: decodeURIComponent(legacy[1]!) };
    const path = pathname.replace(/\/+$/, "");
    const thread = /^\/thread-([^/]+)$/.exec(path);
    if (thread) return { threadId: decodeURIComponent(thread[1]!) };
    if (path === "/usage") return { usage: true };
    if (path === "/bots/usage") return { bots: true, usage: true };
    if (path === "/bots") return { bots: true };
    // A thread opened from OpenBots, showing inside it.
    const botsThread = /^\/bots\/thread-([^/]+)$/.exec(path);
    if (botsThread) return { bots: true, threadId: decodeURIComponent(botsThread[1]!) };
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

/** The mode a page loads into, before routing starts: OpenBots, a thread opened inside it, or Usage. */
export function initialRouteState(pathname: string, hash = "") {
  const route = readRoute(pathname, hash);
  return { usageOpen: !!route.usage, botsOpen: !!route.bots, botsThread: !!route.bots && !!route.threadId, activeChatId: route.bots ? route.threadId : undefined };
}

interface RouteState {
  activeChatId?: string;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  usageOpen?: boolean;
  botsOpen?: boolean;
  botsThread?: boolean;
  chats: { id: string }[];
}
interface RouteStore {
  getState(): RouteState;
  selectChat(id: string): void;
  setState(patch: Pick<RouteState, "activeChatId" | "settingsOpen" | "settingsSection" | "usageOpen" | "botsOpen" | "botsThread"> & { searchFocus?: undefined }): void;
  subscribe(listener: () => void): () => void;
}
type Browser = Pick<Window, "location" | "history" | "addEventListener" | "removeEventListener">;

/** Start only after threads load, so a deep link isn't mistaken for a deleted thread. */
export function startRouting(store: RouteStore, browser: Browser = window): () => void {
  const { location, history } = browser;
  let applying = false;
  // What the URL last said, so only a change to it writes: a listener that runs on Back before ours
  // (gestures.ts, on a phone) mustn't push the page being left back on.
  let written: string | undefined;
  const pathFor = (state: RouteState) => state.settingsOpen
    ? `/settings/${state.settingsSection}`
    : state.usageOpen ? (state.botsOpen ? "/bots/usage" : "/usage") : state.botsOpen ? (state.botsThread && state.activeChatId ? `/bots${threadPath(state.activeChatId)}` : "/bots") : state.activeChatId ? threadPath(state.activeChatId) : "/new";
  const write = (replace: boolean) => {
    const state = store.getState();
    const url = pathFor(state) + location.search;
    const context = { threadId: state.activeChatId };
    written = `${url} ${state.activeChatId}`;
    // The same entry keeps whatever else it holds: which of OpenBots' screens it is, on a phone (see gestures.ts).
    const same = { ...history.state, ...context };
    if (replace) history.replaceState(same, "", url);
    else if (location.pathname + location.search + location.hash !== url) history.pushState(context, "", url);
    else if (history.state?.threadId !== state.activeChatId) history.replaceState(same, "", url);
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
        botsOpen: !!route.bots,
        botsThread: !!route.bots && !!chat && !!route.threadId,
        searchFocus: undefined,
      });
    } finally {
      applying = false;
    }
    // Canonicalize old, unknown and deleted-thread URLs without adding a history entry.
    write(true);
  };
  read();
  const unsubscribe = store.subscribe(() => {
    const state = store.getState();
    if (!applying && `${pathFor(state)}${location.search} ${state.activeChatId}` !== written) write(false);
  });
  browser.addEventListener("popstate", read);
  browser.addEventListener("hashchange", read);
  return () => {
    unsubscribe();
    browser.removeEventListener("popstate", read);
    browser.removeEventListener("hashchange", read);
  };
}
