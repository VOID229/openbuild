import { describe, expect, test } from "bun:test";
import { readRoute, startRouting, threadPath } from "../src/lib/routes";

function harness(url = "/new") {
  let state = { activeChatId: undefined as string | undefined, settingsOpen: false, settingsSection: "profile" as import("../src/lib/store").SettingsSection, botsOpen: undefined as boolean | undefined, botsThread: undefined as boolean | undefined, chats: [{ id: "abc" }, { id: "def" }] };
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
    expect(readRoute("/settings")).toEqual({ section: "profile" });
    expect(readRoute("/settings/appearance/")).toEqual({ section: "appearance" });
    expect(readRoute("/settings/shortcuts")).toEqual({ section: "shortcuts" });
    expect(readRoute("/settings/invalid")).toEqual({ section: "profile" });
    expect(readRoute("/bots/thread-abc")).toEqual({ bots: true, threadId: "abc" });
    expect(readRoute("/thread-%ZZ")).toEqual({});
  });

  test("canonicalizes deep links and stale ids without adding history", () => {
    for (const [url, expected] of [["/", "/new"], ["/thread-missing", "/new"], ["/#/c/abc", "/thread-abc"], ["/settings", "/settings/profile"]]) {
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
    h.store.setState({ settingsSection: "pi" });
    expect(h.location.pathname).toBe("/settings/pi");
    h.go(-1);
    expect(h.store.getState().settingsSection).toBe("general");
    h.go(-1);
    expect(h.store.getState().settingsOpen).toBe(false);
    expect(h.store.getState().activeChatId).toBe("abc");
    h.go(1);
    expect(h.store.getState().settingsOpen).toBe(true);
    h.store.setState({ settingsOpen: false });
    expect(h.location.pathname).toBe("/thread-abc");
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
    expect(h.location.pathname).toBe("/settings/profile");
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
