import type { SettingsSection } from "./store";

const sections: readonly SettingsSection[] = ["security", "account", "profile", "general", "bots", "shortcuts", "pi", "keys", "runtimes", "projects", "devices", "search", "appearance", "notifications", "plugins"];
const validSection = (s: string): s is SettingsSection => sections.includes(s as SettingsSection) || /^plugin:[^/]+$/.test(s);

export const threadPath = (id: string) => `/thread-${encodeURIComponent(id)}`;

type Route = { threadId?: string; section?: SettingsSection; page?: string; index?: true; usage?: true; bots?: true; marketplace?: true; app?: string };

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
    // OpenBots' Marketplace: the catalog, or one app's page.
    if (path === "/bots/marketplace") return { bots: true, marketplace: true };
    const app = /^\/bots\/marketplace\/([^/]+)$/.exec(path);
    if (app) return { bots: true, marketplace: true, app: decodeURIComponent(app[1]!) };
    // Settings opened from OpenBots stays in OpenBots: the same pages under /bots.
    if (path === "/bots/settings" || path.startsWith("/bots/settings/")) {
      const inner = readRoute(path.slice("/bots".length), hash);
      return inner.section ? { ...inner, bots: true } : { bots: true };
    }
    // A thread opened from OpenBots, showing inside it.
    const botsThread = /^\/bots\/thread-([^/]+)$/.exec(path);
    if (botsThread) return { bots: true, threadId: decodeURIComponent(botsThread[1]!) };
    // Settings: its list of sections (a phone's first screen), a section, or a page inside one.
    if (path === "/settings") return { section: "profile", index: true };
    const settings = /^\/settings\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (settings) {
      const section = decodeURIComponent(settings[1]!);
      if (!validSection(section)) return { section: "profile" };
      return settings[2] ? { section, page: decodeURI(settings[2]) } : { section };
    }
  } catch {
    // Malformed percent escapes are an invalid route, not a startup failure.
  }
  return {};
}

/** The mode a page loads into, before routing starts: OpenBots, a thread opened inside it, Usage or Settings. */
export function initialRouteState(pathname: string, hash = "") {
  const route = readRoute(pathname, hash);
  return {
    usageOpen: !!route.usage,
    marketplaceOpen: !!route.marketplace,
    marketplaceApp: route.app,
    botsOpen: !!route.bots,
    botsThread: !!route.bots && !!route.threadId,
    activeChatId: route.bots ? route.threadId : undefined,
    settingsOpen: !!route.section,
    settingsSection: route.section,
    settingsPage: route.page,
    settingsIndex: !!route.index,
  };
}

interface RouteState {
  activeChatId?: string;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  settingsPage?: string;
  settingsIndex?: boolean;
  usageOpen?: boolean;
  marketplaceOpen?: boolean;
  marketplaceApp?: string;
  botsOpen?: boolean;
  botsThread?: boolean;
  chats: { id: string }[];
}
interface RouteStore {
  getState(): RouteState;
  selectChat(id: string): void;
  setState(patch: Pick<RouteState, "activeChatId" | "settingsOpen" | "settingsSection" | "settingsPage" | "settingsIndex" | "usageOpen" | "marketplaceOpen" | "marketplaceApp" | "botsOpen" | "botsThread"> & { searchFocus?: undefined }): void;
  subscribe(listener: () => void): () => void;
}
type Browser = Pick<Window, "location" | "history" | "addEventListener" | "removeEventListener">;

/**
 * What a history entry holds besides its thread. `back`: how many entries back the page this entry
 * shows (Settings or Usage) was opened from, when this app pushed them, so leaving it can return
 * there through the browser's history. `up`: this entry went one level deeper inside Settings (a
 * page inside a section, or a section from a phone's list) or the Marketplace (an app's page from
 * the catalog), so going up is the browser's back.
 */
export type PageHistory = { threadId?: string; back?: number; up?: boolean };

let routed: Browser | undefined;

/** The browser routing runs in, while it does: pages go back through its history rather than around it. */
export const routingBrowser = () => routed;

const settingsPath = (state: RouteState) =>
  state.settingsIndex ? "/settings" : `/settings/${encodeURIComponent(state.settingsSection)}${state.settingsPage ? `/${encodeURI(state.settingsPage)}` : ""}`;

/** Inside Settings, whether `next` is a level below `prev`: a page in the same section, or a section picked from the list. */
function deeper(prev: RouteState, next: RouteState) {
  // On a wide screen the list is beside the section, so leaving it for a section is no step down.
  if (prev.settingsIndex) return !next.settingsIndex && typeof matchMedia === "function" && matchMedia("(max-width: 768px)").matches;
  if (next.settingsIndex || prev.settingsSection !== next.settingsSection || !next.settingsPage) return false;
  return !prev.settingsPage || next.settingsPage.startsWith(`${prev.settingsPage}/`);
}

/** The Marketplace is showing: a page of OpenBots' own, under Settings and Usage. */
const inMarketplace = (state: RouteState) => !!state.botsOpen && !!state.marketplaceOpen && !state.settingsOpen && !state.usageOpen;

/** Start only after threads load, so a deep link isn't mistaken for a deleted thread. */
export function startRouting(store: RouteStore, browser: Browser = window): () => void {
  const { location, history } = browser;
  let applying = false;
  // What the URL last said, so only a change to it writes: a listener that runs on Back before ours
  // (gestures.ts, on a phone) mustn't push the page being left back on.
  let written: string | undefined;
  // The state that was last written, to tell a step inside Settings from a move to somewhere else.
  let last: RouteState | undefined;
  const pathFor = (state: RouteState) => state.settingsOpen
    ? `${state.botsOpen ? "/bots" : ""}${settingsPath(state)}`
    : state.usageOpen ? (state.botsOpen ? "/bots/usage" : "/usage")
    : inMarketplace(state) ? `/bots/marketplace${state.marketplaceApp ? `/${encodeURIComponent(state.marketplaceApp)}` : ""}`
    : state.botsOpen ? (state.botsThread && state.activeChatId ? `/bots${threadPath(state.activeChatId)}` : "/bots") : state.activeChatId ? threadPath(state.activeChatId) : "/new";
  const write = (replace: boolean) => {
    const state = store.getState();
    const prev = last;
    last = { ...state };
    const url = pathFor(state) + location.search;
    const context: PageHistory = { threadId: state.activeChatId };
    written = `${url} ${state.activeChatId}`;
    const current = (history.state ?? {}) as PageHistory;
    // The same entry keeps whatever else it holds: which of OpenBots' screens it is, on a phone (see gestures.ts).
    const same = { ...history.state, ...context };
    // Moving between sections of Settings, or back up a level inside it, is the same visit: replaced, not stacked.
    const within = !!prev?.settingsOpen && state.settingsOpen;
    // The same goes for the Marketplace: into an app's page is a level down, anything else the same visit.
    const market = !!prev && inMarketplace(prev) && inMarketplace(state);
    const marketDeeper = market && !prev!.marketplaceApp && !!state.marketplaceApp;
    if (replace || (within && !deeper(prev!, state)) || (market && !marketDeeper)) history.replaceState(same, "", url);
    else if (location.pathname + location.search + location.hash !== url) {
      const pushed: PageHistory = within || marketDeeper
        ? { ...context, back: current.back ? current.back + 1 : undefined, up: true }
        : state.settingsOpen || (state.usageOpen && !prev?.usageOpen) || (inMarketplace(state) && !(prev && inMarketplace(prev))) ? { ...context, back: 1 } : context;
      history.pushState(pushed, "", url);
    } else if (history.state?.threadId !== state.activeChatId) history.replaceState(same, "", url);
  };
  const read = () => {
    const route = readRoute(location.pathname, location.hash);
    const id = route.threadId ?? (route.section || route.marketplace ? history.state?.threadId : undefined);
    const state = store.getState();
    const chat = state.chats.find((c) => c.id === id);
    applying = true;
    try {
      if (chat) store.selectChat(chat.id); // Also clears the thread’s unread marker.
      store.setState({
        activeChatId: chat?.id,
        settingsOpen: !!route.section,
        settingsSection: route.section ?? state.settingsSection,
        settingsPage: route.page,
        settingsIndex: !!route.index,
        usageOpen: !!route.usage,
        marketplaceOpen: !!route.marketplace,
        marketplaceApp: route.app,
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
  routed = browser;
  const unsubscribe = store.subscribe(() => {
    const state = store.getState();
    if (!applying && `${pathFor(state)}${location.search} ${state.activeChatId}` !== written) write(false);
  });
  browser.addEventListener("popstate", read);
  browser.addEventListener("hashchange", read);
  return () => {
    if (routed === browser) routed = undefined;
    unsubscribe();
    browser.removeEventListener("popstate", read);
    browser.removeEventListener("hashchange", read);
  };
}
