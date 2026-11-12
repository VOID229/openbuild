// Bots on their own, watched in a real Chrome: what their eyes are made of in every mood, how they
// stare and look around with the whole body turning after the eyes, that nothing ever leaves the
// ground, and that awake bots out of view spend no frames.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botAvatars/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const READY = "document.querySelectorAll('#life .bot').length === 12";
const open = async () => {
  const page = await Page.open(chrome!.ws, server!.url.href, 1100, 700, READY);
  await page.settle();
  return page;
};

describe.skipIf(!browser)("a bot on its own", () => {
  test("no dots in its eyes, and happy eyes stay open and solid: never a chevron", async () => {
    const page = await open();
    await page.finish();
    // Each mood's eyes: anything round in them, the strokes and fills they're drawn with, and the size
    // of the first one on screen.
    const eyes = await page.eval<Record<string, { dots: number; lines: number; fills: number; w: number; h: number }>>(`Object.fromEntries([...document.querySelectorAll('#moods .cell')].map((c) => {
      const eye = c.querySelector('.bot-eye');
      const r = eye.getBoundingClientRect();
      return [c.dataset.mood, { dots: c.querySelectorAll('.bot-face circle, .bot-face ellipse').length, lines: eye.querySelectorAll('.bot-eye-line').length, fills: eye.querySelectorAll('.bot-eye-fill').length, w: r.width, h: r.height }];
    }))`);
    for (const e of Object.values(eyes)) expect(e.dots).toBe(0);
    // Happy, and the open eye of a wink: a filled eye pushed up from below, nearly as wide as an open
    // one and most of its height, not a stroke bent into an arc.
    for (const mood of ["happy"]) {
      expect(eyes[mood]).toMatchObject({ lines: 0, fills: 1 });
      expect(eyes[mood]!.w).toBeGreaterThan(eyes.idle!.w * 0.9);
      expect(eyes[mood]!.h).toBeGreaterThan(eyes.idle!.h * 0.6);
    }
    const wink = await page.eval<{ lines: number; fills: number }[]>(`[...document.querySelectorAll('#moods [data-mood="wink"] .bot-eye')].map((e) => ({ lines: e.querySelectorAll('.bot-eye-line').length, fills: e.querySelectorAll('.bot-eye-fill').length }))`);
    expect(wink).toEqual([{ lines: 1, fills: 0 }, { lines: 0, fills: 1 }]);
    // Big and deep: an open eye stands about a fifth of the bot's height.
    expect(eyes.idle!.h).toBeGreaterThan(96 * 0.19);
    // A squint is a slit, well under half an open eye.
    expect(eyes.squint!.h).toBeLessThan(eyes.idle!.h * 0.45);
  });

  test("it stares and looks around, the whole body turning after the eyes, and never leaves the ground", async () => {
    const page = await open();
    // Every 50ms for a few seconds, each awake bot: whether it's looking somewhere, how its body is
    // turned, and how far the lowest point of its body is above where it rests, as a share of its size.
    const samples = await page.eval<{ looking: boolean; turn: number; body: string; lift: number; action: string }[][]>(`new Promise((done) => {
      const cells = [...document.querySelectorAll('#life .cell')];
      const rest = cells.map((c) => { const box = c.querySelector('.bot-shape').getBBox(); return c.getBoundingClientRect().top + ((box.y + box.height) / 100) * Number(c.dataset.size); });
      const out = [];
      const timer = setInterval(() => {
        out.push(cells.map((c, i) => { const b = c.querySelector('.bot'); return {
          looking: 'looking' in b.dataset,
          turn: Math.abs(Number(b.style.getPropertyValue('--turn-x') || 0)),
          body: getComputedStyle(b.querySelector('.bot-tilt')).transform + getComputedStyle(b.querySelector('.bot-turn')).transform,
          lift: (rest[i] - c.querySelector('.bot-shape').getBoundingClientRect().bottom) / Number(c.dataset.size),
          action: b.dataset.action ?? '',
        }; }));
        if (out.length >= 120) { clearInterval(timer); done(out); }
      }, 50);
    })`);
    const bots = samples[0]!.map((_, i) => samples.map((s) => s[i]!));
    // Most of them look somewhere or stare within the few seconds; looking off to a side, the body
    // turns after the eyes (a stare is straight ahead, and only opens the eyes).
    expect(bots.filter((b) => b.some((s) => s.looking)).length).toBeGreaterThanOrEqual(9);
    const aside = bots.filter((b) => b.some((s) => s.turn > 0.3));
    expect(aside.length).toBeGreaterThanOrEqual(5);
    for (const b of aside) expect(new Set(b.map((s) => s.body)).size).toBeGreaterThan(3);
    // Whatever they did, nothing hopped or spun, and no body left the ground: a hop used to lift one
    // by a tenth of its size, while a head cocked to one side can raise a lobe's dip by a few hundredths.
    for (const b of bots) for (const s of b) expect(["", "nod", "squish", "wiggle", "stretch"]).toContain(s.action);
    expect(Math.max(...bots.flat().map((s) => s.lift))).toBeLessThan(0.05);
  }, 20_000);

  test("out of view, awake bots spend no frames", async () => {
    const page = await open();
    await page.eval("document.body.style.paddingTop = '3000px'");
    // Whatever each was in the middle of runs out first.
    await Bun.sleep(3500);
    await page.eval(`(window.changes = 0, new MutationObserver((r) => (window.changes += r.length)).observe(document.getElementById('life'), { subtree: true, attributes: true }))`);
    await page.send("Performance.enable");
    const metrics = async () => Object.fromEntries((await page.send("Performance.getMetrics")).metrics.map((m: { name: string; value: number }) => [m.name, m.value]));
    const before = await metrics();
    await Bun.sleep(3000);
    const after = await metrics();
    // No routines: nothing about them changes.
    expect(await page.eval<number>("window.changes")).toBe(0);
    // Their breathing stays on the compositor: style is worked out now and then (a glance to see
    // whether they're back in view), nowhere near every frame (~180 in the three seconds), and no layout.
    expect(after.RecalcStyleCount - before.RecalcStyleCount).toBeLessThan(60);
    expect(after.LayoutCount - before.LayoutCount).toBe(0);
    // Back in view, they take up their lives again.
    await page.eval("document.body.style.paddingTop = '0px'");
    await page.until("[...document.querySelectorAll('#life .bot')].some((b) => 'looking' in b.dataset || 'action' in b.dataset)", 6000);
  }, 20_000);

  test("with reduced motion, awake bots hold still", async () => {
    const page = await Page.open(chrome!.ws, "about:blank", 1100, 700, "true");
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await page.send("Page.navigate", { url: server!.url.href });
    await page.until(READY);
    await page.eval(`(window.changes = 0, new MutationObserver((r) => (window.changes += r.length)).observe(document.getElementById('life'), { subtree: true, attributes: true }))`);
    await Bun.sleep(2500);
    expect(await page.eval<number>("window.changes")).toBe(0);
    expect(await page.eval<number>("document.getAnimations().filter((a) => a.playState === 'running').length")).toBe(0);
  }, 20_000);
});
