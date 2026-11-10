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

  test("as tall as what it shows, up to a cap past which the list scrolls; it only grows while open", async () => {
    const page = await open("desktop");
    await page.openPicker();
    const measure = () =>
      page.eval<{ height: number; listScroll: number; listClient: number; names: number }>(`(() => {
        const mp = document.querySelector('.mp'), list = document.querySelector('.mp-list');
        return { height: Math.round(mp.getBoundingClientRect().height), listScroll: list.scrollHeight, listClient: list.clientHeight, names: document.querySelectorAll('.mp-name').length };
      })()`);
    // Two favorites: no tall empty panel, and nothing to scroll.
    const favorites = await measure();
    expect(favorites.names).toBe(2);
    expect(favorites.height).toBeLessThan(320);
    expect(favorites.listScroll).toBeLessThanOrEqual(favorites.listClient + 1);
    // The provider's two dozen models: as tall as it gets, and the list scrolls.
    await page.click(".mp-rail-scroll .mp-rail-btn");
    await page.until("document.querySelectorAll('.mp-name').length > 20");
    await page.settle();
    const all = await measure();
    expect(all.height).toBe(380);
    expect(all.listScroll).toBeGreaterThan(all.listClient + 100);
    // Back to the favorites, or narrowing a search, keeps the height: nothing moves under the pointer.
    await page.click('.mp-rail-btn[aria-label="Favorites"], .mp-rail > .mp-rail-btn');
    await page.until("document.querySelectorAll('.mp-name').length === 2");
    await page.settle();
    expect((await measure()).height).toBe(all.height);
    await page.eval("document.querySelector('.mp-search input').focus()");
    await page.send("Input.insertText", { text: "haiku" });
    await page.settle();
    expect((await measure()).height).toBe(all.height);
    // Opened again, it fits what it shows again.
    await page.key("Escape", "Escape", 27);
    await page.until(`document.querySelector('.mp') === null || document.querySelector('.mp').getAttribute('data-state') !== 'open'`);
    await page.openPicker();
    expect((await measure()).height).toBe(favorites.height);
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
    await page.key("Enter", "Enter", 13);
    await page.until(`document.querySelector('.mp') === null || document.querySelector('.mp').getAttribute('data-state') !== 'open'`);
    expect((await pill(page)).label).toStartWith("Model: Claude Haiku 5.5");
    // ↓ from the search moves into the list; Enter picks the focused row.
    await page.openPicker();
    await page.key("ArrowDown", "ArrowDown", 40);
    expect(await page.eval<any>("document.activeElement?.className")).toBe("mp-pick");
    await page.key("ArrowDown", "ArrowDown", 40);
    await page.key("Enter", "Enter", 13);
    await page.until(`document.querySelector('.mp') === null || document.querySelector('.mp').getAttribute('data-state') !== 'open'`);
    expect((await pill(page)).label).toStartWith("Model: Claude Sonnet 5.5");
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
    await page.openPicker();
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
    const light = await open("phone", "theme=light");
    await light.openPicker();
    await light.shoot("picker-phone-light");
  }, 30_000);
});
