// The look pickers in a real Chrome: in the New bot dialog and the details panel's Look editor, on a
// phone, a laptop and a tall screen, every shape's eyes sit inside it, clear of its rim; and so do
// they in every face a still bot pulls. The dialog's preview is only the shape picked: it blinks and
// follows the pointer, and pulls no tricks. (That they do however a bot turns is
// tests/botMascotRig.test.ts's, in arithmetic.)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MARGIN } from "../src/lib/bots/rig";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botLookPicker/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const open = async (view: string, width: number, height: number, count = 13) => {
  const page = await Page.open(chrome!.ws, `${server!.url.href}?view=${view}`, width, height, `document.querySelectorAll('${view === "gallery" ? "#gallery" : ".bots-shapes"} .bot').length === ${count}`);
  await page.settle();
  return page;
};

/**
 * In the page: the bots under `scope` whose eyes come within `margin` units (of the bot's 100-unit
 * box) of its rim. With the cut to the body's outline lifted, so an eye over the edge would show,
 * points across each eye are tried: wherever the eye is, the body must be too, there and `margin`
 * further out from the eye's middle.
 */
const tooNear = (page: Page, scope: string, margin: number) =>
  page.eval<string[]>(`(() => {
    const lift = document.createElement('style');
    lift.textContent = '.bot-skin { clip-path: none !important } .bot-skin, .bot-skin * { pointer-events: auto !important } .bot .bot-shape { pointer-events: auto }';
    document.head.append(lift);
    const near = [];
    for (const b of document.querySelectorAll(${JSON.stringify(`${scope} .bot`)})) {
      const body = b.querySelector('.bot-shape');
      const m = (b.getBoundingClientRect().width / 100) * ${margin};
      const name = (b.closest('[aria-label]')?.getAttribute('aria-label') ?? '') + ' ' + (b.closest('[data-mood]')?.dataset.mood ?? '');
      for (const eye of b.querySelectorAll('.bot-eye-fill, .bot-eye-heart path')) {
        const r = eye.getBoundingClientRect();
        let bad = false;
        for (let i = 0; i <= 5 && !bad; i++)
          for (let j = 0; j <= 5 && !bad; j++) {
            const [x, y] = [r.left + (r.width * i) / 5, r.top + (r.height * j) / 5];
            const here = document.elementsFromPoint(x, y);
            if (!here.some((h) => h === eye || eye.contains(h))) continue;
            const [ox, oy] = [x - (r.left + r.width / 2), y - (r.top + r.height / 2)];
            const n = Math.hypot(ox, oy) || 1;
            if (!here.includes(body) || !document.elementsFromPoint(x + (ox / n) * m, y + (oy / n) * m).includes(body)) bad = true;
          }
        if (bad) near.push(name.trim());
      }
    }
    lift.remove();
    return [...new Set(near)];
  })()`);

// Measured on the screen, a little short of MARGIN: a pixel is 2.5 of its units here.
const CLEAR = MARGIN - 1.5;

describe.skipIf(!browser)("the look pickers", () => {
  for (const [label, width, height] of [["a phone", 390, 844], ["a laptop", 1280, 800], ["a tall screen", 1280, 1100]] as const) {
    test(`in the New bot dialog on ${label}, every shape's eyes sit clear of its rim`, async () => {
      const page = await open("dialog", width, height);
      // As in the screenshot this was found in: the house picked, in purple.
      // (One at a time: each change is made to the look as it was last drawn.)
      await page.eval(`document.querySelector('.bots-shapes [aria-label="House"]').click()`);
      await page.until(`document.querySelector('.bots-shapes [aria-label="House"]').getAttribute('aria-checked') === 'true'`);
      await page.eval(`document.querySelector('.bots-colors [aria-label="Purple"]').click()`);
      await page.until(`document.querySelector('.bots-colors [aria-label="Purple"]').getAttribute('aria-checked') === 'true' && document.querySelector('.bots-shapes [aria-label="House"]').getAttribute('aria-checked') === 'true'`);
      await page.settle();
      expect(await tooNear(page, ".bots-shapes", CLEAR)).toEqual([]);
    });

    test(`in the details panel's Look editor on ${label}, every shape's eyes sit clear of its rim`, async () => {
      const page = await open("editor", width, height);
      expect(await tooNear(page, ".bots-shapes", CLEAR)).toEqual([]);
    });
  }

  test("in the New bot dialog, the preview is just the shape picked: it blinks and follows the pointer, and pulls no tricks", async () => {
    const page = await open("dialog", 1280, 800);
    const hero = "document.querySelector('.bots-dialog-hero .bot')";
    // Everything it does from here on: any move played, face pulled, pose taken or blink.
    await page.eval(`(() => {
      const b = ${hero}, seen = (window.seen = { actions: [], moods: [], looking: 0, blinks: 0, playful: b.classList.contains('bot-playful') });
      new MutationObserver(() => {
        if (b.dataset.action) seen.actions.push(b.dataset.action);
        if (b.dataset.mood !== 'idle') seen.moods.push(b.dataset.mood);
        if ('looking' in b.dataset) seen.looking++;
        if ('blink' in b.dataset) seen.blinks++;
      }).observe(b, { attributes: true });
    })()`);
    const [x, y, w] = await page.eval<[number, number, number]>(`(() => { const r = (${hero}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, r.width]; })()`);
    const turn = () => page.eval<number>(`Number((/rotateY\\((-?[\\d.]+)deg\\)/.exec((${hero}).querySelector('.bot-body').style.transform) ?? [0, 0])[1])`);
    const settleAt = async (px: number, py: number) => {
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py });
      await Bun.sleep(900);
    };
    // Following the pointer: it turns toward wherever it is.
    await settleAt(x - w * 3, y);
    const left = await turn();
    await settleAt(x + w * 3, y);
    const right = await turn();
    expect(left).toBeLessThan(-5);
    expect(right).toBeGreaterThan(5);
    // Hovered and pressed: no nod, smile or turn right round.
    await settleAt(x, y);
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    // A new shape and colour picked: it's simply that shape, with no reaction played over it.
    await page.eval(`document.querySelector('.bots-shapes [aria-label="House"]').click()`);
    await page.until(`(${hero}).querySelector('.bot-shape').getAttribute('d') === document.querySelector('.bots-shapes [aria-label="House"] .bot-shape').getAttribute('d')`);
    await page.eval(`document.querySelector('.bots-colors [aria-label="Purple"]').click()`);
    // Left alone a while: it blinks, and does nothing else.
    await settleAt(x + w * 3, y - w);
    await Bun.sleep(6500);
    const seen = await page.eval<{ actions: string[]; moods: string[]; looking: number; blinks: number; playful: boolean }>("window.seen");
    expect(seen.actions).toEqual([]);
    expect(seen.moods).toEqual([]);
    expect(seen.looking).toBe(0);
    expect(seen.playful).toBe(false);
    expect(seen.blinks).toBeGreaterThan(0);
    // Still following.
    expect(await turn()).toBeGreaterThan(5);
  }, 30_000);

  test("in every face a still bot pulls, every shape's eyes sit clear of its rim", async () => {
    const page = await open("gallery", 1100, 900, 13 * 7);
    // A face at a time: it takes a while to look at them all.
    for (const mood of ["idle", "happy", "love", "thinking", "surprised", "sleepy", "wink"]) expect(await tooNear(page, `[data-mood="${mood}"]`, CLEAR)).toEqual([]);
  }, 60_000);
});
