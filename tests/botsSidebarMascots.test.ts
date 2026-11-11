// The bots in OpenBots' sidebar, pointed at in a real Chrome. A bot's own chat, pinned (a tile) or
// not (a row), only follows the pointer with its eyes while it's on the row, aiming at it from far
// over: no hop or happy face on the way in, no spin when pressed. A group's huddle doesn't react to
// the pointer at all, and keeps fidgeting only for the member at work.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { aimAt, TRACK_REACH } from "../src/components/bots/BotAvatar";
import { SHAPES } from "../src/lib/bots/looks";
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

const open = async () => {
  const page = await Page.open(chrome!.ws, server!.url.href, 1100, 800, "document.querySelectorAll('.bots-row, .bots-tile').length >= 5");
  await page.settle();
  return page;
};

/** The sidebar item (tile or row button) showing a chat, by its avatar's label or its title. */
const item = (kind: "tile" | "row", title: string) =>
  kind === "tile"
    ? `[...document.querySelectorAll('.bots-tile')].find((t) => t.querySelector('.bots-tile-name')?.textContent === ${JSON.stringify(title)})`
    : `[...document.querySelectorAll('.bots-row-main')].find((r) => r.querySelector('.bots-row-title')?.textContent === ${JSON.stringify(title)})`;

/** Each bot in an item: where it looks (the --track-* it follows), and what it's doing. */
const mascots = (page: Page, find: string) =>
  page.eval<{ x: number | null; y: number | null; tracking: boolean; action: string | null; mood: string | null; busy: boolean }[]>(`[...(${find}).querySelectorAll('.bot')].map((b) => ({
    x: b.style.getPropertyValue('--track-x') === '' ? null : Number(b.style.getPropertyValue('--track-x')),
    y: b.style.getPropertyValue('--track-y') === '' ? null : Number(b.style.getPropertyValue('--track-y')),
    tracking: 'tracking' in b.dataset, action: b.dataset.action ?? null, mood: b.dataset.mood ?? null, busy: 'busy' in b.dataset,
  }))`);

/** Waits until the item's first bot's eyes satisfy `holds` (given x, y and tracking), as they spring there. */
const until = (page: Page, find: string, holds: string) =>
  page.until(`(() => { const b = (${find}).querySelector('.bot'); const v = (n) => b.style.getPropertyValue(n) === '' ? null : Number(b.style.getPropertyValue(n));
    const x = v('--track-x'), y = v('--track-y'), tracking = 'tracking' in b.dataset; return ${holds}; })()`);

/** Moves the real pointer to (dx, dy) from the item's avatar's centre, in steps, as a hand does. "far"
 *  is as far right as the item goes, still on it. */
async function pointAt(page: Page, find: string, dx: number | "far", dy: number) {
  const [cx, cy, edge] = await page.eval<[number, number, number]>(`(() => { const item = ${find}; const r = item.querySelector('.bot').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, item.getBoundingClientRect().right - 3]; })()`);
  const x = dx === "far" ? edge - cx : dx;
  for (let i = 1; i <= 4; i++) await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx + (x * i) / 4, y: cy + (dy * i) / 4 });
  await page.settle();
}

const away = (page: Page) => page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1090, y: 790 });

describe.skipIf(!browser)("bots in OpenBots' sidebar", () => {
  for (const [kind, title] of [["tile", "Pip"], ["row", "Manager"]] as const) {
    test(`a bot's ${kind === "tile" ? "pinned tile" : "row"} follows the pointer with its eyes, and only that`, async () => {
      const page = await open();
      const find = item(kind, title);
      expect((await mascots(page, find))[0]).toMatchObject({ x: null, tracking: false });

      // Off to the right of the avatar, a little below: the eyes go right and a little down, well over.
      await pointAt(page, find, "far", 12);
      await until(page, find, `tracking && x > ${TRACK_REACH * 0.95}`);
      const right = (await mascots(page, find))[0]!;
      expect(right.x!).toBeLessThan(TRACK_REACH * 1.06);
      expect(right.y!).toBeGreaterThan(0);
      expect(right.y!).toBeLessThan(right.x! / 3);
      // No hop and no smile on the way in.
      expect(right.action).toBeNull();
      expect(right.mood).toBe("idle");

      // Up and to the left, close in: the eyes follow there, by less.
      await pointAt(page, find, -8, -10);
      await until(page, find, "x < 0 && y < 0");
      await Bun.sleep(400);
      const near = (await mascots(page, find))[0]!;
      expect(near.x!).toBeLessThan(0);
      expect(near.y!).toBeLessThan(0);
      expect(Math.hypot(near.x!, near.y!)).toBeLessThan(Math.hypot(right.x!, right.y!));

      // Pressing doesn't spin it.
      await pointAt(page, find, 20, 0);
      const [x, y] = await page.eval<[number, number]>(`(() => { const r = (${find}).querySelector('.bot').getBoundingClientRect(); return [r.x + r.width / 2 + 20, r.y + r.height / 2]; })()`);
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await Bun.sleep(60);
      expect((await mascots(page, find))[0]!.action).toBeNull();
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });

      // Off the item: it stops following and eases back to looking ahead.
      await away(page);
      await until(page, find, "x === null");
      expect((await mascots(page, find))[0]).toMatchObject({ x: null, y: null, tracking: false, action: null });
    });
  }

  for (const [kind, title] of [["tile", "Crew pinned-group"], ["row", "Crew row-group"]] as const) {
    test(`a group's ${kind === "tile" ? "pinned tile" : "row"} doesn't react to the pointer`, async () => {
      const page = await open();
      const find = item(kind, title);
      await pointAt(page, find, "far", 10);
      const [x, y] = await page.eval<[number, number]>(`(() => { const r = (${find}).querySelector('.bot').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await Bun.sleep(60);
      for (const m of await mascots(page, find)) expect(m).toMatchObject({ x: null, y: null, tracking: false, action: null, mood: "idle" });
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    });
  }

  test("a group keeps fidgeting only for the member at work, pointer or not", async () => {
    const page = await open();
    const find = item("row", "Crew busy-group");
    const before = await mascots(page, find);
    expect(before.map((m) => m.busy)).toEqual([false, true]);
    await pointAt(page, find, "far", 0);
    const during = await mascots(page, find);
    expect(during.map((m) => m.busy)).toEqual([false, true]);
    for (const m of during) expect(m.tracking).toBe(false);
  });

  test("however far over they look, every shape keeps its eyes on its body", async () => {
    const page = await open();
    // Each shape's body, and both eyes (as drawn at their default size) at full reach every which way.
    const misses = await page.eval<string[]>(`(() => {
      const shapes = ${JSON.stringify(SHAPES.map((s) => ({ id: s.id, path: s.path, face: s.face })))};
      const aims = ${JSON.stringify(Object.fromEntries(SHAPES.map((s) => [s.id, Array.from({ length: 16 }, (_, a) => aimAt(Math.cos((a / 8) * Math.PI) * 1000, Math.sin((a / 8) * Math.PI) * 1000, 28, s.face.reach))])))};
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 100 100');
      document.body.append(svg);
      const misses = [];
      for (const { id, path, face } of shapes) {
        const body = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        body.setAttribute('d', path);
        svg.append(body);
        const s = (face.scale ?? 1) * 1.12, gap = face.gap * 1.1, ew = 7.5 * s, eh = 16 * s;
        for (let a = 0; a < 16; a++) {
          const [lx, ly] = aims[id][a];
          for (const side of [-1, 1]) {
            const cx = face.x + (side * gap) / 2 + lx, cy = face.y + ly;
            // The eye's outline: the ends of its rounded caps and the sides at their middle.
            for (const [px, py] of [[cx, cy - eh / 2], [cx, cy + eh / 2], [cx - ew / 2, cy], [cx + ew / 2, cy]])
              if (!body.isPointInFill(new DOMPoint(px, py))) misses.push(id + ' ' + a);
          }
        }
        body.remove();
      }
      svg.remove();
      return [...new Set(misses)];
    })()`);
    expect(misses).toEqual([]);
  });

  test("with reduced motion, nothing follows the pointer", async () => {
    const page = await open();
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    // The old page is still there for a moment after reload() returns: mark it, to wait for the new one.
    await page.eval("window.beforeReload = true; location.reload()");
    await page.until("!window.beforeReload && document.querySelectorAll('.bots-row, .bots-tile').length >= 5");
    await page.settle();
    const find = item("row", "Manager");
    await pointAt(page, find, "far", 12);
    expect((await mascots(page, find))[0]).toMatchObject({ x: null, tracking: false, action: null });
  });
});
