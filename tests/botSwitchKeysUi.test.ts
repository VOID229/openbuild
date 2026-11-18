// ⌥1–9 in the OpenBots sidebar, in a real Chrome: it goes to the pinned tiles first, left to right and
// row by row, then down the list (or, set so in Settings, the list only); held a moment, Option shows
// each one's number on it, and a quick press never flashes them; typing in a field keeps what a
// layout types with Option. Closed to the rail, the same numbers go down its avatars.
// Set OPENBUILD_SCREENSHOTS to a folder to keep a picture of the numbers showing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;
const shots = process.env.OPENBUILD_SCREENSHOTS;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botSwitchKeys/index.html`);
  chrome = await launchChrome();
  if (shots) await mkdir(shots, { recursive: true });
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const LIST = ["row-worker", "row-ada", "row-bea", "row-cy", "row-dot", "row-eli", "row-fox"];
const PINNED = ["pin-pip", "pin-crew", "pin-scout"];

const open = async (query = "", width = 1000, height = 820) => {
  const rail = query.includes("rail");
  const page = await Page.open(chrome!.ws, `${server!.url.href}?${query}`, width, height, rail ? "document.querySelectorAll('.bots-rail-item').length === 10" : "document.querySelectorAll('[data-bot-slot]').length === 10");
  // Every press records whether it was taken from the page.
  await page.eval(`window.taken = []; window.addEventListener("keydown", (e) => /^Digit/.test(e.code) && taken.push(e.defaultPrevented))`);
  await page.settle();
  return page;
};

const ALT = 1;
const altDown = (page: Page) => page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, modifiers: ALT });
const altUp = (page: Page) => page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, modifiers: 0 });
/** Option and a digit, Option still held after. `key` is the character the layout makes of it, typed into a focused field unless it's taken. */
const digit = async (page: Page, n: number, key = String(n)) => {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: `Digit${n}`, windowsVirtualKeyCode: 48 + n, modifiers: ALT, text: key, unmodifiedText: String(n) });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: `Digit${n}`, windowsVirtualKeyCode: 48 + n, modifiers: ALT });
};
/** A whole ⌥N: Option down, the digit, Option up. */
const press = async (page: Page, n: number, key?: string) => {
  await altDown(page);
  await digit(page, n, key);
  await altUp(page);
};

const active = (page: Page) => page.eval<string>("bots.getState().activeId");
const badges = (page: Page) =>
  page.eval<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('.bots-switch-key')].map((k) => [k.closest('[data-bot-slot]').dataset.botSlot, k.textContent]))`);
/**
 * Where each number sits: "ok" when it's on its item, a small keycap (at most 16px tall), in its
 * avatar's bottom right (below its middle and right of it, not over its face at the top left), and
 * not over the row's or tile's text; otherwise what's wrong.
 */
const placements = (page: Page) =>
  page.eval<string[]>(`[...document.querySelectorAll('.bots-switch-key')].map((k) => {
    const host = k.closest('[data-bot-slot]');
    const r = k.getBoundingClientRect(), item = host.getBoundingClientRect();
    const face = host.querySelector('.bots-sidebar-avatar > *').getBoundingClientRect();
    const text = host.querySelector('.bots-row-text, .bots-tile-name')?.getBoundingClientRect();
    if (r.width < 8 || r.height > 16) return "size " + r.width + "x" + r.height;
    if (r.left < item.left || r.right > item.right || r.top < item.top || r.bottom > item.bottom) return "outside its item";
    if (r.left + r.width / 2 < face.left + face.width / 2 || r.top < face.top + face.height / 2) return "over the avatar's face";
    if (text && r.right > text.left && r.left < text.right && r.bottom > text.top && r.top < text.bottom) return "over the text";
    return "ok";
  })`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shoot(page: Page, name: string) {
  if (!shots) return;
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(shots, `bot-switch-keys-${name}.png`), Buffer.from(data, "base64"));
}

describe.skipIf(!browser)("⌥1–9 in the OpenBots sidebar", () => {
  test("goes to the pinned ones left to right, row by row, then down the list, as a click would", async () => {
    const page = await open();
    // Two tiles to a row: the third pinned one starts the second row, on the left.
    const boxes = await page.eval<{ id: string; x: number; y: number }[]>(`[...document.querySelectorAll('.bots-tile')].map((t) => ({ id: t.dataset.botSlot, x: Math.round(t.getBoundingClientRect().x), y: Math.round(t.getBoundingClientRect().y) }))`);
    expect(boxes.map((b) => b.id)).toEqual(PINNED);
    expect(boxes[1]!.y).toBe(boxes[0]!.y);
    expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x);
    expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y);
    expect(boxes[2]!.x).toBe(boxes[0]!.x);

    const expected = [...PINNED, ...LIST].slice(0, 9);
    for (const n of [1, 2, 3, 4, 5, 9, 6]) {
      // As a click on a row does, it leaves a page (the marketplace) for the chat.
      await page.eval(`store.setState({ marketplaceOpen: true })`);
      await press(page, n, ["¡", "™", "£", "¢", "∞", "§", "¶", "•", "ª"][n - 1]);
      expect(await active(page)).toBe(expected[n - 1]!);
      expect(await page.eval<boolean>("store.getState().marketplaceOpen")).toBe(false);
    }
    expect(await page.eval<boolean[]>("taken")).toEqual([true, true, true, true, true, true, true]);
  }, 30_000);

  test("set to leave the pinned ones out, it numbers the list only, and a number past its end is left alone", async () => {
    const page = await open();
    await page.eval(`store.getState().updateSettings({ botKeysIncludePinned: false })`);
    await press(page, 1);
    expect(await active(page)).toBe("row-worker");
    await press(page, 7);
    expect(await active(page)).toBe("row-fox");
    await press(page, 8);
    expect(await active(page)).toBe("row-fox");
    expect(await page.eval<boolean[]>("taken")).toEqual([true, true, false]);
  }, 30_000);

  test("held a moment, Option shows each one's number on it, and letting go hides them", async () => {
    for (const theme of ["light", "dark"] as const) {
      const page = await open(`theme=${theme}`);
      await altDown(page);
      await page.until("document.querySelectorAll('.bots-switch-key').length === 9");
      expect(await badges(page)).toEqual(Object.fromEntries([...PINNED, ...LIST].slice(0, 9).map((id, i) => [id, `Alt+${i + 1}`])));
      // Each sits at its own avatar's bottom right, clear of its face, and inside its item.
      expect(await placements(page)).toEqual(Array(9).fill("ok"));
      await wait(200);
      await shoot(page, `open-${theme}`);
      // Pressing one with them showing goes there, and they stay up while Option is.
      await digit(page, 2, "™");
      expect(await active(page)).toBe("pin-crew");
      expect(Object.keys(await badges(page))).toHaveLength(9);
      await altUp(page);
      await page.until("!document.querySelector('.bots-switch-key')");
    }
  }, 40_000);

  test("the numbers come up half a second after Option goes down", async () => {
    const page = await open();
    await page.eval(`window.downAt = 0; window.shownAt = 0;
      addEventListener("keydown", (e) => e.key === "Alt" && (downAt = performance.now()), true);
      new MutationObserver(() => !shownAt && document.querySelector('.bots-switch-key') && (shownAt = performance.now())).observe(document.body, { childList: true, subtree: true })`);
    await altDown(page);
    await page.until("document.querySelectorAll('.bots-switch-key').length === 9");
    expect(await page.eval<number>("shownAt - downAt")).toBeGreaterThanOrEqual(495);
    await altUp(page);
  }, 30_000);

  test("left out of the numbers, the pinned ones show none", async () => {
    const page = await open();
    await page.eval(`store.getState().updateSettings({ botKeysIncludePinned: false })`);
    await altDown(page);
    await page.until("document.querySelectorAll('.bots-switch-key').length === 7");
    expect(await badges(page)).toEqual(Object.fromEntries(LIST.map((id, i) => [id, `Alt+${i + 1}`])));
    await altUp(page);
  }, 30_000);

  test("a quick ⌥N goes straight there without the numbers flashing, and Option in another shortcut shows none", async () => {
    const page = await open();
    await page.eval(`window.flashed = 0; new MutationObserver(() => document.querySelector('.bots-switch-key') && flashed++).observe(document.body, { childList: true, subtree: true })`);
    // Pressed before they show, the digit goes there, and they don't come up for the rest of that hold.
    await altDown(page);
    await digit(page, 3, "£");
    expect(await active(page)).toBe("pin-scout");
    await wait(700);
    expect(await page.eval<number>("flashed")).toBe(0);
    await altUp(page);
    // Option with a letter is some other shortcut (⌥M is dictation), however long it's held after.
    await altDown(page);
    await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "µ", code: "KeyM", windowsVirtualKeyCode: 77, modifiers: ALT });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "µ", code: "KeyM", windowsVirtualKeyCode: 77, modifiers: ALT });
    await wait(700);
    expect(await page.eval<number>("flashed")).toBe(0);
    await altUp(page);
    // Option tapped on its own doesn't flash them either.
    await altDown(page);
    await wait(100);
    await altUp(page);
    await wait(600);
    expect(await page.eval<number>("flashed")).toBe(0);
  }, 30_000);

  test("typing in a field, it takes what types nothing or a symbol, and leaves what a layout types with Option", async () => {
    const page = await open();
    const typed = () => page.eval<string>("document.querySelector('#composer').value");
    await page.eval("document.querySelector('#composer').focus()");
    // A US Mac's ⌥1 makes "¡", and Windows' or Linux's Alt+2 types nothing: both go to the bot.
    await press(page, 1, "¡");
    expect(await active(page)).toBe("pin-pip");
    await page.eval("document.querySelector('#composer').focus()");
    await press(page, 2, "2");
    expect(await active(page)).toBe("pin-crew");
    expect(await typed()).toBe("");
    // A German Mac's ⌥5 types "[", a British one's ⌥3 types "#", and "£" is typed with Option too: those stay the field's.
    await page.eval("document.querySelector('#composer').focus()");
    await press(page, 5, "[");
    await press(page, 3, "#");
    await press(page, 3, "£");
    expect(await active(page)).toBe("pin-crew");
    expect(await typed()).toBe("[#£");
    // And in a plain input the same.
    await page.eval("document.querySelector('#field').focus()");
    await press(page, 9, "}");
    expect(await page.eval<string>("document.querySelector('#field').value")).toBe("}");
    expect(await active(page)).toBe("pin-crew");
  }, 30_000);

  test("a key something else already took stays theirs", async () => {
    const page = await open();
    // As the side panel's and a terminal's own ⌥1–9 do, or a shortcut set to the same keys in Settings.
    await page.eval(`addEventListener("keydown", (e) => e.code === "Digit4" && (e.preventDefault(), e.stopPropagation()), true)`);
    await press(page, 4);
    expect(await active(page)).toBe("row-worker");
    await press(page, 1);
    expect(await active(page)).toBe("pin-pip");
  }, 30_000);

  test("closed to the rail, the same numbers go down its avatars", async () => {
    const page = await open("rail", 1000, 900);
    await press(page, 1);
    expect(await active(page)).toBe("pin-pip");
    await press(page, 4);
    expect(await active(page)).toBe("row-worker");
    await altDown(page);
    await page.until("document.querySelectorAll('.bots-switch-key').length === 9");
    expect(await badges(page)).toEqual(Object.fromEntries([...PINNED, ...LIST].slice(0, 9).map((id, i) => [id, `Alt+${i + 1}`])));
    expect(await placements(page)).toEqual(Array(9).fill("ok"));
    await wait(200);
    await shoot(page, "rail");
    await altUp(page);
    await page.until("!document.querySelector('.bots-switch-key')");
  }, 30_000);

  test("on a Mac the numbers read ⌥N, and Settings says Option", async () => {
    const page = await open("settings", 1100, 900);
    const ua = await page.eval<string>("navigator.userAgent");
    await page.send("Emulation.setUserAgentOverride", { userAgent: ua.replace(/\(X11;[^)]*\)/, "(Macintosh; Intel Mac OS X 10_15_7)"), platform: "MacIntel" });
    await page.send("Page.reload");
    await page.until("navigator.platform === 'MacIntel' && document.querySelectorAll('[data-bot-slot]').length === 10");
    await page.settle();
    expect(await page.eval<boolean>(`!!document.querySelector('[aria-label="Include pinned in Option + 1–9"]')`)).toBe(true);
    await altDown(page);
    await page.until("document.querySelectorAll('.bots-switch-key').length === 9");
    expect(Object.values(await badges(page))).toEqual(["⌥1", "⌥2", "⌥3", "⌥4", "⌥5", "⌥6", "⌥7", "⌥8", "⌥9"]);
    expect(await placements(page)).toEqual(Array(9).fill("ok"));
    await page.eval(`document.querySelector('[aria-label="Include pinned in Option + 1–9"]').scrollIntoView({ block: "center" })`);
    await wait(200);
    await shoot(page, "mac");
    await altUp(page);
  }, 30_000);

  test("Settings → Shortcuts turns the pinned ones in and out of the numbers", async () => {
    const page = await open("settings", 1100, 900);
    const toggle = `document.querySelector('[aria-label="Include pinned in Alt + 1–9"]')`;
    expect(await page.eval<string>(`${toggle}.getAttribute('aria-checked')`)).toBe("true");
    await page.eval(`${toggle}.scrollIntoView({ block: "center" })`);
    await page.settle();
    await shoot(page, "settings");
    await page.click(`[aria-label="Include pinned in Alt + 1–9"]`);
    expect(await page.eval<boolean>("store.getState().settings.botKeysIncludePinned")).toBe(false);
    expect(await page.eval<string>(`${toggle}.getAttribute('aria-checked')`)).toBe("false");
    await press(page, 1);
    expect(await active(page)).toBe("row-worker");
    await press(page, 2);
    expect(await active(page)).toBe("row-ada");
  }, 30_000);
});
