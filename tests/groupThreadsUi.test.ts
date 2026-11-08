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
async function open(width = 1280, height = 860) {
  const page = await Page.open(chrome!.ws, server!.url.href, width, height, "window.store?.getState().chatsLoaded && window.bots?.getState().loaded");
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
  return page;
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
});
