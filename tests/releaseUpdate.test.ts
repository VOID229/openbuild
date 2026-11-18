// Updating OpenBuild from the sidebar, in a real Chrome: the whole app on a fake server whose releases
// the test controls (tests/fixtures/releaseUpdate). The button beside the version is the refresh icon
// until a release is out (a click checks, the wheel turning; the app also checks by itself every five
// minutes), the download icon while one is on offer (hovering lists what it changes; a click installs
// it, with its steps as progress), and the restart icon once it's installed (a click restarts the
// server, and the page reloads when it's back). Nothing here updates or restarts anything real.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/releaseUpdate/index.html`, {
    // The app names a new thread's page /new, and a restart ends by reloading it: the real server
    // answers any page's path with the app.
    "/new": (req) => fetch(new URL("/", req.url)),
  });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

/** The button in OpenBuild's own sidebar; OpenBots' sidebar has its copy. */
const BUTTON = ".sidebar:not(.bots-sidebar) .release-update";
const BOTS_BUTTON = ".bots-sidebar .release-update";
const CARD = ".release-card[data-state='open']";
const CHANGES = [
  "feat(bots): bots close their own question cards (#351)",
  "fix(bots): Claude turns survive a reply with no visible output (#350)",
  "feat(bots): say what a bot is doing in another chat (#349)",
  "fix(mobile): phones get the desktop's sidebar header (#348)",
  "fix(releases): point at the repository's new home (#347)",
  "perf(sidebar): keep the thread list still while a reply streams (#346)",
  "feat(usage): show every machine's spend together (#345)",
  "fix(pi): keep a steer that lands between two tool calls (#344)",
];

type Start = "" | "available" | "installing" | "ready";
/** The app at a desktop's size, or a phone's with its list slid on. `before` runs on the blank tab, to emulate media first. */
async function open(start: Start = "", { phone = false, before }: { phone?: boolean; before?: (page: Page) => Promise<unknown> } = {}) {
  const page = await Page.open(chrome!.ws, "about:blank", phone ? 390 : 1100, phone ? 760 : 800, "true");
  if (phone) await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await before?.(page);
  await page.send("Page.navigate", { url: `${server!.url.href}${start ? `?update=${start}` : ""}` });
  await page.until(`!!document.querySelector(${JSON.stringify(BUTTON)}) && !!window.update?.getState().info`, 15_000);
  if (phone) {
    // A phone starts with the list put away: slide it on, as its menu button would. Only once the store
    // has hydrated, since hydrating closes it again on a phone.
    await page.eval("store.persist.hasHydrated() || new Promise((resolve) => { const off = store.persist.onFinishHydration(() => { off(); resolve(true); }); })");
    await page.eval("store.setState({ sidebarOpen: true })");
    await page.until("!!document.querySelector('.sidebar.sidebar-open:not(.bots-sidebar)')");
  }
  await page.finished(".sidebar:not(.bots-sidebar)");
  return page;
}

interface Shown {
  view: string;
  name: string | null;
  step?: string;
  failed: boolean;
  busy: boolean;
  /** Which of the three icons shows: each one's opacity. */
  icons: { check: number; download: number; restart: number };
}
const shown = (page: Page, button = BUTTON) =>
  page.eval<Shown>(`(() => {
    const b = document.querySelector(${JSON.stringify(button)});
    const icon = (name) => Number(getComputedStyle(b.querySelector('[data-icon="' + name + '"]')).opacity);
    return { view: b.dataset.view, name: b.getAttribute('aria-label'), step: b.dataset.step, failed: b.hasAttribute('data-failed'), busy: b.getAttribute('aria-busy') === 'true', icons: { check: icon('check'), download: icon('download'), restart: icon('restart') } };
  })()`);
const view = (page: Page, is: string, button = BUTTON) => page.until(`document.querySelector(${JSON.stringify(button)})?.dataset.view === ${JSON.stringify(is)}`);

interface CardText { title: string; sub?: string; changes: string[]; hint?: string; action?: string; error?: string; alert: boolean; progress?: string | null }
/** What the card over the button says, or undefined while there is none. */
const card = (page: Page) =>
  page.eval<CardText | undefined>(`(() => {
    const c = document.querySelector(${JSON.stringify(CARD)});
    if (!c) return undefined;
    const text = (sel) => c.querySelector(sel)?.textContent ?? undefined;
    return { title: text('.release-card-title'), sub: text('.release-card-sub'), changes: [...c.querySelectorAll('.release-card-changes li')].map((li) => li.textContent), hint: text('.release-card-hint'), action: text('.release-card-action'), error: text('.release-card-error'), alert: !!c.querySelector('[role="alert"]'), progress: c.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') };
  })()`);
const titled = (page: Page, title: string) => page.until(`document.querySelector(${JSON.stringify(CARD)})?.querySelector('.release-card-title')?.textContent === ${JSON.stringify(title)}`);
const noCard = (page: Page, within?: number) => page.until(`!document.querySelector(${JSON.stringify(CARD)})`, within);

const center = (page: Page, selector: string) => page.eval<[number, number]>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
const hover = async (page: Page, selector = BUTTON) => {
  const [x, y] = await center(page, selector);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
};
const leave = (page: Page) => page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 720, y: 320 });
const tap = async (page: Page, at: string | [number, number]) => {
  const [x, y] = typeof at === "string" ? await center(page, at) : at;
  await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.settle();
};
/** The card's "Show more" / "Show less", if it has one. */
const toggle = (page: Page) =>
  page.eval<{ text: string; expanded: string | null } | undefined>(`(() => { const b = document.querySelector(${JSON.stringify(CARD)})?.querySelector('.release-card-more-toggle'); return b ? { text: b.textContent, expanded: b.getAttribute('aria-expanded') } : undefined; })()`);
interface Box { left: number; right: number; top: number; bottom: number; width: number; height: number }
const box = (page: Page, selector: string) =>
  page.eval<Box>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })()`);
/** Each listed change: its text, and whether it's cut off at its two lines. */
const lines = (page: Page) =>
  page.eval<{ text: string; clamped: boolean }[]>(`[...document.querySelector(${JSON.stringify(CARD)}).querySelectorAll('.release-card-changes li')].map((li) => ({ text: li.textContent, clamped: li.scrollHeight > li.clientHeight + 1 }))`);
/** A changelog that's long both ways: more changes than a card lists, and one too long for its two lines. */
const LONG = [
  "fix(bots): a reply that runs on and on, past what two lines of the card can hold, so it has to be cut short somewhere with an ellipsis and read in full only once the card is opened out (#399)",
  ...Array.from({ length: 38 }, (_, i) => `fix(app): change number ${398 - i} (#${398 - i})`),
];
const calls = (page: Page) => page.eval<{ checks: number; fresh: number; updates: number; restarts: number }>("release.calls");
/** The app coming back to a tab that was offline: one of the moments it checks by itself. */
const online = (page: Page) => page.eval("(window.dispatchEvent(new Event('online')), true)");
const say = (page: Page, ...lines: string[]) => page.eval(`(${JSON.stringify(lines)}.forEach((line) => release.say(line)), true)`);

/** The animations turning the icon's wheel: how many, whether one runs for good, and where the last one ends. */
const turning = (page: Page, icon: "check" | "restart", button = BUTTON) =>
  page.eval<{ count: number; endless: boolean; rest?: string; angle: string }>(`(() => {
    const el = document.querySelector(${JSON.stringify(button)}).querySelector('[data-icon="${icon}"] > span');
    const all = el.getAnimations();
    const last = all.at(-1);
    return { count: all.length, endless: all.some((a) => a.effect.getComputedTiming().iterations === Infinity), rest: last?.effect.getKeyframes().at(-1)?.rotate, angle: getComputedStyle(el).rotate };
  })()`);
/** How much of the ring round the download is drawn, from 0 to 1, where its transition is heading. */
const ring = async (page: Page) => {
  await page.finish(BUTTON);
  return page.eval<{ drawn: number; opacity: number }>(`(() => {
    const svg = document.querySelector(${JSON.stringify(BUTTON)}).querySelector('.release-update-ring');
    return { drawn: 1 - parseFloat(getComputedStyle(svg.querySelector('circle:last-child')).strokeDashoffset), opacity: Number(getComputedStyle(svg).opacity) };
  })()`);
};
/** Which parts of the download icon are falling: the arrow's shaft and head, never the tray. */
const falling = (page: Page) =>
  page.eval<boolean[]>(`[...document.querySelector(${JSON.stringify(BUTTON)}).querySelectorAll('[data-icon="download"] path')].map((p) => getComputedStyle(p).animationName === 'release-arrow')`);
const halo = (page: Page, button = BUTTON) =>
  page.eval<{ name: string; opacity: number }>(`(() => { const s = getComputedStyle(document.querySelector(${JSON.stringify(button)}), '::after'); return { name: s.animationName, opacity: Number(s.opacity) }; })()`);
/** Records every transition the button's icons start from now on, as "icon:property". */
const watchIcons = (page: Page) =>
  page.eval(`(() => { window.iconRuns = []; document.querySelector(${JSON.stringify(BUTTON)}).addEventListener('transitionrun', (e) => { const icon = e.target.dataset?.icon; if (icon) window.iconRuns.push(icon + ':' + e.propertyName); }); return true; })()`);
const iconRuns = (page: Page) => page.eval<string[]>("window.iconRuns");

describe.skipIf(!browser)("updating OpenBuild from the sidebar", () => {
  test("at rest it's the refresh icon; a click checks the track, the wheel turning until the answer, and says it's up to date", async () => {
    const page = await open();
    const rest = await shown(page);
    expect(rest).toMatchObject({ view: "idle", name: "Check for updates", failed: false, busy: false, icons: { check: 1, download: 0, restart: 0 } });
    // Small, beside the version, inside the footer.
    const [button, label, row] = await page.eval<{ left: number; right: number; width: number; height: number }[]>(`[${JSON.stringify(BUTTON)}, '.sidebar:not(.bots-sidebar) .release-label', '.sidebar:not(.bots-sidebar) .settings-row'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height }; })`);
    expect(button!.width).toBe(22);
    expect(button!.left).toBeGreaterThanOrEqual(label!.right);
    expect(button!.left - label!.right).toBeLessThan(8);
    expect(button!.right).toBeLessThanOrEqual(row!.right);

    // Hovering says what a click does.
    await hover(page);
    await titled(page, "Check for updates");
    const asked = await calls(page);
    expect(asked.fresh).toBe(0);

    await page.eval("(release.hold(), true)");
    await page.click(BUTTON);
    await view(page, "checking");
    expect(await shown(page)).toMatchObject({ busy: true, name: "Checking for updates", icons: { check: 1 } });
    await titled(page, "Checking for updates…");
    // It asked the repository, not for a remembered answer.
    expect((await calls(page)).fresh).toBe(1);
    // The wheel turns, and keeps turning.
    const first = await turning(page, "check");
    expect(first).toMatchObject({ count: 1, endless: true });
    await page.until(`getComputedStyle(document.querySelector(${JSON.stringify(BUTTON)}).querySelector('[data-icon="check"] > span')).rotate !== ${JSON.stringify(first.angle)}`);
    // A second click while it's out asks nothing more.
    await page.click(BUTTON);
    expect((await calls(page)).fresh).toBe(1);

    // Every animation the wheel is given from here on: how it comes to rest.
    await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(BUTTON)}).querySelector('[data-icon="check"] > span'), animate = el.animate.bind(el); window.rests = []; el.animate = (frames, timing) => { window.rests.push({ from: parseFloat(frames[0].rotate), to: frames.at(-1).rotate, iterations: timing.iterations ?? 1, easing: timing.easing }); return animate(frames, timing); }; return true; })()`);
    await page.eval("(release.answer(), true)");
    await view(page, "idle");
    // It doesn't snap back: from where it was, what is left of the turn eases out to where the icon
    // looks the same (its two arrows match every half turn).
    const rests = await page.eval<{ from: number; to: string; iterations: number; easing?: string }[]>("window.rests");
    expect(rests).toHaveLength(1);
    expect(rests[0]).toMatchObject({ to: "180deg", iterations: 1 });
    expect(rests[0]!.easing).toStartWith("cubic-bezier");
    expect(rests[0]!.from).toBeGreaterThanOrEqual(0);
    expect(rests[0]!.from).toBeLessThan(180);
    await titled(page, "You're up to date");
    expect((await card(page))!.sub).toBe("No newer nightly release.");
    await page.finished(BUTTON);
    expect((await turning(page, "check")).count).toBe(0);
    expect(await shown(page)).toMatchObject({ view: "idle", busy: false, icons: { check: 1, download: 0, restart: 0 } });
    // The answer leaves by itself.
    await leave(page);
    await noCard(page, 6000);
  }, 30_000);

  test("it checks by itself every five minutes and on coming back online, quietly, and the download icon turns in when a release is out", async () => {
    // Every interval the page sets, so the five-minute one can be found and fired.
    const page = await open("", {
      before: async (p) => {
        await p.send("Page.enable");
        await p.send("Page.addScriptToEvaluateOnNewDocument", { source: "(() => { window.intervals = []; const set = window.setInterval; window.setInterval = (fn, ms, ...rest) => { window.intervals.push({ fn, ms }); return set(fn, ms, ...rest); }; })()" });
      },
    });
    expect(await page.eval<number>("window.intervals.filter((i) => i.ms === 5 * 60_000).length")).toBeGreaterThanOrEqual(1);
    const loaded = await calls(page);
    expect(loaded.checks).toBeGreaterThanOrEqual(1);
    expect(loaded.fresh).toBe(0);

    await watchIcons(page);
    // Five minutes on: every timer of that length fires.
    await page.eval(`(release.publish('0.3.53-nightly', ${JSON.stringify(CHANGES.slice(0, 3))}), window.intervals.filter((i) => i.ms === 5 * 60_000).forEach((i) => i.fn()), true)`);
    await view(page, "available");
    await page.finished(BUTTON);
    expect(await shown(page)).toMatchObject({ view: "available", name: "Install Nightly 0.3.53", busy: false, icons: { check: 0, download: 1, restart: 0 } });
    // Quietly: nobody asked, so the wheel never turned and the repository wasn't pressed. And once:
    // both sidebars and the notice show the release, on one watch between them.
    expect((await calls(page)).fresh).toBe(0);
    expect((await calls(page)).checks).toBe(loaded.checks + 1);
    // The icons changed hands rather than swapping: one faded and turned out as the other turned in.
    const runs = await iconRuns(page);
    for (const run of ["check:opacity", "check:rotate", "check:scale", "download:opacity", "download:rotate", "download:scale"]) expect(runs).toContain(run);
    // Nothing opened over the sidebar by itself.
    expect(await card(page)).toBeUndefined();

    // Coming back online looks again; a tab that isn't showing doesn't.
    const before = (await calls(page)).checks;
    await online(page);
    await page.until(`release.calls.checks === ${before + 1}`);
  }, 30_000);

  test("a release on offer: hovering lists what it changes, a click installs it step by step, and the restart icon waits with its halo", async () => {
    const page = await open("available");
    expect(await shown(page)).toMatchObject({ view: "available", name: "Install Nightly 0.3.53", icons: { check: 0, download: 1, restart: 0 } });
    expect(await card(page)).toBeUndefined();
    // At rest nothing moves.
    expect((await falling(page)).some(Boolean)).toBe(false);
    expect((await ring(page)).opacity).toBe(0);

    await hover(page);
    await titled(page, "Nightly 0.3.53 is available");
    expect(await card(page)).toMatchObject({
      sub: "What's new since 0.3.52",
      // Each change without its prefix and pull request number.
      changes: ["Bots close their own question cards once they're settled another way", "Claude turns survive a reply with no visible output and a tool call with no result", "Say what a bot is doing in another chat, with a calmer mascot"],
      hint: "Click to install",
    });
    // A tooltip for a mouse: no button in it.
    expect((await card(page))!.action).toBeUndefined();
    // Above the button, on screen.
    const [box, button] = await page.eval<{ left: number; right: number; top: number; bottom: number }[]>(`[${JSON.stringify(CARD)}, ${JSON.stringify(BUTTON)}].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })`);
    expect(box!.bottom).toBeLessThanOrEqual(button!.top);
    expect(box!.left).toBeGreaterThanOrEqual(0);
    expect(box!.right).toBeLessThanOrEqual(1100);

    await watchIcons(page);
    await page.click(BUTTON);
    await view(page, "installing");
    expect((await calls(page)).updates).toBe(1);
    expect(await shown(page)).toMatchObject({ step: "check", busy: true, name: "Updating to Nightly 0.3.53", icons: { download: 1 } });
    await titled(page, "Updating to Nightly 0.3.53");
    expect(await card(page)).toMatchObject({ sub: "Checking for a new release…", progress: "0" });
    // The arrow falls into the tray, which stays where it is; the ring round it has begun.
    expect(await falling(page)).toEqual([true, false, true]);
    const checking = await ring(page);
    expect(checking.opacity).toBe(1);
    expect(checking.drawn).toBeGreaterThan(0);

    // Each line `ob update` prints for a step moves it on.
    await say(page, "Downloading 0.3.53-nightly…");
    await page.until(`document.querySelector(${JSON.stringify(BUTTON)}).dataset.step === 'download'`);
    const downloading = await ring(page);
    expect(downloading.drawn).toBeGreaterThan(checking.drawn);
    expect(await card(page)).toMatchObject({ sub: "Downloading…", progress: "1" });
    await say(page, "bun install v1.3.8 (b64edcb4)", "Installing dependencies…");
    await page.until(`document.querySelector(${JSON.stringify(BUTTON)}).dataset.step === 'install'`);
    const installing = await ring(page);
    expect(installing.drawn).toBeGreaterThan(downloading.drawn);
    expect(installing.drawn).toBeLessThan(1);
    expect(await card(page)).toMatchObject({ sub: "Installing dependencies…", progress: "2" });
    // A click while it installs starts nothing else.
    await page.click(BUTTON);
    expect((await calls(page)).updates).toBe(1);
    expect((await iconRuns(page)).filter((run) => run.startsWith("check:") || run.startsWith("restart:"))).toEqual([]);

    await say(page, "Updated to OpenBuild 0.3.53-nightly (nightly).", "Changes will take effect on the next restart.");
    await page.eval("(release.finish(0), true)");
    await view(page, "ready");
    // The ring closes, the download hands over to the restart icon, and the arrow stops falling.
    expect((await ring(page)).drawn).toBe(1);
    expect(await shown(page)).toMatchObject({ view: "ready", name: "Restart OpenBuild to finish updating", busy: false, failed: false, icons: { check: 0, download: 0, restart: 1 } });
    for (const run of ["download:opacity", "download:rotate", "restart:opacity", "restart:rotate"]) expect(await iconRuns(page)).toContain(run);
    expect((await falling(page)).some(Boolean)).toBe(false);
    // Done and waiting: the halo keeps opening out, slowly.
    expect((await halo(page)).name).toBe("release-waiting");
    await titled(page, "Nightly 0.3.53 is installed");
    expect(await card(page)).toMatchObject({ sub: "Restart OpenBuild to start using it. Running turns carry on.", hint: "Click to restart" });
    // The release it runs is still the old one until it restarts.
    expect(await page.eval<string>("document.querySelector('.sidebar:not(.bots-sidebar) .release-label').getAttribute('aria-label')")).toBe("Nightly 0.3.52");
    expect((await calls(page)).restarts).toBe(0);
  }, 40_000);

  test("a long way behind, the changelog lists six changes and counts the rest", async () => {
    const page = await open();
    await page.eval(`(release.publish('0.3.60', ${JSON.stringify(CHANGES)}), true)`);
    await online(page);
    await view(page, "available");
    await hover(page);
    await titled(page, "Stable 0.3.60 is available");
    const listed = (await card(page))!.changes;
    expect(listed).toHaveLength(7);
    expect(listed[0]).toBe("Bots close their own question cards");
    expect(listed[5]).toBe("Keep the thread list still while a reply streams");
    // Cut short, it says so.
    expect(listed[6]).toBe("… and 2 more");
    expect(await toggle(page)).toMatchObject({ text: "Show more", expanded: "false" });
    // Moving off it puts the card away.
    await leave(page);
    await noCard(page);
  }, 30_000);

  test("a changelog that's cut short says so, and \"Show more\" opens the card out to all of it, inside the window; a click still installs", async () => {
    const page = await open();
    // Short enough to fit: nothing to show more of.
    await page.eval(`(release.publish('0.3.53-nightly', ["fix(app): one (#1)", "fix(app): two (#2)"]), true)`);
    await online(page);
    await view(page, "available");
    await hover(page);
    await titled(page, "Nightly 0.3.53 is available");
    expect(await toggle(page)).toBeUndefined();
    await leave(page);
    await noCard(page);

    // Only one change, but too long for its two lines: it ends in an ellipsis, and there's more to show.
    await page.eval(`(release.publish('0.3.54-nightly', ${JSON.stringify(LONG.slice(0, 1))}), true)`);
    await online(page);
    await page.until("window.update.getState().info?.latest === '0.3.54-nightly'");
    await hover(page);
    await titled(page, "Nightly 0.3.54 is available");
    await page.until(`!!document.querySelector(${JSON.stringify(CARD)} + ' .release-card-more-toggle')`);
    const clamp = await page.eval<{ clamp: string; overflow: string }>(`(() => { const s = getComputedStyle(document.querySelector(${JSON.stringify(CARD)} + ' .release-card-changes li')); return { clamp: s.webkitLineClamp, overflow: s.overflow }; })()`);
    expect(clamp).toEqual({ clamp: "2", overflow: "hidden" });
    expect((await lines(page))[0]!.clamped).toBe(true);
    expect(await toggle(page)).toMatchObject({ text: "Show more", expanded: "false" });
    await leave(page);
    await noCard(page);

    // Long both ways: six changes, the first cut off, and the rest counted after an ellipsis.
    await page.eval(`(release.publish('0.3.60-nightly', ${JSON.stringify(LONG)}), true)`);
    await online(page);
    await page.until("window.update.getState().info?.latest === '0.3.60-nightly'");
    await hover(page);
    await titled(page, "Nightly 0.3.60 is available");
    await page.finished(CARD);
    const short = await lines(page);
    expect(short).toHaveLength(7);
    expect(short[0]!.clamped).toBe(true);
    expect(short[6]!.text).toBe("… and 33 more");
    expect(await toggle(page)).toMatchObject({ text: "Show more", expanded: "false" });
    const small = await box(page, CARD);
    const button = await box(page, BUTTON);

    // Shown more: every change, none cut, in a card much taller and a bit wider, still above the
    // button and inside the window, its list scrolling past what that holds.
    await page.click(`${CARD} .release-card-more-toggle`);
    await page.until(`document.querySelector(${JSON.stringify(CARD)})?.hasAttribute('data-more')`);
    await page.finished(CARD);
    const all = await lines(page);
    expect(all).toHaveLength(39);
    expect(all.some((line) => line.clamped)).toBe(false);
    expect(all[0]!.text).toStartWith("A reply that runs on and on");
    expect(all[38]!.text).toBe("Change number 361");
    expect(await toggle(page)).toMatchObject({ text: "Show less", expanded: "true" });
    const big = await box(page, CARD);
    expect(big.height).toBeGreaterThan(small.height * 1.5);
    expect(big.width).toBeGreaterThan(small.width);
    expect(big.width).toBeLessThanOrEqual(400);
    expect(big.left).toBeGreaterThanOrEqual(8);
    expect(big.right).toBeLessThanOrEqual(1100 - 8);
    expect(big.top).toBeGreaterThanOrEqual(8);
    expect(big.bottom).toBeLessThanOrEqual(button.top);
    const list = await page.eval<{ scroll: number; client: number }>(`(() => { const ul = document.querySelector(${JSON.stringify(CARD)} + ' .release-card-changes'); return { scroll: ul.scrollHeight, client: ul.clientHeight }; })()`);
    expect(list.scroll).toBeGreaterThan(list.client);
    // The toggle and the hint are still in the card, under the list.
    const [shown, hint] = [await box(page, `${CARD} .release-card-more-toggle`), await box(page, `${CARD} .release-card-hint`)];
    expect(shown.bottom).toBeLessThanOrEqual(big.bottom);
    expect(hint.bottom).toBeLessThanOrEqual(big.bottom);
    // Opened out to be read, it stays when the pointer moves off it.
    await leave(page);
    await Bun.sleep(400);
    expect((await card(page))?.title).toBe("Nightly 0.3.60 is available");

    // Shown less: back to six, the same size as before, and still there to read.
    await page.click(`${CARD} .release-card-more-toggle`);
    await page.until(`!document.querySelector(${JSON.stringify(CARD)})?.hasAttribute('data-more')`);
    await page.finished(CARD);
    expect(await lines(page)).toHaveLength(7);
    expect(await toggle(page)).toMatchObject({ text: "Show more", expanded: "false" });
    const again = await box(page, CARD);
    expect(Math.abs(again.height - small.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(again.width - small.width)).toBeLessThanOrEqual(1);

    // Neither installed anything; a click on the button still does.
    expect((await calls(page)).updates).toBe(0);
    await page.click(`${CARD} .release-card-more-toggle`);
    await page.until(`document.querySelector(${JSON.stringify(CARD)})?.hasAttribute('data-more')`);
    await page.click(BUTTON);
    await view(page, "installing");
    expect((await calls(page)).updates).toBe(1);
  }, 40_000);

  test("on a phone \"Show more\" opens the card out inside the window, and its button still installs", async () => {
    const page = await open("", { phone: true });
    await page.eval(`(release.publish('0.3.60-nightly', ${JSON.stringify(LONG)}), true)`);
    await online(page);
    await view(page, "available");
    await tap(page, BUTTON);
    await titled(page, "Nightly 0.3.60 is available");
    await page.finished(CARD);
    expect(await toggle(page)).toMatchObject({ text: "Show more", expanded: "false" });
    // A finger's worth of target.
    expect((await box(page, `${CARD} .release-card-more-toggle`)).height).toBeGreaterThanOrEqual(32);
    const small = await box(page, CARD);
    const button = await box(page, BUTTON);

    await tap(page, `${CARD} .release-card-more-toggle`);
    await page.until(`document.querySelector(${JSON.stringify(CARD)})?.hasAttribute('data-more')`);
    await page.finished(CARD);
    expect(await lines(page)).toHaveLength(39);
    const big = await box(page, CARD);
    expect(big.height).toBeGreaterThan(small.height * 1.5);
    expect(big.width).toBeGreaterThanOrEqual(small.width);
    expect(big.left).toBeGreaterThanOrEqual(8);
    expect(big.right).toBeLessThanOrEqual(390 - 8);
    expect(big.top).toBeGreaterThanOrEqual(8);
    expect(big.bottom).toBeLessThanOrEqual(button.top);
    // The button that installs is in the card, inside the window.
    const action = await box(page, `${CARD} .release-card-action`);
    expect(action.bottom).toBeLessThanOrEqual(big.bottom);
    expect((await calls(page)).updates).toBe(0);

    await tap(page, `${CARD} .release-card-action`);
    await view(page, "installing");
    expect((await calls(page)).updates).toBe(1);
  }, 40_000);

  test("installed: a click restarts the server, the icon turning, and the page reloads on the new release when it's back", async () => {
    const page = await open("ready");
    expect(await shown(page)).toMatchObject({ view: "ready", icons: { check: 0, download: 0, restart: 1 } });
    expect(await page.eval<number>("release.server.reloads")).toBe(0);
    await page.click(BUTTON);
    await view(page, "restarting");
    expect((await calls(page)).restarts).toBe(1);
    expect(await shown(page)).toMatchObject({ busy: true, name: "Restarting OpenBuild", icons: { restart: 1 } });
    expect(await turning(page, "restart")).toMatchObject({ count: 1, endless: true });
    // The halo was for waiting.
    expect((await halo(page)).name).toBe("none");
    await titled(page, "Restarting OpenBuild…");
    expect((await card(page))!.sub).toBe("This page reloads when it's back.");
    // The server is away for a while: nothing reloads, and a click asks for nothing more.
    await Bun.sleep(1500);
    await page.click(BUTTON);
    expect(await page.eval<number>("release.server.reloads")).toBe(0);
    expect((await calls(page)).restarts).toBe(1);

    await page.eval("(release.back(), true)");
    await page.until("window.release?.server.reloads === 1 && !!window.update?.getState().info", 15_000);
    await view(page, "idle");
    expect(await page.eval<string>("document.querySelector('.sidebar:not(.bots-sidebar) .release-label').getAttribute('aria-label')")).toBe("Nightly 0.3.53");
    expect(await shown(page)).toMatchObject({ view: "idle", name: "Check for updates", failed: false });
  }, 40_000);

  test("what goes wrong is said in the card, in the server's words, and a click tries again", async () => {
    const page = await open();
    // A check that can't reach the repository.
    await page.eval("(release.failChecks('Release check failed (fatal: unable to access https://github.com/dkod-ai/openbuild.git/).'), true)");
    await page.click(BUTTON);
    await titled(page, "Couldn't check for updates");
    expect(await card(page)).toMatchObject({ error: "Release check failed (fatal: unable to access https://github.com/dkod-ai/openbuild.git/).", alert: true, hint: "Click to try again" });
    expect(await shown(page)).toMatchObject({ view: "idle", failed: true, busy: false, name: "Couldn't check for updates. Try again" });
    // The card stays while the pointer is elsewhere: it was opened to be read.
    await leave(page);
    await Bun.sleep(400);
    expect((await card(page))?.title).toBe("Couldn't check for updates");

    await page.eval(`(release.failChecks(undefined), release.publish('0.3.53-nightly', ${JSON.stringify(CHANGES.slice(0, 2))}), true)`);
    await page.click(BUTTON);
    await view(page, "available");
    expect((await shown(page)).failed).toBe(false);
    // What the check found is shown at once.
    await titled(page, "Nightly 0.3.53 is available");

    // The server won't start an update while other maintenance runs.
    await page.eval("(release.refuseUpdates('A maintenance job is already running'), true)");
    await page.click(BUTTON);
    await titled(page, "The update didn't install");
    expect(await card(page)).toMatchObject({ error: "A maintenance job is already running", alert: true });
    await page.finished(BUTTON);
    expect(await shown(page)).toMatchObject({ view: "available", failed: true, busy: false, icons: { download: 1 } });

    // `ob update` stops: its own words, without the steps it got through.
    await page.eval("(release.refuseUpdates(undefined), true)");
    await page.click(BUTTON);
    await view(page, "installing");
    expect((await shown(page)).failed).toBe(false);
    await say(page, "Checking for a new release…", "Downloading 0.3.53-nightly…", "openbuild: Your checkout has local changes. Commit or stash them before updating.");
    await page.eval("(release.finish(1), true)");
    await view(page, "available");
    await titled(page, "The update didn't install");
    expect(await card(page)).toMatchObject({ error: "Your checkout has local changes. Commit or stash them before updating.", alert: true, hint: "Click to try again" });
    expect(await shown(page)).toMatchObject({ failed: true, busy: false, name: "The update didn't install. Try again" });
    // The mark on the button says there's something to read, and the ring is gone.
    await page.finished(BUTTON);
    expect(await page.eval<number>(`Number(getComputedStyle(document.querySelector(${JSON.stringify(BUTTON)}).querySelector('.release-update-dot')).opacity)`)).toBe(1);
    expect((await ring(page)).opacity).toBe(0);
    expect((await falling(page)).some(Boolean)).toBe(false);

    // Trying again works, and the failure is forgotten.
    await page.click(BUTTON);
    await view(page, "installing");
    expect((await calls(page)).updates).toBe(3);
    await page.eval("(release.finish(0), true)");
    await view(page, "ready");
    expect((await shown(page)).failed).toBe(false);

    // A restart that fails leaves the old server there, saying why; it still waits for one.
    await page.click(BUTTON);
    await view(page, "restarting");
    await page.eval("(release.failRestart('OpenBuild answers on port 3100, but it wasn\\'t started by `openbuild start`.'), true)");
    await titled(page, "OpenBuild couldn't restart");
    expect(await card(page)).toMatchObject({ error: "OpenBuild answers on port 3100, but it wasn't started by `openbuild start`.", alert: true, hint: "Click to try again" });
    expect(await shown(page)).toMatchObject({ view: "ready", failed: true, busy: false, icons: { restart: 1 } });
    expect(await page.eval<number>("release.server.reloads")).toBe(0);
    // Escape puts the card away; the mark stays.
    await leave(page);
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await noCard(page);
    expect((await shown(page)).failed).toBe(true);
  }, 60_000);

  test("on a phone a tap opens the card first, and its button installs and restarts", async () => {
    const page = await open("", { phone: true });
    expect(await page.eval<boolean>("matchMedia('(hover: none)').matches")).toBe(true);
    // A finger's worth of target round the small button.
    const [x, y] = await center(page, BUTTON);
    expect(await page.eval<boolean>(`[[${x}, ${y - 16}], [${x}, ${y + 16}]].every(([x, y]) => document.elementFromPoint(x, y) === document.querySelector(${JSON.stringify(BUTTON)}))`)).toBe(true);

    // The refresh has nothing to read first: a tap checks, and the card says what it found.
    await page.eval("(release.hold(), true)");
    await tap(page, BUTTON);
    await view(page, "checking");
    await titled(page, "Checking for updates…");
    await page.eval(`(release.publish('0.3.53-nightly', ${JSON.stringify(CHANGES.slice(0, 3))}), release.answer(), true)`);
    await view(page, "available");
    await titled(page, "Nightly 0.3.53 is available");
    // The changelog, and the button a mouse's click would have been. Nothing is installed by looking.
    expect(await card(page)).toMatchObject({ sub: "What's new since 0.3.52", action: "Install update", changes: ["Bots close their own question cards", "Claude turns survive a reply with no visible output", "Say what a bot is doing in another chat"] });
    expect((await card(page))!.hint).toBeUndefined();
    const box = await page.eval<{ left: number; right: number; bottom: number }>(`(() => { const r = document.querySelector(${JSON.stringify(CARD)}).getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom }; })()`);
    expect(box.left).toBeGreaterThanOrEqual(8);
    expect(box.right).toBeLessThanOrEqual(390 - 8);
    expect(box.bottom).toBeLessThanOrEqual(y - 11);
    // It stays while it's read (no pointer rests on a touch screen), and a tap elsewhere puts it away.
    await Bun.sleep(600);
    expect((await card(page))?.title).toBe("Nightly 0.3.53 is available");
    await tap(page, await page.eval<[number, number]>("(() => { const row = document.querySelector('.sidebar:not(.bots-sidebar) .settings-row'), a = row.querySelector('.settings-btn').getBoundingClientRect(), b = row.querySelector('.release-label').getBoundingClientRect(); return [(a.right + b.left) / 2, a.top + a.height / 2]; })()"));
    await noCard(page);
    expect((await calls(page)).updates).toBe(0);

    // A tap on the download opens it again, and another closes it: still nothing installed.
    await tap(page, BUTTON);
    await titled(page, "Nightly 0.3.53 is available");
    await tap(page, BUTTON);
    await noCard(page);
    await tap(page, BUTTON);
    await titled(page, "Nightly 0.3.53 is available");
    expect((await calls(page)).updates).toBe(0);

    await tap(page, ".release-card-action");
    await view(page, "installing");
    expect((await calls(page)).updates).toBe(1);
    // The card stays to say how far it is, without a button.
    await titled(page, "Updating to Nightly 0.3.53");
    await say(page, "Downloading 0.3.53-nightly…");
    await page.until(`document.querySelector(${JSON.stringify(CARD)})?.querySelector('.release-card-sub')?.textContent === 'Downloading…'`);
    expect((await card(page))!.action).toBeUndefined();
    await page.eval("(release.finish(0), true)");
    await view(page, "ready");
    await titled(page, "Nightly 0.3.53 is installed");
    expect((await card(page))!.action).toBe("Restart now");
    expect((await calls(page)).restarts).toBe(0);

    await tap(page, ".release-card-action");
    await view(page, "restarting");
    expect((await calls(page)).restarts).toBe(1);
    await titled(page, "Restarting OpenBuild…");
    await page.eval("(release.back(), true)");
    await page.until("window.release?.server.reloads === 1 && !!window.update?.getState().info", 15_000);
    await view(page, "idle");
  }, 60_000);

  test("OpenBots' sidebar shows the same update, and no notice over the window repeats it", async () => {
    const page = await open("available");
    /** Any notice saying anything about the release: the sidebars' buttons are where it's offered. */
    const notices = () => page.eval<string[]>("[...document.querySelectorAll('.notice-text')].map((n) => n.textContent)");
    expect(await notices()).toEqual([]);
    await page.click(BUTTON);
    await view(page, "installing");
    expect((await calls(page)).updates).toBe(1);
    expect(await notices()).toEqual([]);

    // Over in OpenBots, its footer's button is in the middle of the same install.
    await page.eval("(store.getState().setBotsOpen(true), true)");
    await page.until(`document.querySelector(${JSON.stringify(BOTS_BUTTON)})?.getBoundingClientRect().width > 0`);
    await say(page, "Installing dependencies…");
    await page.until(`document.querySelector(${JSON.stringify(BOTS_BUTTON)}).dataset.step === 'install'`);
    expect(await shown(page, BOTS_BUTTON)).toMatchObject({ view: "installing", busy: true });
    await page.eval("(release.finish(0), true)");
    await view(page, "ready", BOTS_BUTTON);
    expect((await halo(page, BOTS_BUTTON)).name).toBe("release-waiting");
    // Installed and waiting for a restart: the footers' restart buttons say so, and nothing else does.
    await page.settle();
    expect(await notices()).toEqual([]);
    // One update, started once.
    expect((await calls(page)).updates).toBe(1);
  }, 40_000);

  test("an update that was already installing when the page loaded is followed to its end", async () => {
    const page = await open("installing");
    await view(page, "installing");
    expect((await calls(page)).updates).toBe(0);
    await say(page, "Downloading 0.3.53-nightly…");
    await page.until(`document.querySelector(${JSON.stringify(BUTTON)}).dataset.step === 'download'`);
    await page.eval("(release.finish(0), true)");
    await view(page, "ready");
  }, 30_000);

  test("with reduced motion nothing turns, falls or pulses, and the icons change at once", async () => {
    const page = await open("", { before: (p) => p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }) });
    /** Animations and transitions running anywhere in the button, its halo included. (The app's own reduced-motion rule leaves colours a 1 ms transition.) */
    const moving = () => page.eval<number>(`document.querySelector(${JSON.stringify(BUTTON)}).getAnimations({ subtree: true }).filter((a) => a.playState === 'running' && a.effect.getComputedTiming().duration > 1).length`);
    await watchIcons(page);
    await page.eval("(release.hold(), true)");
    await page.click(BUTTON);
    await view(page, "checking");
    await page.settle();
    // The wheel is still; it dims while the check is out.
    expect((await turning(page, "check")).count).toBe(0);
    expect((await shown(page)).icons.check).toBe(0.5);
    expect(await moving()).toBe(0);

    await page.eval(`(release.publish('0.3.53-nightly', ${JSON.stringify(CHANGES.slice(0, 2))}), release.answer(), true)`);
    await view(page, "available");
    await page.settle();
    expect(await shown(page)).toMatchObject({ icons: { check: 0, download: 1, restart: 0 } });
    expect(await moving()).toBe(0);

    await page.click(BUTTON);
    await view(page, "installing");
    await page.settle();
    expect((await falling(page)).some(Boolean)).toBe(false);
    // The ring still shows the step, at once rather than creeping.
    await say(page, "Downloading 0.3.53-nightly…");
    await page.until(`document.querySelector(${JSON.stringify(BUTTON)}).dataset.step === 'download'`);
    await page.settle();
    expect(await moving()).toBe(0);
    expect(await page.eval<number>(`1 - parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(BUTTON)}).querySelector('.release-update-ring circle:last-child')).strokeDashoffset)`)).toBe(0.5);

    await page.eval("(release.finish(0), true)");
    await view(page, "ready");
    await page.settle();
    // Waiting is a still halo.
    const still = await halo(page);
    expect(still.name).toBe("none");
    expect(still.opacity).toBeGreaterThan(0);
    expect(await shown(page)).toMatchObject({ icons: { check: 0, download: 0, restart: 1 } });
    expect(await moving()).toBe(0);
    // Not one transition ran on the icons the whole way.
    expect(await iconRuns(page)).toEqual([]);

    await page.click(BUTTON);
    await view(page, "restarting");
    await page.settle();
    expect((await turning(page, "restart")).count).toBe(0);
    expect(await moving()).toBe(0);
  }, 40_000);
});
