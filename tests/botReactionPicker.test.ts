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
  const page = await Page.open(chrome!.ws, server!.url.href, width, height, "!!document.querySelector('.bots-messages')");
  // Headless Chrome reports hover: none, which hides the hover actions: style the page for a mouse,
  // so the real button is there to click, and drop the sync badge that floats over the top of a short window.
  await page.emulateHover();
  await page.eval(`document.head.append(Object.assign(document.createElement("style"), { textContent: ".bots-sync-status { display: none !important; }" }))`);
  await page.eval(`bots.getState().select("a")`);
  await page.until(`document.querySelector('[data-id="a-39"]') !== null`);
  await page.settle();
  return page;
};

/** The React button's box, which has to be a real, visible one. */
const anchorBox = (page: Page, id: string) =>
  page.eval<{ x: number; y: number; width: number; height: number }>(`(() => { const r = document.querySelector('[data-id="${id}"] button[aria-label="React"]').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);

/**
 * Opens the picker as a person does: scroll the message `id`'s bubble to `at` (a y in the window, or the
 * block to scroll to), hover it so its actions show, and click React. Returns the anchor's box.
 */
const react = async (page: Page, id: string, at: ScrollLogicalPosition | number = "center") => {
  if (typeof at === "number") {
    await page.eval(`(() => {
      const el = document.querySelector('.bots-messages');
      const r = document.querySelector('[data-id="${id}"] .bm-bubble').getBoundingClientRect();
      el.scrollTop += r.top + r.height / 2 - ${at};
    })()`);
  } else await page.eval(`document.querySelector('[data-id="${id}"]').scrollIntoView({ block: ${JSON.stringify(at)} })`);
  await page.settle();
  // A point on the message that nothing (the header, the composer) is covering, nearest its middle.
  const [x, y] = await page.eval<[number, number]>(`(() => {
    const r = document.querySelector('[data-id="${id}"] .bm-bubble').getBoundingClientRect();
    const x = r.x + r.width / 2, mid = (Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2;
    for (let d = 0; d < 400; d += 3) for (const y of [mid - d, mid + d]) {
      if (y > r.top && y < r.bottom && document.elementFromPoint(x, y)?.closest('[data-id="${id}"]')) return [x, y];
    }
    throw new Error("the message is covered");
  })()`);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.until(`getComputedStyle(document.querySelector('[data-id="${id}"] button[aria-label="React"]').closest('.bm-actions')).opacity === "1"`);
  const box = await anchorBox(page, id);
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  const hit = await page.eval<string>(`(() => { const r = document.querySelector('[data-id="${id}"] button[aria-label="React"]').getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e?.closest('button')?.getAttribute('aria-label') ?? e?.tagName + '.' + e?.getAttribute('class') + ' in ' + e?.parentElement?.className + ' y=' + (r.y + r.height / 2) + ' win=' + innerHeight; })()`);
  expect(hit).toBe("React");
  await page.click(`[data-id="${id}"] button[aria-label="React"]`);
  await page.until(`!!document.querySelector('.bm-react-pop')`);
  await page.finished('.bm-react-pop');
  return box;
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

const inside = (all: Awaited<ReturnType<typeof bounds>>, width: number, height: number) => {
  expect(all.pop.left).toBeGreaterThanOrEqual(0);
  expect(all.pop.right).toBeLessThanOrEqual(width);
  expect(all.pop.top).toBeGreaterThanOrEqual(0);
  expect(all.pop.bottom).toBeLessThanOrEqual(height);
  expect(all.left).toBeGreaterThanOrEqual(0);
  expect(all.right).toBeLessThanOrEqual(width);
};

describe.skipIf(!browser)("the reaction picker", () => {
  // a-39 is the manager's (left); a-38 is mine (right). A desktop and a small phone: the widths between
  // are walked by the resize test below.
  for (const width of [1000, 320]) {
    for (const [side, id] of [["left", "a-39"], ["right", "a-38"]] as const) {
      test(`keeps every reaction in the window, ${side} message at ${width}px`, async () => {
        const page = await open(width, 700);
        const box = await react(page, id);
        // A real, on-screen anchor: the message's own button, in the window.
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        if (side === "left" && width === 1000) expect(box.x).toBeGreaterThan(width / 2);
        const quick = await bounds(page);
        inside(quick, width, 700);
        await page.click('.bm-react-pop .bm-react-more');
        await page.settle();
        const all = await bounds(page);
        expect(all.count).toBeGreaterThan(quick.count);
        inside(all, width, 700);
      }, 60_000);
    }
  }

  for (const [label, at] of [["top", 90], ["bottom", 600]] as const) {
    test(`keeps it inside the window with the message at the ${label} edge`, async () => {
      const page = await open(390, 700);
      await react(page, "a-30", at);
      await page.click('.bm-react-pop .bm-react-more');
      await page.settle();
      inside(await bounds(page), 390, 700);
    }, 60_000);
  }

  // A window too short for the picker either side of the message: it is capped to what's there and scrolls.
  for (const [label, at] of [["centered", 94], ["near the top", 70], ["near the bottom", 120]] as const) {
    test(`stays inside a 200px window and scrolls, message ${label}`, async () => {
      const page = await open(390, 200);
      const box = await react(page, "a-30", at);
      if (label === "centered") expect(box.y).toBeGreaterThan(70);
      expect(box.y + box.height).toBeLessThan(138);
      await page.click('.bm-react-pop .bm-react-more');
      await page.settle();
      const all = await bounds(page);
      inside(all, 390, 200);
      expect(all.scroll).toBe(true);
    }, 60_000);
  }

  test("moves back inside the window when it is resized while open", async () => {
    const page = await open(1000, 700);
    await react(page, "a-39");
    await page.click('.bm-react-pop .bm-react-more');
    await page.settle();
    inside(await bounds(page), 1000, 700);
    for (const [w, h] of [[600, 700], [390, 700], [320, 500]] as const) {
      await page.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await page.settle();
      await Bun.sleep(100);
      await page.settle();
      // Still open, so it is the open picker that moved.
      expect(await page.eval<boolean>(`!!document.querySelector('.bm-react-pop')`)).toBe(true);
      inside(await bounds(page), w, h);
    }
  }, 60_000);
});
