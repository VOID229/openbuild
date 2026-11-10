// Reloading the page in a real Chrome (the whole app on a fake server, fixtures/reloadScroll): the
// thread and the sidebar come back scrolled where the reader left them, not to the bottom and the
// top, and a tab of its own still opens a thread at its latest message with the sidebar at the top.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/reloadScroll/index.html`, {
    // A thread's address is the page too, as the real server answers every client route.
    "/thread-*": (req) => fetch(new URL("/", req.url)),
  });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const READY = "!!document.querySelector('.messages [data-message-id]') && document.querySelectorAll('.history .history-row').length > 0";

/** Where the thread and the sidebar are scrolled to, and how far each could go. */
const places = (page: Page) =>
  page.eval<{ thread: number; threadMax: number; sidebar: number; sidebarMax: number }>(`(() => {
    const m = document.querySelector('.messages'), h = document.querySelector('.history');
    return { thread: Math.round(m.scrollTop), threadMax: m.scrollHeight - m.clientHeight, sidebar: Math.round(h.scrollTop), sidebarMax: h.scrollHeight - h.clientHeight };
  })()`);

const reload = async (page: Page) => {
  await page.send("Page.reload", {});
  // The old document can still answer for a moment.
  await page.until("performance.now() < 5000 && document.readyState !== 'loading'");
  await page.until(READY);
  await page.settle();
};

describe.skipIf(!browser)("reloading the page", () => {
  test("keeps the thread and the sidebar where they were scrolled to", async () => {
    const page = await Page.open(chrome!.ws, `${server!.url.href}thread-t0`, 1200, 700, READY);
    await page.settle();
    const opened = await places(page);
    // Opened at the latest message, the sidebar at the top, and both have room to scroll.
    expect(opened.threadMax - opened.thread).toBeLessThanOrEqual(2);
    expect(opened.sidebar).toBe(0);
    expect(opened.sidebarMax).toBeGreaterThan(600);

    await page.wheel(-4000, ".messages");
    await page.wheel(600, ".history");
    const left = await places(page);
    expect(left.threadMax - left.thread).toBeGreaterThan(1000);
    expect(left.sidebar).toBeGreaterThan(300);

    for (let i = 0; i < 2; i++) {
      await reload(page);
      const back = await places(page);
      expect(Math.abs(back.thread - left.thread)).toBeLessThanOrEqual(2);
      expect(Math.abs(back.sidebar - left.sidebar)).toBeLessThanOrEqual(2);
      // And it stays there once everything has settled.
      await Bun.sleep(500);
      const later = await places(page);
      expect(Math.abs(later.thread - left.thread)).toBeLessThanOrEqual(2);
      expect(later.sidebar).toBe(back.sidebar);
    }

    // Scrolled back to the top and the latest message, a reload stays there too.
    await page.eval("document.querySelector('.history').scrollTop = 0");
    for (let i = 0; i < 3; i++) await page.wheel(8000, ".messages");
    await reload(page);
    const reset = await places(page);
    expect(reset.sidebar).toBe(0);
    expect(reset.threadMax - reset.thread).toBeLessThanOrEqual(2);
  }, 60_000);

  test("a tab of its own opens at the latest message with the sidebar at the top", async () => {
    // Page.open gives each page a browser context of its own: nothing the last test kept carries over.
    const page = await Page.open(chrome!.ws, `${server!.url.href}thread-t0`, 1200, 700, READY);
    await page.settle();
    const fresh = await places(page);
    expect(fresh.threadMax - fresh.thread).toBeLessThanOrEqual(2);
    expect(fresh.sidebar).toBe(0);
  }, 30_000);
});
