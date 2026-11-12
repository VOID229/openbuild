// OpenBots' details panel never scrolls sideways, in a real Chrome on a desktop and on phones: on every
// tab of a bot's details and a group's, nothing in the panel is wider than it, while the mascot leans
// after a pointer at the window's edges and plays its moves too, and a sideways wheel or swipe over it
// moves nothing. The tabs fit with their labels whole, in the mono font too; where they can't (a 280px
// screen), they end in an ellipsis instead. Text fields scroll their own text, as they do anywhere. The
// fixture (fixtures/botDetails/page.tsx) fills the panel with words too long to wrap.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

/**
 * In the page: what in the panel is wider than it, or could scroll sideways (a box whose content is
 * wider than it is, clipped or not). Text fields, and labels that end in an ellipsis, only clip their
 * own text. Kept in `window.wide` across calls, so it can be sampled every frame of a move.
 */
const MEASURE = `window.measure = () => {
  const panel = document.querySelector('.bots-details');
  const box = panel.getBoundingClientRect();
  const left = box.left + panel.clientLeft, right = left + panel.clientWidth;
  const name = (el) => el.tagName.toLowerCase() + [...el.classList].map((c) => '.' + c).join('');
  for (const el of [panel, ...panel.querySelectorAll('*')]) {
    const r = el.getBoundingClientRect();
    if (r.width && el !== panel && (r.left < left - 0.5 || r.right > right + 0.5)) window.wide.add(name(el) + ' sticks out ' + (r.left < left - 0.5 ? left - r.left : r.right - right).toFixed(1) + 'px');
    if (el.matches('input, textarea')) continue;
    const s = getComputedStyle(el);
    if (s.overflowX !== 'visible' && s.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth) window.wide.add(name(el) + ' is ' + (el.scrollWidth - el.clientWidth) + 'px too narrow for its content');
  }
}; window.wide = new Set(); true`;

const wide = (page: Page) => page.eval<string[]>("window.measure(), [...window.wide]");

/** Every frame for `ms`: the mascot in motion. */
const watch = (page: Page, ms: number) =>
  page.eval<string[]>(`new Promise((done) => { const end = performance.now() + ${ms}; const tick = () => { window.measure(); if (performance.now() < end) requestAnimationFrame(tick); else done([...window.wide]); }; tick(); })`);

/** Where everything that could scroll sideways is scrolled to, text fields aside. */
const scrolled = (page: Page) =>
  page.eval<string[]>("[document.scrollingElement, ...document.querySelectorAll('*')].filter((el) => el.scrollLeft && !el.matches('input, textarea')).map((el) => el.className + ': ' + el.scrollLeft)");

const open = async (chat: string, width: number, height: number, font?: string) => {
  const page = await Page.open(chrome!.ws, `${server!.url.href}?chat=${chat}${font ? `&font=${font}` : ""}`, width, height, "!!document.querySelector('.bots-view')");
  await page.eval("document.fonts.ready.then(() => true)");
  await page.eval("openBotsDetails(), true");
  await page.until("!!document.querySelector('.bots-details-open .bots-tabs')");
  await page.finish(".bots-details");
  await page.eval(MEASURE);
  return page;
};

/** Each tab in turn, the ones under More too, with its name. */
async function* tabs(page: Page) {
  for (const label of await page.eval<string[]>("[...document.querySelectorAll('.bots-details .bots-tab:not(.bots-tab-more)')].map((t) => t.textContent)")) {
    await page.eval(`[...document.querySelectorAll('.bots-details .bots-tab')].find((t) => t.textContent === ${JSON.stringify(label)}).click(), true`);
    await page.settle();
    yield label;
  }
  if (!(await page.eval<boolean>("!!document.querySelector('.bots-details .bots-tab-more')"))) return;
  await page.click(".bots-details .bots-tab-more");
  for (const label of await page.eval<string[]>("[...document.querySelectorAll('.bots-tab-menu .menu-item')].map((t) => t.textContent)")) {
    if (!(await page.eval<boolean>("!!document.querySelector('.bots-tab-menu')"))) await page.click(".bots-details .bots-tab-more");
    await page.eval(`[...document.querySelectorAll('.bots-tab-menu .menu-item')].find((t) => t.textContent === ${JSON.stringify(label)}).click(), true`);
    await page.settle();
    yield label;
  }
}

const DEVICES = [["desktop", 1280, 860], ["phone", 390, 844], ["narrow phone", 320, 640]] as const;

describe.skipIf(!browser)("the details panel never scrolls sideways", () => {
  for (const [device, width, height] of DEVICES) {
    test(`on a ${device}: nothing on a bot's tabs is wider than the panel, the tabs fit, and the mascot stays inside it`, async () => {
      const page = await open("dm", width, height);
      const seen: string[] = [];
      for await (const tab of tabs(page)) {
        seen.push(tab);
        expect({ tab, wide: await wide(page) }).toEqual({ tab, wide: [] });
      }
      expect(seen).toEqual(["Instructions", "Routines", "Tasks", "Advanced"]);
      // Every tab shows its whole label.
      expect(await page.eval<unknown>("[...document.querySelectorAll('.bots-details .bots-tab')].filter((t) => t.scrollWidth > t.clientWidth).map((t) => t.textContent)")).toEqual([]);
      // The mascot leaning after a pointer at each of the window's edges, and playing each of its moves.
      for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
        await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        expect(await watch(page, 300)).toEqual([]);
      }
      for (const action of ["spin", "wiggle", "squish", "nod", "stretch"]) {
        await page.eval(`bots.setState((s) => ({ pulses: { egg: { key: (s.pulses.egg?.key ?? 0) + 1, action: ${JSON.stringify(action)} } } })), true`);
        expect({ action, wide: await watch(page, 500) }).toEqual({ action, wide: [] });
      }
    }, 60_000);

    test(`on a ${device}: nothing on a group's tabs is wider than the panel`, async () => {
      const page = await open("crew", width, height);
      const seen: string[] = [];
      for await (const tab of tabs(page)) {
        seen.push(tab);
        expect({ tab, wide: await wide(page) }).toEqual({ tab, wide: [] });
      }
      expect(seen).toEqual(["Members 2", "Goal", "Threads"]);
    }, 60_000);

    test(`on a ${device}: a sideways wheel or swipe over the panel moves nothing`, async () => {
      const page = await open("dm", width, height);
      for (const target of [".bots-details-avatar", ".bots-details-name", ".bots-tabs", ".bots-instructions", ".bots-details-foot"]) {
        const [x, y] = await page.eval<[number, number]>(`(() => { const r = document.querySelector(${JSON.stringify(target)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
        await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 240, deltaY: 0 });
        await page.settle();
        expect({ target, scrolled: await scrolled(page) }).toEqual({ target, scrolled: [] });
      }
      // Nor does a script or a focus that asks the panel to show its edge.
      await page.eval("document.querySelector('.bots-details').scrollLeft = 50; document.querySelector('.bots-details-scroll').scrollLeft = 50; document.querySelector('.bots-instructions').focus(), true");
      await page.settle();
      expect(await scrolled(page)).toEqual([]);
    }, 60_000);
  }

  // The widest face the app offers still fits a narrow phone's tabs whole.
  test("with the mono font on a narrow phone, every tab still shows its whole label", async () => {
    const page = await open("dm", 320, 640, "mono");
    expect(await page.eval<string>("getComputedStyle(document.querySelector('.bots-tab')).fontFamily")).toContain("Geist Mono");
    expect(await page.eval<unknown>("[...document.querySelectorAll('.bots-details .bots-tab')].filter((t) => t.scrollWidth > t.clientWidth).map((t) => t.textContent)")).toEqual([]);
    expect(await wide(page)).toEqual([]);
  }, 60_000);

  // Narrower still (a folded phone's cover screen) they don't fit: they give up the ends of their labels
  // to an ellipsis, and the row still doesn't scroll.
  test("on a 280px screen, the tabs end in an ellipsis rather than scroll", async () => {
    const page = await open("dm", 280, 640);
    expect(await page.eval<number>("[...document.querySelectorAll('.bots-details .bots-tab')].filter((t) => t.scrollWidth > t.clientWidth).length")).toBeGreaterThan(0);
    expect(await page.eval<unknown>("(() => { const row = document.querySelector('.bots-details .bots-tabs'); return row.scrollWidth - row.clientWidth; })()")).toBe(0);
    expect(await wide(page)).toEqual([]);
  }, 60_000);
});
