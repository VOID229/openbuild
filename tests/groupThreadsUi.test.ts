// A group's Threads tab in the details panel, in a real Chrome with the whole app on a fake server
// (fixtures/groupThreads): it lists the coding threads the group's bots started from it while they
// work, follows the thread list as threads start and finish, opens one inside the panel itself (not over
// OpenBots), and Back returns to the list. Set OPENBUILD_SCREENSHOTS to a folder to keep
// a picture of each state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { browser, launchChrome, Page } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const shots = process.env.OPENBUILD_SCREENSHOTS;

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/groupThreads/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page, "/bots": page, "/bots/*": page } });
  chrome = await launchChrome();
  if (shots) await mkdir(shots, { recursive: true });
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

async function shoot(page: Page, name: string) {
  if (!shots) return;
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(shots, `${name}.png`), Buffer.from(data, "base64"));
}

const TAB = `[...document.querySelectorAll('.bots-details .bots-tab')].find((t) => t.textContent.startsWith('Threads'))`;

/** The group chat open in OpenBots with its details showing the Threads tab. */
async function open(width = 1280, height = 860, theme = "dark") {
  const page = await Page.open(chrome!.ws, `${server!.url.href}?theme=${theme}`, width, height, "window.store?.getState().chatsLoaded && window.bots?.getState().loaded");
  await showTab(page, width);
  return page;
}

async function showTab(page: Page, width: number) {
  await page.eval(`(() => {
    store.getState().setBotsOpen(true);
    store.getState().setBotsSidebarOpen(${width > 768});
    bots.getState().select("dev");
  })()`);
  // On a phone OpenBots starts with the details closed, once it shows: they're opened after that.
  await page.until("!!document.querySelector('.bots-view .bots-messages')");
  await page.settle();
  await page.eval(`bots.getState().setDetailsOpen(true)`);
  await page.until("!!document.querySelector('.bots-details-open')");
  await page.eval(`${TAB}.click()`);
  await page.until(`${TAB}.getAttribute('aria-selected') === 'true'`);
  // The panel's opening transition has finished.
  await Bun.sleep(350);
  await page.settle();
}

/** What the tab lists: each row's title, the line under it, and its mascot's colour. */
const rows = (page: Page) =>
  page.eval<{ title: string; sub: string; mascot: string | null }[]>(`[...document.querySelectorAll('.bots-details .bots-cards .bots-member')].map((li) => ({
    title: li.querySelector('.bots-routine-title').textContent,
    sub: li.querySelector('.bots-routine-when').textContent,
    mascot: li.querySelector('.bot-avatar, svg') ? li.querySelector('svg').outerHTML.match(/#[0-9a-f]{6}/i)?.[0] ?? 'svg' : null,
  }))`);

/** Sets the server's thread list and has the app poll it now, as it would within five seconds. */
async function serve(page: Page, change: string) {
  await page.eval(`(() => { serverChats = ${change}; reloadThreads(); })()`);
}

const row = (title: string) => `[...document.querySelectorAll('.bots-details .bots-member-main')].find((b) => b.textContent.includes(${JSON.stringify(title)}))`;

/** A real click on the row for `title`. */
async function clickRow(page: Page, title: string) {
  await page.eval(`(() => { document.querySelector('[data-test-row]')?.removeAttribute('data-test-row'); ${row(title)}.setAttribute('data-test-row', ''); })()`);
  await page.click("[data-test-row]");
}


describe.skipIf(!browser)("a group's Threads tab", () => {
  test("lists the working threads the group's bots started from it, with each bot's mascot and the project", async () => {
    const page = await open();
    await page.until(`document.querySelectorAll('.bots-details .bots-cards .bots-member').length === 2`);
    const tabs = await page.eval<string[]>(`[...document.querySelectorAll('.bots-details .bots-tab')].map((t) => t.textContent)`);
    expect(tabs).toEqual(["Members 2", "Goal", "Threads 2"]);
    const listed = await rows(page);
    expect(listed.map((r) => [r.title, r.sub])).toEqual([
      ["Fix the flaky sidebar test", "manager · openbuild"],
      ["Trace the slow startup", "tracer · openbuild-site"],
    ]);
    // Each row carries its bot's mascot, and the two bots look different.
    expect(listed.every((r) => r.mascot)).toBe(true);
    expect(await page.eval<unknown>(`${row("Fix the flaky")}.querySelector('svg').outerHTML !== ${row("Trace the slow")}.querySelector('svg').outerHTML`)).toBe(true);
    // Rows look like the Members tab's.
    const style = await page.eval(`(() => { const s = getComputedStyle(document.querySelector('.bots-details .bots-cards')); return [s.borderRadius, s.borderStyle]; })()`);
    expect(style).toEqual(["16px", "solid"]);
    expect(await page.eval<unknown>("document.documentElement.scrollWidth - innerWidth")).toBe(0);
    await shoot(page, "threads-tab");
  }, 60_000);

  test("follows threads as they start and finish, down to a calm empty state", async () => {
    const page = await open();
    // A bot in the group starts another.
    await serve(page, `[...serverChats, thread("t-new", "Write the release notes", "tracer", "dev", "openbuild")]`);
    await page.until(`document.querySelectorAll('.bots-details .bots-cards .bots-member').length === 3`);
    expect((await rows(page)).map((r) => r.title)).toContain("Write the release notes");
    expect(await page.eval<unknown>(`${TAB}.textContent`)).toBe("Threads 3");
    // One finishes.
    await serve(page, `serverChats.map((c) => c.id === "t-flaky" ? thread(c.id, c.title, "manager", "dev", "openbuild", true) : c)`);
    await page.until(`document.querySelectorAll('.bots-details .bots-cards .bots-member').length === 2`);
    expect((await rows(page)).map((r) => r.title)).not.toContain("Fix the flaky sidebar test");
    // And the rest.
    await serve(page, `serverChats.map((c) => thread(c.id, c.title, c.startedBy.bot, c.startedBy.conversation, c.workspace.projectName, true))`);
    await page.until(`!document.querySelector('.bots-details .bots-cards')`);
    expect(await page.eval<unknown>(`document.querySelector('.bots-details .bots-hint').textContent`)).toBe("No threads working right now. When a bot here starts one, it shows up until it finishes.");
    expect(await page.eval<unknown>(`${TAB}.textContent`)).toBe("Threads");
    await shoot(page, "threads-empty");
  }, 60_000);

  test("opens a thread inside the details panel, not over OpenBots, and Back returns to the list", async () => {
    const page = await open();
    const rect = (sel: string) => page.eval<{ l: number; r: number; t: number; b: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; })()`);
    await page.eval(`document.querySelector('.bots-view textarea, .bots-view [contenteditable]')?.focus()`);
    await clickRow(page, "Trace the slow");
    await page.until(`!!document.querySelector('.bots-details-threadpane .chat')`);
    await page.until(`document.querySelector('.bots-details-threadpane').innerText.includes("Looking into it")`);
    await Bun.sleep(450);
    // Routing and OpenBots are untouched: still the bot chat, the thread is just the panel's content.
    expect(await page.eval<unknown>("location.pathname")).toBe("/bots");
    expect(await page.eval<unknown>("store.getState().botsThread")).toBe(false);
    expect(await page.eval<unknown>("store.getState().botsOpen")).toBe(true);
    expect(await page.eval<unknown>("!!document.querySelector('.bots-view .bots-messages')")).toBe(true);
    expect(await page.eval<unknown>("!!document.querySelector('.floating-tools-bots')")).toBe(false);
    // Contained: the thread sits within the panel, beside the chat, not over it.
    const panel = (await rect(".bots-details"))!;
    const thread = (await rect(".bots-details-threadpane .chat"))!;
    const chatPane = (await rect(".bots-view .bots-messages"))!;
    expect(thread.l).toBeGreaterThanOrEqual(panel.l - 1);
    expect(thread.r).toBeLessThanOrEqual(panel.r + 1);
    expect(thread.b).toBeLessThanOrEqual(panel.b + 1);
    expect(chatPane.r).toBeLessThanOrEqual(panel.l + 1);
    expect(await page.eval<unknown>("document.documentElement.scrollWidth - innerWidth")).toBe(0);
    await shoot(page, "thread-in-panel");

    await page.click('.bots-details-threadpane [aria-label="Back to threads"]');
    await page.until("!document.querySelector('.bots-details-threadpane')");
    expect(await page.eval<unknown>(`${TAB}.getAttribute('aria-selected')`)).toBe("true");
    expect((await rows(page)).length).toBe(2);
    expect(await page.eval<unknown>("bots.getState().activeId")).toBe("dev");
    await shoot(page, "back-to-tab");

    // Opening out to OpenBuild is only ever by choice.
    await clickRow(page, "Fix the flaky");
    await page.until(`!!document.querySelector('.bots-details-threadpane [aria-label="Open in OpenBuild"]')`);
    expect(await page.eval<unknown>("store.getState().botsOpen")).toBe(true);
    await page.click('.bots-details-threadpane [aria-label="Open in OpenBuild"]');
    await page.until("!store.getState().botsOpen");
    expect(await page.eval<unknown>("store.getState().activeChatId")).toBe("t-flaky");
    expect(await page.eval<unknown>("location.pathname")).toBe("/thread-t-flaky");
  }, 60_000);

  test("on a phone, the thread fills the details screen only, and Back returns to the list", async () => {
    const page = await open(390, 800);
    await clickRow(page, "Fix the flaky");
    await page.until(`!!document.querySelector('.bots-details-threadpane .chat')`);
    await Bun.sleep(450);
    expect(await page.eval<unknown>("store.getState().botsThread")).toBe(false);
    expect(await page.eval<unknown>("location.pathname")).toBe("/bots");
    const fit = await page.eval<number[]>(`(() => { const p = document.querySelector('.bots-details').getBoundingClientRect(); const t = document.querySelector('.bots-details-threadpane .chat').getBoundingClientRect(); return [t.left - p.left, p.right - t.right, p.bottom - t.bottom]; })()`);
    expect(fit.every((d) => d >= -1)).toBe(true);
    expect(await page.eval<unknown>("document.documentElement.scrollWidth - innerWidth")).toBe(0);
    await shoot(page, "phone-thread-in-panel");
    await page.click('.bots-details-threadpane [aria-label="Back to threads"]');
    await page.until("!document.querySelector('.bots-details-threadpane')");
    expect(await page.eval<unknown>(`${TAB}.getAttribute('aria-selected')`)).toBe("true");
    expect((await rows(page)).length).toBe(2);
    expect(await page.eval<unknown>("!!document.querySelector('.bots-details-open')")).toBe(true);
    await shoot(page, "phone-back-to-tab");
  }, 60_000);

  describe("resizing a thread open in the panel", () => {
    const GRIP = ".bots-details-threadpane .bots-thread-grip";
    const KEY = "openbuild:bots-thread-width";
    /** The thread's width, the bot chat's beside it, and the row they share. */
    const widths = (page: Page) => page.eval<{ thread: number; chat: number; room: number; overlap: number }>(`(() => {
      const panel = document.querySelector('.bots-details').getBoundingClientRect();
      const chat = document.querySelector('.bots-view .bots-messages').getBoundingClientRect();
      return { thread: Math.round(panel.width), chat: Math.round(chat.width), room: document.querySelector('.bots-view-content').clientWidth, overlap: chat.right - panel.left };
    })()`);
    const gripAt = (page: Page) => page.eval<[number, number]>(`(() => { const r = document.querySelector(${JSON.stringify(GRIP)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    async function drag(page: Page, dx: number) {
      const [x, y] = await gripAt(page);
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 5; i++) await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + (dx * i) / 5, y, button: "left", buttons: 1 });
      // Moves go out with the next frame: let the last one land before letting go.
      await page.settle();
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + dx, y, button: "left", buttons: 0, clickCount: 1 });
      await page.settle();
    }
    async function key(page: Page, name: string, shift = false) {
      const codes: Record<string, number> = { ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35 };
      for (const type of ["rawKeyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: name, code: name, windowsVirtualKeyCode: codes[name], modifiers: shift ? 8 : 0 });
      await page.settle();
    }
    /** Waits out the panel's width transition. */
    const rest = () => Bun.sleep(350);
    async function openThread(page: Page) {
      await clickRow(page, "Trace the slow");
      await page.until(`!!document.querySelector(${JSON.stringify(GRIP)})`);
      await rest();
      await page.settle();
    }

    test("drags by the left edge, between a smallest width and one that leaves the chat room", async () => {
      const page = await open();
      await openThread(page);
      expect((await widths(page)).thread).toBe(480);
      const grip = await page.eval<Record<string, string | null>>(`(() => { const g = document.querySelector(${JSON.stringify(GRIP)}); return Object.fromEntries(['role', 'aria-orientation', 'aria-label', 'aria-valuenow', 'aria-valuemin', 'tabindex'].map((a) => [a, g.getAttribute(a)])); })()`);
      expect(grip).toEqual({ role: "separator", "aria-orientation": "vertical", "aria-label": "Resize the thread", "aria-valuenow": "480", "aria-valuemin": "360", tabindex: "0" });
      expect(await page.eval<unknown>(`getComputedStyle(document.querySelector(${JSON.stringify(GRIP)})).cursor`)).toBe("ew-resize");

      // Wider, following the pointer, and the chat gives way beside it rather than under it.
      await drag(page, -80);
      let w = await widths(page);
      expect(w.thread).toBe(560);
      expect(w.overlap).toBeLessThanOrEqual(1);
      expect(await page.eval<unknown>(`localStorage.getItem(${JSON.stringify(KEY)})`)).toBe("560");
      expect(await page.eval<unknown>("document.body.classList.contains('panel-dragging')")).toBe(false);
      await shoot(page, "thread-resized-dark");

      // No wider than leaves the bot chat its room.
      await drag(page, -2000);
      w = await widths(page);
      expect(w.thread).toBe(w.room - 420);
      expect(w.chat).toBeGreaterThanOrEqual(420 - 1);
      expect(await page.eval<unknown>(`document.querySelector(${JSON.stringify(GRIP)}).getAttribute('aria-valuemax')`)).toBe(String(w.room - 420));
      // And no narrower than a thread still reads.
      await drag(page, 2000);
      expect((await widths(page)).thread).toBe(360);
      expect(await page.eval<unknown>("document.documentElement.scrollWidth - innerWidth")).toBe(0);

      // A double-click goes back to the default, which isn't kept as a choice.
      const [x, y] = await gripAt(page);
      for (const clickCount of [1, 2]) for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount });
      await rest();
      expect((await widths(page)).thread).toBe(480);
      expect(await page.eval<unknown>(`localStorage.getItem(${JSON.stringify(KEY)})`)).toBe(null);
    }, 60_000);

    test("works from the keyboard", async () => {
      const page = await open();
      await openThread(page);
      // Tabbed to: it comes just before the thread's Back button.
      await page.eval(`document.querySelector('.bots-details-threadpane [aria-label="Back to threads"]').focus()`);
      for (const type of ["rawKeyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 });
      await page.settle();
      expect(await page.eval<unknown>(`document.activeElement === document.querySelector(${JSON.stringify(GRIP)})`)).toBe(true);
      await key(page, "ArrowLeft");
      await rest();
      expect((await widths(page)).thread).toBe(496);
      await key(page, "ArrowLeft", true);
      await rest();
      expect((await widths(page)).thread).toBe(560);
      await key(page, "ArrowRight");
      await rest();
      expect((await widths(page)).thread).toBe(544);
      await key(page, "Home");
      await rest();
      expect((await widths(page)).thread).toBe(360);
      await key(page, "End");
      await rest();
      const w = await widths(page);
      expect(w.thread).toBe(w.room - 420);
      // The keys only resize: focus stays on the edge and the thread stays open.
      expect(await page.eval<unknown>("document.activeElement?.classList.contains('bots-thread-grip')")).toBe(true);
      expect(await page.eval<unknown>("!!document.querySelector('.bots-details-threadpane')")).toBe(true);
      // Focused from the keyboard, the edge shows its line.
      await Bun.sleep(300);
      expect(await page.eval<unknown>(`getComputedStyle(document.querySelector(${JSON.stringify(GRIP)}), '::after').opacity`)).toBe("1");
      await shoot(page, "thread-grip-focused");
    }, 60_000);

    test("follows a finger, with a wider edge to catch", async () => {
      const page = await open();
      await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await page.settle();
      await openThread(page);
      expect(await page.eval<unknown>(`document.querySelector(${JSON.stringify(GRIP)}).getBoundingClientRect().width`)).toBe(14);
      const [x, y] = await gripAt(page);
      await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let i = 1; i <= 5; i++) await page.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 20 * i, y }] });
      await page.settle();
      await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.settle();
      expect((await widths(page)).thread).toBe(580);
    }, 60_000);

    test("keeps its width across a reload, held to what a narrower window has room for", async () => {
      const page = await open();
      await openThread(page);
      await drag(page, -100);
      expect((await widths(page)).thread).toBe(580);

      await page.send("Page.reload");
      await page.until("window.store?.getState().chatsLoaded && window.bots?.getState().loaded");
      await showTab(page, 1280);
      await openThread(page);
      expect((await widths(page)).thread).toBe(580);

      // A narrower window: the chat keeps its room, and the width chosen comes back with the room.
      await page.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 860, deviceScaleFactor: 1, mobile: false });
      await rest();
      await page.settle();
      let w = await widths(page);
      expect(w.thread).toBe(w.room - 420);
      expect(w.chat).toBeGreaterThanOrEqual(420 - 1);
      expect(await page.eval<unknown>("document.documentElement.scrollWidth - innerWidth")).toBe(0);
      await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
      await rest();
      await page.settle();
      expect((await widths(page)).thread).toBe(580);
    }, 60_000);

    test("in the light theme too", async () => {
      const page = await open(1280, 860, "light");
      await openThread(page);
      await drag(page, -80);
      expect((await widths(page)).thread).toBe(560);
      await shoot(page, "thread-resized-light");
    }, 60_000);

    test("on a phone the thread fills the details screen, with no edge to drag and a width kept on a wider screen ignored", async () => {
      const page = await open(390, 800);
      await page.eval(`localStorage.setItem(${JSON.stringify(KEY)}, "900")`);
      await clickRow(page, "Fix the flaky");
      await page.until(`!!document.querySelector('.bots-details-threadpane .chat')`);
      await rest();
      expect(await page.eval<unknown>(`!!document.querySelector('.bots-thread-grip')`)).toBe(false);
      const fit = await page.eval<number[]>(`(() => { const p = document.querySelector('.bots-details').getBoundingClientRect(); const t = document.querySelector('.bots-details-threadpane').getBoundingClientRect(); return [p.width, t.width]; })()`);
      expect(fit[0]).toBe(390);
      expect(fit[1]).toBeGreaterThanOrEqual(389);
      expect(await page.eval<unknown>("document.documentElement.scrollWidth - innerWidth")).toBe(0);
    }, 60_000);
  });
});
