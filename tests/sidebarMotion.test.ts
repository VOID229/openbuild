// How the sidebars move, sampled every frame in a real Chrome with the whole app on a fake server
// (fixtures/groupThreads): going into OpenBots, its sidebar fades in once and never flickers after;
// closing OpenBots' sidebar is one motion, its list fading away over the rail as it narrows, never
// blank in between.
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

type Frame = { t: number; opacity: number; listOpacity: number; list: boolean; rail: boolean; width: number };

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
      const list = aside?.querySelector('.bots-sidebar-inner'), rail = aside?.querySelector('.bots-rail-inner');
      // What shows: the list, or the rail under it, whichever is more opaque.
      const inner = list && rail ? (op(list) >= op(rail) ? list : rail) : list ?? rail;
      const shown = aside && getComputedStyle(aside).display !== 'none' && aside.getBoundingClientRect().width > 0;
      frames.push({
        t: performance.now() - start,
        opacity: shown ? op(aside) * op(inner) : 0,
        listOpacity: list ? op(list) : 0,
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

  test("both sidebars are one width, with their wordmarks the same size in the same place", async () => {
    const page = await Page.open(chrome!.ws, server!.url.href, 1280, 800, READY);
    const mark = () =>
      page.eval<{ text: string; center: number; top: number; size: string; sidebar: number }>(`(() => {
        const el = [...document.querySelectorAll('.sidebar .wordmark')].find((w) => w.getBoundingClientRect().width > 0);
        const r = el.getBoundingClientRect();
        return { text: el.textContent, center: Math.round(r.left + r.width / 2), top: Math.round(r.top), size: getComputedStyle(el).fontSize, sidebar: Math.round(el.closest('.sidebar').getBoundingClientRect().width) };
      })()`);
    await page.eval("store.setState({ botsOpen: false, sidebarOpen: true })");
    await page.settle();
    const build = await mark();
    await page.eval("store.setState({ botsOpen: true, botsSidebarOpen: true })");
    await page.until("[...document.querySelectorAll('.bots-sidebar .wordmark')].some((w) => w.getBoundingClientRect().width > 0)");
    await page.settle();
    const bots = await mark();
    expect([build.text, bots.text]).toEqual(["OpenBuild", "OpenBots"]);
    expect(bots.sidebar).toBe(build.sidebar);
    expect(bots.center).toBe(build.center);
    expect(bots.top).toBe(build.top);
    expect(build.size).toBe("18px");
    expect(bots.size).toBe("18px");
  }, 60_000);

  test("closing OpenBots' sidebar fades the list away over the rail as it narrows", async () => {
    const page = await Page.open(chrome!.ws, `${server!.url.href}bots`, 1280, 800, READY);
    await page.eval("store.setState({ botsOpen: true, botsSidebarOpen: true })");
    await page.settle();
    const frames = await sample(page, `document.querySelector('.bots-sidebar [aria-label="Close sidebar"]').click()`, 800);
    const early = frames.filter((f) => f.t > 40 && f.t < 150);
    expect(early.length).toBeGreaterThan(0);
    // One motion: from the first frames the rail is there under the list, which fades out over it as
    // the sidebar narrows. The sidebar never goes blank in between.
    expect(frames.every((f) => f.rail)).toBe(true);
    expect(early.every((f) => f.list)).toBe(true);
    const full = Math.max(...frames.map((f) => f.width));
    expect(early.some((f) => f.width > 100 && f.width < full - 8)).toBe(true);
    expect(early.some((f) => f.listOpacity < 1)).toBe(true);
    expect(frames.every((f) => f.opacity > 0.3)).toBe(true);
    // Then the rail, at its own width.
    const last = frames.at(-1)!;
    expect(last).toMatchObject({ rail: true, list: false, width: 84 });
    expect(await page.eval<boolean>("store.getState().botsSidebarOpen")).toBe(false);
  }, 60_000);
});
