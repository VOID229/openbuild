// The pages inside a Settings section (a bot's editor, a group's, a Pi file's) go back with an arrow
// that mirrors the close button: its size and look, at the top left opposite it, and pinned like it
// while the page scrolls. The sections themselves have none.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

const SKILL = "---\nname: release\n---\n" + "Tag the release, then write the notes.\n".repeat(80);

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/settingsBack/index.html")).default;
  server = Bun.serve({
    port: 0,
    development: false,
    routes: {
      "/": page,
      "/api/pi/status": () => Response.json({ installed: true, version: "1.0.0", updateAvailable: false }),
      "/api/pi/resources": () => Response.json({ resources: [{ kind: "skill", id: "release", name: "release", enabled: true, files: ["skills/release/SKILL.md"] }], packages: [] }),
      "/api/pi/resources/file": () => Response.json({ content: SKILL }),
      "/api/pi/problems": () => Response.json({ problems: [] }),
      // Whatever else the pages ask for isn't here, and they carry on without it.
      "/api/*": () => Response.json({ error: "not here" }, { status: 404 }),
    },
  });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

type Box = { x: number; y: number; width: number; height: number };
const box = (page: Page, selector: string) =>
  page.eval<Box | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);

const open = async (section: string, width = 1000, height = 700) => {
  const page = await Page.open(chrome!.ws, server!.url.href, width, height, "!!window.store");
  await page.eval(`store.getState().openSettings(${JSON.stringify(section)})`);
  await page.until("!!document.querySelector('.modal-root[data-state=\"open\"] .settings-content .md-h1')");
  // Until the dialog has finished sliding in, so what's measured is where it comes to rest.
  // (Spinners turn forever, so only the animations that end.)
  await page.until("document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity)");
  await page.settle();
  return page;
};

/** Clicks the first button in the settings content whose text or label is `name`. */
const press = (page: Page, name: string) =>
  page.eval(`(() => {
    const b = [...document.querySelectorAll('.settings-content button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent.trim()) === ${JSON.stringify(name)});
    b.click();
    return true;
  })()`);

/** The back arrow and the close button look and sit as mirror images of each other. */
async function mirrorsClose(page: Page, label: string) {
  const back = await page.eval<{ label: string; className: string; tag: string; svg: boolean } | null>(`(() => {
    const b = document.querySelector('.modal .modal-back');
    return b && { label: b.getAttribute('aria-label'), className: b.className, tag: b.tagName, svg: !!b.querySelector('svg.lucide-arrow-left') };
  })()`);
  expect(back).toEqual({ label, className: "icon-btn modal-back", tag: "BUTTON", svg: true });
  const style = (selector: string) =>
    page.eval(`(() => { const s = getComputedStyle(document.querySelector('${selector}')); return { width: s.width, height: s.height, radius: s.borderRadius, color: s.color, background: s.backgroundColor, position: s.position }; })()`);
  expect(await style(".modal .modal-back")).toEqual(await style(".modal .modal-close"));
  const b = (await box(page, ".modal-back"))!;
  const x = (await box(page, ".modal-close"))!;
  const content = (await box(page, ".settings-content"))!;
  expect(b.y).toBe(x.y);
  // As far in from the content's left edge as close is from its right.
  expect(Math.round(b.x - content.x)).toBe(Math.round(content.x + content.width - (x.x + x.width)));
  // The old text link is gone.
  expect(await page.eval<string>("document.querySelector('.settings-content').textContent")).not.toContain("All bots");
}

/** Scrolls the page inside the dialog to its end: the arrow and close stay exactly where they were. */
async function staysPinned(page: Page) {
  const before = { back: await box(page, ".modal-back"), close: await box(page, ".modal-close") };
  const scrolled = await page.eval<number>("(() => { const el = document.querySelector('.settings-content'); el.scrollTop = el.scrollHeight; return el.scrollTop; })()");
  await page.settle();
  expect(scrolled).toBeGreaterThan(20);
  expect(await box(page, ".modal-back")).toEqual(before.back);
  expect(await box(page, ".modal-close")).toEqual(before.close);
  // And it's still the topmost thing there, clickable over whatever scrolled under it.
  const b = before.back!;
  expect(await page.eval<boolean>(`document.elementFromPoint(${b.x + b.width / 2}, ${b.y + b.height / 2})?.closest('.modal-back') !== null`)).toBe(true);
}

describe.skipIf(!browser)("the back arrow on pages inside Settings", () => {
  test("the sections themselves have no back arrow", async () => {
    const page = await open("bots");
    for (const section of ["profile", "general", "bots", "shortcuts", "pi", "runtimes", "projects", "devices", "appearance", "notifications", "plugins", "security"]) {
      await page.eval(`store.setState({ settingsSection: ${JSON.stringify(section)} })`);
      await page.settle();
      expect(await page.eval<boolean>("!!document.querySelector('.modal-back')")).toBe(false);
      expect(await page.eval<boolean>("document.querySelector('.modal').classList.contains('has-back')")).toBe(false);
    }
  }, 60_000);

  test("a bot's page: mirrors close, stays pinned while it scrolls, and goes back to all bots", async () => {
    const page = await open("bots");
    await press(page, "Edit");
    await page.until("!!document.querySelector('.modal-back')");
    await page.settle();
    await mirrorsClose(page, "Back to all bots");
    await staysPinned(page);
    await page.click(".modal-back");
    await page.until("!document.querySelector('.modal-back')");
    expect(await page.eval<string>("document.querySelector('.settings-content').textContent")).toContain("Your bots");
    // Focus stays in the dialog, so Tab and Esc still work there.
    expect(await page.eval<boolean>("document.querySelector('.modal').contains(document.activeElement)")).toBe(true);
  }, 60_000);

  test("a group's page: mirrors close, stays pinned while it scrolls, and goes back to all bots", async () => {
    const page = await open("bots");
    await page.eval(`(() => { [...document.querySelectorAll('.bots-set-row-main')].find((b) => b.textContent.includes('Crew')).click(); return true; })()`);
    await page.until("!!document.querySelector('.modal-back')");
    await page.settle();
    expect(await page.eval<string>("document.querySelector('input[aria-label=\"Group name\"]').value")).toBe("Crew");
    await mirrorsClose(page, "Back to all bots");
    await staysPinned(page);
    // From the keyboard too.
    await page.eval("document.querySelector('.modal-back').focus()");
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await page.until("!document.querySelector('.modal-back')");
    expect(await page.eval<string>("document.querySelector('.settings-content').textContent")).toContain("Groups");
  }, 60_000);

  test("a Pi file's page asks before dropping unsaved changes, then goes back to Pi agent", async () => {
    // Short enough that the editor scrolls.
    const page = await open("pi", 1000, 320);
    await page.until("!!document.querySelector('[aria-label=\"Edit release\"]')");
    await press(page, "Edit release");
    await page.until("!!document.querySelector('.pi-code')");
    await page.settle();
    await mirrorsClose(page, "Back to Pi agent");
    // Its old back button in the editor's header is gone.
    expect(await page.eval<number>("document.querySelectorAll('.pi-editor-head button').length")).toBe(1);
    await staysPinned(page);
    await page.eval("document.querySelector('.pi-code').focus()");
    await page.send("Input.insertText", { text: "edited " });
    await page.until("!!document.querySelector('.pi-editor-head .badge')");
    // Keep editing: the page stays, arrow and all.
    await page.eval("(window.asked = 0, window.confirm = () => (window.asked++, false), true)");
    await page.click(".modal-back");
    expect(await page.eval<number>("window.asked")).toBe(1);
    expect(await page.eval<boolean>("!!document.querySelector('.pi-code') && !!document.querySelector('.modal-back')")).toBe(true);
    // Discard: back to Pi agent.
    await page.eval("(window.confirm = () => (window.asked++, true), true)");
    await page.click(".modal-back");
    await page.until("!document.querySelector('.modal-back')");
    expect(await page.eval<number>("window.asked")).toBe(2);
    expect(await page.eval<string>("document.querySelector('.settings-content .md-h1').textContent")).toContain("Pi agent");
  }, 60_000);

  test("Esc on a page inside a section still closes Settings", async () => {
    const page = await open("bots");
    await press(page, "Edit");
    await page.until("!!document.querySelector('.modal-back')");
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page.until("store.getState().settingsOpen === false");
  }, 60_000);

  test("on a phone the arrow starts the sheet's header as close ends it, and stays there as the page scrolls", async () => {
    const page = await open("bots", 390, 800);
    const tabs = await box(page, ".settings-nav");
    await press(page, "Edit");
    await page.until("!!document.querySelector('.modal-back')");
    await page.settle();
    const style = (selector: string) =>
      page.eval(`(() => { const s = getComputedStyle(document.querySelector('${selector}')); return { width: s.width, height: s.height, radius: s.borderRadius, background: s.backgroundColor }; })()`);
    expect(await style(".modal .modal-back")).toEqual(await style(".modal .modal-close"));
    const b = (await box(page, ".modal-back"))!;
    const x = (await box(page, ".modal-close"))!;
    const nav = (await box(page, ".settings-nav"))!;
    const content = (await box(page, ".settings-content"))!;
    expect(b.y).toBe(x.y);
    expect(b.x + b.width).toBeLessThanOrEqual(nav.x);
    expect(x.x).toBeGreaterThanOrEqual(nav.x + nav.width);
    expect(b.y + b.height).toBeLessThanOrEqual(content.y);
    await staysPinned(page);
    await page.click(".modal-back");
    await page.until("!document.querySelector('.modal-back')");
    // The header is back to tabs and close only.
    expect(await box(page, ".settings-nav")).toEqual(tabs);
  }, 60_000);
});

/** Scrolls the page inside the section far down, then reports how far it went. */
const scrollToEnd = (page: Page) =>
  page.eval<number>("(() => { const el = document.querySelector('.settings-content'); el.scrollTop = el.scrollHeight; return el.scrollTop; })()");

/** Where the section's page is scrolled to, and how far it could scroll at most. */
const scroll = (page: Page) =>
  page.eval<{ top: number; max: number }>("(() => { const el = document.querySelector('.settings-content'); return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight }; })()");

/** Back from a page scrolled far down: the section opens at its top, with focus still in the dialog. */
async function backOpensAtTop(page: Page, back: () => Promise<unknown>, heading: string) {
  await page.until("!!document.querySelector('.modal-back')");
  await page.settle();
  // All the way to its end, as far as it goes.
  const end = await scrollToEnd(page);
  expect(end).toBeGreaterThan(40);
  expect(end).toBe((await scroll(page)).max);
  await back();
  await page.until("!document.querySelector('.modal-back')");
  await page.settle();
  expect(await page.eval<string>("document.querySelector('.settings-content').textContent")).toContain(heading);
  const { top, max } = await scroll(page);
  // The section is taller than the dialog, so it could have kept the page's offset.
  expect(max).toBeGreaterThan(0);
  expect(top).toBe(0);
  expect(await page.eval<boolean>("document.querySelector('.modal').contains(document.activeElement)")).toBe(true);
}

for (const [device, width, height] of [["desktop", 1000, 520], ["phone", 390, 640]] as const) {
  describe.skipIf(!browser)(`going back on a ${device} opens the section at its top`, () => {
    test("from a bot's page, with the arrow", async () => {
      const page = await open("bots", width, height);
      await press(page, "Edit");
      await backOpensAtTop(page, () => page.click(".modal-back"), "Your bots");
    }, 60_000);

    test("from a group's page, with Enter on the arrow", async () => {
      const page = await open("bots", width, height);
      await page.eval(`(() => { [...document.querySelectorAll('.bots-set-row-main')].find((b) => b.textContent.includes('Crew')).click(); return true; })()`);
      await backOpensAtTop(page, async () => {
        await page.eval("document.querySelector('.modal-back').focus()");
        await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
        await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      }, "Groups");
    }, 60_000);

    test("from a Pi file's page, once unsaved changes are discarded", async () => {
      // Short enough that the editor scrolls well past its top.
      const page = await open("pi", width, 300);
      await page.until("!!document.querySelector('[aria-label=\"Edit release\"]')");
      await press(page, "Edit release");
      await page.until("!!document.querySelector('.pi-code')");
      await page.eval("document.querySelector('.pi-code').focus()");
      await page.send("Input.insertText", { text: "edited " });
      await page.until("!!document.querySelector('.pi-editor-head .badge')");
      await page.eval("(window.asked = 0, window.confirm = () => (window.asked++, false), true)");
      // Keeping the changes keeps the page where it was scrolled to.
      const kept = await scrollToEnd(page);
      await page.click(".modal-back");
      expect(await page.eval<number>("window.asked")).toBe(1);
      expect((await scroll(page)).top).toBe(kept);
      await page.eval("(window.confirm = () => (window.asked++, true), true)");
      await backOpensAtTop(page, () => page.click(".modal-back"), "Pi agent");
      expect(await page.eval<number>("window.asked")).toBe(2);
    }, 60_000);

    test("the arrow and close stay pinned through it, and Esc still closes Settings", async () => {
      const page = await open("bots", width, height);
      const close = await box(page, ".modal-close");
      await press(page, "Edit");
      await backOpensAtTop(page, () => page.click(".modal-back"), "Your bots");
      expect(await box(page, ".modal-close")).toEqual(close);
      // And into a page again: it starts at its top as well, arrow in place.
      await press(page, "Edit");
      await page.until("!!document.querySelector('.modal-back')");
      await page.settle();
      expect((await scroll(page)).top).toBe(0);
      await staysPinned(page);
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await page.until("store.getState().settingsOpen === false");
    }, 60_000);
  });
}
