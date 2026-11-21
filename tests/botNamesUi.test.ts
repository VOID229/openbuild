// A name another bot has, in a real Chrome on the whole app (fixtures/groupThreads, bots "manager" and
// "tracer"): each form that names a bot says "You already have a bot named …" right under its field, in
// the words typed, and sends nothing until the name is free. The New bot dialog, the Rename dialog, the
// details panel's name and the bot's Settings page all do. Bots called the same from before keep their
// names, and either can still be renamed. (The server's half: tests/botNames.test.ts.)
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

/** OpenBots open on a chat, at /bots so the app's routing doesn't close it again once threads load. */
async function open(width = 1280, height = 800, chat = "dm-tracer") {
  const page = await Page.open(chrome!.ws, `${server!.url.href}bots?theme=dark`, width, height, "window.store?.getState().chatsLoaded && window.bots?.getState().loaded");
  await page.eval(`(() => {
    store.getState().setBotsOpen(true);
    store.getState().setBotsSidebarOpen(${width > 768});
    bots.getState().select(${JSON.stringify(chat)});
  })()`);
  await page.until("!!document.querySelector('.bots-view .bots-messages')?.checkVisibility()");
  await page.settle();
  return page;
}

/** Replaces what the field `selector` holds with `text`, as typing does. */
async function type(page: Page, selector: string, text: string) {
  await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select(); })()`);
  await page.send("Input.insertText", { text });
  await page.settle();
}
const press = async (page: Page, key: "Enter" | "Escape") => {
  const code = key === "Enter" ? 13 : 27;
  for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: code, ...(key === "Enter" && type === "keyDown" ? { text: "\r" } : {}) });
  await page.settle();
};
/** The error under a name field, whether its field says it's invalid and points at it, and whether it's on the screen. */
const errorOf = (page: Page, field: string) =>
  page.eval<{ text: string | null; invalid: boolean; described: boolean; seen: boolean; wide: boolean }>(`(() => {
    const el = document.querySelector(${JSON.stringify(field)});
    const err = document.querySelector('.bots-name-error');
    const r = err?.getBoundingClientRect();
    return {
      text: err?.textContent ?? null,
      invalid: el?.getAttribute('aria-invalid') === 'true',
      described: !!err && el?.getAttribute('aria-describedby') === err.id,
      seen: !!r && r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
      wide: document.documentElement.scrollWidth > innerWidth,
    };
  })()`);
/** What the page asked the server to change about bots since `from`: reading a chat isn't a change. */
const writes = (page: Page, from = 0) => page.eval<{ method: string; path: string; body: any }[]>(`(window.sent ?? []).slice(${from}).filter((s) => /^\\/api\\/bots(\\/[^/]+)?$/.test(s.path))`);
const sentSoFar = (page: Page) => page.eval<number>("(window.sent ?? []).length");
const menuItem = (name: string) => `[...document.querySelectorAll('[role=menuitem]')].find((b) => b.textContent.includes(${JSON.stringify(name)}))`;

const NO_ERROR = { text: null, invalid: false, described: false, seen: false, wide: false };

describe.skipIf(!browser)("a bot's name another bot has", () => {
  for (const [label, width, height] of [["on a desktop", 1280, 800], ["on a phone", 390, 844]] as const) {
    test(`the New bot dialog says so under the name and won't create it, ${label}`, async () => {
      const page = await open(width, height);
      // On a phone the chat covers the list: the dialog is the sidebar's, opened as the "+" menu's New bot does.
      if (width < 500) await page.eval(`window.dispatchEvent(new CustomEvent("openbots:dialog", { detail: { kind: "bot" } }))`);
      else {
        await page.eval(`[...document.querySelectorAll('button[aria-label="New"]')].find((b) => b.getBoundingClientRect().width > 0).click()`);
        await page.until(`!!${menuItem("New bot")}`);
        await page.eval(`${menuItem("New bot")}.click()`);
      }
      await page.until("!!document.querySelector('.bots-name-input')");
      const from = await sentSoFar(page);

      await type(page, ".bots-name-input", "  Manager ");
      expect(await errorOf(page, ".bots-name-input")).toEqual({ text: "You already have a bot named Manager", invalid: true, described: true, seen: true, wide: false });
      expect(await page.eval<boolean>("document.querySelector('.bots-dialog button[type=submit]').disabled")).toBe(true);
      await press(page, "Enter");
      expect(await page.eval<boolean>("!!document.querySelector('.bots-name-input')")).toBe(true);
      expect(await writes(page, from)).toEqual([]);

      // A free name: the line goes, and Create makes it.
      await type(page, ".bots-name-input", "Scout");
      expect(await errorOf(page, ".bots-name-input")).toEqual(NO_ERROR);
      await page.eval("document.querySelector('.bots-dialog button[type=submit]').click()");
      await page.until(`(window.sent ?? []).slice(${from}).some((s) => s.method === "POST" && s.path === "/api/bots")`);
      expect((await writes(page, from)).map((w) => [w.method, w.path, w.body.name])).toEqual([["POST", "/api/bots", "Scout"]]);
    }, 60_000);
  }

  test("the Rename dialog says so, and renames to a free name", async () => {
    const page = await open();
    const [x, y] = await page.eval<[number, number]>(`(() => { const r = document.querySelector('.bots-row[data-drag-id="dm-tracer"]').getBoundingClientRect(); return [r.x + 40, r.y + r.height / 2]; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x, y, button: "right", clickCount: 1 });
    await page.until(`!!${menuItem("Rename bot")}`);
    await page.eval(`${menuItem("Rename bot")}.click()`);
    const field = 'dialog[aria-label="Rename bot"] input';
    await page.until(`!!document.querySelector(${JSON.stringify(field)})`);
    // Its own name, as it opens, is fine.
    expect(await errorOf(page, field)).toEqual(NO_ERROR);
    const from = await sentSoFar(page);
    await type(page, field, "MANAGER");
    expect(await errorOf(page, field)).toEqual({ text: "You already have a bot named MANAGER", invalid: true, described: true, seen: true, wide: false });
    await press(page, "Enter");
    expect(await page.eval<boolean>(`!!document.querySelector(${JSON.stringify(field)})`)).toBe(true);
    expect(await writes(page, from)).toEqual([]);
    await type(page, field, "Atlas");
    expect(await errorOf(page, field)).toEqual(NO_ERROR);
    await press(page, "Enter");
    await page.until(`(window.sent ?? []).slice(${from}).some((s) => s.method === "PATCH")`);
    expect((await writes(page, from)).map((w) => [w.method, w.path, w.body.name])).toEqual([["PATCH", "/api/bots/tracer", "Atlas"]]);
  }, 60_000);

  test("the details panel's name stays open with the line under it until the name is free", async () => {
    const page = await open();
    await page.eval(`bots.getState().setDetailsOpen(true)`);
    await page.until("!!document.querySelector('button.bots-details-name')");
    await page.eval("document.querySelector('button.bots-details-name').click()");
    await page.until("!!document.querySelector('.bots-details-name-input')");
    const from = await sentSoFar(page);
    await type(page, ".bots-details-name-input", "manager");
    expect(await errorOf(page, ".bots-details-name-input")).toEqual({ text: "You already have a bot named manager", invalid: true, described: true, seen: true, wide: false });
    await press(page, "Enter");
    expect(await page.eval<boolean>("!!document.querySelector('.bots-details-name-input')")).toBe(true);
    expect(await writes(page, from)).toEqual([]);
    // Escape leaves it as it was.
    await press(page, "Escape");
    expect(await page.eval<string>("document.querySelector('button.bots-details-name').textContent")).toBe("tracer");
    expect(await writes(page, from)).toEqual([]);
  }, 60_000);

  test("the bot's Settings page keeps the name typed, with the line, and saves a free one", async () => {
    const page = await open();
    await page.eval(`store.getState().openSettings("bots"); store.setState({ settingsPage: "bot/tracer" })`);
    await page.until("!!document.querySelector('#bot-name')");
    const from = await sentSoFar(page);
    await type(page, "#bot-name", "Manager");
    await page.eval("document.querySelector('#bot-name').blur()");
    await page.settle();
    expect(await errorOf(page, "#bot-name")).toEqual({ text: "You already have a bot named Manager", invalid: true, described: true, seen: true, wide: false });
    expect(await page.eval<string>("document.querySelector('#bot-name').value")).toBe("Manager");
    expect(await writes(page, from)).toEqual([]);
    await type(page, "#bot-name", "Atlas");
    expect(await errorOf(page, "#bot-name")).toEqual(NO_ERROR);
    await press(page, "Enter");
    await page.until(`(window.sent ?? []).slice(${from}).some((s) => s.method === "PATCH")`);
    expect((await writes(page, from)).map((w) => [w.method, w.path, w.body.name])).toEqual([["PATCH", "/api/bots/tracer", "Atlas"]]);
  }, 60_000);

  test("two bots called the same from before both show, keep their name, and either renames", async () => {
    const page = await open();
    // As the server sends them: a second "manager", made before the check.
    await page.eval(`bots.setState((s) => ({
      bots: [...s.bots, { ...s.bots.find((b) => b.id === "manager"), id: "twin", primary: undefined }],
      conversations: [...s.conversations, { id: "dm-twin", kind: "direct", botIds: ["twin"], createdAt: 1, updatedAt: 1, messages: [] }],
    }))`);
    await page.eval(`store.getState().openSettings("bots"); store.setState({ settingsPage: "bot/twin" })`);
    await page.until("!!document.querySelector('#bot-name')");
    expect(await page.eval<string>("document.querySelector('#bot-name').value")).toBe("manager");
    // Its own name is no clash, so leaving the field says nothing and sends nothing.
    const from = await sentSoFar(page);
    await page.eval("document.querySelector('#bot-name').focus(); document.querySelector('#bot-name').blur()");
    await page.settle();
    expect(await errorOf(page, "#bot-name")).toEqual(NO_ERROR);
    expect(await writes(page, from)).toEqual([]);
    await type(page, "#bot-name", "Twin");
    await press(page, "Enter");
    await page.until(`(window.sent ?? []).slice(${from}).some((s) => s.method === "PATCH")`);
    expect((await writes(page, from)).map((w) => [w.method, w.path, w.body.name])).toEqual([["PATCH", "/api/bots/twin", "Twin"]]);
  }, 60_000);
});
