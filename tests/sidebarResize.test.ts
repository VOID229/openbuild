// The sidebar's edge on a desktop (SidebarGrip.tsx, lib/sidebarWidth.ts): dragged, the sidebar follows
// between its limits and keeps the width across a reload; over the line only the cursor changes; a
// double-click gives the sidebar its own width back. OpenBuild's thread list and OpenBots' list are
// one width, so a width dragged on one is the other's too. And each footer sits evenly between its
// line and the window's bottom edge.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { clampSidebarWidth, loadSidebarWidth, PANE_MIN, saveSidebarWidth, SIDEBAR_MAX, SIDEBAR_MIN, sidebarMax } from "../src/lib/sidebarWidth";
import { browser, launchChrome, Page } from "./chromePage";

describe("sidebar width", () => {
  const store = new Map<string, string>();
  const saved = globalThis.localStorage;
  beforeAll(() => {
    Object.assign(globalThis, { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) } });
  });
  afterAll(() => Object.assign(globalThis, { localStorage: saved }));
  afterEach(() => store.clear());

  test("stays between its smallest and what leaves the pane beside it its room", () => {
    expect(clampSidebarWidth(100, 1600)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(360.4, 1600)).toBe(360);
    expect(clampSidebarWidth(5000, 1600)).toBe(SIDEBAR_MAX);
    expect(sidebarMax(900)).toBe(900 - PANE_MIN);
    // A window too narrow for both still gets the smallest sidebar.
    expect(sidebarMax(600)).toBe(SIDEBAR_MIN);
  });

  test("is the sidebar's own until dragged, and forgets a width that's unreadable or too small", () => {
    expect(loadSidebarWidth()).toBeUndefined();
    saveSidebarWidth(400);
    expect(loadSidebarWidth()).toBe(400);
    saveSidebarWidth(undefined);
    expect(store.size).toBe(0);
    for (const bad of ["nope", "12", "", "-400"]) {
      store.set("openbuild:sidebar-width", bad);
      expect(loadSidebarWidth()).toBeUndefined();
    }
    store.set("openbuild:sidebar-width", "9000");
    expect(loadSidebarWidth()).toBe(SIDEBAR_MAX);
  });
});

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/groupThreads/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page, "/new": page, "/bots": page, "/bots/*": page } });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

const LOADED = "window.store?.getState().chatsLoaded && window.bots?.getState().loaded";
/** The sidebar that's showing: the other side's is hidden, and has no box. */
const ASIDE = "[...document.querySelectorAll('.sidebar.sidebar-open')].find((el) => el.getBoundingClientRect().width > 0)";
const WIDTH = `Math.round(${ASIDE}.getBoundingClientRect().width)`;
const GRIP = "!!document.querySelector('.sidebar-grip')";

/** OpenBots with its list open. Opened at /bots: at / the app's routing could close OpenBots again. */
async function openBots(width = 1280, height = 800) {
  const page = await Page.open(chrome!.ws, `${server!.url.href}bots`, width, height, `${LOADED} && !!document.querySelector('.bots-sidebar-inner')`);
  await page.eval("store.setState({ botsSidebarOpen: true })");
  await page.finish();
  return page;
}

/** OpenBuild's threads, once routing has put the page at /new, so nothing a test sets is undone. */
async function openThreads(width = 1280, height = 800) {
  const page = await Page.open(chrome!.ws, server!.url.href, width, height, `${LOADED} && location.pathname === "/new"`);
  await page.eval("store.getState().setSidebarOpen(true)");
  await page.finish();
  return page;
}

/** Where the line between the sidebar and the main pane is, halfway down. */
const line = (page: Page) => page.eval<[number, number]>(`(() => { const r = document.querySelector('.main').getBoundingClientRect(); return [r.left, r.top + r.height / 2]; })()`);

async function drag(page: Page, by: number) {
  const [x, y] = await line(page);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 4; i++) await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + (by * i) / 4, y, button: "left", buttons: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + by, y, button: "left", buttons: 0, clickCount: 1 });
  await page.finish();
}

describe.skipIf(!browser)("resizing the sidebar", () => {
  test("its edge is the line's own place, and hovered only the cursor changes", async () => {
    const page = await openBots();
    await page.emulateHover();
    const [x, y] = await line(page);
    const look = `(() => {
      const main = getComputedStyle(document.querySelector('.main'));
      const grip = document.querySelector('.sidebar-grip');
      const g = getComputedStyle(grip), after = getComputedStyle(grip, '::after');
      return { line: [main.borderLeftWidth, main.borderLeftColor], grip: [g.backgroundColor, g.boxShadow, g.outlineStyle, after.content], hit: document.elementFromPoint(${x}, ${y})?.className, cursor: g.cursor };
    })()`;
    const before = await page.eval<{ hit: string; cursor: string; grip: string[] }>(look);
    expect(before.hit).toBe("sidebar-grip");
    expect(before.cursor).toBe("col-resize");
    // Nothing of the grip shows: no fill, ring or line of its own.
    expect(before.grip).toEqual(["rgba(0, 0, 0, 0)", "none", "none", "none"]);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await page.settle();
    expect(await page.eval<unknown>(look)).toEqual(before);
    // It's a separator a screen reader can read and set.
    expect(await page.eval<string[]>(`(() => { const g = document.querySelector('.sidebar-grip'); return [g.getAttribute('role'), g.getAttribute('aria-orientation'), g.getAttribute('aria-label')]; })()`)).toEqual(["separator", "vertical", "Resize the sidebar"]);
  }, 60_000);

  test("dragged, the sidebar follows, keeps the width across a reload, and stays inside its limits", async () => {
    const page = await openBots();
    const start = await page.eval<number>(WIDTH);
    await drag(page, 80);
    expect(await page.eval<number>(WIDTH)).toBe(start + 80);
    expect(await page.eval<string>("localStorage.getItem('openbuild:sidebar-width')")).toBe(String(start + 80));
    // The line went with it, and the grip is still on it.
    const [x, y] = await line(page);
    expect(Math.round(x)).toBe(start + 80);
    expect(await page.eval<string>(`document.elementFromPoint(${x}, ${y})?.className`)).toBe("sidebar-grip");

    await page.send("Page.reload");
    await page.until(`${LOADED} && !!document.querySelector('.bots-sidebar-inner')`, 15_000);
    await page.finish();
    expect(await page.eval<number>(WIDTH)).toBe(start + 80);

    await drag(page, 600);
    expect(await page.eval<number>(WIDTH)).toBe(SIDEBAR_MAX);
    await drag(page, -800);
    expect(await page.eval<number>(WIDTH)).toBe(SIDEBAR_MIN);
  }, 60_000);

  test("the thread list's edge drags too, and the width is OpenBots' as well", async () => {
    const page = await openThreads();
    const start = await page.eval<number>(WIDTH);
    expect(await page.eval<boolean>(`${ASIDE}.classList.contains('bots-sidebar')`)).toBe(false);
    await drag(page, 60);
    expect(await page.eval<number>(WIDTH)).toBe(start + 60);
    const [x] = await line(page);
    expect(Math.round(x)).toBe(start + 60);
    // The same width on the other side, so switching moves nothing.
    await page.eval("store.setState({ botsOpen: true, botsSidebarOpen: true })");
    await page.until(`${ASIDE}?.classList.contains('bots-sidebar')`);
    await page.finish();
    expect(await page.eval<number>(WIDTH)).toBe(start + 60);
    expect(await page.eval<boolean>(GRIP)).toBe(true);
  }, 60_000);

  test("a narrower window holds a wide sidebar back, and gives it back when it widens", async () => {
    const page = await openBots();
    await drag(page, 600);
    expect(await page.eval<number>(WIDTH)).toBe(SIDEBAR_MAX);
    await page.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.finish();
    expect(await page.eval<number>(WIDTH)).toBe(900 - PANE_MIN);
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.finish();
    expect(await page.eval<number>(WIDTH)).toBe(SIDEBAR_MAX);
  }, 60_000);

  test("a double-click gives back the sidebar's own width, and the arrow keys move the edge", async () => {
    const page = await openBots();
    const own = await page.eval<number>(WIDTH);
    await drag(page, 120);
    const [x, y] = await line(page);
    for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 2 });
    await page.finish();
    expect(await page.eval<number>(WIDTH)).toBe(own);
    expect(await page.eval<string | null>("localStorage.getItem('openbuild:sidebar-width')")).toBeNull();

    await page.eval("document.querySelector('.sidebar-grip').focus()");
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
    await page.finish();
    expect(await page.eval<number>(WIDTH)).toBe(own + 16);
    expect(await page.eval<string>("document.querySelector('.sidebar-grip').getAttribute('aria-valuenow')")).toBe(String(own + 16));
  }, 60_000);

  test("no grip on a phone, while a sidebar is closed, or in Settings", async () => {
    const phone = await openBots(390, 844);
    expect(await phone.eval<boolean>(GRIP)).toBe(false);
    const page = await openBots();
    expect(await page.eval<boolean>(GRIP)).toBe(true);
    // Closed to its rail.
    await page.eval("store.getState().setBotsSidebarOpen(false)");
    await page.finish();
    expect(await page.eval<boolean>(GRIP)).toBe(false);
    await page.eval("store.getState().setBotsSidebarOpen(true)");
    await page.finish();
    expect(await page.eval<boolean>(GRIP)).toBe(true);
    // Settings takes the whole window.
    await page.eval("store.getState().openSettings()");
    await page.finish();
    expect(await page.eval<boolean>(GRIP)).toBe(false);

    const threads = await openThreads();
    expect(await threads.eval<boolean>(GRIP)).toBe(true);
    await threads.eval("store.getState().setSidebarOpen(false)");
    await threads.finish();
    expect(await threads.eval<boolean>(GRIP)).toBe(false);
  }, 60_000);
});

describe.skipIf(!browser)("the sidebar's footer", () => {
  /** From the footer's line to its tallest button, and from that button to the sidebar's bottom edge. */
  const gaps = (page: Page) => page.eval<{ above: number; below: number }>(`(() => {
    const aside = ${ASIDE};
    const row = aside.querySelector('.settings-row');
    const r = row.getBoundingClientRect();
    const buttons = [...row.querySelectorAll('button')].map((b) => b.getBoundingClientRect()).filter((b) => b.width);
    const top = Math.min(...buttons.map((b) => b.top)), bottom = Math.max(...buttons.map((b) => b.bottom));
    const line = r.top + parseFloat(getComputedStyle(row).borderTopWidth);
    return { above: top - line, below: aside.getBoundingClientRect().bottom - bottom };
  })()`);

  test("OpenBots' buttons sit as far under its line as above the window's bottom edge", async () => {
    const page = await openBots();
    expect(await gaps(page)).toEqual({ above: 10, below: 10 });
  }, 60_000);

  test("and so do the thread list's", async () => {
    const page = await openThreads();
    expect(await gaps(page)).toEqual({ above: 10, below: 10 });
  }, 60_000);
});
