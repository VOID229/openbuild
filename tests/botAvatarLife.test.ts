// Bots on their own, watched in a real Chrome: what their eyes are made of in every mood, how they
// stare and look around with the whole body turning, rolling and leaning, that nothing ever hops,
// that every shape keeps its eyes on its body however far it turns, and that awake bots out of view
// spend no frames.
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

const READY = "document.querySelectorAll('#life .bot').length === 12 && document.querySelectorAll('#shapes .bot').length >= 14";
const open = async () => {
  const page = await Page.open(chrome!.ws, server!.url.href, 1100, 900, READY);
  await page.settle();
  return page;
};

/**
 * In the page: how a bot stands, read off what its layers were given. The head's turn is read from
 * how far an eye has slid across the body (it stands 30 units off it, drawn at 0.885 of its size).
 */
const STANCE = `((b) => {
  const of = (cls, re) => Number((re.exec(b.querySelector(cls).style.transform) ?? [0, 0])[1]);
  const slid = (/matrix\\(([^)]+)\\)/.exec(b.querySelector('.bot-eye').style.transform)?.[1] ?? '1,0,0,1,0,0').split(',').map(Number);
  const unit = b.getBoundingClientRect().width / 100, turn = (px) => Math.asin(Math.max(-1, Math.min(1, px / unit / 26.5))) * 180 / Math.PI;
  return { yaw: turn(slid[4]), pitch: turn(slid[5]), bodyYaw: of('.bot-body', /rotateY\\((-?[\\d.]+)deg\\)/), roll: of('.bot-whole', /rotate\\((-?[\\d.]+)deg\\)/), zoom: of('.bot-whole', /scale\\((-?[\\d.]+)\\)/) || 1 };
})`;

describe.skipIf(!browser)("a bot on its own", () => {
  test("its eyes are solid and big, with nothing in them, and happy eyes stay open: never a chevron", async () => {
    const page = await open();
    await page.finish();
    // Each mood's eyes: what they're made of, and how big each is on screen.
    type Eye = { tag: string; inside: number; pseudo: boolean; w: number; h: number; fill: string };
    const eyes = await page.eval<Record<string, { round: number; strokes: number; eyes: Eye[] }>>(`Object.fromEntries([...document.querySelectorAll('#moods .cell')].map((c) => [c.dataset.mood, {
      // Anything round or stroked anywhere on the bot: a dot, a glint, an arc.
      round: c.querySelectorAll('circle, ellipse').length,
      strokes: [...c.querySelectorAll('.bot-face *')].filter((el) => { const s = getComputedStyle(el); return (s.stroke !== 'none' && s.strokeWidth !== '0px' && el instanceof SVGElement) || s.borderTopWidth !== '0px'; }).length,
      eyes: [...c.querySelectorAll('.bot-eye')].map((e) => { const shape = e.firstElementChild, r = shape.getBoundingClientRect(), s = getComputedStyle(shape); return {
        tag: shape.tagName.toLowerCase(), inside: shape.tagName === 'SPAN' ? shape.childNodes.length : shape.querySelectorAll('*').length - 1,
        pseudo: [getComputedStyle(shape, '::before').content, getComputedStyle(shape, '::after').content].some((v) => v !== 'none'),
        w: r.width, h: r.height, fill: shape.tagName === 'SPAN' ? s.backgroundColor : getComputedStyle(shape).fill,
      }; }),
    }]))`);
    for (const [mood, e] of Object.entries(eyes)) {
      expect(e.round).toBe(0);
      expect(e.strokes).toBe(0);
      expect(e.eyes.length).toBe(2);
      for (const eye of e.eyes) {
        // One solid shape, one flat colour, nothing drawn inside it or over it.
        expect({ mood, inside: eye.inside, pseudo: eye.pseudo }).toEqual({ mood, inside: 0, pseudo: false });
        expect(eye.fill).toBe("rgb(20, 20, 20)");
        expect(eye.tag).toBe(mood === "love" ? "svg" : "span");
      }
    }
    const [idle] = eyes.idle!.eyes;
    // Big and deep: an open eye stands over a fifth of the bot's height, and more than twice as tall as wide.
    expect(idle!.h).toBeGreaterThan(96 * 0.21);
    expect(idle!.h / idle!.w).toBeGreaterThan(1.7);
    // Happy: still an open, filled eye, a little wider than an open one and most of its height.
    for (const eye of eyes.happy!.eyes) {
      expect(eye.w).toBeGreaterThan(idle!.w * 0.95);
      expect(eye.h).toBeGreaterThan(idle!.h * 0.6);
    }
    // A wink shuts one eye to a slit and smiles with the other.
    const [shut, smiling] = eyes.wink!.eyes;
    expect(shut!.h).toBeLessThan(idle!.h * 0.4);
    expect(smiling!.h).toBeGreaterThan(idle!.h * 0.6);
    // A squint is a slit, well under half an open eye; surprise is rounder, not smaller.
    for (const eye of eyes.squint!.eyes) expect(eye.h).toBeLessThan(idle!.h * 0.4);
    for (const eye of eyes.surprised!.eyes) {
      expect(eye.w).toBeGreaterThan(idle!.w * 1.15);
      expect(eye.h).toBeGreaterThan(idle!.h * 0.7);
    }
  });

  test("the body is flat: one shape in one colour, no shading over it", async () => {
    const page = await open();
    const drawn = await page.eval<string[][]>(`[...document.querySelectorAll('#moods .bot, #shapes .bot')].map((b) => [...b.querySelectorAll('.bot-body > svg > :not(defs)')].map((el) => el.tagName + ':' + (el.getAttribute('fill') ?? '')))`);
    for (const parts of drawn) {
      expect(parts[0]).toMatch(/^path:#[0-9a-f]{6}$/);
      // Only the sprout's leaf is drawn besides.
      expect(parts.length).toBeLessThanOrEqual(2);
    }
    expect(await page.eval<number>(`document.querySelectorAll('.bot linearGradient, .bot radialGradient, .bot filter').length`)).toBe(0);
  });

  test("it stares and looks around, the whole body turning, rolling and leaning, and never hops", async () => {
    const page = await open();
    // Every 50ms for a few seconds, each awake bot: whether it's looking somewhere, how it stands, and
    // how far its body (the box it's drawn in, which rolls and turns about its middle) is above where
    // it rests, as a share of its size.
    type Sample = { looking: boolean; yaw: number; pitch: number; bodyYaw: number; roll: number; zoom: number; lift: number; action: string; eyes: string };
    const samples = await page.eval<Sample[][]>(`new Promise((done) => {
      const cells = [...document.querySelectorAll('#life .cell')];
      const middle = (c) => { const r = c.querySelector('.bot-whole').getBoundingClientRect(); return r.y + r.height / 2; };
      const rest = cells.map(middle);
      const out = [];
      const timer = setInterval(() => {
        out.push(cells.map((c, i) => { const b = c.querySelector('.bot'); return {
          looking: 'looking' in b.dataset, ...${STANCE}(b),
          lift: (rest[i] - middle(c)) / Number(c.dataset.size), action: b.dataset.action ?? '', eyes: b.dataset.eyes ?? '',
        }; }));
        if (out.length >= 120) { clearInterval(timer); done(out); }
      }, 50);
    })`);
    const bots = samples[0]!.map((_, i) => samples.map((s) => s[i]!));
    // Most of them look somewhere or stare within the few seconds.
    expect(bots.filter((b) => b.some((s) => s.looking)).length).toBeGreaterThanOrEqual(9);
    // Looking off to a side, the head turns well over, the body turns with it (by less), and it rolls.
    const aside = bots.filter((b) => b.some((s) => Math.abs(s.yaw) > 15));
    expect(aside.length).toBeGreaterThanOrEqual(5);
    for (const b of aside) {
      // (Over the whole few seconds, not at one moment: the body is heavier, and can still be coming
      // round from the last look when the head is already on the next.)
      const most = (of: (s: Sample) => number) => Math.max(...b.map((s) => Math.abs(of(s))));
      expect(most((s) => s.bodyYaw)).toBeGreaterThan(3);
      expect(most((s) => s.bodyYaw)).toBeLessThan(most((s) => s.yaw));
      expect(most((s) => s.roll)).toBeGreaterThan(1);
      // On its way there and back it's seen part of the way: it's sprung, not switched.
      expect(new Set(b.map((s) => s.yaw.toFixed(0))).size).toBeGreaterThan(2);
    }
    // The busy ones stare wide-eyed among it all.
    expect(bots.some((b) => b.some((s) => s.eyes === "wide"))).toBe(true);
    // Whatever they did, nothing hopped or spun: the moves are the ones that stay in place, and no
    // body's middle rose off where it rests (a hop used to lift one by a tenth of its size).
    for (const b of bots) for (const s of b) expect(["", "nod", "pop", "wiggle", "stretch"]).toContain(s.action);
    expect(Math.max(...bots.flat().map((s) => s.lift))).toBeLessThan(0.03);
  }, 20_000);

  test("following the pointer, every shape turns toward it and keeps its eyes on its body", async () => {
    const page = await open();
    const box = await page.eval<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.getElementById('shapes').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const stance = "(b.querySelector('.bot-body').style.transform + b.querySelector('.bot-eye').style.transform)";
    const still = `[...document.querySelectorAll('#shapes .bot')].every((b) => b.dataset.settled === ${stance})`;
    const mid = box.y + box.h / 2;
    // The pointer at each edge of the window and in two corners, the row between: everyone turns that way.
    for (const [px, py, sx, sy] of [[2, mid, -1, 0], [1098, mid, 1, 0], [550, 2, 0, -1], [550, 898, 0, 1], [1098, 2, 1, -1], [2, 898, -1, 1]] as const) {
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py });
      // Until every body has come to rest (the same two looks running).
      for (let i = 0; i < 80; i++) {
        await Bun.sleep(60);
        if (await page.eval<boolean>(`(() => { const ok = ${still}; for (const b of document.querySelectorAll('#shapes .bot')) b.dataset.settled = ${stance}; return ok; })()`)) break;
      }
      const seen = await page.eval<{ shape: string; yaw: number; pitch: number; roll: number; on: boolean[] }[]>(`[...document.querySelectorAll('#shapes .cell')].map((c) => {
        const b = c.querySelector('.bot'), body = c.querySelector('.bot-shape');
        // Each eye's middle on screen: is the body under it?
        const on = [...c.querySelectorAll('.bot-eye-fill')].map((e) => { const r = e.getBoundingClientRect(); return document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2).includes(body); });
        return { shape: c.dataset.shape, ...${STANCE}(b), on };
      })`);
      for (const s of seen) {
        expect({ shape: s.shape, on: s.on }).toEqual({ shape: s.shape, on: [true, true] });
        if (sx) expect(Math.sign(s.yaw)).toBe(sx);
        if (sy) expect(Math.sign(s.pitch)).toBe(sy);
        // Leaning into it.
        if (sx && !sy) expect(Math.sign(s.roll)).toBe(sx);
      }
      // Where there's room it's a real turn of the head, not a glance.
      if (sx && !sy) expect(seen.filter((s) => Math.abs(s.yaw) > 28).length).toBeGreaterThanOrEqual(6);
    }
  }, 40_000);

  test("pressed, a playful bot turns right round in place, its face going round the back", async () => {
    const page = await open();
    const bot = "document.querySelector('#play .bot')";
    const [x, y] = await page.eval<[number, number]>(`(() => { const r = (${bot}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    const turns = await page.eval<{ turn: number; hidden: boolean; lift: number }[]>(`new Promise((done) => {
      const b = ${bot}, shape = b.querySelector('.bot-shape'), out = [];
      const rest = b.getBoundingClientRect();
      const tick = () => {
        const turn = Number((/rotateY\\((-?[\\d.]+)deg\\)/.exec(b.querySelector('.bot-body').style.transform) ?? [0, 0])[1]);
        const r = shape.getBoundingClientRect();
        out.push({ turn, hidden: b.querySelector('.bot-skin').style.visibility === 'hidden', lift: (rest.y + rest.height / 2 - (r.y + r.height / 2)) / rest.height });
        if (out.length > 5 && turn === 0 || out.length > 200) done(out); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    // All the way round, and back to rest with no transform left on it.
    expect(Math.max(...turns.map((t) => t.turn))).toBeGreaterThan(300);
    expect(turns.at(-1)!.turn).toBe(0);
    // The face is out of sight exactly while the back shows.
    for (const t of turns) expect(t.hidden).toBe(t.turn > 90 && t.turn < 270);
    expect(turns.some((t) => t.hidden)).toBe(true);
    // In place: it never leaves where it sits.
    expect(Math.max(...turns.map((t) => Math.abs(t.lift)))).toBeLessThan(0.06);
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
    // No routines and no springs: nothing about them changes.
    expect(await page.eval<number>("window.changes")).toBe(0);
    // Their breathing stays on the compositor: style is worked out now and then (a glance to see
    // whether they're back in view), nowhere near every frame (~180 in the three seconds), and no layout.
    expect(after.RecalcStyleCount - before.RecalcStyleCount).toBeLessThan(60);
    expect(after.LayoutCount - before.LayoutCount).toBe(0);
    // Back in view, they take up their lives again.
    await page.eval("document.body.style.paddingTop = '0px'");
    await page.until("[...document.querySelectorAll('#life .bot')].some((b) => 'looking' in b.dataset || 'action' in b.dataset)", 6000);
  }, 20_000);

  test("come to rest, a bot is left with no transforms and takes no frames", async () => {
    const page = await open();
    // The ones that only follow the pointer: turned toward it, then let be.
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
    await page.until("[...document.querySelectorAll('#shapes .bot-eye')].every((e) => e.style.transform !== '')");
    await page.eval("document.getElementById('life').remove()");
    await Bun.sleep(1500);
    await page.eval(`(window.changes = 0, new MutationObserver((r) => (window.changes += r.length)).observe(document.getElementById('shapes'), { subtree: true, attributes: true }))`);
    await Bun.sleep(600);
    // Turned and holding it: nothing is written while nothing moves.
    expect(await page.eval<number>("window.changes")).toBe(0);
  }, 20_000);

  test("with reduced motion, awake bots hold still, and a thought is simply held", async () => {
    const page = await Page.open(chrome!.ws, "about:blank", 1100, 900, "true");
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await page.send("Page.navigate", { url: server!.url.href });
    await page.until(READY);
    await page.eval(`(window.changes = 0, new MutationObserver((r) => (window.changes += r.length)).observe(document.body, { subtree: true, attributes: true }))`);
    // The pointer goes by, and one gets pressed: nobody follows it, and nothing turns.
    const [x, y] = await page.eval<[number, number]>(`(() => { const r = document.querySelector('#play .bot').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 40, y: 40 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await Bun.sleep(2500);
    // Only the pressed one's face changed (a smile at the pointer), and it didn't move for it.
    expect(await page.eval<number>("[...document.querySelectorAll('#life .bot, #shapes .bot')].filter((b) => b.dataset.action || b.dataset.looking !== undefined || b.dataset.tracking !== undefined || b.dataset.blink !== undefined).length")).toBe(0);
    expect(await page.eval<number>("[...document.querySelectorAll('#life .bot *, #shapes .bot *, #play .bot *')].filter((el) => el.style.transform).length")).toBe(0);
    expect(await page.eval<string | undefined>("document.querySelector('#play .bot').dataset.action")).toBeUndefined();
    expect(await page.eval<number>("document.getAnimations().filter((a) => a.playState === 'running').length")).toBe(0);
    // A bot thinking still looks up and away: put there, with nothing run to get it there.
    expect(await page.eval<string[]>("['.bot-body', '.bot-eye'].map((c) => document.querySelector('#moods [data-mood=thinking] ' + c).style.transform.split('(')[0])")).toEqual(["perspective", "matrix"]);
  }, 20_000);
});
