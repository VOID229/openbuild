// Dragging bots and groups around the real OpenBots sidebar in Chrome, with a real mouse: above and
// below rows (a line shows where), a pinned bot onto another to swap them, a bot onto a group (asked,
// or as Settings → Bots says), Escape to call it off, and Alt+arrows from the keyboard. A click is
// still a click, and the press that ends a drag doesn't open what was dragged.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botsSidebar/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const open = async (setup = "") => {
  const page = await Page.open(chrome!.ws, server!.url.href, 1000, 720, "document.querySelectorAll('.bots-row, .bots-tile').length >= 5");
  if (setup) await page.eval(setup);
  await page.settle();
  return page;
};

const at = (page: Page, id: string, fx = 0.5, fy = 0.5) =>
  page.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-drag-id="${id}"]').getBoundingClientRect(); return { x: r.x + r.width * ${fx}, y: r.y + r.height * ${fy} }; })()`);

const mouse = (page: Page, type: string, { x, y }: { x: number; y: number }, buttons: number) =>
  page.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });

/** Presses on `from`, moves to `to` in steps, and lets go there unless `hold`. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, hold = false) {
  await mouse(page, "mouseMoved", from, 0);
  await mouse(page, "mousePressed", from, 1);
  for (let i = 1; i <= 10; i++) await mouse(page, "mouseMoved", { x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10 }, 1);
  if (!hold) await mouse(page, "mouseReleased", to, 0);
  await page.settle();
}

const rows = (page: Page) => page.eval<string[]>(`[...document.querySelectorAll('.bots-rows > .bots-row')].map((r) => r.dataset.dragId)`);
const tiles = (page: Page) => page.eval<string[]>(`[...document.querySelectorAll('.bots-tiles > .bots-tile')].map((r) => r.dataset.dragId)`);
const drops = (page: Page) => page.eval<string[]>(`[...document.querySelectorAll('[data-drop]')].map((el) => (el.dataset.dragId ?? el.dataset.dropList) + ':' + el.dataset.drop)`);

describe.skipIf(!browser)("dragging in the OpenBots sidebar", () => {
  test("a row dragged below another goes there, with a line where it lands, and isn't opened", async () => {
    const page = await open();
    expect(await rows(page)).toEqual(["row-bot", "row-group", "busy-group"]);
    await drag(page, await at(page, "row-group"), await at(page, "busy-group", 0.5, 0.8), true);
    // Mid-drag: the picked-up row fades, the ghost follows, a line under the target.
    expect(await drops(page)).toEqual(["busy-group:after"]);
    expect(await page.eval<boolean>(`document.querySelector('[data-drag-id="row-group"]').hasAttribute('data-dragging')`)).toBe(true);
    expect(await page.eval<string>(`document.querySelector('.bots-drag-ghost')?.textContent ?? ''`)).toBe("Crew row-group");
    const line = await page.eval<{ content: string; height: string }>(`(() => { const s = getComputedStyle(document.querySelector('[data-drag-id="busy-group"]'), '::after'); return { content: s.content, height: s.height }; })()`);
    expect(line).toEqual({ content: '""', height: "2px" });
    await mouse(page, "mouseReleased", await at(page, "busy-group", 0.5, 0.8), 0);
    await page.settle();
    expect(await rows(page)).toEqual(["row-bot", "busy-group", "row-group"]);
    expect(await page.eval<string[]>(`bots.getState().order`)).toEqual(["row-bot", "busy-group", "row-group"]);
    // Nothing left marked, no ghost, and the chat that was open is still the one open.
    expect(await drops(page)).toEqual([]);
    expect(await page.eval<number>(`document.querySelectorAll('.bots-drag-ghost, [data-dragging]').length`)).toBe(0);
    expect(await page.eval<string>(`bots.getState().activeId`)).toBe("row-bot");
  });

  test("a click without a drag still opens the chat", async () => {
    const page = await open();
    await page.click('[data-drag-id="row-group"] .bots-row-main');
    expect(await page.eval<string>(`bots.getState().activeId`)).toBe("row-group");
    await page.click('[data-drag-id="pinned-group"]');
    expect(await page.eval<string>(`bots.getState().activeId`)).toBe("pinned-group");
  });

  test("a pinned bot dropped straight onto another pinned bot swaps them", async () => {
    // Manager's chat pinned third: [pip, crew, manager].
    const page = await open(`bots.setState({ conversations: bots.getState().conversations.map((c) => c.id === 'row-bot' ? { ...c, pinnedAt: 3 } : c) })`);
    expect(await tiles(page)).toEqual(["pinned-bot", "pinned-group", "row-bot"]);
    await drag(page, await at(page, "pinned-bot"), await at(page, "row-bot"), true);
    expect(await drops(page)).toEqual(["row-bot:onto"]);
    await mouse(page, "mouseReleased", await at(page, "row-bot"), 0);
    await page.settle();
    expect(await tiles(page)).toEqual(["row-bot", "pinned-group", "pinned-bot"]);
    expect(await page.eval<number>(`document.querySelectorAll('.bots-drop-menu').length`)).toBe(0);
  });

  test("dropped beside a tile, a row is pinned there", async () => {
    const page = await open();
    await drag(page, await at(page, "busy-group"), await at(page, "pinned-bot", 0.85, 0.5));
    expect(await tiles(page)).toEqual(["pinned-bot", "busy-group", "pinned-group"]);
    expect(await rows(page)).toEqual(["row-bot", "row-group"]);
  });

  test("a bot dropped onto a group asks: swap places, remembered", async () => {
    const page = await open();
    // Pip's tile onto the pinned crew it isn't in.
    await drag(page, await at(page, "pinned-bot"), await at(page, "pinned-group"));
    await page.until(`document.querySelector('.bots-drop-menu')?.dataset.state === 'open'`);
    const items = await page.eval<string[]>(`[...document.querySelectorAll('.bots-drop-menu .menu-item')].map((b) => b.textContent.trim())`);
    expect(items).toEqual(["Add Pip to Crew pinned-group", "Swap places"]);
    await page.click(".bots-drop-remember input");
    await page.click(".bots-drop-menu .menu-item:nth-of-type(2)");
    // The group now on the left, the bot on the right; Pip isn't added.
    expect(await tiles(page)).toEqual(["pinned-group", "pinned-bot"]);
    expect(await page.eval<string[]>(`bots.getState().conversations.find((c) => c.id === 'pinned-group').botIds`)).toEqual(["manager", "tracer"]);
    expect(await page.eval<string>(`store.getState().settings.botGroupDrop`)).toBe("swap");
    // Remembered: the next drop on a group swaps without asking.
    await drag(page, await at(page, "pinned-bot"), await at(page, "pinned-group"));
    expect(await page.eval<number>(`document.querySelectorAll('.bots-drop-menu').length`)).toBe(0);
    expect(await tiles(page)).toEqual(["pinned-bot", "pinned-group"]);
  });

  test("a bot dropped onto a group's row asks, and adding it adds it there without moving anything", async () => {
    const page = await open();
    await drag(page, await at(page, "row-bot"), await at(page, "busy-group", 0.5, 0.5), true);
    // A row's middle is "onto" only for a group the bot can join; its edges are still above and below.
    expect(await drops(page)).toEqual(["busy-group:onto"]);
    await mouse(page, "mouseReleased", await at(page, "busy-group"), 0);
    await page.until(`document.querySelector('.bots-drop-menu')?.dataset.state === 'open'`);
    await page.click(".bots-drop-menu .menu-item:nth-of-type(1)");
    expect(await page.eval<string[]>(`bots.getState().conversations.find((c) => c.id === 'busy-group').botIds`)).toEqual(["pip", "scout", "manager"]);
    expect(await rows(page)).toEqual(["row-bot", "row-group", "busy-group"]);
    // Not remembered: it asks again.
    expect(await page.eval<unknown>(`store.getState().settings.botGroupDrop`)).toBeUndefined();
    await drag(page, await at(page, "row-bot"), await at(page, "row-group"));
    await page.until(`document.querySelector('.bots-drop-menu')?.dataset.state === 'open'`);
    // Escape closes it, and nothing changes.
    await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page.until(`!document.querySelector('.bots-drop-menu')`);
    expect(await page.eval<string[]>(`bots.getState().conversations.find((c) => c.id === 'row-group').botIds`)).toEqual(["tracer", "scout"]);
  });

  test("set to add in Settings, a bot dropped on a group joins it without asking", async () => {
    const page = await open(`store.getState().updateSettings({ botGroupDrop: 'add' })`);
    await drag(page, await at(page, "row-bot"), await at(page, "row-group"));
    expect(await page.eval<number>(`document.querySelectorAll('.bots-drop-menu').length`)).toBe(0);
    expect(await page.eval<string[]>(`bots.getState().conversations.find((c) => c.id === 'row-group').botIds`)).toEqual(["tracer", "scout", "manager"]);
  });

  test("Escape mid-drag calls it off", async () => {
    const page = await open();
    await drag(page, await at(page, "row-bot"), await at(page, "busy-group", 0.5, 0.9), true);
    expect(await drops(page)).toEqual(["busy-group:after"]);
    await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await mouse(page, "mouseReleased", await at(page, "busy-group", 0.5, 0.9), 0);
    await page.settle();
    expect(await drops(page)).toEqual([]);
    expect(await rows(page)).toEqual(["row-bot", "row-group", "busy-group"]);
    expect(await page.eval<number>(`document.querySelectorAll('.bots-drag-ghost').length`)).toBe(0);
  });

  test("Alt+arrows move the focused chat along its list, and it keeps focus", async () => {
    const page = await open();
    await page.eval(`document.querySelector('[data-drag-id="row-bot"] .bots-row-main').focus()`);
    for (const type of ["rawKeyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, modifiers: 1 });
    await page.settle();
    expect(await rows(page)).toEqual(["row-group", "row-bot", "busy-group"]);
    expect(await page.eval<string | undefined>(`document.activeElement.closest('[data-drag-id]')?.dataset.dragId`)).toBe("row-bot");
    // A tile goes left and right.
    await page.eval(`document.querySelector('[data-drag-id="pinned-group"]').focus()`);
    for (const type of ["rawKeyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, modifiers: 1 });
    await page.settle();
    expect(await tiles(page)).toEqual(["pinned-group", "pinned-bot"]);
  });

  test("the chat's menu moves it too, and adds a bot to a group", async () => {
    const page = await open();
    const { x, y } = await at(page, "busy-group");
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", clickCount: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", clickCount: 1 });
    await page.until(`document.querySelector('.bots-menu')?.dataset.state === 'open'`);
    const labels = await page.eval<string[]>(`[...document.querySelectorAll('.bots-menu > .menu-item .menu-item-label')].map((l) => l.textContent)`);
    // Last in its list: up, not down. A group isn't added to a group.
    expect(labels).toContain("Move up");
    expect(labels).not.toContain("Move down");
    expect(await page.eval<number>(`[...document.querySelectorAll('.bots-menu .menu-item-label')].filter((l) => l.textContent === 'Add to group').length`)).toBe(0);
    await page.eval(`[...document.querySelectorAll('.bots-menu > .menu-item')].find((b) => b.textContent.includes('Move up')).click()`);
    await page.settle();
    expect(await rows(page)).toEqual(["row-bot", "busy-group", "row-group"]);
  });
});
