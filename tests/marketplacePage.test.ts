import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// OpenBots' Marketplace as a page in the main pane, clicked at in a DOM: every way in opens it (the
// sidebar's button, a bot's Connect card), an app's page sits a level under the catalog, and Back and
// Esc step up and then out, leaving the sidebar and the world as they were. tests/routes.test.ts
// covers its addresses and history. Each test file runs in its own process (scripts/test.ts), so the
// globals stay here.
const win = new Window({ url: "http://localhost/bots" });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(win)) if (!(key in g)) g[key] = (win as any)[key];
Object.assign(g, { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, sessionStorage: win.sessionStorage, location: win.location, history: win.history, getComputedStyle: win.getComputedStyle.bind(win) });
g.window.matchMedia = (q: string) => ({ matches: q.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} });
g.matchMedia = g.window.matchMedia;
g.IS_REACT_ACT_ENVIRONMENT = true;
g.HTMLElement.prototype.scrollIntoView ??= function () {};

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useStore } = await import("../src/lib/store");
const { enterWorkspace } = await import("../src/lib/bots/store");
const { useWorkspace } = await import("../src/lib/bots/workspace");
useWorkspace.setState({ localId: "srv", localName: "Studio" });
enterWorkspace("srv");
const { MarketplacePage, ConnectCard } = await import("../src/components/bots/BotApps");

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  globalThis.fetch = (async (input: string) => {
    const path = String(input).replace(/^http:\/\/localhost/, "");
    if (path.endsWith("/api/bots/apps")) return Response.json({ apps: [{ id: "linear", status: "connected", connectedAt: Date.now(), tools: [{ name: "list_issues", description: "List issues" }] }], clients: [], githubKey: false });
    return Response.json({});
  }) as unknown as typeof fetch;
  useStore.setState({ botsOpen: true, botsSidebarOpen: true, sidebarOpen: false, marketplaceOpen: false, marketplaceApp: undefined, settingsOpen: false, usageOpen: false });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const frames = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const click = (el: Element) => act(async () => { el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as any); });
const escape = () => act(async () => { window.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as any); });
const Page = () => (useStore((s) => s.marketplaceOpen) ? createElement(MarketplacePage) : createElement("p", { id: "chat" }, "Bot chat"));
const sides = () => ({ botsOpen: useStore.getState().botsOpen, botsSidebarOpen: useStore.getState().botsSidebarOpen, sidebarOpen: useStore.getState().sidebarOpen });

test("the catalog opens as a page, an app's page is a level under it, and Back and Esc step up and then out", async () => {
  const before = sides();
  await act(async () => root.render(createElement(Page)));
  await act(async () => useStore.getState().openMarketplace());
  await frames();
  expect(host.querySelector(".mpage .page-title")!.textContent).toBe("Marketplace");
  // No dialog: it's a region of the page, with the categories and the list.
  expect(document.querySelector("dialog")).toBeNull();
  expect(host.querySelector("[role=region][aria-label=Marketplace]")).not.toBeNull();
  expect(host.querySelector(".apps-nav")).not.toBeNull();

  const linear = [...host.querySelectorAll(".app-row-main")].find((b) => b.textContent!.includes("Linear"))!;
  await click(linear);
  await frames();
  expect(useStore.getState().marketplaceApp).toBe("linear");
  // The trail names where it sits; the cards say what it is.
  expect(host.querySelector(".mpage .page-title")!.textContent).toBe("Marketplace/Linear");
  expect([...host.querySelectorAll(".app-card-title")].map((t) => t.textContent)).toEqual(["Connection", "Tools", "Danger zone"]);
  expect(host.querySelector(".app-list-card .app-card-count")!.textContent).toBe("1");

  // Esc: up to the catalog, then out to the bot chat.
  await escape();
  expect(useStore.getState()).toMatchObject({ marketplaceOpen: true, marketplaceApp: undefined });
  await escape();
  expect(useStore.getState().marketplaceOpen).toBe(false);
  expect(host.querySelector("#chat")).not.toBeNull();

  // The header's back does the same (and the trail's first step goes to the catalog).
  await act(async () => useStore.getState().openMarketplace("linear"));
  await frames();
  await click(host.querySelector(".mpage-crumb")!);
  expect(useStore.getState()).toMatchObject({ marketplaceOpen: true, marketplaceApp: undefined });
  await act(async () => useStore.getState().openMarketplace("linear"));
  await frames();
  await click(host.querySelector(".page-back")!);
  expect(useStore.getState()).toMatchObject({ marketplaceOpen: true, marketplaceApp: undefined });
  await click(host.querySelector(".page-back")!);
  expect(useStore.getState().marketplaceOpen).toBe(false);
  // Neither sidebar nor world changed on the way.
  expect(sides()).toEqual(before);
});

test("a search keeps Esc while it has something in it", async () => {
  await act(async () => root.render(createElement(Page)));
  await act(async () => useStore.getState().openMarketplace());
  await frames();
  const input = host.querySelector<HTMLInputElement>(".apps-search input")!;
  input.focus();
  input.value = "lin";
  await escape();
  expect(useStore.getState().marketplaceOpen).toBe(true);
});

test("a bot's Connect card opens that app's page", async () => {
  await act(async () => root.render(createElement(ConnectCard, { appId: "notion" })));
  await frames();
  await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Connect")!);
  expect(useStore.getState()).toMatchObject({ marketplaceOpen: true, marketplaceApp: "notion", botsOpen: true });
});

test("an app that isn't in the catalog opens the catalog", async () => {
  await act(async () => root.render(createElement(Page)));
  await act(async () => useStore.getState().openMarketplace("gone"));
  await frames();
  expect(useStore.getState().marketplaceApp).toBeUndefined();
  expect(host.querySelector(".mpage .page-title")!.textContent).toBe("Marketplace");
});
