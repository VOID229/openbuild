// The bots in a group, watched in a real Chrome: the member at work is awake and the rest doze,
// wherever the group shows its bots (its tile and row in the sidebar, the chat's header and the
// mascots beside messages, the details panel). Waking and nodding off are eased, dozing costs the
// main thread nothing, reduced motion holds the pose, and nothing spins or hops.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botMascots/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const READY = "document.querySelectorAll('.bots-tile').length >= 5 && !!document.querySelector('.bots-details .bots-member')";
const open = async () => {
  const page = await Page.open(chrome!.ws, server!.url.href, 1180, 760, READY);
  await page.settle();
  return page;
};

/**
 * How shut a bot's eyes are, in the page: an eye closes by being squashed to a dash, so 1 is open and
 * near 0 shut. A blink squashes it for a moment too; that isn't being shut.
 */
const OPEN = `((b) => 'blink' in b.dataset ? 1 : new DOMMatrix(getComputedStyle(b.querySelector('.bot-eye-fill')).transform).d)`;

/** The colour of each bot under `selector`, by where it is: whether it dozes, whether it's busy, and how open its eyes are. */
type Seen = { where: string; color: string; asleep: boolean; busy: boolean; eye: number };
const seen = (page: Page) =>
  page.eval<Seen[]>(`(() => {
    const places = {
      tile: [...document.querySelectorAll('.bots-tile')].filter((t) => !t.textContent.includes('Dr Eggbot')),
      row: [...document.querySelectorAll('.bots-row')],
      header: [...document.querySelectorAll('.bots-head')],
      message: [...document.querySelectorAll('.bm-group .bm-avatar')],
      hero: [...document.querySelectorAll('.bots-details-avatar')],
      member: [...document.querySelector('.bots-details .bots-cards').querySelectorAll('.bots-member')],
    };
    return Object.entries(places).flatMap(([where, els]) => els.flatMap((el) => [...el.querySelectorAll('.bot')].map((b) => (
      { where, color: b.dataset.color, asleep: 'asleep' in b.dataset, busy: 'busy' in b.dataset, eye: ${OPEN}(b) }
    ))));
  })()`);

/** Every bot in the "OpenBuild Dev" tile, by colour (Moss is green, Boo amber). */
const devBot = (color: string) => `[...document.querySelectorAll('.bots-tile')].find((t) => t.textContent.includes('OpenBuild Dev')).querySelector('.bot[data-color="${color}"]')`;

/** The transitions running under a bot, with what they change and how long they take. */
const transitions = (page: Page, bot: string) =>
  page.eval<{ on: string; property: string; duration: number; delay: number }[]>(`(${bot}).getAnimations({ subtree: true }).filter((a) => a instanceof CSSTransition).map((a) => ({
    on: ['bot-eye-fill', 'bot-doze', 'bot-nap'].find((c) => a.effect.target.classList.contains(c)) ?? '', property: a.transitionProperty, duration: a.effect.getTiming().duration, delay: a.effect.getTiming().delay,
  }))`);

/**
 * Records every transition from now on as it starts: a short one (the lids open in 140 ms) can be
 * over before a slow frame lets `transitions` look. `started` reads them back for a bot.
 */
const watchTransitions = (page: Page) =>
  page.eval(`(window.started = [], window.watching ||= (document.addEventListener('transitionrun', (e) => {
    const a = e.target.getAnimations().find((a) => a instanceof CSSTransition && a.transitionProperty === e.propertyName);
    if (a) window.started.push({ target: e.target, property: e.propertyName, duration: a.effect.getTiming().duration, delay: a.effect.getTiming().delay });
  }), true), true)`);
const started = (page: Page, bot: string) =>
  page.eval<{ on: string; property: string; duration: number; delay: number }[]>(`window.started.filter((t) => (${bot}).contains(t.target)).map((t) => ({
    on: ['bot-eye-fill', 'bot-doze', 'bot-nap'].find((c) => t.target.classList.contains(c)) ?? '', property: t.property, duration: t.duration, delay: t.delay,
  }))`);

const setWorking = (page: Page, ids: string[]) =>
  page.eval(`bots.setState({ status: Object.fromEntries(${JSON.stringify(ids)}.map((id) => [id, { state: "working", conversationId: "dev" }])) })`);

describe.skipIf(!browser)("bots dozing in a group", () => {
  test("only the member at work is awake, wherever the group shows its bots", async () => {
    const page = await open();
    const bots = await seen(page);
    for (const where of ["tile", "row", "header", "message", "hero", "member"]) expect(bots.some((b) => b.where === where)).toBe(true);
    for (const b of bots) {
      // Moss (green) is at work: awake, and busy but beside its messages (the line saying what it's
      // doing has a busy mascot of its own). Everyone else dozes, eyes shut.
      const moss = b.color === "green";
      expect({ ...b, eye: b.eye < 0.3 }).toEqual({ ...b, asleep: !moss, busy: moss && b.where !== "message", eye: !moss });
    }
    // A bot's own chat doesn't doze, and has no "zzz" to show.
    expect(await page.eval<object>(`(() => { const b = [...document.querySelectorAll('.bots-tile')].find((t) => t.textContent.includes('Dr Eggbot')).querySelector('.bot'); return { asleep: 'asleep' in b.dataset, zzz: !!b.querySelector('.bot-zzz'), open: ${OPEN}(b) > 0.9 }; })()`)).toEqual({ asleep: false, zzz: false, open: true });
  });

  test("a member at work in a big group is shown, never one of the count", async () => {
    const page = await open();
    const everyone = `[...document.querySelectorAll('.bots-tile')].find((t) => t.textContent.includes('Everyone'))`;
    const colors = () => page.eval<string[]>(`[...(${everyone}).querySelectorAll('.bot')].map((b) => b.dataset.color)`);
    // Three members, and the other three as a count in the fourth seat.
    expect(await colors()).toEqual(["white", "green", "amber"]);
    expect(await page.eval<string>(`(${everyone}).querySelector('.bot-huddle-seat .bot-huddle-more').textContent`)).toBe("+3");
    // Spark (teal), the sixth, starts work: it takes the last dozing member's place, awake.
    await setWorking(page, ["moss", "spark"]);
    await page.settle();
    expect(await colors()).toEqual(["white", "green", "teal"]);
    expect(await page.eval<boolean>(`'busy' in (${everyone}).querySelector('.bot[data-color="teal"]').dataset`)).toBe(true);
  });

  test("a bot wakes when it starts work and dozes off when it stops, eased both ways", async () => {
    const page = await open();
    // Boo (amber) starts work: awake at once, with a stretch, its eyes opening and its body coming up.
    await watchTransitions(page);
    await setWorking(page, ["moss", "boo"]);
    await page.settle();
    const boo = devBot("amber");
    expect(await page.eval<object>(`({ asleep: 'asleep' in (${boo}).dataset, busy: 'busy' in (${boo}).dataset, action: (${boo}).dataset.action })`)).toEqual({ asleep: false, busy: true, action: "stretch" });
    const waking = await started(page, boo);
    expect(waking.some((t) => t.on === "bot-eye-fill" && t.property === "transform" && t.duration >= 100)).toBe(true);
    expect(waking.some((t) => t.on === "bot-doze" && t.duration >= 400)).toBe(true);
    expect(waking.some((t) => t.on === "bot-nap" && t.duration >= 400)).toBe(true);

    // It stops: the eyes grow heavy and shut slowly, as the face drops and the body slumps, slower still.
    await Bun.sleep(1200);
    await setWorking(page, ["moss"]);
    await page.settle();
    expect(await page.eval<boolean>(`'asleep' in (${boo}).dataset`)).toBe(true);
    const dozing = await transitions(page, boo);
    const eye = dozing.find((t) => t.on === "bot-eye-fill" && t.property === "transform")!;
    expect(eye.duration).toBeGreaterThanOrEqual(600);
    expect(dozing.find((t) => t.on === "bot-doze")!.duration).toBeGreaterThanOrEqual(1000);
    expect(dozing.find((t) => t.on === "bot-nap")!.duration).toBeGreaterThanOrEqual(1000);
    // Not shut yet, a moment in.
    expect(await page.eval<number>(`${OPEN}(${boo})`)).toBeGreaterThan(0.5);
    // Settled: eyes shut, face down, body slumped over.
    await page.finish();
    const [eyes, slump, nap] = await page.eval<[number, string, string]>(`[${OPEN}(${boo}), getComputedStyle((${boo}).querySelector('.bot-doze')).transform, getComputedStyle((${boo}).querySelector('.bot-nap')).transform]`);
    expect(eyes).toBeLessThan(0.3);
    for (const t of [slump, nap]) {
      expect(t).not.toBe("none");
      expect(t).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
    }
  }, 20_000);

  test("dozing bots only breathe under their zzz, and on the compositor", async () => {
    const page = await open();
    await setWorking(page, []);
    // Let them nod off, the one that was at work coming to rest first.
    await page.until("[...document.querySelectorAll('.bot-whole, .bot-body, .bot-eye')].every((el) => !el.style.transform)");
    await page.finish();
    const running = await page.eval<{ name: string; on: string }[]>(`document.getAnimations().filter((a) => a.playState === 'running').map((a) => ({ name: a.animationName ?? a.transitionProperty, on: a.effect.target.matches('.bot[data-asleep]') ? 'bot' : a.effect.target.matches('.bot[data-asleep] > .bot-zzz > span, .bot-huddle-box[data-dozing] > .bot-zzz > span') ? 'zzz' : '' }))`);
    expect(running.length).toBeGreaterThan(10);
    // The breathing, and the letters of the "zzz" over them floating up.
    for (const a of running) expect(a).toEqual(a.on === "zzz" ? { name: "bot-zzz", on: "zzz" } : { name: "bot-breathe", on: "bot" });
    expect(running.some((a) => a.on === "zzz")).toBe(true);
    // Breathing runs off the main thread: no restyling frame after frame (that would be ~120 in the
    // two seconds), only now and then as a bot's cycle of breaths comes round, and no layout at all.
    await page.send("Performance.enable");
    const metrics = async () => Object.fromEntries((await page.send("Performance.getMetrics")).metrics.map((m: { name: string; value: number }) => [m.name, m.value]));
    const before = await metrics();
    await Bun.sleep(2000);
    const after = await metrics();
    expect(after.RecalcStyleCount - before.RecalcStyleCount).toBeLessThanOrEqual(10);
    expect(after.LayoutCount - before.LayoutCount).toBe(0);
  }, 20_000);

  test("with reduced motion, dozing bots hold the pose and nothing moves", async () => {
    const page = await Page.open(chrome!.ws, "about:blank", 1180, 760, "true");
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await page.send("Page.navigate", { url: server!.url.href });
    await page.until(READY);
    await page.settle();
    const bots = await seen(page);
    for (const b of bots) if (b.color !== "green") expect({ asleep: b.asleep, shut: b.eye < 0.3 }).toEqual({ asleep: true, shut: true });
    // Moss at work doesn't fidget, the rest don't breathe: nothing runs at all.
    await Bun.sleep(500);
    const moving = () => page.eval<number>(`document.getAnimations().filter((a) => a.playState === 'running' && a.effect.target.closest('.bot')).length`);
    expect(await moving()).toBe(0);
    expect(await page.eval<number>(`[...document.querySelectorAll('.bot')].filter((b) => b.dataset.action || b.dataset.eyes).length`)).toBe(0);
    // Waking and nodding off are instant, without a stretch.
    await setWorking(page, ["moss", "boo"]);
    await page.settle();
    expect(await page.eval<(number | null)[]>(`[${OPEN}(${devBot("amber")}), (${devBot("amber")}).dataset.action ?? null]`)).toEqual([1, null]);
    await setWorking(page, ["moss"]);
    await page.settle();
    expect(await page.eval<number>(`${OPEN}(${devBot("amber")})`)).toBeLessThan(0.3);
    expect(await moving()).toBe(0);
  }, 20_000);

  test("however busy the bots get, nothing spins or hops, in the sidebar or the chat", async () => {
    const page = await open();
    await page.eval(`(() => {
      window.moves = [];
      window.poses = 0;
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.attributeName === 'data-action' && r.target.dataset.action) window.moves.push(r.target.dataset.action);
          if (r.attributeName === 'data-eyes' || r.attributeName === 'style') window.poses++;
        }
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-action', 'data-eyes', 'style'] });
    })()`);
    // Every bot at work, in every place they show: a lot of fidgeting to watch.
    await setWorking(page, ["egg", "moss", "boo", "pill", "tile", "spark"]);
    // Which beats may be drawn at all is botMascotRoutines.test.ts's; this is that they're drawn here.
    await Bun.sleep(3000);
    const moves = await page.eval<string[]>("window.moves");
    expect(await page.eval<number>("window.poses")).toBeGreaterThan(5);
    // The ones that woke stretched; whatever else they did, none of it was a spin or a hop.
    expect(moves).toContain("stretch");
    expect(moves.filter((m) => m === "spin" || m === "hop")).toEqual([]);
  }, 30_000);
});
