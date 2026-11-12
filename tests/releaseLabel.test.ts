// The release in the sidebar's footer, in a real Chrome: just "Nightly" at rest, its whole label as its
// name. Hovered, or focused from the keyboard, the version opens out beside it (the window widening, the
// version fading up behind it) and folds away again after; on a touch screen a tap shows it and another
// tap, or one elsewhere, puts it away. With reduced motion it shows and goes at once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botsSidebar/index.html`, {
    "/api/config": () => Response.json({ mode: "local", release: { channel: "nightly", version: "0.1.10" } }),
  });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const LABEL = "document.querySelector('.release-label')";

/** The OpenBots sidebar at a desktop's size, or a phone's. `before` runs on the blank tab, to emulate media first. */
const open = async (phone = false, before?: (page: Page) => Promise<unknown>) => {
  const page = await Page.open(chrome!.ws, "about:blank", phone ? 390 : 1100, phone ? 760 : 800, "true");
  await before?.(page);
  await page.send("Page.navigate", { url: server!.url.href });
  await page.until(`!!${LABEL}`, 15_000);
  // A phone starts with the list put away: slide it on, as its menu button would. Only once the store
  // has hydrated, since hydrating closes it again on a phone.
  if (phone) {
    await page.eval("store.persist.hasHydrated() || new Promise((resolve) => { const off = store.persist.onFinishHydration(() => { off(); resolve(true); }); })");
    await page.eval("store.setState({ botsSidebarOpen: true })");
    await page.until("!!document.querySelector('.bots-sidebar.sidebar-open')");
  }
  await page.settle();
  await page.eval("Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {}))).then(() => true)");
  return page;
};

/** Until the label's transitions have finished. */
const done = (page: Page) =>
  page.eval(`Promise.all(${LABEL}.getAnimations({ subtree: true }).filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {}))).then(() => true)`);

type Label = { name: string | null; text: string; window: number; version: number; opacity: number; height: number; transitions: number };
const label = (page: Page) =>
  page.eval<Label>(`(() => {
    const l = ${LABEL}, w = l.querySelector('.release-version'), v = w.querySelector(':scope > span > span');
    return {
      name: l.getAttribute('aria-label'), text: l.textContent,
      window: w.getBoundingClientRect().width, version: v.getBoundingClientRect().width,
      opacity: Number(getComputedStyle(v).opacity), height: l.getBoundingClientRect().height,
      transitions: l.getAnimations({ subtree: true }).filter((a) => a instanceof CSSTransition && a.playState === 'running').length,
    };
  })()`);

const center = (page: Page) => page.eval<[number, number]>(`(() => { const r = ${LABEL}.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
const hover = async (page: Page) => {
  const [x, y] = await center(page);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
};
const leave = (page: Page) => page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 100 });
const tap = async (page: Page, at?: [number, number]) => {
  const [x, y] = at ?? (await center(page));
  await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.settle();
};

const folded = (l: Label) => {
  expect(l.window).toBeLessThan(1);
  expect(l.opacity).toBe(0);
};
const shown = (l: Label) => {
  // The version uncovered whole, not squeezed.
  expect(l.window).toBeGreaterThan(10);
  expect(l.window).toBeGreaterThanOrEqual(l.version - 0.5);
  expect(l.opacity).toBe(1);
};

describe.skipIf(!browser)("the release in the sidebar's footer", () => {
  test("is just the channel at rest, named in full, and opens out to the version on hover and folds away after", async () => {
    const page = await open();
    const rest = await label(page);
    expect(rest.name).toBe("Nightly 0.1.10");
    folded(rest);

    await hover(page);
    // It animates there rather than jumping.
    await page.settle();
    expect((await label(page)).transitions).toBeGreaterThan(0);
    await done(page);
    const hovered = await label(page);
    shown(hovered);
    expect(hovered.height).toBe(rest.height);

    await leave(page);
    await page.settle();
    expect((await label(page)).transitions).toBeGreaterThan(0);
    await done(page);
    folded(await label(page));
  }, 20_000);

  test("opens out when focused from the keyboard", async () => {
    const page = await open();
    // Tab through the footer until the label has focus, as a keyboard user would.
    for (let i = 0; i < 60 && !(await page.eval<boolean>(`document.activeElement === ${LABEL}`)); i++) {
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    }
    expect(await page.eval<boolean>(`${LABEL}.matches(':focus-visible')`)).toBe(true);
    await page.settle();
    await done(page);
    shown(await label(page));
  }, 20_000);

  test("on a phone, a tap shows the version and another tap, or one elsewhere, puts it away", async () => {
    const page = await open(true, (p) => p.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }));
    expect(await page.eval<boolean>("matchMedia('(hover: none)').matches")).toBe(true);
    folded(await label(page));

    await tap(page);
    await done(page);
    shown(await label(page));
    // Its own line under the footer's buttons, inside the sidebar.
    const [right, width] = await page.eval<[number, number]>(`[${LABEL}.querySelector('.release-version').getBoundingClientRect().right, document.querySelector('.settings-row').getBoundingClientRect().right]`);
    expect(right).toBeLessThanOrEqual(width);

    await tap(page);
    await done(page);
    folded(await label(page));

    await tap(page);
    await done(page);
    shown(await label(page));
    await tap(page, [200, 120]);
    await done(page);
    folded(await label(page));
  }, 20_000);

  test("with reduced motion, shows and goes at once", async () => {
    const page = await open(false, (p) => p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }));
    await hover(page);
    await page.settle();
    const hovered = await label(page);
    expect(hovered.transitions).toBe(0);
    shown(hovered);
    await leave(page);
    await page.settle();
    const left = await label(page);
    expect(left.transitions).toBe(0);
    folded(left);
  }, 20_000);
});
