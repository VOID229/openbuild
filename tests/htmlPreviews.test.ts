// Pages (html_render) closing to a chip and opening again, in a real Chrome, in an OpenBuild thread
// and an OpenBots chat: the X takes the frame away, the chip brings a fresh one back at the page's
// size, a page a few turns back starts closed, and the reader's choice outlives a redraw and a reload.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { botPagesOld, threadPagesOld } from "../src/lib/pagePreviews";
import type { BotMessage } from "../shared/bots";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

test("a thread's pages age by the user's turns", () => {
  const roles = ["user", "assistant", "user", "assistant", "shell", "user", "user", "user", "assistant", "user", "assistant"];
  // After the first reply: users at 2, 5, 6, 7, 9 (the shell command doesn't count).
  expect(threadPagesOld(roles.map((role) => ({ role })))).toEqual([true, true, false, false, false, false, false, false, false, false, false]);
  expect(threadPagesOld([])).toEqual([]);
});

test("a chat's pages age by the turns of everyone but their author", () => {
  let i = 0;
  const m = (author: string, extra: Partial<BotMessage> = {}): BotMessage => ({ id: `m${i++}`, author, at: i, text: "x", ...extra });
  const page = { title: "P", html: "<p>", height: 100 };
  // A direct chat: the user's messages are the turns; two in a row count once.
  const direct = [m("bot", { html: page }), m("me"), m("bot"), m("me"), m("me"), m("bot"), m("me"), m("bot"), m("me"), m("bot", { html: page })];
  expect([...botPagesOld(direct)]).toEqual([]);
  direct.push(m("me"));
  expect([...botPagesOld(direct)]).toEqual(["m0"]);
  // Bots talking: the other bot's answers are turns, the author's own and activity lines aren't.
  const side = [m("a", { html: page }), m("b"), m("a"), m("b"), m("b"), m("a"), m("b", { event: { kind: "routine", text: "Ran" } as BotMessage["event"] }), m("b"), m("a"), m("c"), m("a")];
  expect(botPagesOld(side).size).toBe(0);
  side.push(m("b"));
  expect(botPagesOld(side).has(side[0]!.id)).toBe(true);
});

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/htmlPreviews/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const surfaces = {
  thread: { scroller: ".messages", row: "[data-message-id]" },
  bots: { scroller: ".bots-messages", row: ".bm-row[data-id]" },
} as const;
type Surface = keyof typeof surfaces;

const open = async (surface: Surface, theme = "dark") => {
  const page = await Page.open(chrome!.ws, `${server!.url.href}?surface=${surface}&theme=${theme}`, 1100, 800, "document.querySelectorAll('.html-render-chip, .html-render').length === 2");
  await page.settle();
  return page;
};

/** Each page, by title: whether it's a chip or a card, and its frame. */
const pages = (page: Page) =>
  page.eval<{ title: string; chip: boolean; frames: number; expanded: string | null }[]>(`[...document.querySelectorAll('.html-render-chip, figure.html-render')].map((el) => ({
    title: el.querySelector('.html-render-chip-title, .html-render-title').textContent,
    chip: el.classList.contains('html-render-chip'),
    frames: el.querySelectorAll('iframe').length,
    expanded: el.querySelector('[aria-expanded]')?.getAttribute('aria-expanded') ?? null,
  }))`);
const card = (title: string) => `[...document.querySelectorAll('figure.html-render')].find((f) => f.querySelector('.html-render-title').textContent === ${JSON.stringify(title)})`;
const chip = (title: string) => `[...document.querySelectorAll('.html-render-chip')].find((f) => f.querySelector('.html-render-chip-title').textContent === ${JSON.stringify(title)})`;
const loads = (page: Page, name: string) => page.eval<number>(`window.loads.filter((n) => n === ${JSON.stringify(name)}).length`);

describe.skipIf(!browser)("page previews", () => {
  for (const surface of ["thread", "bots"] as const) {
    test(`a page a few turns back starts closed, the latest one runs (${surface})`, async () => {
      const page = await open(surface);
      await page.until("window.loads.includes('new')");
      expect(await pages(page)).toEqual([
        { title: "Old signups", chip: true, frames: 0, expanded: "false" },
        { title: "New signups", chip: false, frames: 1, expanded: "true" },
      ]);
      expect(await loads(page, "old")).toBe(0);
      // One 36px row on a hairline, the whole of it a button.
      const row = await page.eval<{ h: number; radius: string; border: string; hit: boolean }>(`(() => {
        const c = ${chip("Old signups")};
        c.scrollIntoView({ block: "center" });
        const r = c.getBoundingClientRect(), s = getComputedStyle(c);
        const at = document.elementFromPoint(r.left + 4, r.top + r.height / 2);
        return { h: r.height, radius: s.borderTopLeftRadius, border: s.borderTopWidth, hit: at === c.querySelector('.html-render-chip-open') };
      })()`);
      expect(row).toEqual({ h: 36, radius: "12px", border: "1px", hit: true });
    }, 30_000);

    test(`the X closes a page to a chip, and the chip opens a fresh one at its size (${surface})`, async () => {
      const page = await open(surface);
      await page.until("window.loads.includes('new')");
      await page.settle();
      await page.until(`Math.abs(${card("New signups")}.querySelector('iframe').offsetHeight - 180) < 4`);
      // Laid out, not as drawn: the card scales a touch as it eases in.
      const size = await page.eval<number>(`${card("New signups")}.querySelector('iframe').offsetHeight`);
      const actions = await page.eval<string[]>(`[...${card("New signups")}.querySelectorAll('.html-render-action')].map((b) => b.getAttribute('aria-label'))`);
      expect(actions).toEqual(["Download HTML", "Full screen", "Close preview"]);
      await page.eval(`${card("New signups")}.querySelector('[aria-label="Close preview"]').focus()`);
      await page.eval(`${card("New signups")}.querySelector('[aria-label="Close preview"]').click()`);
      await page.settle();
      expect((await pages(page))[1]).toEqual({ title: "New signups", chip: true, frames: 0, expanded: "false" });
      expect(await page.eval<number>("document.querySelectorAll('iframe.html-render-frame').length")).toBe(0);
      // The keyboard stays with the page, on the chip that stands for it.
      expect(await page.eval<boolean>(`document.activeElement === ${chip("New signups")}.querySelector('.html-render-chip-open')`)).toBe(true);
      expect(await page.eval<string[]>(`[...${chip("New signups")}.querySelectorAll('[aria-label]')].map((b) => b.getAttribute('aria-label'))`)).toEqual(["Download HTML"]);
      // Opened again: a new frame, loaded again, at the size the page measured, without a jump.
      await page.eval(`${chip("New signups")}.querySelector('.html-render-chip-open').click()`);
      await page.settle();
      expect((await pages(page))[1]).toEqual({ title: "New signups", chip: false, frames: 1, expanded: "true" });
      expect(await page.eval<number>(`${card("New signups")}.querySelector('iframe').offsetHeight`)).toBe(size);
      await page.until("window.loads.filter((n) => n === 'new').length === 2");
      expect(await page.eval<boolean>(`document.activeElement === ${card("New signups")}.querySelector('[aria-label="Close preview"]')`)).toBe(true);
      // It eases in, by opacity and scale only.
      const moving = await page.eval<string[]>(`${card("New signups")}.getAnimations().map((a) => a.animationName)`);
      expect(moving.every((n) => n === "html-render-in")).toBe(true);
    }, 30_000);

    test(`the reader's choice outlives a redraw and a reload (${surface})`, async () => {
      const page = await open(surface);
      await page.eval(`${chip("Old signups")}.querySelector('.html-render-chip-open').click()`);
      await page.eval(`${card("New signups")}.querySelector('[aria-label="Close preview"]').click()`);
      await page.settle();
      await page.until("window.loads.includes('old')");
      const flipped = [
        { title: "Old signups", chip: false, frames: 1, expanded: "true" },
        { title: "New signups", chip: true, frames: 0, expanded: "false" },
      ];
      expect(await pages(page)).toEqual(flipped);
      // Drawn again from scratch: the conversation goes and comes back.
      if (surface === "thread") {
        await page.eval("window.__chats = store.getState().chats; store.setState({ chats: [] })");
        await page.settle();
        await page.eval("store.setState({ chats: window.__chats })");
      } else {
        await page.eval("window.__convs = bots.getState().conversations; bots.setState({ activeId: undefined })");
        await page.settle();
        await page.eval("bots.setState({ activeId: 'dm', conversations: window.__convs })");
      }
      await page.until("document.querySelectorAll('.html-render-chip, .html-render').length === 2");
      await page.settle();
      expect(await pages(page)).toEqual(flipped);
      // And a reload (the tab's session keeps it).
      await page.send("Page.reload");
      await page.until("document.querySelectorAll('.html-render-chip, .html-render').length === 2");
      await page.settle();
      expect(await pages(page)).toEqual(flipped);
    }, 30_000);

    test(`a page opening or closing above the view doesn't move what the reader is looking at (${surface})`, async () => {
      const page = await open(surface);
      const { scroller, row } = surfaces[surface];
      // Up past the old page, with the wheel, as a reader would.
      for (let i = 0; i < 12; i++) {
        const above = await page.eval<boolean>(`${chip("Old signups")}.getBoundingClientRect().bottom < document.querySelector('${scroller}').getBoundingClientRect().top - 60`);
        const top = await page.eval<number>(`document.querySelector('${scroller}').scrollTop`);
        if (top < 400 && above) break;
        await page.wheel(-250, scroller);
      }
      // Put the old page just above the view.
      await page.eval(`(() => { const s = document.querySelector('${scroller}'); s.scrollTop += ${chip("Old signups")}.getBoundingClientRect().bottom - s.getBoundingClientRect().top + 80; })()`);
      await page.settle();
      const spot = () =>
        page.eval<{ id: string; top: number }>(`(() => {
          const s = document.querySelector('${scroller}'), view = s.getBoundingClientRect();
          const r = [...s.querySelectorAll('${row}')].find((el) => el.getBoundingClientRect().top > view.top + 100);
          return { id: r.dataset.messageId ?? r.dataset.id, top: Math.round(r.getBoundingClientRect().top - view.top) };
        })()`);
      const before = await spot();
      await page.eval(`${chip("Old signups")}.querySelector('.html-render-chip-open').click()`);
      await page.until("window.loads.includes('old')");
      await page.settle();
      const opened = await spot();
      expect(opened.id).toBe(before.id);
      expect(Math.abs(opened.top - before.top)).toBeLessThanOrEqual(1);
      await page.eval(`${card("Old signups")}.querySelector('[aria-label="Close preview"]').click()`);
      await page.settle();
      const closed = await spot();
      expect(closed.id).toBe(before.id);
      expect(Math.abs(closed.top - before.top)).toBeLessThanOrEqual(1);
    }, 30_000);
  }

  test("in a bot chat, the closed page's bubble shrinks to the chip", async () => {
    const page = await open("bots", "light");
    const bubble = await page.eval<{ width: number; padding: string; chip: number }>(`(() => {
      const c = ${chip("Old signups")}, b = c.closest('.bm-bubble');
      return { width: b.getBoundingClientRect().width, padding: getComputedStyle(b).paddingTop, chip: c.getBoundingClientRect().width };
    })()`);
    expect(bubble.padding).toBe("0px");
    expect(Math.abs(bubble.width - bubble.chip)).toBeLessThanOrEqual(1);
    expect(bubble.width).toBeLessThan(500);
  }, 30_000);
});
