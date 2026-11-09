import { describe, expect, test } from "bun:test";
import { initialRouteState, readRoute, startRouting, threadPath } from "../src/lib/routes";

function harness(url = "/new") {
  let state = { activeChatId: undefined as string | undefined, settingsOpen: false, settingsSection: "profile" as import("../src/lib/store").SettingsSection, settingsPage: undefined as string | undefined, settingsIndex: false as boolean | undefined, botsOpen: undefined as boolean | undefined, botsThread: undefined as boolean | undefined, chats: [{ id: "abc" }, { id: "def" }] };
  const subscribers = new Set<() => void>();
  const listeners = new Map<string, () => void>();
  let entries = [{ url, state: null as any }];
  let at = 0;
  const location = new URL(url, "http://localhost");
  const updateLocation = () => { location.href = new URL(entries[at]!.url, location.origin).href; };
  const history = {
    get state() { return entries[at]!.state; },
    replaceState(state: any, _: string, url: any) { entries[at] = { state, url }; updateLocation(); },
    pushState(state: any, _: string, url: any) { entries = entries.slice(0, at + 1); entries.push({ state, url }); at++; updateLocation(); },
  };
  const store = {
    getState: () => state,
    selectChat(id: string) { store.setState({ activeChatId: id }); },
    setState(patch: Partial<typeof state>) { state = { ...state, ...patch }; subscribers.forEach((f) => f()); },
    subscribe(f: () => void) { subscribers.add(f); return () => { subscribers.delete(f); }; },
  };
  const browser = { location, history, addEventListener: (event: string, f: () => void) => listeners.set(event, f), removeEventListener: (event: string) => listeners.delete(event) };
  const stop = startRouting(store, browser as unknown as Parameters<typeof startRouting>[1]);
  return {
    store, location, stop, history,
    count: () => entries.length,
    /** `before` is another popstate listener, one that runs ahead of the router's. */
    go(offset: number, before?: () => void) { at += offset; updateLocation(); before?.(); listeners.get("popstate")?.(); },
    reload() { stop(); return startRouting(store, browser as unknown as Parameters<typeof startRouting>[1]); },
  };
}

describe("clean URLs", () => {
  test("parses readable routes, escaped ids and legacy links safely", () => {
    expect(threadPath("a/b #")).toBe("/thread-a%2Fb%20%23");
    expect(readRoute("/thread-a%2Fb%20%23")).toEqual({ threadId: "a/b #" });
    expect(readRoute("/", "#/c/abc")).toEqual({ threadId: "abc" });
    // Settings alone is its list of sections (a phone's first screen); then a section, or a page inside one.
    expect(readRoute("/settings")).toEqual({ section: "profile", index: true });
    expect(readRoute("/settings/appearance/")).toEqual({ section: "appearance" });
    expect(readRoute("/settings/shortcuts")).toEqual({ section: "shortcuts" });
    expect(readRoute("/settings/runtimes")).toEqual({ section: "runtimes" });
    expect(readRoute("/settings/devices")).toEqual({ section: "devices" });
    expect(readRoute("/settings/plugin:hello")).toEqual({ section: "plugin:hello" });
    expect(readRoute("/settings/bots/models")).toEqual({ section: "bots", page: "models" });
    expect(readRoute("/settings/bots/bot/b%25201")).toEqual({ section: "bots", page: "bot/b%201" });
    expect(readRoute("/settings/invalid")).toEqual({ section: "profile" });
    expect(readRoute("/settings/invalid/page")).toEqual({ section: "profile" });
    expect(readRoute("/bots/thread-abc")).toEqual({ bots: true, threadId: "abc" });
    expect(readRoute("/thread-%ZZ")).toEqual({});
  });

  test("canonicalizes deep links and stale ids without adding history", () => {
    for (const [url, expected] of [["/", "/new"], ["/thread-missing", "/new"], ["/#/c/abc", "/thread-abc"], ["/settings", "/settings"], ["/settings/nope", "/settings/profile"], ["/settings/bots/bot/b%25201", "/settings/bots/bot/b%25201"]]) {
      const h = harness(url);
      expect(h.location.pathname).toBe(expected!);
      expect(h.location.hash).toBe("");
      expect(h.count()).toBe(1);
      h.stop();
    }
  });

  test("thread creation, settings sections, closing, Back and Forward stay in sync", () => {
    const h = harness();
    h.store.setState({ activeChatId: "abc" });
    expect(h.location.pathname).toBe("/thread-abc");
    h.store.setState({ settingsOpen: true, settingsSection: "general" });
    expect(h.count()).toBe(3);
    // Settings was opened from the thread one entry back, so leaving it can go back there.
    expect(h.history.state).toMatchObject({ threadId: "abc", back: 1 });
    // Moving between sections is the same visit: the entry is replaced, not stacked.
    h.store.setState({ settingsSection: "pi" });
    expect(h.location.pathname).toBe("/settings/pi");
    expect(h.count()).toBe(3);
    expect(h.history.state).toMatchObject({ back: 1 });
    h.go(-1);
    expect(h.store.getState().settingsOpen).toBe(false);
    expect(h.store.getState().activeChatId).toBe("abc");
    h.go(1);
    expect(h.store.getState()).toMatchObject({ settingsOpen: true, settingsSection: "pi" });
    h.store.setState({ settingsOpen: false });
    expect(h.location.pathname).toBe("/thread-abc");
    h.stop();
  });

  test("pages inside a section stack as entries that count their way back, and going up or across replaces", () => {
    const h = harness("/thread-abc");
    h.store.setState({ settingsOpen: true, settingsSection: "bots" });
    h.store.setState({ settingsPage: "models" });
    expect(h.location.pathname).toBe("/settings/bots/models");
    expect(h.count()).toBe(3);
    // One level deeper: Back goes up to the section, and leaving Settings is two entries back.
    expect(h.history.state).toMatchObject({ threadId: "abc", back: 2, up: true });
    h.store.setState({ settingsPage: "bot/b 1" });
    expect(h.location.pathname).toBe("/settings/bots/bot/b%201");
    // A page beside it (not inside it) takes its place.
    expect(h.count()).toBe(3);
    h.go(-1);
    expect(h.store.getState()).toMatchObject({ settingsOpen: true, settingsSection: "bots", settingsPage: undefined });
    h.go(1);
    expect(h.store.getState()).toMatchObject({ settingsSection: "bots", settingsPage: "bot/b 1" });
    // Another section replaces the page's entry, still counting the way back.
    h.store.setState({ settingsSection: "general", settingsPage: undefined });
    expect(h.location.pathname).toBe("/settings/general");
    expect(h.count()).toBe(3);
    expect(h.history.state).toMatchObject({ back: 2 });
    h.go(-2);
    expect(h.store.getState()).toMatchObject({ settingsOpen: false, activeChatId: "abc" });
    // Opened by a link, there's no entry behind it to go back to.
    const deep = harness("/settings/pi/skills");
    expect(deep.store.getState()).toMatchObject({ settingsOpen: true, settingsSection: "pi", settingsPage: "skills" });
    expect(deep.history.state?.back).toBeUndefined();
    deep.stop();
    h.stop();
  });

  test("Usage remembers it was opened from one entry back", () => {
    const h = harness("/thread-abc");
    h.store.setState({ usageOpen: true } as never);
    expect(h.location.pathname).toBe("/usage");
    expect(h.history.state).toMatchObject({ threadId: "abc", back: 1 });
    h.stop();
  });

  test("settings reload retains underlying thread and unrelated updates don't push history", () => {
    const h = harness("/thread-def?keep=1");
    h.store.setState({ settingsOpen: true, settingsSection: "keys" });
    const stop = h.reload();
    expect(h.store.getState().activeChatId).toBe("def");
    h.store.setState({ chats: [...h.store.getState().chats] });
    expect(h.count()).toBe(2);
    h.store.setState({ settingsOpen: false });
    expect(h.location.pathname + h.location.search).toBe("/thread-def?keep=1");
    stop();
  });

  test("Back and Forward keep what else an entry holds, like which OpenBots screen it is on a phone", () => {
    const h = harness("/bots");
    const history = h.history;
    history.pushState({ ...history.state, botsLayer: "chat" }, "", "/bots");
    history.pushState({ ...history.state, botsLayer: "details" }, "", "/bots");
    h.go(-1);
    expect(history.state?.botsLayer).toBe("chat");
    h.go(1);
    expect(history.state?.botsLayer).toBe("details");
    // A different page is a new entry, and starts clean.
    h.store.setState({ settingsOpen: true });
    expect(h.location.pathname).toBe("/bots/settings/profile");
    expect(history.state?.botsLayer).toBeUndefined();
  });

  test("Usage opened from OpenBots stays there, and closing it goes back to OpenBots", () => {
    expect(readRoute("/bots/usage")).toEqual({ bots: true, usage: true });
    const h = harness("/bots");
    h.store.setState({ usageOpen: true } as never);
    expect(h.location.pathname).toBe("/bots/usage");
    const stop = h.reload();
    expect(h.store.getState()).toMatchObject({ botsOpen: true, usageOpen: true });
    h.store.setState({ usageOpen: false } as never);
    expect(h.location.pathname).toBe("/bots");
    h.go(-1);
    expect(h.store.getState()).toMatchObject({ botsOpen: true, usageOpen: true });
    stop();
  });

  test("Settings opened from OpenBots stays in OpenBots through its pages, and leaving goes back to OpenBots", () => {
    expect(readRoute("/bots/settings")).toEqual({ bots: true, section: "profile", index: true });
    expect(readRoute("/bots/settings/bots/models")).toEqual({ bots: true, section: "bots", page: "models" });
    const h = harness("/bots");
    h.store.setState({ botsOpen: true });
    h.store.setState({ settingsOpen: true, settingsSection: "bots" });
    expect(h.location.pathname).toBe("/bots/settings/bots");
    h.store.setState({ settingsPage: "models" });
    expect(h.location.pathname).toBe("/bots/settings/bots/models");
    // Up a level inside Settings: still OpenBots underneath.
    h.go(-1);
    expect(h.store.getState()).toMatchObject({ botsOpen: true, settingsOpen: true, settingsSection: "bots", settingsPage: undefined });
    // Leaving Settings lands back in OpenBots, not OpenBuild.
    h.go(-1);
    expect(h.store.getState()).toMatchObject({ botsOpen: true, settingsOpen: false });
    expect(h.location.pathname).toBe("/bots");
    // Reloaded on a Settings page opened from OpenBots, it's still OpenBots.
    expect(initialRouteState("/bots/settings/general")).toMatchObject({ botsOpen: true, settingsOpen: true, settingsSection: "general" });
    h.stop();
  });

  test("the Marketplace is a page of OpenBots: an app's page is a level below the catalog, and leaving goes back where it was opened", () => {
    expect(readRoute("/bots/marketplace")).toEqual({ bots: true, marketplace: true });
    expect(readRoute("/bots/marketplace/github")).toEqual({ bots: true, marketplace: true, app: "github" });
    expect(initialRouteState("/bots/marketplace/github")).toMatchObject({ botsOpen: true, marketplaceOpen: true, marketplaceApp: "github", settingsOpen: false, usageOpen: false });
    const h = harness("/bots");
    h.store.setState({ botsOpen: true });
    const count = h.count();
    h.store.setState({ marketplaceOpen: true } as never);
    expect(h.location.pathname).toBe("/bots/marketplace");
    expect(h.history.state).toMatchObject({ back: 1 });
    // Into an app's page: a new entry, one level down.
    h.store.setState({ marketplaceApp: "github" } as never);
    expect(h.location.pathname).toBe("/bots/marketplace/github");
    expect(h.history.state).toMatchObject({ back: 2, up: true });
    expect(h.count()).toBe(count + 2);
    // Back from the app is the catalog, still in OpenBots.
    h.go(-1);
    expect(h.store.getState()).toMatchObject({ botsOpen: true, marketplaceOpen: true, marketplaceApp: undefined });
    // Back again leaves it for the bot chat.
    h.go(-1);
    expect(h.store.getState()).toMatchObject({ botsOpen: true, marketplaceOpen: false });
    expect(h.location.pathname).toBe("/bots");
    // Opened straight at an app (a bot's Connect), stepping up to the catalog replaces the entry, and leaving is one step back.
    h.store.setState({ marketplaceOpen: true, marketplaceApp: "notion" } as never);
    expect(h.location.pathname).toBe("/bots/marketplace/notion");
    h.store.setState({ marketplaceApp: undefined } as never);
    expect(h.location.pathname).toBe("/bots/marketplace");
    expect(h.history.state).toMatchObject({ back: 1 });
    // Settings over it covers it, at its own address.
    h.store.setState({ settingsOpen: true, settingsSection: "bots" });
    expect(h.location.pathname).toBe("/bots/settings/bots");
    h.stop();
  });

  test("a thread opened from OpenBots stays in OpenBots, and Back returns to the bot chat", () => {
    const h = harness("/bots");
    h.store.setState({ activeChatId: "abc", botsOpen: true, botsThread: true });
    expect(h.location.pathname).toBe("/bots/thread-abc");
    h.go(-1);
    expect(h.location.pathname).toBe("/bots");
    expect(h.store.getState()).toMatchObject({ botsOpen: true, botsThread: false });
    h.go(1);
    expect(h.store.getState()).toMatchObject({ activeChatId: "abc", botsOpen: true, botsThread: true });
    // On a phone, gestures.ts hears Back first and changes the store before the route is read.
    h.go(-1, () => h.store.setState({ chats: [...h.store.getState().chats] }));
    expect(h.location.pathname).toBe("/bots");
    expect(h.store.getState().botsThread).toBe(false);
    h.go(1);
    expect(h.location.pathname).toBe("/bots/thread-abc");
    h.stop();
    // A link to a thread that's gone is the bot chat.
    const gone = harness("/bots/thread-missing");
    expect(gone.location.pathname).toBe("/bots");
    expect(gone.store.getState().botsThread).toBe(false);
    gone.stop();
  });

  test("a thread opened out of OpenBots to OpenBuild gets its own route, and Back returns to it in OpenBots", () => {
    const h = harness("/bots/thread-abc");
    expect(h.store.getState()).toMatchObject({ activeChatId: "abc", botsOpen: true, botsThread: true });
    h.store.setState({ botsOpen: false, botsThread: false });
    expect(h.location.pathname).toBe("/thread-abc");
    h.go(-1);
    expect(h.store.getState()).toMatchObject({ activeChatId: "abc", botsOpen: true, botsThread: true });
    h.stop();
  });

  test("archiving or deleting the active thread routes back to new", () => {
    const h = harness("/thread-abc");
    h.store.setState({ activeChatId: undefined });
    expect(h.location.pathname).toBe("/new");
    h.store.setState({ chats: [] });
    h.go(-1);
    expect(h.location.pathname).toBe("/new");
    expect(h.store.getState().activeChatId).toBeUndefined();
    h.stop();
  });
});

describe("initialRouteState", () => {
  test("a thread opened inside OpenBots loads as that thread, not the bot chat", () => {
    expect(initialRouteState("/bots/thread-abc")).toEqual({ usageOpen: false, marketplaceOpen: false, marketplaceApp: undefined, botsOpen: true, botsThread: true, activeChatId: "abc", settingsOpen: false, settingsSection: undefined, settingsPage: undefined, settingsIndex: false });
  });
  test("OpenBots, Usage and plain threads load into their own mode", () => {
    expect(initialRouteState("/bots")).toMatchObject({ botsOpen: true, botsThread: false, activeChatId: undefined });
    expect(initialRouteState("/bots/usage")).toMatchObject({ botsOpen: true, usageOpen: true, botsThread: false });
    expect(initialRouteState("/thread-abc")).toMatchObject({ botsOpen: false, botsThread: false });
    expect(initialRouteState("/new")).toMatchObject({ botsOpen: false, usageOpen: false, settingsOpen: false });
    expect(initialRouteState("/settings/bots/models")).toMatchObject({ settingsOpen: true, settingsSection: "bots", settingsPage: "models", settingsIndex: false });
  });
});
