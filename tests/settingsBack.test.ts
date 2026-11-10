// Settings is a page in the main pane, and the pages inside its sections (a bot's, a group's, a Pi
// file's) go back with an arrow at the start of their own header, beside the trail to them
// ("Bots / Scout"). The page's header goes back out of Settings; Esc goes up one level at a time. On
// a phone there's one header: the sections are its first screen, and its back goes up a level.
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
  await page.until("!!document.querySelector('.spage .settings-content')");
  // Until the section has finished fading in, so what's measured is where it comes to rest.
  // (Spinners turn forever, so only the animations that end.)
  await page.until("document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity)");
  await page.settle();
  return page;
};

/** Clicks the first button in the settings content whose text or label is `name`. */
const press = (page: Page, name: string) =>
  page.eval(`(() => {
    const b = [...document.querySelectorAll('.settings-content button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent.trim()) === ${JSON.stringify(name)} || b.textContent.trim().startsWith(${JSON.stringify(name)}));
    b.click();
    return true;
  })()`);

const key = async (page: Page, k: "Escape" | "Enter") => {
  const code = k === "Escape" ? 27 : 13;
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code, ...(k === "Enter" ? { text: "\r" } : {}) });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code });
};

const text = (page: Page, selector: string) => page.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);

/** A page inside a section: its arrow back, labelled for where it goes, and the trail to it, at the top of the content. */
async function subPage(page: Page, title: string, trail: string) {
  await page.until("!!document.querySelector('.subpage-back')");
  await page.settle();
  const back = await page.eval<{ label: string; tag: string; svg: boolean } | null>(`(() => {
    const b = document.querySelector('.subpage-back');
    return b && { label: b.getAttribute('aria-label'), tag: b.tagName, svg: !!b.querySelector('svg.lucide-arrow-left') };
  })()`);
  expect(back).toEqual({ label: `Back to ${trail}`, tag: "BUTTON", svg: true });
  expect(await text(page, ".subpage-title")).toBe(title);
  expect(await text(page, ".subpage-crumb")).toBe(`${trail}/`);
  // The arrow and the title sit on one line, at the top of the content, under the page's header.
  const arrow = (await box(page, ".subpage-back"))!;
  const head = (await box(page, ".page-head"))!;
  const titleBox = (await box(page, ".subpage-title"))!;
  expect(arrow.y).toBeGreaterThanOrEqual(head.y + head.height);
  expect(Math.abs(arrow.y + arrow.height / 2 - (titleBox.y + titleBox.height / 2))).toBeLessThan(4);
  // The old text link is gone.
  expect(await text(page, ".settings-content")).not.toContain("All bots");
}

describe.skipIf(!browser)("Settings as a page", () => {
  test("every section has the page's back in its header and no arrow of its own", async () => {
    const page = await open("bots");
    for (const section of ["profile", "general", "bots", "shortcuts", "pi", "keys", "runtimes", "projects", "devices", "appearance", "notifications", "plugins", "security"]) {
      await page.eval(`store.setState({ settingsSection: ${JSON.stringify(section)}, settingsPage: undefined })`);
      await page.settle();
      expect(await page.eval<boolean>("!!document.querySelector('.subpage-back')")).toBe(false);
      expect(await page.eval<string | null>("document.querySelector('.page-head .page-back')?.getAttribute('aria-label') ?? null")).toBe("Back");
      expect(await text(page, ".page-title")).toBe("Settings");
    }
    // The page's back leaves Settings.
    await page.click(".page-back");
    await page.until("store.getState().settingsOpen === false");
  }, 60_000);

  test("Runtimes is called Harnesses, with its own mark", async () => {
    const page = await open("runtimes");
    expect(await text(page, '.settings-nav-item[aria-current="true"]')).toBe("Harnesses");
    expect(await page.eval<boolean>(`!!document.querySelector('.settings-nav-item[aria-current="true"] svg.lucide-cable')`)).toBe(true);
    expect(await text(page, ".settings-content .md-h1")).toContain("Harnesses");
  }, 60_000);

  test("a bot's page: arrow and trail, and back to all bots with focus kept on the page", async () => {
    const page = await open("bots");
    await press(page, "Bot 0");
    await subPage(page, "Bot 0", "Bots");
    expect(await page.eval<string>("store.getState().settingsPage")).toBe("bot/b0");
    await page.click(".subpage-back");
    await page.until("!document.querySelector('.subpage-back')");
    expect(await text(page, ".settings-content")).toContain("Your bots");
    expect(await page.eval<boolean>("store.getState().settingsOpen")).toBe(true);
    // Focus stays on the page, so Tab and Esc still work there.
    expect(await page.eval<boolean>("document.querySelector('.spage').contains(document.activeElement)")).toBe(true);
  }, 60_000);

  test("a group's page, back from the keyboard", async () => {
    const page = await open("bots");
    await page.eval(`(() => { [...document.querySelectorAll('.bots-set-row-main')].find((b) => b.textContent.includes('Crew')).click(); return true; })()`);
    await subPage(page, "Crew", "Bots");
    expect(await page.eval<string>("document.querySelector('input[aria-label=\"Group name\"]').value")).toBe("Crew");
    await page.eval("document.querySelector('.subpage-back').focus()");
    await key(page, "Enter");
    await page.until("!document.querySelector('.subpage-back')");
    expect(await text(page, ".settings-content")).toContain("Groups");
  }, 60_000);

  test("Bots → Models: the default model, fallbacks and each bot's own", async () => {
    const page = await open("bots");
    await press(page, "Models");
    await subPage(page, "Models", "Bots");
    expect(await page.eval<string[]>(`[...document.querySelectorAll('.settings-content button[aria-haspopup="listbox"]')].map((b) => b.getAttribute('aria-label'))`)).toEqual(
      expect.arrayContaining(["Default model", "Model for Bot 0", "Model for Bot 5"]),
    );
    expect(await text(page, ".settings-content")).toContain("Default fallback models");
  }, 60_000);

  test("a Pi file's page asks before dropping unsaved changes, then goes back to its list", async () => {
    // Short enough that the editor scrolls.
    const page = await open("pi", 1000, 320);
    await page.until("[...document.querySelectorAll('.nav-row')].some((b) => b.textContent.startsWith('Skills'))");
    await press(page, "Skills");
    await subPage(page, "Skills", "Pi agent");
    await page.until("!!document.querySelector('[aria-label=\"Edit release\"]')");
    await press(page, "Edit release");
    await page.until("!!document.querySelector('.pi-code')");
    await page.settle();
    expect(await text(page, ".subpage-title")).toBe("release");
    expect(await page.eval<string[]>("[...document.querySelectorAll('.subpage-crumb')].map((c) => c.textContent)")).toEqual(["Pi agent/", "Skills/"]);
    await page.eval("document.querySelector('.pi-code').focus()");
    await page.send("Input.insertText", { text: "edited " });
    await page.until("!!document.querySelector('.pi-editor-head .badge')");
    // Keep editing: the page stays, arrow and all.
    await page.eval("(window.asked = 0, window.confirm = () => (window.asked++, false), true)");
    await page.click(".subpage-back");
    expect(await page.eval<number>("window.asked")).toBe(1);
    expect(await page.eval<boolean>("!!document.querySelector('.pi-code') && !!document.querySelector('.subpage-back')")).toBe(true);
    // Discard: back to the skills.
    await page.eval("(window.confirm = () => (window.asked++, true), true)");
    await page.click(".subpage-back");
    await page.until("!document.querySelector('.pi-code')");
    expect(await page.eval<number>("window.asked")).toBe(2);
    expect(await text(page, ".subpage-title")).toBe("Skills");
  }, 60_000);

  test("Esc goes up a level at a time: out of a page, then out of Settings", async () => {
    const page = await open("bots");
    await press(page, "Bot 0");
    await page.until("!!document.querySelector('.subpage-back')");
    await key(page, "Escape");
    await page.until("!document.querySelector('.subpage-back')");
    expect(await page.eval<boolean>("store.getState().settingsOpen")).toBe(true);
    await key(page, "Escape");
    await page.until("store.getState().settingsOpen === false");
  }, 60_000);

  test("on a phone, the sections are the first screen and the header goes back one level at a time", async () => {
    const page = await Page.open(chrome!.ws, server!.url.href, 390, 800, "!!window.store");
    await page.eval("store.getState().openSettings()");
    await page.until("!!document.querySelector('.spage-index .settings-nav')");
    await page.settle();
    // The list of sections, the whole width, and no section beside it.
    const nav = (await box(page, ".settings-nav"))!;
    expect(nav.width).toBeGreaterThan(380);
    expect(await page.eval<boolean>("!!document.querySelector('.settings-content')")).toBe(false);
    expect(await text(page, ".page-title")).toBe("Settings");
    await page.click('.settings-nav-item[aria-label="Bots"]');
    await page.until("!!document.querySelector('.settings-content')");
    expect(await text(page, ".page-title")).toBe("Bots");
    expect(await page.eval<boolean>("!!document.querySelector('.settings-nav')")).toBe(false);
    // Into a bot: the header names it, and the content doesn't repeat the arrow or the trail.
    await press(page, "Bot 0");
    await page.until("document.querySelector('.page-title').textContent === 'Bot 0'");
    expect(await page.eval<string>("getComputedStyle(document.querySelector('.subpage-head')).display")).toBe("none");
    expect(await page.eval<string>("document.querySelector('.page-back').getAttribute('aria-label')")).toBe("Back to Bots");
    await page.click(".page-back");
    await page.until("document.querySelector('.page-title').textContent === 'Bots'");
    await page.click(".page-back");
    await page.until("!!document.querySelector('.spage-index')");
    await page.click(".page-back");
    await page.until("store.getState().settingsOpen === false");
  }, 60_000);

  test("opened again within 10 seconds it's where it was left, scrolled as it was; later it starts at Profile's top", async () => {
    const page = await Page.open(chrome!.ws, server!.url.href, 1000, 360, "!!window.store");
    const content = ".spage .settings-content";
    const scrollOf = () => page.eval<number>(`Math.round(document.querySelector(${JSON.stringify(content)}).scrollTop)`);
    await page.eval("store.getState().openSettings()");
    await page.until("!!document.querySelector('.spage .settings-content')");
    expect(await page.eval<string>("store.getState().settingsSection")).toBe("profile");
    // Into Bots, and down it.
    await page.eval(`document.querySelector('.settings-nav-item[aria-label="Bots"]').click()`);
    await page.until("store.getState().settingsSection === 'bots'");
    await page.settle();
    await page.eval(`document.querySelector(${JSON.stringify(content)}).scrollTop = 150`);
    await page.settle();
    expect(await scrollOf()).toBe(150);
    // Out, and straight back in from the sidebar's button: Bots, 150px down.
    await page.eval("store.getState().closeSettings()");
    await page.until("!document.querySelector('.spage')");
    await page.eval("store.getState().openSettings()");
    await page.until("!!document.querySelector('.spage .settings-content')");
    await page.settle();
    expect(await page.eval<string>("store.getState().settingsSection")).toBe("bots");
    expect(await scrollOf()).toBe(150);
    // Out again, and back after more than 10 seconds: Profile, at its top.
    await page.eval("store.getState().closeSettings()");
    await page.until("!document.querySelector('.spage')");
    await page.eval("(() => { const real = Date.now; Date.now = () => real() + 11_000; return true; })()");
    await page.eval("store.getState().openSettings()");
    await page.until("!!document.querySelector('.spage .settings-content')");
    await page.settle();
    expect(await page.eval<string>("store.getState().settingsSection")).toBe("profile");
    expect(await scrollOf()).toBe(0);
  }, 60_000);

  test("Bots → Models on a phone: each fallback on one line, lined up, and each bot's picker under its name", async () => {
    const page = await Page.open(chrome!.ws, server!.url.href, 390, 900, "!!window.store");
    await page.eval("bots.setState({ defaultFallbackModels: ['openai-codex/gpt-6.1-sol', 'opencode-go/glm-5.3-flash', 'openrouter/deepseek/deepseek-v4.1-flash-1017-a-very-long-name'] })");
    await page.eval("store.getState().openSettings('bots')");
    await page.until("!!document.querySelector('.settings-content')");
    await press(page, "Models");
    await page.until("document.querySelectorAll('.bots-fallbacks .naming-row').length === 4");
    await page.settle();
    const rows = await page.eval<{ index: Box; picker: Box; row: Box }[]>(`[...document.querySelectorAll('.bots-fallbacks .naming-row')].map((r) => {
      const b = (el) => { const x = el.getBoundingClientRect(); return { x: x.x, y: x.y, width: x.width, height: x.height }; };
      return { index: b(r.querySelector('.naming-index')), picker: b(r.querySelector('.select-wrap')), row: b(r) };
    })`);
    for (const { index, picker, row } of rows) {
      // One line: the number and the picker side by side, centred on each other.
      expect(row.height).toBeLessThan(48);
      expect(Math.abs(index.y + index.height / 2 - (picker.y + picker.height / 2))).toBeLessThan(2);
      expect(picker.x).toBeGreaterThan(index.x + index.width);
    }
    // The pickers start and end in the same place on every row, the one to add another included.
    expect(new Set(rows.map((r) => Math.round(r.picker.x))).size).toBe(1);
    expect(new Set(rows.map((r) => Math.round(r.picker.x + r.picker.width))).size).toBe(1);
    // Nothing runs off the screen.
    expect(await page.eval<boolean>("[...document.querySelectorAll('.bots-fallbacks .naming-row *')].every((el) => el.getBoundingClientRect().right <= innerWidth)")).toBe(true);
    // Each bot's name, whole, with its picker the row's width under it.
    const bots = await page.eval<{ nameBottom: number; pickerTop: number; pickerWidth: number; rowWidth: number; clipped: boolean }[]>(`[...document.querySelectorAll('.bots-set-model-row')].map((r) => {
      const name = r.querySelector('.bots-set-model-name').getBoundingClientRect();
      const picker = r.querySelector('.bots-set-model').getBoundingClientRect();
      const label = r.querySelector('.bots-set-model-name .setting-label');
      return { nameBottom: name.bottom, pickerTop: picker.top, pickerWidth: picker.width, rowWidth: r.getBoundingClientRect().width, clipped: label.scrollWidth > label.clientWidth };
    })`);
    expect(bots.length).toBe(6);
    for (const b of bots) {
      expect(b.pickerTop).toBeGreaterThanOrEqual(b.nameBottom);
      expect(Math.abs(b.pickerWidth - b.rowWidth)).toBeLessThan(2);
      expect(b.clipped).toBe(false);
    }
  }, 60_000);
});

/** Scrolls the page inside the section far down, then reports how far it went. */
const scrollToEnd = (page: Page) =>
  page.eval<number>("(() => { const el = document.querySelector('.settings-content'); el.scrollTop = el.scrollHeight; return el.scrollTop; })()");

/** Where the section's page is scrolled to, and how far it could scroll at most. */
const scroll = (page: Page) =>
  page.eval<{ top: number; max: number }>("(() => { const el = document.querySelector('.settings-content'); return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight }; })()");

/** The way back from a page inside a section: its arrow on a wide screen, the header's on a phone. */
const backFrom = (device: "desktop" | "phone") => (device === "phone" ? ".page-back" : ".subpage-back");

/** Back from a page scrolled far down: the section opens at its top, with focus still on the page. */
async function backOpensAtTop(page: Page, back: () => Promise<unknown>, heading: string) {
  await page.until("!!document.querySelector('.subpage')");
  await page.settle();
  // All the way to its end, as far as it goes.
  const end = await scrollToEnd(page);
  expect(end).toBeGreaterThan(40);
  expect(end).toBe((await scroll(page)).max);
  await back();
  await page.until("!document.querySelector('.subpage')");
  await page.settle();
  expect(await text(page, ".settings-content")).toContain(heading);
  const { top, max } = await scroll(page);
  // The section is taller than the page, so it could have kept the page's offset.
  expect(max).toBeGreaterThan(0);
  expect(top).toBe(0);
  expect(await page.eval<boolean>("document.querySelector('.spage').contains(document.activeElement)")).toBe(true);
}

for (const [device, width, height] of [["desktop", 1000, 520], ["phone", 390, 640]] as const) {
  describe.skipIf(!browser)(`going back on a ${device} opens the section at its top`, () => {
    test("from a bot's page", async () => {
      const page = await open("bots", width, height);
      await press(page, "Bot 0");
      await backOpensAtTop(page, () => page.click(backFrom(device)), "Your bots");
    }, 60_000);

    test("from a group's page, with Enter on the arrow", async () => {
      const page = await open("bots", width, height);
      await page.eval(`(() => { [...document.querySelectorAll('.bots-set-row-main')].find((b) => b.textContent.includes('Crew')).click(); return true; })()`);
      await backOpensAtTop(page, async () => {
        await page.eval(`document.querySelector(${JSON.stringify(backFrom(device))}).focus()`);
        await key(page, "Enter");
      }, "Groups");
    }, 60_000);

    test("from a Pi file's page, once unsaved changes are discarded", async () => {
      // Short enough that the editor scrolls well past its top.
      const page = await open("pi", width, 300);
      await page.until("[...document.querySelectorAll('.nav-row')].some((b) => b.textContent.startsWith('Skills'))");
      await press(page, "Skills");
      await page.until("!!document.querySelector('[aria-label=\"Edit release\"]')");
      await press(page, "Edit release");
      await page.until("!!document.querySelector('.pi-code')");
      await page.eval("document.querySelector('.pi-code').focus()");
      await page.send("Input.insertText", { text: "edited " });
      await page.until("!!document.querySelector('.pi-editor-head .badge')");
      await page.eval("(window.asked = 0, window.confirm = () => (window.asked++, false), true)");
      // Keeping the changes keeps the page where it was scrolled to.
      const kept = await scrollToEnd(page);
      await page.click(backFrom(device));
      expect(await page.eval<number>("window.asked")).toBe(1);
      expect((await scroll(page)).top).toBe(kept);
      await page.eval("(window.confirm = () => (window.asked++, true), true)");
      await page.click(backFrom(device));
      await page.until("!document.querySelector('.pi-code')");
      expect(await page.eval<number>("window.asked")).toBe(2);
      expect(await page.eval<string>("store.getState().settingsPage")).toBe("skills");
    }, 60_000);

    test("into a page again, it starts at its top, and Esc goes back up", async () => {
      const page = await open("bots", width, height);
      await press(page, "Bot 0");
      await backOpensAtTop(page, () => page.click(backFrom(device)), "Your bots");
      await scrollToEnd(page);
      await press(page, "Bot 1");
      await page.until("!!document.querySelector('.subpage')");
      await page.settle();
      expect((await scroll(page)).top).toBe(0);
      await key(page, "Escape");
      await page.until("!document.querySelector('.subpage')");
      expect(await page.eval<boolean>("store.getState().settingsOpen")).toBe(true);
    }, 60_000);
  });
}
