// The reaction picker, in a real Chrome: every reaction stays inside the window and reachable,
// wherever the message sits and however narrow the screen, before and after "more" is opened.
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

const open = async (width: number, height: number) => {
  const page = await Page.open(chrome!.ws, server!.url.href, width, height, "!!document.querySelector('.bm-group, .bots-messages')");
  await page.eval(`bots.getState().select("a")`);
  await page.until(`document.querySelector('[data-id="a-39"]') !== null`);
  await page.settle();
  return page;
};

/** Opens the picker from the React button of the message `id`. */
const react = async (page: Page, id: string, block: ScrollLogicalPosition = "center") => {
  await page.eval(`document.querySelector('[data-id="${id}"]').scrollIntoView({ block: ${JSON.stringify(block)} })`);
  await page.settle();
  await page.eval(`document.querySelector('[data-id="${id}"] button[aria-label="React"]').click()`);
  await page.until(`!!document.querySelector('.bm-react-pop')`);
  await Bun.sleep(400);
  await page.settle();
};

/** How far the picker and its buttons overshoot the window, and how many buttons there are. */
const bounds = (page: Page) =>
  page.eval<{ count: number; left: number; right: number; top: number; bottom: number; pop: { left: number; right: number; top: number; bottom: number }; scroll: boolean }>(`(() => {
    const pop = document.querySelector('.bm-react-pop');
    const p = pop.getBoundingClientRect();
    const rects = [...pop.querySelectorAll('.bm-react-btn')].map((b) => b.getBoundingClientRect());
    return {
      count: rects.length,
      left: Math.min(...rects.map((r) => r.left)),
      right: Math.max(...rects.map((r) => r.right)),
      top: Math.min(...rects.map((r) => r.top)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
      pop: { left: p.left, right: p.right, top: p.top, bottom: p.bottom },
      scroll: pop.scrollHeight > pop.clientHeight,
    };
  })()`);

describe.skipIf(!browser)("the reaction picker", () => {
  // a-39 is the manager's (left); a-38 is mine (right). Narrow widths include a small phone.
  for (const width of [1000, 600, 390, 320]) {
    for (const [side, id] of [["left", "a-39"], ["right", "a-38"]] as const) {
      test(`keeps every reaction in the window, ${side} message at ${width}px`, async () => {
        const page = await open(width, 700);
        await react(page, id);
        const quick = await bounds(page);
        expect(quick.pop.left).toBeGreaterThanOrEqual(0);
        expect(quick.pop.right).toBeLessThanOrEqual(width);
        expect(quick.right).toBeLessThanOrEqual(width);
        await page.click('.bm-react-pop .bm-react-more');
        await page.settle();
        const all = await bounds(page);
        expect(all.count).toBeGreaterThan(quick.count);
        expect(all.pop.left).toBeGreaterThanOrEqual(0);
        expect(all.pop.right).toBeLessThanOrEqual(width);
        expect(all.left).toBeGreaterThanOrEqual(0);
        expect(all.right).toBeLessThanOrEqual(width);
        expect(all.pop.top).toBeGreaterThanOrEqual(0);
        expect(all.pop.bottom).toBeLessThanOrEqual(700);
      }, 60_000);
    }
  }

  for (const block of ["start", "end"] as const) {
    test(`keeps it inside the window with the message at the ${block === "start" ? "top" : "bottom"} edge`, async () => {
      const page = await open(390, 700);
      await react(page, "a-30", block);
      await page.click('.bm-react-pop .bm-react-more');
      await page.settle();
      const all = await bounds(page);
      expect(all.pop.top).toBeGreaterThanOrEqual(0);
      expect(all.pop.bottom).toBeLessThanOrEqual(700);
      expect(all.pop.left).toBeGreaterThanOrEqual(0);
      expect(all.pop.right).toBeLessThanOrEqual(390);
    }, 60_000);
  }

  test("scrolls inside the window when it is too short for every reaction", async () => {
    const page = await open(390, 200);
    await react(page, "a-39");
    await page.click('.bm-react-pop .bm-react-more');
    await page.settle();
    const all = await bounds(page);
    expect(all.pop.top).toBeGreaterThanOrEqual(0);
    expect(all.pop.bottom).toBeLessThanOrEqual(200);
    expect(all.scroll).toBe(true);
  }, 60_000);
});
