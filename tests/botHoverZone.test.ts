// The room beside a bubble where its actions come up counts as hovering the message, with a mouse:
// pointing there shows the actions before the pointer reaches the bubble. The zone is as tall as the
// bubble and as wide as the actions, on the side they come up on, and it moves nothing, covers no other
// message and no other row's zone. Touch screens keep holding a bubble for its actions.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botScroll/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

type Box = { left: number; right: number; top: number; bottom: number };
type Row = { id: string; mine: boolean; bubble: Box; line: Box; foot: Box; zone: Box | null; actions: number };

/** Runs of several bubbles from each side, short and long, in a direct chat, a group and a side chat. */
const CHATS = `(() => {
  const start = Date.now() - 600_000;
  const short = ["Sounds good.", "On it: merging #219 first, then the bump.", "Done."];
  const long = "That adds some latency, though we haven't measured how much on your setup. ".repeat(4);
  const run = (chat, from, authors) => authors.map((author, i) => ({ id: chat + "-" + (from + i), author, at: start + (from + i) * 1000, text: i === 1 ? long : short[i % short.length] }));
  const conv = (id, kind, botIds, messages) => ({ id, kind, name: kind === "direct" ? undefined : "Crew " + id, botIds, createdAt: start, updatedAt: start, messages });
  const direct = conv("d", "direct", ["manager"], [...run("d", 0, ["me", "me", "me"]), ...run("d", 3, ["manager", "manager", "manager"]), ...run("d", 6, ["me"]), ...run("d", 7, ["manager"])]);
  const group = conv("g", "group", ["manager", "helper"], [...run("g", 0, ["manager", "manager"]), ...run("g", 2, ["helper", "helper", "helper"]), ...run("g", 5, ["me", "me", "me"]), ...run("g", 8, ["helper"])]);
  const side = conv("s", "side", ["manager", "helper"], [...run("s", 0, ["manager", "manager"]), ...run("s", 2, ["helper"])]);
  bots.setState((s) => ({ conversations: [...s.conversations.filter((c) => !["d", "g", "s"].includes(c.id)), direct, group, side] }));
  return true;
})()`;

const open = async (hover: boolean, chat: string, width = 1000) => {
  const page = await Page.open(chrome!.ws, server!.url.href, width, 900, "!!document.querySelector('.bots-messages')");
  if (hover) await page.emulateHover();
  await page.eval(`document.head.append(Object.assign(document.createElement("style"), { textContent: ".bots-sync-status { display: none !important; }" }))`);
  await page.eval(CHATS);
  await page.eval(`bots.getState().select(${JSON.stringify(chat)})`);
  await page.until(`document.querySelector('[data-id="${chat}-0"]') !== null`);
  await page.finished();
  return page;
};

/** Every message row in view, with its bubble, its line, its foot and its hover zone (null without one). */
const rows = (page: Page) =>
  page.eval<Row[]>(`(() => {
    const box = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    return [...document.querySelectorAll('.bots-messages .bm-row')].map((row) => {
      const line = row.querySelector('.bm-line'), l = line.getBoundingClientRect();
      const z = getComputedStyle(row.querySelector('.bm-bubble'), '::after');
      let zone = null;
      if (z.content !== 'none' && z.display !== 'none') {
        const w = parseFloat(z.width), mine = !!row.closest('.bm-mine');
        zone = { left: mine ? l.left - w : l.right, right: mine ? l.left : l.right + w, top: l.top, bottom: l.bottom };
      }
      return {
        id: row.dataset.id,
        mine: !!row.closest('.bm-mine'),
        bubble: box(row.querySelector('.bm-bubble').getBoundingClientRect()),
        line: box(l),
        foot: box(row.querySelector('.bm-foot').getBoundingClientRect()),
        zone,
        actions: row.querySelectorAll('.bm-actions > *').length,
      };
    });
  })()`);

/** The message whose line (its bubble, or the zone beside it) is under a point, if any. */
const rowAt = (page: Page, x: number, y: number) =>
  page.eval<string | null>(`document.elementFromPoint(${x}, ${y})?.closest('.bm-line')?.closest('.bm-row')?.dataset.id ?? null`);

/** Whether the message's actions come up (or go), once their fade is over. */
const actionsShown = async (page: Page, id: string) => {
  const opacity = `getComputedStyle(document.querySelector('[data-id="${id}"] .bm-actions')).opacity`;
  await page.until(`["0", "1"].includes(${opacity}) && !document.querySelector('[data-id="${id}"] .bm-actions').getAnimations().length`);
  return page.eval<boolean>(`${opacity} === "1"`);
};

const move = async (page: Page, x: number, y: number) => {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.settle();
};

const overlap = (a: Box, b: Box) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

describe.skipIf(!browser)("with a mouse", () => {
  for (const chat of ["d", "g"]) {
    test(`${chat === "d" ? "a direct chat" : "a group"}: pointing beside a bubble, where its actions come up, shows them`, async () => {
      const page = await open(true, chat);
      const all = (await rows(page)).filter((r) => r.id.startsWith(`${chat}-`));
      expect(all.length).toBeGreaterThanOrEqual(8);
      // Runs of several bubbles from both sides, each bubble its own row with its own zone.
      expect(all.filter((r) => r.mine).length).toBeGreaterThanOrEqual(3);
      expect(all.filter((r) => !r.mine).length).toBeGreaterThanOrEqual(3);
      for (const r of all) {
        await page.eval(`document.querySelector('[data-id="${r.id}"]').scrollIntoView({ block: "center" })`);
        await page.settle();
        const [row] = (await rows(page)).filter((x) => x.id === r.id);
        const { bubble, zone } = row!;
        expect(zone).not.toBeNull();
        // As tall as the bubble, as wide as its actions (padding included), on their side of it.
        expect(zone!.top).toBeCloseTo(bubble.top, 0);
        expect(zone!.bottom).toBeCloseTo(bubble.bottom, 0);
        const w = row!.actions === 4 ? 4 * 28 + 8 : 3 * 28 + 8;
        expect(zone!.right - zone!.left).toBeCloseTo(w, 0);
        if (row!.mine) expect(zone!.right).toBeCloseTo(bubble.left, 0);
        else expect(zone!.left).toBeCloseTo(bubble.right, 0);
        const actions = await page.eval<Box>(`(() => { const r = document.querySelector('[data-id="${r.id}"] .bm-actions').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`);
        expect(actions.left).toBeGreaterThanOrEqual(zone!.left - 0.5);
        expect(actions.right).toBeLessThanOrEqual(zone!.right + 0.5);

        const y = (bubble.top + bubble.bottom) / 2;
        const near = row!.mine ? bubble.left - 3 : bubble.right + 3;
        const far = row!.mine ? zone!.left + 3 : zone!.right - 3;
        const beyond = row!.mine ? zone!.left - 6 : zone!.right + 6;
        const opposite = row!.mine ? bubble.right + 6 : bubble.left - 6;
        // Off to the side, and past the zone, the message isn't hovered.
        await move(page, beyond, y);
        expect(await rowAt(page, beyond, y)).not.toBe(r.id);
        expect(await actionsShown(page, r.id)).toBe(false);
        // Just beside the bubble, and at the far end of the room for the actions, it is.
        for (const x of [near, far]) {
          await move(page, x, y);
          expect(await rowAt(page, x, y)).toBe(r.id);
          expect(await actionsShown(page, r.id)).toBe(true);
          await move(page, beyond, y);
          expect(await actionsShown(page, r.id)).toBe(false);
        }
        // Above and below the bubble, and on its other side, the zone doesn't reach.
        expect(await rowAt(page, opposite, y)).not.toBe(r.id);
        for (const yy of [bubble.top - 2, bubble.bottom + 2]) {
          const at = await page.eval<string>(`document.elementFromPoint(${near}, ${yy})?.closest('.bm-line') ? "line" : "no"`);
          expect(at).toBe("no");
        }
        // Each action still takes its own clicks over the zone.
        await move(page, near, y);
        for (const label of ["React", "Reply", "Copy"]) {
          const hit = await page.eval<string | null>(`(() => { const b = document.querySelector('[data-id="${r.id}"] .bm-actions button[aria-label="${label}"]').getBoundingClientRect(); return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('button')?.getAttribute('aria-label') ?? null; })()`);
          expect(hit).toBe(label);
        }
        await move(page, beyond, y);
      }
      }, 60_000);

    test(`${chat === "d" ? "a direct chat" : "a group"}: the zones cover no other message, no other zone, and move nothing`, async () => {
      const page = await open(true, chat);
      const withZones = await rows(page);
      const zoned = withZones.filter((r) => r.zone);
      expect(zoned.length).toBeGreaterThanOrEqual(8);
      for (const a of zoned) {
        for (const b of withZones) {
          if (a === b) continue;
          expect(overlap(a.zone!, b.line)).toBe(false);
          expect(overlap(a.zone!, b.foot)).toBe(false);
          if (b.zone) expect(overlap(a.zone!, b.zone)).toBe(false);
        }
        // Nor the row's own reactions, under it.
        expect(overlap(a.zone!, a.foot)).toBe(false);
      }
      // Each point of another message's bubble still belongs to that message.
      for (const b of withZones) {
        const x = (b.bubble.left + b.bubble.right) / 2;
        for (const y of [b.bubble.top + 2, (b.bubble.top + b.bubble.bottom) / 2, b.bubble.bottom - 2]) {
          // Points under the header or the composer aren't the conversation's.
          if (!(await page.eval<boolean>(`!!document.elementFromPoint(${x}, ${y})?.closest('.bots-messages')`))) continue;
          expect(await rowAt(page, x, y)).toBe(b.id);
        }
      }
      // Without the zones, everything sits exactly where it did.
      const scroll = await page.eval<number>(`document.querySelector('.bots-messages').scrollHeight`);
      await page.eval(`document.head.append(Object.assign(document.createElement("style"), { id: "no-zone", textContent: ".bm-bubble::after { display: none !important; }" }))`);
      await page.settle();
      const without = await rows(page);
      expect(without.every((r) => r.zone === null)).toBe(true);
      expect(without.map(({ zone, ...r }) => r)).toEqual(withZones.map(({ zone, ...r }) => r));
      expect(await page.eval<number>(`document.querySelector('.bots-messages').scrollHeight`)).toBe(scroll);
      }, 60_000);
  }

  test("a drag selecting text selects what it did without the zones, whichever zone it ends in", async () => {
    const page = await open(true, "d");
    await page.eval(`document.querySelector('[data-id="d-4"]').scrollIntoView({ block: "center" })`);
    await page.settle();
    const all = await rows(page);
    const at = (id: string) => all.find((r) => r.id === id)!;
    /** Where the text of message `id` starts. */
    const textStart = (id: string) =>
      page.eval<[number, number]>(`(() => { const r = document.querySelector('[data-id="${id}"] .bm-text').getBoundingClientRect(); return [r.left + 1, r.top + 8]; })()`);
    /** Presses at `from`, drags to `to` as a hand does, lets go, and says what's selected. */
    const drag = async (from: [number, number], to: [number, number]) => {
      await page.eval(`getSelection().removeAllRanges(), true`);
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from[0], y: from[1], button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 10; i++) await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from[0] + ((to[0] - from[0]) * i) / 10, y: from[1] + ((to[1] - from[1]) * i) / 10, button: "left", buttons: 1 });
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to[0], y: to[1], button: "left", buttons: 0, clickCount: 1 });
      await page.settle();
      return page.eval<string>(`getSelection().toString()`);
    };
    const mid = (r: Row, side: "zone") => [(r[side]!.left + r[side]!.right) / 2, (r[side]!.top + r[side]!.bottom) / 2] as [number, number];
    // From a bot's text into its own zone, from the bubble above into the next one's zone, and from the
    // user's text into the zone of the bot's message under it.
    const drags: [[number, number], [number, number]][] = [
      [await textStart("d-4"), mid(at("d-4"), "zone")],
      [await textStart("d-3"), mid(at("d-4"), "zone")],
      [await textStart("d-6"), mid(at("d-7"), "zone")],
    ];
    const withZones: string[] = [];
    for (const [from, to] of drags) withZones.push(await drag(from, to));
    expect(withZones[0]!.length).toBeGreaterThan(100);
    expect(withZones[1]!.length).toBeGreaterThan(withZones[0]!.length);
    await page.eval(`document.head.append(Object.assign(document.createElement("style"), { textContent: ".bm-bubble::after { display: none !important; }" }))`);
    await page.settle();
    const without: string[] = [];
    for (const [from, to] of drags) without.push(await drag(from, to));
    expect(withZones).toEqual(without);
  }, 60_000);

  test("a chat that's only there to read has no actions, and no zone", async () => {
    const page = await open(true, "s");
    const all = (await rows(page)).filter((r) => r.id.startsWith("s-"));
    expect(all.length).toBe(3);
    for (const r of all) {
      expect(r.actions).toBe(0);
      expect(r.zone).toBeNull();
    }
  }, 60_000);
});

describe.skipIf(!browser)("on a touch screen", () => {
  test("there's no zone beside a bubble: holding it brings up the actions, as before", async () => {
    for (const width of [390, 1000]) {
      const page = await open(false, "g", width);
      const all = (await rows(page)).filter((r) => r.id.startsWith("g-"));
      expect(all.length).toBeGreaterThanOrEqual(8);
      for (const r of all) {
        expect(r.zone).toBeNull();
        if (r.bubble.top < 0 || r.bubble.bottom > 900) continue;
        const x = r.mine ? r.bubble.left - 3 : r.bubble.right + 3;
        expect(await rowAt(page, x, (r.bubble.top + r.bubble.bottom) / 2)).not.toBe(r.id);
      }
      }
  }, 60_000);
});
