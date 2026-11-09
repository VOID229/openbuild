// Groups' avatars measured in a real Chrome, in both themes, wherever they show (sidebar rows and
// tiles, the rail, Settings; the hover card and chat header line theirs up instead): every member drawn is in plain view,
// with nothing over it, and a big group's count sits in a seat of its own or beside the huddle, clear
// of every member, inside the item it's in and big enough to read, and clear of the "zzz" over a dozing
// huddle. Rows still line up.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botHuddles/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const READY = "document.querySelectorAll('.bots-tile').length >= 3 && !!document.querySelector('[data-place=size-96] .bot-huddle')";
const open = async (theme: "light" | "dark") => {
  const page = await Page.open(chrome!.ws, `${server!.url.href}?theme=${theme}`, 1100, 900, READY);
  await page.settle();
  return page;
};

type Box = { left: number; top: number; right: number; bottom: number };
type Huddle = { where: string; size: number; bodies: Box[]; hidden: number; touched: number; more: (Box & { text: string; font: number; clipped: boolean; seat: boolean; cell: Box | null }) | null; host: Box | null };

/**
 * Every huddle on the page: its members' drawn bodies, how many are covered, how many the count
 * touches (any point of its disc or pill, or its box beside the huddle, inside a body's outline), the count
 * and the item it's in.
 */
const huddles = (page: Page) =>
  page.eval<Huddle[]>(`(() => {
    const box = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    return [...document.querySelectorAll('.bot-huddle')].map((h) => {
      const where = h.closest('.bots-tile') ? 'tile' : h.closest('.bots-row') ? 'row' : h.closest('[data-place]')?.dataset.place ?? '?';
      const shapes = [...h.querySelectorAll('.bot-shape')];
      // Covered: the middle of a member's body is something else on screen.
      const hidden = shapes.filter((s) => { const r = s.getBoundingClientRect(); return !document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)?.closest('.bot')?.contains(s); }).length;
      const m = h.querySelector('.bot-huddle-more');
      const host = h.closest('.bots-tile, .bots-rail-item, .bots-peek, .bots-row-main');
      let touched = 0;
      if (m) {
        const r = m.getBoundingClientRect(), round = !!m.closest('.bot-huddle-seat');
        const points = [];
        for (let x = r.left; x <= r.right; x += 0.5) for (let y = r.top; y <= r.bottom; y += 0.5)
          // In a seat it's a disc, or a pill: within half its height of the line through its middle.
          if (!round || Math.hypot(x - Math.max(r.left + r.height / 2, Math.min(x, r.right - r.height / 2)), y - (r.top + r.bottom) / 2) <= r.height / 2) points.push([x, y]);
        touched = shapes.filter((s) => {
          const inv = s.getScreenCTM().inverse();
          return points.some(([x, y]) => s.isPointInFill(new DOMPoint(x, y).matrixTransform(inv)));
        }).length;
      }
      return {
        where, size: h.querySelector('.bot-huddle-box').offsetWidth, bodies: shapes.map((s) => box(s.getBoundingClientRect())), hidden, touched,
        more: m && { ...box(m.getBoundingClientRect()), text: m.textContent, font: parseFloat(getComputedStyle(m).fontSize), clipped: m.scrollWidth > m.clientWidth + 0.5, seat: !!m.closest('.bot-huddle-seat'), cell: m.closest('.bot-huddle-seat') && box(m.closest('.bot-huddle-seat').getBoundingClientRect()) },
        host: host && box(host.getBoundingClientRect()),
      };
    });
  })()`);

const meets = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const within = (a: Box, b: Box) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;

describe.skipIf(!browser)("groups' avatars", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`every member shows, and the count sits clear of them (${theme})`, async () => {
      const page = await open(theme);
      const all = await huddles(page);
      for (const where of ["tile", "row", "rail", "size-26", "size-34", "size-96"]) expect(all.some((h) => h.where === where && h.more)).toBe(true);
      for (const h of all) {
        const label = `${h.where} at ${h.size}px`;
        expect({ label, hidden: h.hidden }).toEqual({ label, hidden: 0 });
        if (!h.more) continue;
        expect({ label, touched: h.touched }).toEqual({ label, touched: 0 });
        // In a seat at the sizes that have room for one; beside, after the huddle, at the others.
        expect({ label, seat: h.more.seat }).toEqual({ label, seat: h.size >= 32 });
        if (!h.more.seat) expect(h.more.left).toBeGreaterThanOrEqual(Math.max(...h.bodies.map((b) => b.right)));
        expect(h.more.font).toBeGreaterThanOrEqual(9);
        expect({ label, clipped: h.more.clipped }).toEqual({ label, clipped: false });
        if (h.more.cell) expect({ label, inSeat: within(h.more, h.more.cell) }).toEqual({ label, inSeat: true });
        if (h.host) expect({ label, inside: within(h.more, h.host) }).toEqual({ label, inside: true });
      }
      // Seven in a group: three shown and four counted in a seat, four shown and three counted beside.
      const seven = (where: string) => all.find((h) => h.where === where && h.more?.text.endsWith(h.size >= 32 ? "4" : "3"));
      for (const where of ["tile", "row", "rail", "size-96"]) expect(seven(where)?.bodies).toHaveLength(3);
      expect(seven("size-26")?.bodies).toHaveLength(4);
    });
  }

  test("the zzz over a dozing huddle stays clear of its count, in a seat or beside it", async () => {
    // Held still, each letter where it rests; padded by about as far as it floats while it's in view.
    const page = await Page.open(chrome!.ws, "about:blank", 1100, 900, "true");
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await page.send("Page.navigate", { url: server!.url.href });
    await page.until(READY);
    await page.settle();
    const seen = await page.eval<{ label: string; seat: boolean; shown: boolean; letters: Box[]; more: Box }[]>(`[...document.querySelectorAll('.bot-huddle')].filter((h) => h.querySelector('.bot-zzz') && h.querySelector('.bot-huddle-more')).map((h) => {
      const zzz = h.querySelector('.bot-zzz'), pad = parseFloat(getComputedStyle(zzz).fontSize) * 0.2;
      const letters = [...zzz.children].map((l) => { const r = l.getBoundingClientRect(); return { left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad }; });
      const m = h.querySelector('.bot-huddle-more').getBoundingClientRect();
      const where = h.closest('.bots-tile') ? 'tile' : h.closest('.bots-row') ? 'row' : h.closest('[data-place]')?.dataset.place;
      return { label: where + ' at ' + h.querySelector('.bot-huddle-box').offsetWidth + 'px', seat: h.dataset.more === 'seat', shown: getComputedStyle(zzz).opacity === '1', letters, more: { left: m.left, top: m.top, right: m.right, bottom: m.bottom } };
    })`);
    // Both kinds: the seat (tiles, rows, rail, Settings) and a count beside a small huddle.
    expect(seen.some((h) => h.seat)).toBe(true);
    expect(seen.some((h) => !h.seat)).toBe(true);
    for (const h of seen) expect({ label: h.label, shown: h.shown, overlaps: h.letters.filter((l) => meets(l, h.more)).length }).toEqual({ label: h.label, shown: true, overlaps: 0 });
  });

  test("a group's count doesn't push its row's name out of line with the others", async () => {
    const page = await open("dark");
    const lefts = await page.eval<number[]>(`[...document.querySelectorAll('.bots-row .bots-row-text')].map((t) => t.getBoundingClientRect().left)`);
    expect(lefts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(lefts).size).toBe(1);
  });
});
