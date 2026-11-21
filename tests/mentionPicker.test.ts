// The "@" pickers in a real Chrome. A bot chat's (fixtures/botScroll, a group with manager and helper)
// opens after punctuation as well as a space ("(@", as a sent message tags it), and both it and a
// thread's file list (fixtures/threadSend) open at the "@" they were typed at: above its line, under
// it when there's no room above, kept inside the window. A new thread's composer opens its list
// downwards, so there it is under the line. A phone keeps the list across the box.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let bots: Awaited<ReturnType<typeof serveFixture>> | undefined;
let threads: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  bots = await serveFixture(`${import.meta.dir}/fixtures/botScroll/index.html`);
  threads = await serveFixture(`${import.meta.dir}/fixtures/threadSend/index.html`, { "/thread-*": (req) => fetch(new URL("/", req.url)), "/new": (req) => fetch(new URL("/", req.url)) });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await bots?.stop();
  await threads?.stop();
});

const FIELD = "document.querySelector('.bots-composer-textarea')";
const MENU = "document.querySelector('.bots-mentions')";
const KEYS = { ArrowLeft: 37, Enter: 13 } as const;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

class PickerPage extends Page {
  async type(text: string) {
    await this.send("Input.insertText", { text });
    await this.settle();
  }
  async press(key: keyof typeof KEYS, times = 1) {
    for (let i = 0; i < times; i++) {
      for (const type of ["rawKeyDown", "keyUp"]) await this.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: KEYS[key] });
    }
    await this.settle();
  }
  /** A newline in the draft, as Shift+Enter types it. */
  async newline() {
    await this.eval(`document.execCommand("insertText", false, "\\n")`);
    await this.settle();
  }
  labels() {
    return this.eval<string[]>(`[...document.querySelectorAll('.bots-mentions .menu-item-label')].map((e) => e.textContent)`);
  }
  /** Where `el` is once its opening rise has run (it starts 4px low). */
  box(el: string) {
    return this.eval<Box>(`(() => { document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).forEach((a) => a.finish()); const r = ${el}.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`);
  }
  /**
   * Where the draft's last "@" is drawn, read off the draft's own drawing (the backdrop under the
   * field, laid out character for character as the field is), not off the field.
   */
  at() {
    return this.eval<Box>(`(() => {
      const draft = document.querySelector('.bots-draft');
      const walker = document.createTreeWalker(draft, NodeFilter.SHOW_TEXT);
      let hit;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.includes('@')) hit = [n, n.data.lastIndexOf('@')];
      const range = document.createRange();
      range.setStart(hit[0], hit[1]);
      range.setEnd(hit[0], hit[1] + 1);
      const r = range.getClientRects()[0];
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    })()`);
  }
}

const openBots = async (width = 1000, height = 700) => {
  const page = await PickerPage.open(chrome!.ws, bots!.url.href, width, height, `!!${FIELD} && !!document.querySelector('.bm-group')`);
  await page.eval(`bots.getState().select("b")`);
  await page.until(`document.querySelector('.bm-row[data-id^="b-"]') !== null`);
  await page.eval(`${FIELD}.focus()`);
  await page.settle();
  return page;
};

describe.skipIf(!browser)("the @ pickers", () => {
  test('"(@" opens the bot picker, and picking a bot inside the brackets leaves "(@helper)"', async () => {
    const page = await openBots();
    await page.type(`you're welcome" (@`);
    expect(await page.labels()).toEqual(["manager", "helper", "All bots"]);
    // Every other opening mark does too; an "@" inside a word (an email address) doesn't.
    for (const [typed, open] of [[` "@`, true], [` [@`, true], [` “@`, true], [` me@`, false]] as const) {
      await page.eval(`(() => { const el = ${FIELD}; el.select(); document.execCommand("delete"); })()`);
      await page.type(`hi${typed}`);
      expect([typed, await page.eval<boolean>(`!!${MENU}`)]).toEqual([typed, open]);
    }
    await page.eval(`(() => { const el = ${FIELD}; el.select(); document.execCommand("delete"); })()`);
    await page.type("ask (@)");
    await page.press("ArrowLeft");
    await page.type("hel");
    expect(await page.labels()).toEqual(["helper"]);
    await page.press("Enter");
    const f = await page.eval<{ value: string; caret: number }>(`({ value: ${FIELD}.value, caret: ${FIELD}.selectionStart })`);
    expect(f).toEqual({ value: "ask (@helper)", caret: "ask (@helper".length });
    // The draft shows it as a mention, as the sent message will be.
    expect(await page.eval<string | null>(`document.querySelector('.bots-draft .bots-draft-mention')?.textContent ?? null`)).toBe("@helper");
  }, 60_000);

  test("the picker opens at the @, above its line, also a few lines down a draft", async () => {
    const page = await openBots();
    await page.type("another thing is, to make bots more proactive.");
    await page.newline();
    await page.type("they should behave like actual coworkers.");
    await page.newline();
    await page.type(`you were asleep. you're welcome" (@`);
    await page.until(`!!${MENU}`);
    const at = await page.at();
    const menu = await page.box(MENU);
    const form = await page.box("document.querySelector('.bots-composer')");
    expect(Math.abs(menu.left - at.left)).toBeLessThan(1.5);
    // Just over the "@"'s own line, which is inside the box: not over the box's top edge.
    expect(at.top).toBeGreaterThan(form.top + 40);
    expect(Math.abs(at.top - 6 - menu.bottom)).toBeLessThan(3);
    // Typing the name keeps the list where it opened.
    await page.type("hel");
    expect(Math.abs((await page.box(MENU)).left - at.left)).toBeLessThan(1.5);
  }, 60_000);

  test("with no room above the line it opens under it, and it never runs off the window's edge", async () => {
    const page = await openBots();
    // The box at the top of the window, its right part off the window's edge.
    await page.eval(`(() => { const f = document.querySelector('.bots-composer'); f.style.cssText = 'position: fixed; top: 4px; left: ' + (innerWidth - 120) + 'px; width: 600px; max-width: none; margin: 0'; })()`);
    await page.type("@");
    await page.until(`!!${MENU}`);
    const at = await page.at();
    const menu = await page.box(MENU);
    const width = await page.eval<number>("innerWidth");
    expect(menu.top).toBeGreaterThanOrEqual(at.bottom + 3);
    expect(menu.right).toBeLessThanOrEqual(width - 8 + 0.5);
    expect(menu.left).toBeGreaterThanOrEqual(8);
  }, 60_000);

  test("on a phone the picker stays across the box", async () => {
    const page = await openBots(390, 800);
    await page.type("a long line that wraps once at least on a phone (@");
    await page.until(`!!${MENU}`);
    const menu = await page.box(MENU);
    const form = await page.box("document.querySelector('.bots-composer')");
    expect(await page.eval<string>(`${MENU}.style.left`)).toBe("");
    expect(Math.abs(menu.left - form.left)).toBeLessThan(2);
    expect(Math.abs(menu.right - form.right)).toBeLessThan(2);
    expect(menu.bottom).toBeLessThanOrEqual(form.top);
  }, 60_000);

  test("a thread's file list opens at its @, after a quote too", async () => {
    const page = await PickerPage.open(chrome!.ws, `${threads!.url.href}thread-t0`, 1200, 700, "!!document.querySelector('.messages [data-message-id]') && !!document.querySelector('.composer-input')");
    // The thread's files, from its workspace.
    await page.eval(`(() => {
      const real = window.fetch;
      window.fetch = (input, init) => new URL(String(input instanceof Request ? input.url : input), location.href).pathname === "/api/workspaces/files"
        ? Promise.resolve(Response.json({ entries: [{ path: "notes.md", dir: false }, { path: "src", dir: true }, { path: "src/app.ts", dir: false }] }))
        : real(input, init);
    })()`);
    await page.eval("document.querySelector('.composer-input').focus()");
    const lead = "x".repeat(12) + ' see "';
    await page.type(`${lead}@`);
    await page.until("!!document.querySelector('.mention-menu')");
    const where = await page.eval<{ expected: number; line: number; menu: Box }>(`(() => {
      const el = document.querySelector('.composer-input');
      const s = getComputedStyle(el);
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = [s.fontStyle, s.fontWeight, s.fontSize, s.fontFamily].join(' ');
      ctx.letterSpacing = s.letterSpacing;
      const r = el.getBoundingClientRect();
      document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).forEach((a) => a.finish());
      const m = document.querySelector('.mention-menu').getBoundingClientRect();
      return {
        expected: r.left + el.clientLeft + parseFloat(s.paddingLeft) + ctx.measureText(${JSON.stringify(lead)}).width,
        line: r.top + el.clientTop + parseFloat(s.paddingTop),
        menu: { left: m.left, right: m.right, top: m.top, bottom: m.bottom },
      };
    })()`);
    expect(Math.abs(where.menu.left - where.expected)).toBeLessThan(3);
    expect(where.menu.bottom).toBeLessThanOrEqual(where.line);
    expect(where.line - where.menu.bottom).toBeLessThan(14);
    expect(await page.eval<string[]>("[...document.querySelectorAll('.mention-menu .mention-name')].map((e) => e.textContent)")).toContain("notes.md");
  }, 60_000);

  test("a new thread's file list opens under its @, where its lists open downwards", async () => {
    const page = await PickerPage.open(chrome!.ws, `${threads!.url.href}new`, 1200, 800, "!!document.querySelector('.composer-home .composer-input')");
    await page.eval(`(() => {
      const real = window.fetch;
      window.fetch = (input, init) => new URL(String(input instanceof Request ? input.url : input), location.href).pathname === "/api/workspaces/files"
        ? Promise.resolve(Response.json({ entries: [{ path: "notes.md", dir: false }, { path: "src", dir: true }] }))
        : real(input, init);
    })()`);
    await page.eval("document.querySelector('.composer-input').focus()");
    const lead = "look at (";
    await page.type(`${lead}@`);
    await page.until("!!document.querySelector('.mention-menu')");
    const where = await page.eval<{ expected: number; line: number; menu: Box }>(`(() => {
      const el = document.querySelector('.composer-input');
      const s = getComputedStyle(el);
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = [s.fontStyle, s.fontWeight, s.fontSize, s.fontFamily].join(' ');
      ctx.letterSpacing = s.letterSpacing;
      const r = el.getBoundingClientRect();
      document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).forEach((a) => a.finish());
      const m = document.querySelector('.mention-menu').getBoundingClientRect();
      return {
        expected: r.left + el.clientLeft + parseFloat(s.paddingLeft) + ctx.measureText(${JSON.stringify(lead)}).width,
        line: r.top + el.clientTop + parseFloat(s.paddingTop) + parseFloat(s.lineHeight),
        menu: { left: m.left, right: m.right, top: m.top, bottom: m.bottom },
      };
    })()`);
    expect(Math.abs(where.menu.left - where.expected)).toBeLessThan(3);
    // Under the "@"'s line, close to it.
    expect(where.menu.top).toBeGreaterThanOrEqual(where.line);
    expect(where.menu.top - where.line).toBeLessThan(14);
  }, 60_000);
});
