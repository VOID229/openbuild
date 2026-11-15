// A phone gets the desktop's sidebar and composers, fitted to its width: the Build/Bots switch in either
// sidebar's header (not a wordmark, with the way across at the foot), the search behind a button, and
// composers drawn as the desktop draws them, with their send button showing. Run in Chrome with the
// whole app on a fake server (fixtures/groupThreads), at an iPhone's 390×844.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/groupThreads/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const READY = "window.store?.getState().chatsLoaded && window.bots?.getState().loaded";
const PHONE = { width: 390, height: 844 };

const resize = (page: Page, width: number, height: number) =>
  page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

/** What shows in a sidebar's header and footer. */
const sidebarParts = (page: Page, sidebar: string) =>
  page.eval<{ switch: string | null; wordmark: boolean; search: boolean; searchButton: boolean; toggle: boolean }>(`(() => {
    const aside = document.querySelector(${JSON.stringify(sidebar)});
    const shown = (el) => !!el && el.getBoundingClientRect().width > 0;
    return {
      switch: aside.querySelector('.brand-row .mode-switch .mode-pill-on')?.textContent ?? null,
      wordmark: shown(aside.querySelector('.wordmark')),
      search: shown(aside.querySelector('label.search')),
      searchButton: shown(aside.querySelector('.brand-row [aria-label="Search"]')),
      toggle: shown(aside.querySelector('.settings-row .bots-toggle')),
    };
  })()`);

/** The look of the box a composer is drawn in, and whether its send button shows. */
const box = (page: Page, composer: string, send: string) =>
  page.eval<{ look: string[]; send: boolean }>(`(() => {
    const el = document.querySelector(${JSON.stringify(composer)});
    const s = getComputedStyle(el);
    const button = el.querySelector(${JSON.stringify(send)});
    return {
      look: [s.backgroundColor, s.borderTopWidth, s.borderTopColor, s.borderTopLeftRadius, s.boxShadow, s.paddingTop, s.paddingLeft],
      send: !!button && getComputedStyle(button).display !== 'none' && button.getBoundingClientRect().width > 0,
    };
  })()`);

describe.skipIf(!browser)("phone layout", () => {
  test("OpenBuild's drawer has the Build/Bots switch and a search button, as on a desktop", async () => {
    const page = await Page.open(chrome!.ws, server!.url.href, PHONE.width, PHONE.height, READY);
    await page.eval("store.setState({ botsOpen: false, sidebarOpen: true })");
    await page.finish();
    expect(await sidebarParts(page, ".sidebar:not(.bots-sidebar)")).toEqual({ switch: "Build", wordmark: false, search: false, searchButton: true, toggle: false });
    // The search opens from its button, ready to type in.
    await page.click('.sidebar:not(.bots-sidebar) .brand-row [aria-label="Search"]');
    await page.until("document.activeElement?.matches('.sidebar:not(.bots-sidebar) label.search input')");
  }, 60_000);

  test("the switch swaps the drawer for OpenBots' list, which has the same header, and back", async () => {
    const page = await Page.open(chrome!.ws, server!.url.href, PHONE.width, PHONE.height, READY);
    await page.eval("store.setState({ botsOpen: false, sidebarOpen: true })");
    await page.finish();
    await page.eval(`[...document.querySelectorAll('.sidebar:not(.bots-sidebar) .mode-pill')].find((b) => b.textContent === 'Bots').click()`);
    await page.until("store.getState().botsOpen");
    await page.finish();
    expect(await page.eval<[boolean, boolean]>("[store.getState().botsSidebarOpen, store.getState().sidebarOpen]")).toEqual([true, false]);
    expect(await sidebarParts(page, ".bots-sidebar")).toEqual({ switch: "Bots", wordmark: false, search: false, searchButton: true, toggle: false });
    // The list is the whole screen, its switch inside it.
    const [left, right] = await page.eval<[number, number]>("(() => { const r = document.querySelector('.bots-sidebar .mode-switch').getBoundingClientRect(); return [r.left, r.right]; })()");
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(PHONE.width);
    await page.eval(`[...document.querySelectorAll('.bots-sidebar .mode-pill')].find((b) => b.textContent === 'Build').click()`);
    await page.until("!store.getState().botsOpen && store.getState().sidebarOpen");
  }, 60_000);

  test("a thread's composer is the desktop's box, with its send button", async () => {
    const page = await Page.open(chrome!.ws, server!.url.href, 1280, 800, READY);
    await page.eval("store.setState({ botsOpen: false, sidebarOpen: false }); store.getState().selectChat('t-done')");
    await page.until("!!document.querySelector('.dock .composer')");
    await page.finish();
    const desktop = await box(page, ".dock .composer", ".round-btn-send");
    await resize(page, PHONE.width, PHONE.height);
    await page.finish();
    const phone = await box(page, ".dock .composer", ".round-btn-send");
    expect(phone).toEqual(desktop);
    expect(phone.send).toBe(true);
  }, 60_000);

  test("a bot chat's composer is the desktop's, with its files and poll buttons and its send button", async () => {
    const page = await Page.open(chrome!.ws, server!.url.href, 1280, 800, READY);
    await page.eval("store.setState({ botsOpen: true, botsSidebarOpen: true }); bots.setState({ activeId: 'dev' })");
    await page.until("!!document.querySelector('.bots-composer')");
    await page.finish();
    const desktop = await box(page, ".bots-composer", ".bots-send");
    await resize(page, PHONE.width, PHONE.height);
    await page.eval("store.setState({ botsSidebarOpen: false })");
    await page.finish();
    const phone = await box(page, ".bots-composer", ".bots-send");
    expect(phone).toEqual(desktop);
    expect(phone.send).toBe(true);
    // A group's two buttons before the text, not one that opens a sheet of them.
    expect(await page.eval<(string | null)[]>("[...document.querySelectorAll('.bots-composer-row > .bots-composer-btn')].slice(0, 2).map((b) => b.getAttribute('aria-label'))")).toEqual(["Add files", "New poll"]);
  }, 60_000);
});
