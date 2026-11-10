// How the sidebars move, sampled every frame in a real Chrome with the whole app on a fake server
// (fixtures/groupThreads): going into OpenBots, its sidebar fades in once and never flickers after;
// closing OpenBots' sidebar slides its list away as it narrows to the rail, instead of the rail
// replacing it at once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/groupThreads/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page, "/bots": page, "/bots/*": page } });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

const READY = "window.store?.getState().chatsLoaded && window.bots?.getState().loaded";

type Frame = { t: number; opacity: number; list: boolean; rail: boolean; width: number };

/**
 * Runs `action`, then for `ms` records each frame of OpenBots' sidebar: how opaque it shows (its own
 * opacity times its content's), whether the list or the rail is in it, and its width.
 */
const sample = (page: Page, action: string, ms: number) =>
  page.eval<Frame[]>(`new Promise((resolve) => {
    const frames = [];
    const start = performance.now();
    const op = (el) => (el ? Number(getComputedStyle(el).opacity) : 1);
    ${action};
    const tick = () => {
      const aside = document.querySelector('.bots-sidebar');
      const inner = aside?.querySelector('.bots-sidebar-inner, .bots-rail-inner');
      const shown = aside && getComputedStyle(aside).display !== 'none' && aside.getBoundingClientRect().width > 0;
      frames.push({
        t: performance.now() - start,
        opacity: shown ? op(aside) * op(inner) : 0,
        list: !!aside?.querySelector('.bots-sidebar-inner'),
        rail: !!aside?.querySelector('.bots-rail-inner'),
        width: aside ? aside.getBoundingClientRect().width : 0,
      });
      if (performance.now() - start < ${ms}) requestAnimationFrame(tick);
      else resolve(frames);
    };
    requestAnimationFrame(tick);
  })`);

/** The biggest drop in opacity once it has started rising: a flicker, if more than a hair. */
function worstDip(frames: Frame[]) {
  let peak = 0;
  let dip = 0;
  for (const f of frames) {
    peak = Math.max(peak, f.opacity);
    dip = Math.max(dip, peak - f.opacity);
  }
  return dip;
}

describe.skipIf(!browser)("sidebar motion", () => {
  for (const open of [true, false]) {
    test(`into OpenBots, with its sidebar ${open ? "open" : "on the rail"}, it fades in once and stays`, async () => {
      const page = await Page.open(chrome!.ws, server!.url.href, 1280, 800, READY);
      await page.eval(`store.setState({ botsOpen: false, sidebarOpen: true, botsSidebarOpen: ${open} })`);
      await page.settle();
      const frames = await sample(page, `document.querySelector('[aria-label="OpenBots"]').click()`, 700);
      expect(await page.eval<boolean>("store.getState().botsOpen")).toBe(true);
      expect(frames.at(-1)!.opacity).toBe(1);
      expect(frames.every((f) => (open ? f.list : f.rail))).toBe(true);
      // No frame goes back toward transparent once it has come in.
      expect(worstDip(frames)).toBeLessThan(0.02);
    }, 60_000);
  }

  test("closing OpenBots' sidebar slides the list away as it narrows, then shows the rail", async () => {
    const page = await Page.open(chrome!.ws, `${server!.url.href}bots`, 1280, 800, READY);
    await page.eval("store.setState({ botsOpen: true, botsSidebarOpen: true })");
    await page.settle();
    const frames = await sample(page, `document.querySelector('.bots-sidebar [aria-label="Close sidebar"]').click()`, 800);
    const early = frames.filter((f) => f.t > 40 && f.t < 200);
    expect(early.length).toBeGreaterThan(0);
    // While it narrows, the list is still there, fading, in a sidebar between its widths.
    expect(early.every((f) => f.list && !f.rail)).toBe(true);
    expect(early.some((f) => f.width > 100 && f.width < 280)).toBe(true);
    expect(early.some((f) => f.opacity < 1)).toBe(true);
    // Then the rail, at its own width.
    const last = frames.at(-1)!;
    expect(last).toMatchObject({ rail: true, list: false, width: 84 });
    expect(await page.eval<boolean>("store.getState().botsSidebarOpen")).toBe(false);
  }, 60_000);
});
