// The composer's model picker in a real Chrome, desktop and phone: one pill in the composer (model,
// reasoning level, and a bolt while Fast is on), reasoning and speed chosen inside the picker, the
// permission mode in the workspace row under the composer, and compact rows that fit the screen.
// Set OPENBUILD_SCREENSHOTS to a folder to keep a picture of each state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;
const shots = process.env.OPENBUILD_SCREENSHOTS;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/modelPicker/index.html`);
  chrome = await launchChrome();
  if (shots) await mkdir(shots, { recursive: true });
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const SIZES = { desktop: [1000, 700], phone: [360, 760] } as const;

class PickerPage extends Page {
  /** Headless Chrome has no pointer at all: a mouse, as on a desktop, so the picker focuses its search. */
  mouse() {
    return this.eval(`(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => real(q === "(pointer: fine)" ? "all" : q);
    })()`);
  }
  async openPicker() {
    await this.click(".pill-model");
    await this.until(`document.querySelector('.mp')?.getAttribute('data-state') === 'open'`);
    await Bun.sleep(200);
    await this.settle();
  }
  /** A real mouse click at a point of the window. */
  async clickAt(x: number, y: number) {
    for (const type of ["mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    await this.settle();
  }
  /** A finger's tap in the middle of `selector`, or at a point. */
  async tap(at: string | [number, number]) {
    const [x, y] = typeof at === "string" ? await this.eval<[number, number]>(`(() => { const r = document.querySelector(${JSON.stringify(at)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`) : at;
    await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await Bun.sleep(50);
    await this.settle();
  }
  state() {
    return this.eval<string | null>("document.querySelector('.mp')?.getAttribute('data-state') ?? null");
  }
  async closed() {
    await this.until(`document.querySelector('.mp') === null || document.querySelector('.mp').getAttribute('data-state') !== 'open'`);
  }
  async key(key: string, code = key, keyCode = 0) {
    // Enter as typed (with its text), so it also presses a focused button.
    const text = key === "Enter" ? "\r" : undefined;
    for (const type of [text ? "keyDown" : "rawKeyDown", "keyUp"]) await this.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, ...(type !== "keyUp" && text && { text }) });
    await this.settle();
  }
  async shoot(name: string) {
    if (!shots) return;
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(shots, `${name}.png`), Buffer.from(data, "base64"));
  }
}

async function open(size: keyof typeof SIZES, query = "") {
  const [width, height] = SIZES[size];
  const page = await PickerPage.open(chrome!.ws, `${server!.url.href}?${query}`, width, height, "!!document.querySelector('.composer-bar .pill-model')");
  await page.mouse();
  await page.settle();
  return page;
}

/** Where the picker's parts sit, and whether anything spills out of it or off the screen. */
const layout = (page: Page) =>
  page.eval<any>(`(() => {
    const box = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const mp = document.querySelector('.mp');
    const spills = [...mp.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1 && !['auto', 'scroll', 'hidden'].includes(getComputedStyle(el).overflowX) && getComputedStyle(el).textOverflow !== 'ellipsis').map((el) => el.className);
    return {
      mp: box('.mp'), list: box('.mp-list'), effort: box('.mp-effort'), foot: box('.mp-foot'), speed: box('.mp-speed'),
      rows: [...document.querySelectorAll('.mp-pick')].map((el) => el.getBoundingClientRect().height),
      levels: [...document.querySelectorAll('.mp-effort-level')].map((el) => el.querySelector('.mp-effort-long').textContent),
      spills,
      viewport: [innerWidth, innerHeight],
    };
  })()`);

const pill = (page: Page) =>
  page.eval<any>(`(() => {
    const el = document.querySelector('.composer-bar .pill-model');
    return { label: el.getAttribute('aria-label'), effort: el.querySelector('.pill-effort')?.textContent ?? null, bolt: !!el.querySelector('svg.lucide-zap.pill-fast'), text: el.textContent };
  })()`);

describe.skipIf(!browser)("model picker", () => {
  test("the composer has one model pill; permissions sit in the workspace row under it", async () => {
    const page = await open("desktop");
    const bar = await page.eval<any>(`(() => ({
      pills: [...document.querySelectorAll('.composer .pill')].map((el) => el.className),
      permissionInComposer: !!document.querySelector('.composer .permission-pill'),
      permissionInRow: document.querySelector('.ws-bottom .permission-pill')?.getAttribute('aria-label') ?? null,
    }))()`);
    expect(bar.pills).toHaveLength(1);
    expect(bar.pills[0]).toContain("pill-model");
    expect(bar.permissionInComposer).toBe(false);
    expect(bar.permissionInRow).toBe("Permissions: Ask");
    expect(await pill(page)).toMatchObject({ label: "Model: Claude Opus 5.5, Medium reasoning", effort: "Medium", bolt: false });
    await page.shoot("composer-dark");
  }, 30_000);

  test("on a desktop, reasoning is a column beside the list and speed a toggle in the footer; both keep the picker open", async () => {
    const page = await open("desktop");
    await page.openPicker();
    await page.shoot("picker-dark");
    const l = await layout(page);
    expect(l.effort.left).toBeGreaterThanOrEqual(l.list.right - 1);
    expect(l.effort.top).toBeLessThan(l.list.bottom);
    expect(l.levels).toEqual(["Low", "Medium", "High", "Extra high", "Max"]);
    expect(l.foot.top).toBeGreaterThanOrEqual(l.list.bottom - 1);
    expect(l.speed).not.toBeNull();
    expect(Math.max(...l.rows)).toBeLessThanOrEqual(30);
    expect(l.mp.bottom).toBeLessThanOrEqual(l.viewport[1]);
    expect(l.spills).toEqual([]);

    await page.click('.mp-effort-level:nth-child(4)');
    expect(await page.eval<any>("document.querySelector('.mp').getAttribute('data-state')")).toBe("open");
    await page.click('.mp-speed-opt[aria-checked="false"]');
    expect(await page.eval<any>("document.querySelector('.mp').getAttribute('data-state')")).toBe("open");
    expect(await page.eval<any>(`document.querySelector('.mp-speed-opt[aria-checked="true"]').textContent`)).toBe("Fast");
    expect(await pill(page)).toMatchObject({ label: "Model: Claude Opus 5.5, XHigh reasoning, Fast", effort: "XHigh", bolt: true });
    expect((await pill(page)).text).not.toContain("⚡");
    await page.shoot("picker-dark-fast");
  }, 30_000);

  test("in a narrow pane at the right of the window, it stays inside the pane instead of being cut off", async () => {
    // Narrower than the picker, and well away from the window's left edge.
    const page = await open("desktop", "pane=420");
    await page.openPicker();
    const at = await page.eval<any>(`(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width }; };
      return { mp: r(document.querySelector('.mp')), pane: r(document.querySelector('.side-pane')), list: r(document.querySelector('.mp-list')) };
    })()`);
    await page.shoot("desktop-pane");
    expect(at.mp.left).toBeGreaterThanOrEqual(at.pane.left);
    expect(at.mp.right).toBeLessThanOrEqual(at.pane.right);
    // The model list is in view, not just the reasoning column.
    expect(at.list.left).toBeGreaterThanOrEqual(at.pane.left);
    expect(at.list.width).toBeGreaterThan(150);
  }, 60_000);

  test("one compact height whatever it shows: a short list leaves room, a long one scrolls", async () => {
    const page = await open("desktop");
    await page.openPicker();
    const measure = () =>
      page.eval<{ height: number; listScroll: number; listClient: number; names: number }>(`(() => {
        const mp = document.querySelector('.mp'), list = document.querySelector('.mp-list');
        return { height: Math.round(mp.getBoundingClientRect().height), listScroll: list.scrollHeight, listClient: list.clientHeight, names: document.querySelectorAll('.mp-name').length };
      })()`);
    // Two favorites.
    const favorites = await measure();
    expect(favorites.names).toBe(2);
    expect(favorites.height).toBe(320);
    // The provider's two dozen models: the same height, and the list scrolls.
    await page.click(".mp-rail-scroll .mp-rail-btn");
    await page.until("document.querySelectorAll('.mp-name').length > 20");
    await page.settle();
    const all = await measure();
    expect(all.height).toBe(320);
    expect(all.listScroll).toBeGreaterThan(all.listClient + 100);
    // A search down to one model doesn't shrink it either.
    await page.eval("document.querySelector('.mp-search input').focus()");
    await page.send("Input.insertText", { text: "haiku" });
    await page.settle();
    expect((await measure()).height).toBe(320);
  }, 30_000);

  test("Remote control's row is as wide as its label and toggle, so its tooltip opens under them", async () => {
    const page = await open("desktop", "home=1");
    await page.until("!!document.querySelector('.remote-control-row')");
    const [row, toggle, composer] = await page.eval<[number, number, number]>(`[document.querySelector('.remote-control-row').getBoundingClientRect().width, document.querySelector('.remote-control-row .toggle').getBoundingClientRect().right - document.querySelector('.remote-control-row').getBoundingClientRect().left, document.querySelector('.composer').getBoundingClientRect().width]`);
    expect(row).toBeLessThan(composer / 2);
    expect(row).toBeGreaterThanOrEqual(toggle);
  }, 30_000);

  test("search, favorites and the keyboard still work", async () => {
    const page = await open("desktop");
    await page.openPicker();
    // Opens on the favorites, with the search focused.
    expect(await page.eval<any>("[...document.querySelectorAll('.mp-name')].map((el) => el.textContent)")).toEqual(["Claude Opus 5.5", "Claude Sonnet 5.5"]);
    expect(await page.eval<any>("document.activeElement?.getAttribute('aria-label')")).toBe("Search models");
    await page.send("Input.insertText", { text: "haiku" });
    await page.settle();
    expect(await page.eval<any>("[...document.querySelectorAll('.mp-name')].map((el) => el.textContent)")).toEqual(["Claude Haiku 5.5"]);
    // Enter picks the first match and leaves the picker open, the search still focused.
    await page.key("Enter", "Enter", 13);
    expect((await pill(page)).label).toStartWith("Model: Claude Haiku 5.5");
    expect(await page.state()).toBe("open");
    expect(await page.eval<any>("document.activeElement?.getAttribute('aria-label')")).toBe("Search models");
    // ↓ from the search moves into the list; Enter picks the focused row, and it keeps the focus.
    await page.eval("document.querySelector('.mp-search input').select()");
    await page.key("Backspace", "Backspace", 8);
    await page.key("ArrowDown", "ArrowDown", 40);
    expect(await page.eval<any>("document.activeElement?.className")).toBe("mp-pick");
    await page.key("ArrowDown", "ArrowDown", 40);
    await page.key("Enter", "Enter", 13);
    expect((await pill(page)).label).toStartWith("Model: Claude Sonnet 5.5");
    expect(await page.state()).toBe("open");
    expect(await page.eval<any>("document.activeElement?.querySelector('.mp-name')?.textContent")).toBe("Claude Sonnet 5.5");
    // ↑ and Enter again: another pick, still open.
    await page.key("ArrowUp", "ArrowUp", 38);
    await page.key("Enter", "Enter", 13);
    expect((await pill(page)).label).toStartWith("Model: Claude Opus 5.5");
    expect(await page.state()).toBe("open");
    // Esc closes it and hands the focus back to the pill.
    await page.key("Escape", "Escape", 27);
    await page.closed();
    expect(await page.eval<any>("document.activeElement?.classList.contains('pill-model')")).toBe(true);
  }, 30_000);

  test("picking a model keeps the picker open, so model, reasoning and speed are set in one go; a click outside, the pill or Esc closes it", async () => {
    const page = await open("desktop");
    await page.openPicker();
    // One model, then another: the picker stays, the row and the pill follow.
    await page.click('.mp-row:nth-child(2) .mp-pick');
    expect(await page.state()).toBe("open");
    expect((await pill(page)).label).toBe("Model: Claude Sonnet 5.5, Medium reasoning");
    expect(await page.eval<any>(`document.querySelector('.mp-row[aria-selected="true"] .mp-name')?.textContent`)).toBe("Claude Sonnet 5.5");
    await page.click('.mp-row:nth-child(1) .mp-pick');
    expect(await page.state()).toBe("open");
    // Then its reasoning and speed.
    await page.click('.mp-effort-level:nth-child(3)');
    expect(await page.state()).toBe("open");
    await page.click('.mp-speed-opt[aria-checked="false"]');
    expect(await page.state()).toBe("open");
    expect(await pill(page)).toMatchObject({ label: "Model: Claude Opus 5.5, High reasoning, Fast", effort: "High", bolt: true });
    await page.shoot("picker-several-picks");

    // A click outside closes it.
    await page.clickAt(20, 20);
    await page.closed();
    // So does the pill again.
    await page.openPicker();
    await page.click(".pill-model");
    await page.closed();
    // And Esc.
    await page.openPicker();
    await page.key("Escape", "Escape", 27);
    await page.closed();
    expect((await pill(page)).label).toBe("Model: Claude Opus 5.5, High reasoning, Fast");
  }, 30_000);

  test("a new thread's harness can be switched without closing the picker either", async () => {
    const page = await open("desktop", "home=1");
    await page.openPicker();
    const harness = await page.eval<number>("document.querySelectorAll('.mp-foot .mp-runtime').length");
    expect(harness).toBeGreaterThan(1);
    const checked = () => page.eval<string>(`document.querySelector('.mp-foot .mp-runtime[aria-checked="true"]').getAttribute('aria-label')`);
    const before = await checked();
    await page.click('.mp-foot .mp-runtime[aria-checked="false"]:not(.mp-runtime-missing)');
    expect(await page.state()).toBe("open");
    expect(await checked()).not.toBe(before);
  }, 30_000);

  test("reasoning and speed are radio groups: ←/→ move between options, and each group is one Tab stop", async () => {
    const page = await open("desktop");
    await page.openPicker();
    // A level's name is its long label; the short one is for narrow pickers.
    const name = "(el) => (el.querySelector('.mp-effort-long') ?? el).textContent";
    const focused = () => page.eval<any>(`(${name})(document.activeElement)`);
    const stops = (group: string) => page.eval<any>(`[...document.querySelectorAll('${group} [role=radio]')].filter((el) => el.tabIndex === 0).map(${name})`);
    // Only the selected option takes Tab.
    expect(await stops(".mp-effort-levels")).toEqual(["Medium"]);
    expect(await stops(".mp-speed")).toEqual(["Standard"]);

    await page.eval(`document.querySelector('.mp-effort-level[aria-checked="true"]').focus()`);
    await page.key("ArrowRight", "ArrowRight", 39);
    expect(await focused()).toBe("High");
    await page.key("ArrowLeft", "ArrowLeft", 37);
    await page.key("ArrowLeft", "ArrowLeft", 37);
    expect(await focused()).toBe("Low");
    await page.key("ArrowDown", "ArrowDown", 40);
    expect(await focused()).toBe("Medium");
    // Tab leaves the group rather than stepping through its levels.
    await page.key("Tab", "Tab", 9);
    expect(await page.eval<any>("!!document.activeElement?.closest('.mp-effort-levels')")).toBe(false);

    await page.eval(`document.querySelector('.mp-speed-opt[aria-checked="true"]').focus()`);
    await page.key("ArrowRight", "ArrowRight", 39);
    expect(await focused()).toBe("Fast");
    await page.key("ArrowLeft", "ArrowLeft", 37);
    expect(await focused()).toBe("Standard");

    // Picking a level moves the Tab stop with it.
    await page.click('.mp-effort-level:nth-child(3)');
    expect(await stops(".mp-effort-levels")).toEqual(["High"]);
  }, 30_000);

  test("a model without reasoning levels says so instead of listing them", async () => {
    const page = await open("desktop");
    await page.openPicker();
    await page.send("Input.insertText", { text: "legacy" });
    await page.key("Enter", "Enter", 13);
    // Still open, and the Reasoning section follows the pick at once.
    expect(await page.state()).toBe("open");
    expect(await page.eval<any>("document.querySelectorAll('.mp-effort-level').length")).toBe(0);
    expect(await page.eval<any>("document.querySelector('.mp-effort-note')?.textContent")).toContain("uses its default reasoning");
    expect((await pill(page)).effort).toBeNull();
  }, 30_000);

  test("in light theme too", async () => {
    const page = await open("desktop", "theme=light");
    await page.openPicker();
    expect((await layout(page)).spills).toEqual([]);
    await page.shoot("picker-light");
    const home = await open("desktop", "theme=light&home=1");
    expect(await home.eval<any>("document.querySelector('.ws-top .permission-pill')?.getAttribute('aria-label')")).toBe("Permissions: Ask");
    await home.shoot("home-light");
  }, 30_000);

  test("on a phone, the levels make a row under the list and everything fits the sheet", async () => {
    const page = await open("phone");
    await page.shoot("composer-phone");
    await page.openPicker();
    await page.shoot("picker-phone");
    const l = await layout(page);
    expect(l.effort.top).toBeGreaterThanOrEqual(l.list.bottom - 1);
    expect(l.effort.width).toBeGreaterThan(l.list.width);
    expect(l.foot.top).toBeGreaterThanOrEqual(l.effort.bottom - 1);
    expect(l.mp.left).toBeGreaterThanOrEqual(0);
    expect(l.mp.right).toBeLessThanOrEqual(l.viewport[0]);
    expect(l.mp.bottom).toBeLessThanOrEqual(l.viewport[1]);
    expect(l.foot.bottom).toBeLessThanOrEqual(l.mp.bottom + 0.5);
    expect(l.spills).toEqual([]);
    // Every level is on screen, not scrolled out of the row.
    const levels = await page.eval<{ left: number; right: number }[]>("[...document.querySelectorAll('.mp-effort-level')].map((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; })");
    expect(levels).toHaveLength(5);
    for (const r of levels) {
      expect(r.left).toBeGreaterThanOrEqual(l.mp.left);
      expect(r.right).toBeLessThanOrEqual(l.mp.right);
    }
    // Tapping a model, then a level, keeps the sheet up; a tap outside it puts it away.
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.tap('.mp-row:nth-child(2) .mp-pick');
    expect(await page.state()).toBe("open");
    await page.tap('.mp-effort-level:nth-child(4)');
    expect(await page.state()).toBe("open");
    expect((await pill(page)).label).toBe("Model: Claude Sonnet 5.5, XHigh reasoning");
    await page.shoot("picker-phone-several-picks");
    // The sheet covers the pill, so a tap above it is the way out.
    await page.tap([180, 20]);
    await page.closed();
    expect((await pill(page)).label).toBe("Model: Claude Sonnet 5.5, XHigh reasoning");
    const light = await open("phone", "theme=light");
    await light.openPicker();
    await light.shoot("picker-phone-light");
  }, 30_000);
});
