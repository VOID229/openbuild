// Chats between bots (side chats) in the OpenBots sidebar, in a real Chrome. Closed to the rail, the
// sidebar still lists them, last and apart from the user's own bots and groups as in the open list;
// each shows its two bots side by side with a speech bubble between them, so it reads as a DM between
// those bots and never as a group. Clicking one opens it, and hovering it says who it's between. The
// open list draws them the same way.
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

/** Each rail item, top to bottom: its name, whether it has the DM mark, sits its bots side by side, and is in the "Between bots" group. */
const railItems = (page: Page) =>
  page.eval<Item[]>(`[...document.querySelectorAll('.bots-rail-list .bots-rail-item')].map((b) => ({
    label: b.getAttribute('aria-label'),
    mark: !!b.querySelector('.bots-dm-mark'),
    pair: !!b.querySelector('.bot-huddle[data-pair]'),
    between: !!b.closest('[role=group][aria-label="Between bots"]'),
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
      { label: "Pip & Manager, between Pip and Manager", mark: true, pair: true, between: true },
      { label: "Which hotel fits the budget?, between Tracer and Scout", mark: true, pair: true, between: true },
    ]);
    // Set apart from the rest by a rule, as the list sets them apart in a section of their own.
    expect(await page.eval<boolean>(`document.querySelector('.bots-rail-list [role=group]').previousElementSibling.classList.contains('bots-rail-sep')`)).toBe(true);
    // An unread one keeps its dot.
    expect(await page.eval<boolean>(`!!document.querySelector('.bots-rail-item[aria-label^="Pip & Manager"] .bots-rail-dot')`)).toBe(true);
  }, 30_000);

  test("the two bots sit side by side with the bubble under where they meet, not on a group's diagonal", async () => {
    const page = await open("rail");
    const geometry = await page.eval<{ dy: number; dx: number; mark: number; middle: number; below: boolean }>(`(() => {
      const item = document.querySelector('.bots-rail-item[aria-label^="Pip & Manager"]');
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
    await page.click(`.bots-rail-item[aria-label^="Which hotel"]`);
    expect(await page.eval<string>(`bots.getState().activeId`)).toBe("side-topic");
    expect(await page.eval<string | null>(`document.querySelector('.bots-rail-item-active')?.getAttribute('aria-label') ?? null`)).toBe("Which hotel fits the budget?, between Tracer and Scout");
  }, 30_000);

  test("hovering one in the rail says who it's between", async () => {
    const page = await open("rail");
    const [x, y] = await page.eval<[number, number]>(`(() => { const r = document.querySelector('.bots-rail-item[aria-label^="Which hotel"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await page.until(`document.querySelector('.bots-peek')?.dataset.state === 'open'`);
    expect(await page.eval<{ name: string; between: string | null; mark: boolean }>(`(() => {
      const p = document.querySelector('.bots-peek');
      return { name: p.querySelector('.bots-peek-name').textContent, between: p.querySelector('.bots-peek-between')?.textContent ?? null, mark: !!p.querySelector('.bots-peek-between .bots-dm-mark') };
    })()`)).toEqual({ name: "Which hotel fits the budget?", between: "Between Tracer and Scout", mark: true });

    // A group's card says nothing of the kind.
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 800 });
    await page.until(`!document.querySelector('.bots-peek')`);
    const [gx, gy] = await page.eval<[number, number]>(`(() => { const r = document.querySelector('.bots-rail-item[aria-label="Crew row-group"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: gx, y: gy });
    await page.until(`document.querySelector('.bots-peek')?.dataset.state === 'open'`);
    expect(await page.eval<boolean>(`!!document.querySelector('.bots-peek-between')`)).toBe(false);
  }, 30_000);

  test("the open list draws them the same way, under Between bots (and a hidden one under Hidden)", async () => {
    const page = await open("open");
    const rows = await page.eval<{ name: string; mark: boolean; pair: boolean; section: string | null }[]>(`[...document.querySelectorAll('.bots-row')].map((r) => ({
      name: r.querySelector('.bots-row-title').textContent,
      mark: !!r.querySelector('.bots-dm-mark'),
      pair: !!r.querySelector('.bot-huddle[data-pair]'),
      section: r.closest('.bots-section')?.querySelector('.history-heading')?.firstChild?.textContent ?? null,
    }))`);
    expect(rows.filter((r) => r.mark)).toEqual([
      { name: "Pip & Manager", mark: true, pair: true, section: "Between bots" },
      { name: "Which hotel fits the budget?", mark: true, pair: true, section: "Between bots" },
      { name: "Pip & Scout", mark: true, pair: true, section: "Hidden" },
    ]);
    expect(rows.filter((r) => !r.mark).every((r) => !r.pair && r.section !== "Between bots")).toBe(true);
  }, 30_000);

  test("a pinned side chat keeps its mark among the pinned", async () => {
    const page = await open("rail");
    await page.eval(`bots.setState({ conversations: bots.getState().conversations.map((c) => c.id === "side-topic" ? { ...c, pinnedAt: 3 } : c) })`);
    await page.settle();
    const items = await railItems(page);
    expect(items[2]).toEqual({ label: "Which hotel fits the budget?, between Tracer and Scout", mark: true, pair: true, between: false });
    expect(items.filter((i) => i.between).map((i) => i.label)).toEqual(["Pip & Manager, between Pip and Manager"]);
  }, 30_000);
});
