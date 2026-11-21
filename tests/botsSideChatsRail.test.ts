// Chats between bots (side chats) in the OpenBots sidebar, in a real Chrome. Closed to the rail, the
// sidebar still lists them, last and apart from the user's own bots and groups as in the open list;
// each shows its two bots side by side with a speech bubble between them, so it reads as a DM between
// those bots and never as a group. Each goes by who's in it ("Pip and Manager DM", a meeting with three
// bots or more), with its topic in the hover card. Clicking one opens it. The open list draws them the
// same way. One that has closed leaves the list, the search and the rail, and the rail leaves out
// whatever a section folded shut in the list holds.
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

/** The fixture's sidebar plus two side chats (one named for its topic, one unread) and a hidden one, open or closed to the rail. */
const open = async (sidebar: "open" | "rail") => {
  const page = await Page.open(chrome!.ws, server!.url.href, 1000, 900, "document.querySelectorAll('.bots-row, .bots-tile').length >= 5");
  await page.eval(`(() => {
    const at = Date.now() - 30_000;
    const side = (id, botIds, extra) => ({ id, kind: "side", botIds, createdAt: at, updatedAt: at, messages: [{ id: id + "-m", author: botIds[1], at, text: "Total, flights included." }], ...extra });
    bots.setState({ conversations: [
      ...bots.getState().conversations,
      side("side-pair", ["pip", "manager"], { unread: true, updatedAt: at + 2 }),
      side("side-topic", ["tracer", "scout"], { name: "Which hotel fits the budget?", updatedAt: at + 1 }),
      side("side-hidden", ["pip", "scout"], { hidden: true }),
    ] });
    ${sidebar === "rail" ? "store.setState({ botsSidebarOpen: false });" : ""}
  })()`);
  // Closing, the list stays over the rail while the sidebar narrows: wait until it's gone.
  await page.until(sidebar === "rail" ? "document.querySelectorAll('.bots-rail-item').length >= 7 && !document.querySelector('.bots-sidebar-closing')" : "document.querySelectorAll('.bots-row').length >= 5");
  await page.settle();
  return page;
};

type Item = { label: string; mark: boolean; pair: boolean; between: boolean };

/** Each rail item, top to bottom: its name, whether it has the DM mark, sits its bots side by side, and is in the "DMs" group. */
const railItems = (page: Page) =>
  page.eval<Item[]>(`[...document.querySelectorAll('.bots-rail-list .bots-rail-item')].map((b) => ({
    label: b.getAttribute('aria-label'),
    mark: !!b.querySelector('.bots-dm-mark'),
    pair: !!b.querySelector('.bot-huddle[data-pair]'),
    between: !!b.closest('[role=group][aria-label="DMs"]'),
  }))`);

describe.skipIf(!browser)("chats between bots in the OpenBots sidebar", () => {
  test("closed to the rail, the sidebar still lists them, last, each marked as a DM between two bots", async () => {
    const page = await open("rail");
    const items = await railItems(page);
    // The user's own bots and groups first, as before…
    expect(items.slice(0, 5).map((i) => i.label)).toEqual(["Pip", "Crew pinned-group", "Manager", "Crew row-group", "Crew busy-group"]);
    expect(items.slice(0, 5).some((i) => i.mark || i.pair || i.between)).toBe(false);
    // …then the side chats, newest first, each saying who it's between. A hidden one stays out of it.
    expect(items.slice(5)).toEqual([
      { label: "Pip and Manager DM", mark: true, pair: true, between: true },
      { label: "Tracer and Scout DM", mark: true, pair: true, between: true },
    ]);
    // Set apart from the rest by a rule, as the list sets them apart in a section of their own.
    expect(await page.eval<boolean>(`document.querySelector('.bots-rail-list [role=group]').previousElementSibling.classList.contains('bots-rail-sep')`)).toBe(true);
    // An unread one keeps its dot.
    expect(await page.eval<boolean>(`!!document.querySelector('.bots-rail-item[aria-label^="Pip and Manager"] .bots-rail-dot')`)).toBe(true);
  }, 30_000);

  test("the two bots sit side by side with the bubble under where they meet, not on a group's diagonal", async () => {
    const page = await open("rail");
    const geometry = await page.eval<{ dy: number; dx: number; mark: number; middle: number; below: boolean }>(`(() => {
      const item = document.querySelector('.bots-rail-item[aria-label^="Pip and Manager"]');
      const [a, b] = [...item.querySelectorAll('.bot-huddle-spot')].map((s) => s.getBoundingClientRect());
      const mark = item.querySelector('.bots-dm-mark').getBoundingClientRect();
      const box = item.querySelector('.bot-huddle-box').getBoundingClientRect();
      return { dy: Math.abs(a.y - b.y), dx: b.x - a.x, mark: mark.x + mark.width / 2, middle: box.x + box.width / 2, below: mark.y + mark.height / 2 > a.y + a.height / 2 };
    })()`);
    expect(geometry.dy).toBeLessThan(1);
    expect(geometry.dx).toBeGreaterThan(15);
    expect(Math.abs(geometry.mark - geometry.middle)).toBeLessThan(1);
    expect(geometry.below).toBe(true);
    // A group of two still huddles on the diagonal, unmarked.
    expect(await page.eval<number>(`(() => {
      const [a, b] = [...document.querySelector('.bots-rail-item[aria-label="Crew row-group"]').querySelectorAll('.bot-huddle-spot')].map((s) => s.getBoundingClientRect());
      return Math.abs(a.y - b.y);
    })()`)).toBeGreaterThan(5);
  }, 30_000);

  test("clicking one in the rail opens it", async () => {
    const page = await open("rail");
    await page.click(`.bots-rail-item[aria-label^="Tracer and Scout"]`);
    expect(await page.eval<string>(`bots.getState().activeId`)).toBe("side-topic");
    expect(await page.eval<string | null>(`document.querySelector('.bots-rail-item-active')?.getAttribute('aria-label') ?? null`)).toBe("Tracer and Scout DM");
  }, 30_000);

  test("hovering one in the rail names who's in it, and shows its topic under the name", async () => {
    const page = await open("rail");
    const [x, y] = await page.eval<[number, number]>(`(() => { const r = document.querySelector('.bots-rail-item[aria-label^="Tracer and Scout"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await page.until(`document.querySelector('.bots-peek')?.dataset.state === 'open'`);
    expect(await page.eval<{ name: string; between: string | null; mark: boolean }>(`(() => {
      const p = document.querySelector('.bots-peek');
      return { name: p.querySelector('.bots-peek-name').textContent, between: p.querySelector('.bots-peek-between')?.textContent ?? null, mark: !!p.querySelector('.bots-peek-between .bots-dm-mark') };
    })()`)).toEqual({ name: "Tracer and Scout DM", between: "Which hotel fits the budget?", mark: true });

    // A group's card says nothing of the kind.
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 800 });
    await page.until(`!document.querySelector('.bots-peek')`);
    const [gx, gy] = await page.eval<[number, number]>(`(() => { const r = document.querySelector('.bots-rail-item[aria-label="Crew row-group"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: gx, y: gy });
    await page.until(`document.querySelector('.bots-peek')?.dataset.state === 'open'`);
    expect(await page.eval<boolean>(`!!document.querySelector('.bots-peek-between')`)).toBe(false);
  }, 30_000);

  test("the open list draws them the same way, under DMs (and a hidden one under Hidden)", async () => {
    const page = await open("open");
    const rows = await page.eval<{ name: string; mark: boolean; pair: boolean; section: string | null }[]>(`[...document.querySelectorAll('.bots-row')].map((r) => ({
      name: r.querySelector('.bots-row-title').textContent,
      mark: !!r.querySelector('.bots-dm-mark'),
      pair: !!r.querySelector('.bot-huddle[data-pair]'),
      section: r.closest('.bots-section')?.querySelector('.history-heading')?.firstChild?.textContent ?? null,
    }))`);
    expect(rows.filter((r) => r.mark)).toEqual([
      { name: "Pip and Manager DM", mark: true, pair: true, section: "DMs" },
      { name: "Tracer and Scout DM", mark: true, pair: true, section: "DMs" },
      { name: "Pip and Scout DM", mark: true, pair: true, section: "Hidden" },
    ]);
    expect(rows.filter((r) => !r.mark).every((r) => !r.pair && r.section !== "DMs")).toBe(true);
  }, 30_000);

  test("a pinned side chat keeps its mark among the pinned", async () => {
    const page = await open("rail");
    await page.eval(`bots.setState({ conversations: bots.getState().conversations.map((c) => c.id === "side-topic" ? { ...c, pinnedAt: 3 } : c) })`);
    await page.settle();
    const items = await railItems(page);
    expect(items[2]).toEqual({ label: "Tracer and Scout DM", mark: true, pair: true, between: false });
    expect(items.filter((i) => i.between).map((i) => i.label)).toEqual(["Pip and Manager DM"]);
  }, 30_000);

  test("a closed DM leaves the sidebar, list, search and rail, and three bots or more are a meeting", async () => {
    const page = await open("open");
    const heading = `[...document.querySelectorAll('.bots-section .history-heading')].find((h) => h.closest('.bots-section').querySelector('.bots-dm-mark') && !h.textContent.startsWith('Hidden'))`;
    await page.eval(`(() => {
      const at = Date.now() - 30_000;
      bots.setState((s) => ({ conversations: [
        ...s.conversations.map((c) => (c.id === "side-pair" ? { ...c, name: "Flight budget", huddle: { by: "pip", from: "row-bot", topic: "Flight budget", limit: 6, closedAt: at } } : c)),
        { id: "side-four", kind: "side", botIds: ["pip", "manager", "tracer", "scout"], name: "Release plan", createdAt: at, updatedAt: at + 3, messages: [{ id: "f-m", author: "pip", at, text: "Friday?" }] },
      ] }));
    })()`);
    await page.until(`[...document.querySelectorAll('.bots-row-title')].some((t) => t.textContent.endsWith('meeting'))`);
    const titles = () => page.eval<string[]>(`[...document.querySelectorAll('.bots-row-title')].map((t) => t.textContent)`);
    // The closed one is gone; the open DM and the meeting of four share a heading that names both.
    expect((await titles()).filter((t) => t.endsWith(" DM") || t.endsWith(" meeting"))).toEqual(["Pip, Manager and Tracer and 1 more meeting", "Tracer and Scout DM", "Pip and Scout DM"]);
    expect(await page.eval<string>(`${heading}.firstChild.textContent`)).toBe("DMs and meetings");
    // Not in the search either: its messages say the same as the others'.
    await page.eval(`document.querySelector('.bots-sidebar [aria-label="Search"]').click()`);
    await page.until("!!document.querySelector('.bots-sidebar .search input')");
    const search = (text: string) => page.eval(`(() => { const i = document.querySelector('.bots-sidebar .search input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await search("Total, flights");
    await page.until(`!!document.querySelector('.bots-list .history-heading')?.textContent.match(/result/i)`);
    expect(await titles()).toEqual(["Tracer and Scout DM", "Pip and Scout DM"]);
    // A meeting is found by its topic, which its name doesn't show; the closed DM's topic finds nothing.
    await search("release plan");
    await page.until(`[...document.querySelectorAll('.bots-row-title')].length === 1`);
    expect(await titles()).toEqual(["Pip, Manager and Tracer and 1 more meeting"]);
    await search("hotel fits");
    await page.until(`[...document.querySelectorAll('.bots-row-title')].map((t) => t.textContent).join() === "Tracer and Scout DM"`);
    await search("flight budget");
    await page.until(`!!document.querySelector('.bots-list .history-empty')`);
    expect(await titles()).toEqual([]);
    // And on the rail, under its group's name.
    await search("");
    await page.eval(`store.setState({ botsSidebarOpen: false })`);
    await page.until("!document.querySelector('.bots-sidebar-closing') && !!document.querySelector('.bots-rail-list [role=group]')");
    const items = await page.eval<{ label: string; group: string | null }[]>(`[...document.querySelectorAll('.bots-rail-list [role=group] .bots-rail-item')].map((b) => ({ label: b.getAttribute('aria-label'), group: b.closest('[role=group]').getAttribute('aria-label') }))`);
    expect(items).toEqual([
      { label: "Pip, Manager and Tracer and 1 more meeting", group: "DMs and meetings" },
      { label: "Tracer and Scout DM", group: "DMs and meetings" },
    ]);
  }, 30_000);

  test("the rail leaves out what a section folded shut in the list holds: the user's own and the DMs", async () => {
    const page = await open("rail");
    await page.eval(`bots.setState((s) => ({ sections: ["Work"], conversations: s.conversations.map((c) => (c.id === "row-group" ? { ...c, section: "Work" } : c)) }))`);
    const labels = () => page.eval<string[]>(`[...document.querySelectorAll('.bots-rail-list .bots-rail-item')].map((b) => b.getAttribute('aria-label'))`);
    const groups = () => page.eval<string[]>(`[...document.querySelectorAll('.bots-rail-list [role=group]')].map((g) => g.getAttribute('aria-label'))`);
    await page.settle();
    // All open: Work's group and the chats between bots are there.
    expect(await labels()).toContain("Crew row-group");
    expect(await groups()).toEqual(["DMs"]);
    // Folded in the list (the same state the list's headings toggle), each leaves the rail.
    await page.eval(`["Work", "side"].forEach((name) => bots.getState().toggleFolded(name))`);
    await page.until("!document.querySelector('.bots-rail-list [role=group]')");
    await page.settle();
    // The pinned tiles and the unfiled rows have no fold: they stay. No separator is left dangling at the end.
    expect(await labels()).toEqual(["Pip", "Crew pinned-group", "Manager", "Crew busy-group"]);
    expect(await page.eval<boolean>("document.querySelector('.bots-rail-list').lastElementChild?.classList.contains('bots-rail-sep') ?? false")).toBe(false);
    // Unfolded from the list's own headings, they come back.
    await page.eval("store.setState({ botsSidebarOpen: true })");
    await page.until("!!document.querySelector('.bots-list')");
    for (const name of ["Work", "DMs"]) {
      await page.eval(`[...document.querySelectorAll('.bots-section .history-heading-toggle')].find((b) => b.firstChild?.textContent === ${JSON.stringify(name)}).click()`);
    }
    await page.eval("store.setState({ botsSidebarOpen: false })");
    await page.until("!document.querySelector('.bots-sidebar-closing') && document.querySelectorAll('.bots-rail-list [role=group]').length === 1");
    expect(await labels()).toContain("Crew row-group");
    expect(await groups()).toEqual(["DMs"]);
  }, 30_000);
});
