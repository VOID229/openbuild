// Settings takes the whole window, in OpenBuild and in OpenBots: neither sidebar (nor the OpenBots rail)
// shows beside it, and closing it brings back the sidebar just as it was, open or closed. In a real
// Chrome with the whole app on a fake server (fixtures/groupThreads).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/groupThreads/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page, "/bots": page, "/bots/*": page, "/settings/*": page } });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

const READY = "window.store?.getState().chatsLoaded && window.bots?.getState().loaded";

const SIDEBARS = `[...document.querySelectorAll('.sidebar')].filter((s) => s.getBoundingClientRect().width > 0 && getComputedStyle(s).display !== 'none').length`;
/** Until the sidebars have finished sliding to `n` showing. */
const sidebarsSettle = (page: Page, n: number) => page.until(`${SIDEBARS} === ${n}`);

/** What shows: a sidebar that takes up room, and where Settings' page starts. */
const layout = (page: Page) =>
  page.eval<{ sidebars: number; pageLeft: number | null; tools: boolean }>(`(() => {
    const sidebars = [...document.querySelectorAll('.sidebar')].filter((s) => s.getBoundingClientRect().width > 0 && getComputedStyle(s).display !== 'none').length;
    const spage = document.querySelector('.spage');
    const tools = [...document.querySelectorAll('.floating-tools')].some((t) => t.getBoundingClientRect().width > 0 && getComputedStyle(t).display !== 'none');
    return { sidebars, pageLeft: spage ? Math.round(spage.getBoundingClientRect().left) : null, tools };
  })()`);

async function settings(page: Page, open: boolean) {
  await page.eval(open ? "store.getState().openSettings('general')" : "store.setState({ settingsOpen: false })");
  await page.until(open ? "!!document.querySelector('.spage .settings-content')" : "!document.querySelector('.spage')");
  await page.settle();
}

describe.skipIf(!browser)("Settings fills the window", () => {
  for (const world of ["OpenBuild", "OpenBots"] as const) {
    for (const sidebarOpen of [true, false]) {
      test(`from ${world}, with its sidebar ${sidebarOpen ? "open" : "closed"}`, async () => {
        const page = await Page.open(chrome!.ws, `${server!.url.href}${world === "OpenBots" ? "bots" : ""}`, 1280, 800, READY);
        await page.eval(`store.setState(${world === "OpenBots" ? `{ botsOpen: true, botsSidebarOpen: ${sidebarOpen} }` : `{ botsOpen: false, sidebarOpen: ${sidebarOpen} }`})`);
        await page.settle();
        // Before: OpenBuild's sidebar when open, OpenBots' list or rail always.
        await sidebarsSettle(page, world === "OpenBots" || sidebarOpen ? 1 : 0);

        await settings(page, true);
        expect(await layout(page)).toEqual({ sidebars: 0, pageLeft: 0, tools: false });
        // Its header starts at the window's edge, with nothing floating over it.
        expect(await page.eval<number>("Math.round(document.querySelector('.spage .page-back').getBoundingClientRect().left)")).toBeLessThan(24);

        await settings(page, false);
        const state = await page.eval<{ botsOpen: boolean; open: boolean }>(`(() => { const s = store.getState(); return { botsOpen: s.botsOpen, open: ${world === "OpenBots" ? "s.botsSidebarOpen" : "s.sidebarOpen"} }; })()`);
        expect(state).toEqual({ botsOpen: world === "OpenBots", open: sidebarOpen });
        await sidebarsSettle(page, world === "OpenBots" || sidebarOpen ? 1 : 0);
      }, 60_000);
    }
  }
});
