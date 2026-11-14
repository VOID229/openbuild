// The big mascot in a bot's details panel, in a real Chrome (the real OpenBots pane, from
// fixtures/botDetails): it follows the pointer while the pointer is over the panel, quick and direct
// as bots always followed it, and pays it no mind anywhere else; when the pointer leaves the panel it
// lets go, easing back to rest over many frames rather than snapping there. And it does nothing else:
// no blinks, looks, faces or moves of its own, and none when the bot types (a squint) or is pleased
// (a happy face, a jelly).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEPTH } from "../src/lib/bots/rig";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botDetails/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const BOT = "document.querySelector('.bots-details-avatar .bot')";

/** Everything its layers were given, as one string: the same string, the same stance. */
const LAYERS = `[...(${BOT}).querySelectorAll('.bot-whole, .bot-body, .bot-eye')].map((el) => el.style.transform).join(' | ')`;

/**
 * Each frame from now on (in `window.frames`): where its eyes have slid to across the body (between
 * the two, in px), how far round that turns its head (the face stands DEPTH units off the body, near
 * enough), and anything else on it: a move, a face, a blink, a look of its own, a form of eye.
 */
const RECORD = `(() => {
  const b = ${BOT};
  window.frames = [];
  const tick = () => {
    const eyes = [...b.querySelectorAll('.bot-eye')].map((e) => /matrix\\(([^)]+)\\)/.exec(e.style.transform)?.[1].split(',').map(Number) ?? [1, 0, 0, 1, 0, 0]);
    const [x, y] = [(eyes[0][4] + eyes[1][4]) / 2, (eyes[0][5] + eyes[1][5]) / 2];
    const unit = b.offsetWidth / 100, turn = (px) => Math.asin(Math.max(-1, Math.min(1, px / unit / ${DEPTH + 1}))) * 180 / Math.PI;
    window.frames.push({ at: performance.now(), x, yaw: turn(x), pitch: turn(y), layers: ${LAYERS}, tracking: 'tracking' in b.dataset, action: b.dataset.action ?? null, mood: b.dataset.mood, blink: 'blink' in b.dataset, looking: 'looking' in b.dataset, eyes: b.dataset.eyes ?? null });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`;

type Frame = { at: number; x: number; yaw: number; pitch: number; layers: string; tracking: boolean; action: string | null; mood: string; blink: boolean; looking: boolean; eyes: string | null };
const frames = (page: Page) => page.eval<Frame[]>("window.frames.splice(0)");

/** Waits until the mascot has held quite still for 400 ms: every layer where it was. */
const settled = (page: Page) =>
  page.until(`(() => {
    const now = ${LAYERS}, state = (window.holding ??= {});
    if (state.seen !== now) Object.assign(state, { seen: now, since: performance.now() });
    return performance.now() - state.since >= 400;
  })()`, 8000);

const move = (page: Page, x: number, y: number) => page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });

describe.skipIf(!browser)("the details panel's mascot", () => {
  test("follows the pointer about the panel only, lets go as it leaves, and plays nothing of its own", async () => {
    const page = await Page.open(chrome!.ws, `${server!.url.href}?chat=dm`, 1100, 800, "!!document.querySelector('.bots-view')");
    await page.eval("openBotsDetails(), true");
    await page.until(`!!document.querySelector('.bots-details-open') && !!${BOT}`);
    await page.finish(".bots-details");
    const box = await page.eval<{ panel: { l: number; r: number; t: number; b: number }; bot: { x: number; y: number } }>(`(() => {
      const p = document.querySelector('.bots-details').getBoundingClientRect(), b = (${BOT}).getBoundingClientRect();
      return { panel: { l: p.left, r: p.right, t: p.top, b: Math.min(p.bottom, innerHeight) }, bot: { x: b.left + b.width / 2, y: b.top + b.height / 2 } };
    })()`);
    const rest = await page.eval<string>(LAYERS);
    await page.eval(RECORD);
    const all: Frame[] = [];
    const take = async () => {
      const got = await frames(page);
      all.push(...got);
      return got;
    };

    // Over the chat, beside the panel: it pays the pointer no mind, held at rest.
    await move(page, box.panel.l - 200, box.bot.y);
    await Bun.sleep(400);
    let seen = await take();
    expect(seen.length).toBeGreaterThan(5);
    for (const f of seen) expect({ layers: f.layers, tracking: f.tracking }).toEqual({ layers: rest, tracking: false });

    // Into the panel, level with it on the left: it turns that way, quick and direct.
    await move(page, box.panel.l + 6, box.bot.y);
    await settled(page);
    seen = await take();
    const left = seen.at(-1)!;
    expect(left.tracking).toBe(true);
    expect(left.yaw).toBeLessThan(-8);
    // Most of the way there within a sixth of a second of setting off (wherever frames came often
    // enough to tell: a starved machine's springs are stepped in long frames, and run slow).
    const off = seen.findIndex((f) => f.layers !== rest);
    const x0 = seen[0]!.x;
    const gaps = seen.slice(off + 1, off + 12).map((f, i) => f.at - seen[off + i]!.at);
    const soon = seen.find((f) => f.at >= seen[off]!.at + 150)!;
    if (Math.max(...gaps) < 40) expect((soon.x - x0) / (left.x - x0)).toBeGreaterThan(0.75);

    // Across the panel, below it on the right: round it comes, to the right and down.
    await move(page, box.panel.r - 6, box.panel.b - 6);
    await settled(page);
    const right = (await take()).at(-1)!;
    expect(right.tracking).toBe(true);
    expect(right.yaw).toBeGreaterThan(8);
    expect(right.pitch).toBeGreaterThan(3);

    // The bot types and is pleased, the pointer still on the panel: no squint, no happy face, no move.
    await page.eval("bots.getState().setTyping('dm', 'egg', true), bots.getState().pulse('egg', 'happy'), bots.setState((s) => ({ pulses: { egg: { key: (s.pulses.egg?.key ?? 0) + 1, action: 'spin' } } })), true");
    await Bun.sleep(1200);
    await page.eval("bots.getState().setTyping('dm', 'egg', false), true");
    seen = await take();
    expect(seen.at(-1)!.layers).toBe(right.layers);

    // Out of the panel, over the chat: it lets go and eases back to rest, over many frames, never in a jump.
    await move(page, box.panel.l - 200, box.bot.y);
    await settled(page);
    const back = await take();
    expect(back.at(-1)!.layers).toBe(rest);
    expect(back.at(-1)!.tracking).toBe(false);
    const going = back.slice(0, back.findIndex((f) => f.layers === rest) + 1).filter((f, i, all) => i === 0 || f.layers !== all[i - 1]!.layers);
    expect(going.length).toBeGreaterThan(8);
    const span = Math.abs(back.at(-1)!.x - right.x);
    for (let i = 1; i < going.length; i++) expect(Math.abs(going[i]!.x - going[i - 1]!.x)).toBeLessThan(span * 0.3);

    // And all along, nothing of its own: no move, face, blink, look or other eyes.
    for (const f of all) expect({ action: f.action, mood: f.mood, blink: f.blink, looking: f.looking, eyes: f.eyes }).toEqual({ action: null, mood: "idle", blink: false, looking: false, eyes: null });

    // Back over the panel, it takes the pointer up again.
    await move(page, box.panel.l + 6, box.bot.y);
    await settled(page);
    const again = (await take()).at(-1)!;
    expect(again.tracking).toBe(true);
    expect(again.layers).toBe(left.layers);
  }, 40_000);
});
