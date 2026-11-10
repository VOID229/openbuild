// Opening and folding a run of background actions in an OpenBots chat, in a real Chrome with the whole
// app on a fake server (fixtures/groupThreads): the toggle stays exactly where it is on screen every
// frame, mid-chat and at the very bottom, and the lines ease open and fold away rather than jump.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/groupThreads/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page, "/bots": page, "/bots/*": page } });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

const READY = "window.store?.getState().chatsLoaded && window.bots?.getState().loaded";
const TOGGLE = ".bots-messages .bm-events-toggle";

/** The group chat, long, with a run of 24 background actions `after` messages from its end. */
async function open(after: number) {
  const page = await Page.open(chrome!.ws, `${server!.url.href}bots`, 1280, 800, READY);
  await page.eval(`(() => {
    const s = bots.getState();
    const chat = s.conversations.find((c) => c.kind === 'group');
    const bot = chat.botIds[0];
    const t0 = Date.now() - 3_600_000;
    const said = (i) => ({ id: 'm' + i, author: i % 2 ? bot : 'me', at: t0 + i * 1000, text: 'Message ' + i + ' about the build, long enough to take a line or two in the chat.' });
    const ran = (i) => ({ id: 'e' + i, author: bot, at: t0 + 60_000 + i * 1000, text: '', event: { kind: 'routine', text: 'Ran a routine', detail: 'Routine ' + (i % 3) } });
    const messages = [...Array.from({ length: 40 }, (_, i) => said(i)), ...Array.from({ length: 24 }, (_, i) => ran(i)), ...Array.from({ length: ${after} }, (_, i) => ({ ...said(100 + i), at: t0 + 120_000 + i * 1000 }))];
    bots.setState({ conversations: s.conversations.map((c) => (c.id === chat.id ? { ...c, messages, more: false } : c)), activeId: chat.id });
    store.setState({ botsOpen: true, botsSidebarOpen: true });
    return true;
  })()`);
  await page.until(`!!document.querySelector(${JSON.stringify(TOGGLE)})`);
  await page.settle();
  return page;
}

/** Clicks the toggle, then records its top on screen, the chat's scroll and the run's height, every frame. */
const clickAndWatch = (page: Page, ms = 700) =>
  page.eval<{ top: number; scroll: number; body: number }[]>(`new Promise((resolve) => {
    const toggle = document.querySelector(${JSON.stringify(TOGGLE)});
    const chat = document.querySelector('.bots-messages');
    const body = toggle.closest('.bm-events').querySelector('.bm-events-body');
    const frames = [];
    const start = performance.now();
    const read = () => frames.push({ top: toggle.getBoundingClientRect().top, scroll: chat.scrollTop, body: body.getBoundingClientRect().height });
    read();
    toggle.click();
    const tick = () => {
      read();
      if (performance.now() - start < ${ms}) requestAnimationFrame(tick);
      else resolve(frames);
    };
    requestAnimationFrame(tick);
  })`);

describe.skipIf(!browser)("a run of background actions holds the view", () => {
  test("mid-chat: opening and folding it never moves the toggle, and the height eases both ways", async () => {
    const page = await open(30);
    // Bring the toggle to the middle of the view.
    await page.eval(`(() => { const t = document.querySelector(${JSON.stringify(TOGGLE)}); const c = document.querySelector('.bots-messages'); c.scrollTop += t.getBoundingClientRect().top - c.getBoundingClientRect().top - c.clientHeight / 2; return true; })()`);
    await page.settle();
    for (const step of ["open", "fold"]) {
      const frames = await clickAndWatch(page);
      const first = frames[0]!.top;
      expect({ step, moved: Math.max(...frames.map((f) => Math.abs(f.top - first))) }).toEqual({ step, moved: expect.any(Number) });
      expect(Math.max(...frames.map((f) => Math.abs(f.top - first)))).toBeLessThan(1);
      // In between: part-way open, not all at once.
      const heights = frames.map((f) => f.body);
      const end = step === "open" ? Math.max(...heights) : 0;
      expect(end > 100 || step === "fold").toBe(true);
      expect(heights.some((h) => h > 20 && h < Math.max(...heights) - 20)).toBe(true);
      expect(Math.round(heights.at(-1)!)).toBe(Math.round(end));
    }
  }, 60_000);

  test("at the very bottom: folding a long run doesn't pull the view up, nor throw it to the top", async () => {
    const page = await open(2);
    await page.eval("(() => { const c = document.querySelector('.bots-messages'); c.scrollTop = c.scrollHeight; return true; })()");
    await page.settle();
    await clickAndWatch(page);
    await page.eval("(() => { const c = document.querySelector('.bots-messages'); c.scrollTop = c.scrollHeight; return true; })()");
    await page.settle();
    const frames = await clickAndWatch(page);
    const first = frames[0]!;
    expect(Math.max(...frames.map((f) => Math.abs(f.top - first.top)))).toBeLessThan(1);
    expect(Math.min(...frames.map((f) => f.scroll))).toBeGreaterThan(first.scroll - 2);
    expect(frames.at(-1)!.body).toBe(0);
  }, 60_000);
});
