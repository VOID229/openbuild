// The look pickers in a real Chrome: in the New bot dialog and the details panel's Look editor, on a
// phone, a laptop and a tall screen, every shape's eyes sit inside it, clear of its rim; and so do
// they in every face a still bot pulls. (That they do however a bot turns is
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

  test("in every face a still bot pulls, every shape's eyes sit clear of its rim", async () => {
    const page = await open("gallery", 1100, 900, 13 * 7);
    // A face at a time: it takes a while to look at them all.
    for (const mood of ["idle", "happy", "love", "thinking", "surprised", "sleepy", "wink"]) expect(await tooNear(page, `[data-mood="${mood}"]`, CLEAR)).toEqual([]);
  }, 60_000);
});
