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

/** The colour of each bot under `selector`, by where it is: whether it dozes and whether it's busy. */
type Seen = { where: string; color: string; asleep: boolean; busy: boolean; lid: number | null; eye: number };
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
    return Object.entries(places).flatMap(([where, els]) => els.flatMap((el) => [...el.querySelectorAll('.bot')].map((b) => {
      const lid = b.querySelector('.bot-lid');
      return { where, color: b.dataset.color, asleep: 'asleep' in b.dataset, busy: 'busy' in b.dataset, lid: lid && Number(getComputedStyle(lid).opacity), eye: Number(getComputedStyle(b.querySelector('.bot-eye')).opacity) };
    })));
  })()`);

/** Every bot in the "OpenBuild Dev" tile, by colour (Moss is green, Boo amber). */
const devBot = (color: string) => `[...document.querySelectorAll('.bots-tile')].find((t) => t.textContent.includes('OpenBuild Dev')).querySelector('.bot[data-color="${color}"]')`;

/** The transitions running under a bot, with what they change and how long they take. */
const transitions = (page: Page, bot: string) =>
  page.eval<{ on: string; property: string; duration: number; delay: number }[]>(`(${bot}).getAnimations({ subtree: true }).filter((a) => a instanceof CSSTransition).map((a) => ({
    on: ['bot-lid', 'bot-eye', 'bot-tilt', 'bot-turn', 'bot-look', 'bot-light'].find((c) => a.effect.target.classList.contains(c)) ?? '', property: a.transitionProperty, duration: a.effect.getTiming().duration, delay: a.effect.getTiming().delay,
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
      expect({ ...b, lid: b.lid! > 0.99, eye: b.eye < 0.01 }).toEqual({ ...b, asleep: !moss, busy: moss && b.where !== "message", lid: !moss, eye: !moss });
    }
    // A bot's own chat doesn't doze, and has no lids to close.
    expect(await page.eval<null>(`[...document.querySelectorAll('.bots-tile')].find((t) => t.textContent.includes('Dr Eggbot')).querySelector('.bot-lid')`)).toBeNull();
  });

  test("a member at work in a big group is shown, never one of the count", async () => {
    const page = await open();
    const everyone = `[...document.querySelectorAll('.bots-tile')].find((t) => t.textContent.includes('Everyone'))`;
    const colors = () => page.eval<string[]>(`[...(${everyone}).querySelectorAll('.bot')].map((b) => b.dataset.color)`);
    expect(await colors()).toEqual(["white", "green", "amber", "blue"]);
    expect(await page.eval<string>(`(${everyone}).querySelector('.bot-huddle-more').textContent`)).toBe("+2");
    // Spark (teal), the fifth, starts work: it takes the last dozing member's place, awake.
    await setWorking(page, ["moss", "spark"]);
    await page.settle();
    expect(await colors()).toEqual(["white", "green", "amber", "teal"]);
    expect(await page.eval<boolean>(`'busy' in (${everyone}).querySelector('.bot[data-color="teal"]').dataset`)).toBe(true);
  });

  test("a bot wakes when it starts work and dozes off when it stops, eased both ways", async () => {
    const page = await open();
    // Boo (amber) starts work: awake at once, with a stretch, its eyes opening and head coming up.
    await setWorking(page, ["moss", "boo"]);
    await page.settle();
    const boo = devBot("amber");
    expect(await page.eval<object>(`({ asleep: 'asleep' in (${boo}).dataset, busy: 'busy' in (${boo}).dataset, action: (${boo}).dataset.action })`)).toEqual({ asleep: false, busy: true, action: "stretch" });
    const waking = await transitions(page, boo);
    expect(waking.some((t) => t.on === "bot-lid" && t.property === "opacity" && t.duration >= 100)).toBe(true);
    expect(waking.some((t) => t.on === "bot-tilt" && t.duration >= 400)).toBe(true);

    // It stops: the eyes grow heavy first and shut slowly, then the head goes down, slower still.
    await Bun.sleep(1200);
    await setWorking(page, ["moss"]);
    await page.settle();
    expect(await page.eval<boolean>(`'asleep' in (${boo}).dataset`)).toBe(true);
    const dozing = await transitions(page, boo);
    const eye = dozing.find((t) => t.on === "bot-eye" && t.property === "transform")!;
    expect(eye.duration).toBeGreaterThanOrEqual(600);
    expect(dozing.find((t) => t.on === "bot-lid")!.delay).toBeGreaterThanOrEqual(400);
    expect(dozing.find((t) => t.on === "bot-tilt")!.duration).toBeGreaterThanOrEqual(1000);
    // Not shut yet, a moment in.
    expect(Number(await page.eval(`getComputedStyle((${boo}).querySelector('.bot-lid')).opacity`))).toBeLessThan(0.5);
    // Settled: eyes shut, head leaning in.
    await Bun.sleep(2000);
    const [lid, eyeOpacity, tilt] = await page.eval<[string, string, string]>(`[(${boo}).querySelector('.bot-lid'), (${boo}).querySelector('.bot-eye'), (${boo}).querySelector('.bot-tilt')].map((el, i) => getComputedStyle(el)[i < 2 ? 'opacity' : 'transform'])`);
    expect([lid, eyeOpacity]).toEqual(["1", "0"]);
    expect(tilt).not.toBe("none");
    expect(tilt).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
  }, 20_000);

  test("dozing bots only breathe under their zzz, and on the compositor", async () => {
    const page = await open();
    await setWorking(page, []);
    // Let them nod off.
    await Bun.sleep(2200);
    const running = await page.eval<{ name: string; on: string }[]>(`document.getAnimations().filter((a) => a.playState === 'running').map((a) => ({ name: a.animationName ?? a.transitionProperty, on: a.effect.target.matches('.bot[data-asleep]') ? 'bot' : a.effect.target.matches('.bot[data-asleep] > .bot-zzz > span, .bot-huddle[data-dozing] > .bot-zzz > span') ? 'zzz' : '' }))`);
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
    for (const b of bots) if (b.color !== "green") expect({ asleep: b.asleep, lid: b.lid, eye: b.eye }).toEqual({ asleep: true, lid: 1, eye: 0 });
    // Moss at work doesn't fidget, the rest don't breathe: nothing runs at all.
    await Bun.sleep(1500);
    const moving = () => page.eval<number>(`document.getAnimations().filter((a) => a.playState === 'running' && a.effect.target.closest('.bot')).length`);
    expect(await moving()).toBe(0);
    expect(await page.eval<number>(`[...document.querySelectorAll('.bot')].filter((b) => b.dataset.action || b.dataset.eyes).length`)).toBe(0);
    // Waking and nodding off are instant, without a stretch.
    await setWorking(page, ["moss", "boo"]);
    await page.settle();
    expect(await page.eval<(string | null)[]>(`[getComputedStyle((${devBot("amber")}).querySelector('.bot-lid')).opacity, (${devBot("amber")}).dataset.action ?? null]`)).toEqual(["0", null]);
    await setWorking(page, ["moss"]);
    await page.settle();
    expect(await page.eval<string>(`getComputedStyle((${devBot("amber")}).querySelector('.bot-lid')).opacity`)).toBe("1");
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
    await Bun.sleep(9000);
    const moves = await page.eval<string[]>("window.moves");
    expect(await page.eval<number>("window.poses")).toBeGreaterThan(20);
    // The ones that woke stretched; whatever else they did, none of it was a spin or a hop.
    expect(moves).toContain("stretch");
    expect(moves.filter((m) => m === "spin" || m === "hop")).toEqual([]);
  }, 30_000);
});
