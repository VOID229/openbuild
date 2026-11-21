// The bots' glyph beside "Bots" in Settings' nav is an icon like the others there: it holds still,
// under the mouse too. Only the bots themselves (their mascots) blink and look about.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { browser, launchChrome, Page } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/settingsBack/index.html")).default;
  server = Bun.serve({
    port: 0,
    development: false,
    routes: {
      "/": page,
      "/api/*": () => Response.json({ error: "not here" }, { status: 404 }),
    },
  });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

const ROW = `[...document.querySelectorAll('.settings-nav-item')].find((b) => b.textContent.trim() === 'Bots')`;

/** How many animations and transitions the glyph's eyes have (the icon's colour may ease, as any icon's does), and each eye's transform as drawn. */
const glyph = (page: Page) =>
  page.eval<{ moving: number; eyes: string[] }>(`(() => {
    const svg = ${ROW}.querySelector('svg.bots-glyph');
    return {
      moving: svg.querySelector('.bots-glyph-eyes').getAnimations({ subtree: true }).length,
      eyes: [...svg.querySelectorAll('.bots-glyph-eyes rect')].map((r) => getComputedStyle(r).transform),
    };
  })()`);

test.skipIf(!browser)("the Bots icon in Settings' nav holds still, at rest and under the mouse", async () => {
  const page = await Page.open(chrome!.ws, server!.url.href, 1000, 700, "!!window.store");
  await page.eval(`store.getState().openSettings("general")`);
  await page.until("!!document.querySelector('.settings-nav svg.bots-glyph')");
  await page.emulateHover();
  await page.finish();
  // At rest: nothing running on it, and the eyes as drawn.
  const still = await glyph(page);
  expect(still.moving).toBe(0);
  expect(still.eyes).toHaveLength(2);

  // The mouse on the row, as a person would put it there.
  const [x, y] = await page.eval<[number, number]>(`(() => { const r = ${ROW}.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.until(`${ROW}.matches(':hover')`);
  await page.settle();
  // No animation or transition starts on the glyph, so its eyes stay where they are.
  expect(await glyph(page)).toEqual(still);
}, 30_000);
