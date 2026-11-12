// The bots in OpenBots' sidebar, pointed at in a real Chrome. A bot's own chat, pinned (a tile) or
// not (a row), only follows the pointer while it's on the row: its whole body turns toward it and
// leans into it, with no hop or happy face on the way in and no spin when pressed. A group's huddle
// doesn't react to the pointer at all, and keeps fidgeting only for the member at work.
// (That every shape keeps its eyes on its body while it does is tests/botAvatarLife.test.ts's.)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PITCH, YAW } from "../src/lib/bots/rig";
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

/**
 * In the page: how a bot stands, read off what its layers were given (null while it has nothing on
 * it). The head's turn is read from how far an eye has slid across the body (it stands 32 units off
 * it, drawn at 0.877 of its size).
 */
const STANCE = `((b) => {
  const of = (cls, re) => { const t = b.querySelector(cls).style.transform; return t === '' ? null : Number((re.exec(t) ?? [0, 0])[1]); };
  const slid = /matrix\\(([^)]+)\\)/.exec(b.querySelector('.bot-eye').style.transform)?.[1].split(',').map(Number);
  const unit = b.getBoundingClientRect().width / 100, turn = (px) => Math.asin(Math.max(-1, Math.min(1, px / unit / 28.06))) * 180 / Math.PI;
  return { yaw: slid ? turn(slid[4]) : null, pitch: slid ? turn(slid[5]) : null, bodyYaw: of('.bot-body', /rotateY\\((-?[\\d.]+)deg\\)/), lean: of('.bot-whole', /rotate\\((-?[\\d.]+)deg\\)/) };
})`;

/** Each bot in an item: how far its head is turned (right and down, in degrees), its body under it, how it leans, and what it's doing. */
const mascots = (page: Page, find: string) =>
  page.eval<{ yaw: number | null; pitch: number | null; bodyYaw: number | null; lean: number | null; tracking: boolean; action: string | null; mood: string | null; busy: boolean }[]>(`[...(${find}).querySelectorAll('.bot')].map((b) => ({
    ...${STANCE}(b), tracking: 'tracking' in b.dataset, action: b.dataset.action ?? null, mood: b.dataset.mood ?? null, busy: 'busy' in b.dataset,
  }))`);

/** Waits until the item's first bot satisfies `holds` (given yaw, pitch, bodyYaw, lean and tracking), as it springs there. */
const until = (page: Page, find: string, holds: string) =>
  page.until(`(() => { const b = (${find}).querySelector('.bot'); const { yaw, pitch, bodyYaw, lean } = ${STANCE}(b), tracking = 'tracking' in b.dataset; return ${holds}; })()`);

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
      expect((await mascots(page, find))[0]).toMatchObject({ yaw: null, lean: null, tracking: false });

      // Off to the right of the avatar, a little below: the head turns right over that way, and a little down.
      await pointAt(page, find, "far", 12);
      await until(page, find, `tracking && yaw > ${YAW * 0.65}`);
      const right = (await mascots(page, find))[0]!;
      // (Read off the nearer eye, which slides further than the head turns: the eyes sit well apart.)
      expect(right.yaw!).toBeLessThan(YAW * 1.65);
      expect(right.pitch!).toBeGreaterThan(0);
      expect(right.pitch!).toBeLessThan(right.yaw! / 3);
      // No hop and no smile on the way in.
      expect(right.action).toBeNull();
      expect(right.mood).toBe("idle");
      // The whole body turns under the head, by less and a beat behind, and leans toward the pointer.
      await until(page, find, `bodyYaw > ${YAW * 0.25} && lean > 8`);
      const turned = (await mascots(page, find))[0]!;
      expect(turned.bodyYaw!).toBeLessThan(turned.yaw!);

      // Up and to the left, close in: it turns there, and not all the way.
      await pointAt(page, find, -8, -10);
      await until(page, find, "yaw < 0 && pitch < 0 && lean < 0");
      await Bun.sleep(500);
      const near = (await mascots(page, find))[0]!;
      expect(near.yaw!).toBeLessThan(0);
      expect(near.pitch!).toBeLessThan(0);
      expect(Math.hypot(near.yaw! / YAW, near.pitch! / PITCH)).toBeLessThan(0.96);
      expect(near.bodyYaw!).toBeLessThan(0);
      expect(near.lean!).toBeLessThan(0);

      // Pressing doesn't spin it.
      await pointAt(page, find, 20, 0);
      const [x, y] = await page.eval<[number, number]>(`(() => { const r = (${find}).querySelector('.bot').getBoundingClientRect(); return [r.x + r.width / 2 + 20, r.y + r.height / 2]; })()`);
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await Bun.sleep(60);
      expect((await mascots(page, find))[0]!.action).toBeNull();
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });

      // Off the item: it stops following and eases back to looking ahead, with nothing left on it.
      await away(page);
      await until(page, find, "yaw === null && bodyYaw === null && lean === null");
      expect((await mascots(page, find))[0]).toMatchObject({ yaw: null, pitch: null, bodyYaw: null, lean: null, tracking: false, action: null });
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
      for (const m of await mascots(page, find)) expect(m).toMatchObject({ tracking: false, action: null, mood: "idle" });
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

  test("with reduced motion, nothing follows the pointer", async () => {
    const page = await open();
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    // The old page is still there for a moment after reload() returns: mark it, to wait for the new one.
    await page.eval("window.beforeReload = true; location.reload()");
    await page.until("!window.beforeReload && document.querySelectorAll('.bots-row, .bots-tile').length >= 5");
    await page.settle();
    const find = item("row", "Manager");
    await pointAt(page, find, "far", 12);
    expect((await mascots(page, find))[0]).toMatchObject({ yaw: null, lean: null, tracking: false, action: null });
  });
});
