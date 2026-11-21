// Settings, Usage and OpenBots' Marketplace are pages over whatever was showing when the first of
// them was opened: a thread, the new-thread screen, the bot chat. Esc, or the back arrow in a page's
// header, leaves for that from anywhere in them: not back to the page it was opened from (Usage
// opened from the Marketplace), and not up through the sections and pages inside it. The browser's own
// back still steps through each entry, and where it lands is the entry it started from, not a new one
// stacked on top. In a real Chrome with the whole app on a fake server (fixtures/groupThreads).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/groupThreads/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page, "/new": page, "/usage": page, "/settings/*": page, "/bots": page, "/bots/*": page } });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

const THREADS = "window.store?.getState().chatsLoaded";
const READY = `${THREADS} && window.bots?.getState().loaded`;

/** OpenBots loads its bots once it is opened; a thread's own address (OpenBuild's side) waits for the threads alone. */
const open = (path = "/bots", width = 1280, height = 800) => Page.open(chrome!.ws, new URL(path, server!.url).href, width, height, path.startsWith("/bots") ? READY : THREADS);

const escape = async (page: Page) => {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
};

const entries = (page: Page) => page.eval<number>("history.length");

/** Until the address says `want` and the page showing is that one. */
async function at(page: Page, want: string) {
  await page.until(`location.pathname === ${JSON.stringify(want)}`);
  await page.settle();
}

/** Back at `want` (the bot chat, a thread, the new-thread screen), with no page over it. */
async function left(page: Page, want: string) {
  await at(page, want);
  await page.until("!document.querySelector('.spage, .ustats, .mpage')");
  expect(await page.eval<object>("(({ settingsOpen, usageOpen, marketplaceOpen }) => ({ settingsOpen, usageOpen: !!usageOpen, marketplaceOpen: !!marketplaceOpen }))(store.getState())")).toEqual({
    settingsOpen: false,
    usageOpen: false,
    marketplaceOpen: false,
  });
}

/** The Marketplace, from the button at the foot of OpenBots' sidebar, as a person opens it. */
async function marketplace(page: Page) {
  await page.click(".bots-sidebar [aria-label=Marketplace]");
  await at(page, "/bots/marketplace");
}

/** Usage, as its shortcut and the sidebar's button open it. */
async function usage(page: Page, path: string) {
  await page.eval("store.getState().setUsageOpen(true)");
  await at(page, path);
  await page.until("!!document.querySelector('.ustats')");
}

/** Moves around inside Settings: two sections from its nav, then a page inside Bots. */
async function aroundSettings(page: Page, prefix: string) {
  await page.eval("store.getState().openSettings('general')");
  await at(page, `${prefix}/settings/general`);
  await page.click('.settings-nav-item[aria-label="Appearance"]');
  await at(page, `${prefix}/settings/appearance`);
  await page.click('.settings-nav-item[aria-label="Bots"]');
  await at(page, `${prefix}/settings/bots`);
  await page.eval("store.getState().openSettings('bots', 'models')");
  await at(page, `${prefix}/settings/bots/models`);
}

describe.skipIf(!browser)("leaving a page goes back to what it was opened over", () => {
  for (const how of ["Esc", "the back arrow"] as const) {
    const leave = (page: Page) => (how === "Esc" ? escape(page) : page.click(".page-head .page-back"));

    test(`Usage opened from the Marketplace: ${how} goes to the bot chat, not back to the Marketplace`, async () => {
      const page = await open();
      const start = await entries(page);
      await marketplace(page);
      await usage(page, "/bots/usage");
      await leave(page);
      await left(page, "/bots");
      // Back through the history it came, so nothing is stacked on top: Forward goes to the Marketplace.
      expect(await entries(page)).toBe(start + 2);
      await page.eval("history.forward()");
      await at(page, "/bots/marketplace");
    }, 60_000);

    test(`Settings, after its sections and a page inside one: ${how} leaves it`, async () => {
      const page = await open();
      await aroundSettings(page, "/bots");
      await leave(page);
      await left(page, "/bots");
    }, 60_000);

    test(`an app's page in the Marketplace: ${how} leaves the Marketplace, not for the catalog`, async () => {
      const page = await open();
      await marketplace(page);
      await page.eval("store.setState({ marketplaceApp: 'github' })");
      await at(page, "/bots/marketplace/github");
      await leave(page);
      await left(page, "/bots");
    }, 60_000);

    test(`a thread, then Usage, then Settings and a page inside it: ${how} goes back to the thread`, async () => {
      const page = await open("/new");
      await page.eval("store.getState().selectChat('t-flaky')");
      await at(page, "/thread-t-flaky");
      await usage(page, "/usage");
      await aroundSettings(page, "");
      await leave(page);
      await left(page, "/thread-t-flaky");
      expect(await page.eval<string>("store.getState().activeChatId")).toBe("t-flaky");
    }, 60_000);

    test(`a thread opened inside OpenBots, then Settings: ${how} goes back to that thread`, async () => {
      const page = await open();
      await page.eval("store.setState({ activeChatId: 't-flaky', botsThread: true })");
      await at(page, "/bots/thread-t-flaky");
      await page.eval("store.getState().openSettings('general')");
      await at(page, "/bots/settings/general");
      await leave(page);
      await left(page, "/bots/thread-t-flaky");
      expect(await page.eval<boolean>("!!store.getState().botsThread")).toBe(true);
    }, 60_000);
  }

  test("opened by a link, with nothing behind it, Esc closes the page over what is under it", async () => {
    for (const [link, under] of [["/bots/settings/bots/models", "/bots"], ["/usage", "/new"], ["/bots/marketplace/github", "/bots"]] as const) {
      const page = await open(link);
      await at(page, link);
      await escape(page);
      await left(page, under);
    }
  }, 60_000);

  test("the browser's own back still steps back through each page", async () => {
    const page = await open();
    await marketplace(page);
    await usage(page, "/bots/usage");
    await page.eval("history.back()");
    await at(page, "/bots/marketplace");
    await page.eval("history.back()");
    await left(page, "/bots");
  }, 60_000);

  test("on a phone, the header's arrow still goes up a level inside Settings, and Esc leaves", async () => {
    const page = await open("/bots", 390, 800);
    await page.eval("store.getState().openSettings('bots', 'models')");
    await at(page, "/bots/settings/bots/models");
    // Once the pane has slid in over the list, so the click lands on the arrow.
    await page.until("document.querySelector('.page-title')?.textContent === 'Models'");
    await page.finished();
    expect(await page.eval<string>("document.querySelector('.page-head .page-back').getAttribute('aria-label')")).toBe("Back to Bots");
    await page.click(".page-head .page-back");
    await at(page, "/bots/settings/bots");
    await escape(page);
    await left(page, "/bots");
  }, 60_000);
});

// Esc closes what is open over Settings, or what uses it with focus, before it leaves Settings: the
// next Esc leaves. A menu left open in the sidebar Settings hides stays mounted there, out of sight:
// it is not over the page, and takes no Esc.
describe.skipIf(!browser)("Esc in Settings", () => {
  test("a menu left open in the sidebar that Settings hides doesn't hold Esc", async () => {
    const page = await open();
    await page.click(".bots-sidebar [aria-label=New]");
    await page.until("!!document.querySelector('.popover-portal')?.checkVisibility()");
    // As the Settings shortcut does, with the menu still open.
    await page.eval("store.getState().openSettings('general')");
    await at(page, "/bots/settings/general");
    await page.until("!!document.querySelector('.spage')");
    await page.until("![...document.querySelectorAll('.popover-portal')].some((p) => p.checkVisibility())");
    await escape(page);
    await left(page, "/bots");
  }, 60_000);

  test("a dropdown open in Settings closes first, and the next Esc leaves", async () => {
    const page = await open();
    await page.eval("store.getState().openSettings('general')");
    await at(page, "/bots/settings/general");
    await page.click('.settings-content button[aria-haspopup="listbox"]');
    await page.until("!!document.querySelector('.popover-portal')?.checkVisibility()");
    // The pointer leaves focus on the trigger, outside the list: the open list still takes the Esc.
    await page.eval("document.querySelector('.settings-content button[aria-haspopup=\"listbox\"]').focus()");
    await escape(page);
    await page.until("![...document.querySelectorAll('.popover-portal')].some((p) => p.checkVisibility())", 2_000);
    expect(await page.eval<boolean>("store.getState().settingsOpen")).toBe(true);
    await escape(page);
    await left(page, "/bots");
  }, 60_000);
});
