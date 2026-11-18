// The update notices over the window, in a real Chrome: the whole app on the release fixture's fake
// server (tests/fixtures/releaseUpdate), with harnesses that have a newer version out. They slide in
// at the top right, name the harnesses without versions, and slide back out after a while (4 s; the
// fixture's `?noticeMs=` makes it NOTICE_MS here, so the file doesn't spend its time waiting), the
// clock stopping while the mouse is over one so its button can still be pressed. A newer OpenBuild
// release has no notice: the sidebar's footer offers it (tests/releaseUpdate.test.ts).
//
// Times are taken on the page's clock, as things happen (WATCH), not when a call over CDP sees them,
// so a busy machine makes the waits longer but not the measured windows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

/** How long a notice stays, here: noticeTiming.ms in src/components/Notices.tsx, set by the fixture. */
const NOTICE_MS = 600;
/** NOTICE_LEAVE_MS in src/components/Notices.tsx: the corner's slide out. */
const LEAVE_MS = 220;

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/releaseUpdate/index.html`, {
    "/new": (req) => fetch(new URL("/", req.url)),
  });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const WIDTH = 1100;
const NOTICE = ".notices-corner .notice";

/**
 * Every corner notice's comings and goings, on the page's clock: when it's added (and the animation
 * it starts with), when its clock stops and starts again, when its text changes, when it starts to
 * leave (and how), and when it's gone.
 */
const WATCH = `(() => {
  window.noticeLog = [];
  const log = (kind, el) => window.noticeLog.push({ kind, at: performance.now(), text: el.querySelector('.notice-text')?.textContent, animation: el.getAnimations().map((a) => a.animationName).join() });
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') {
        if (!r.target.matches('${NOTICE}')) continue;
        if (r.attributeName === 'class' && r.target.classList.contains('notice-leaving') && !r.oldValue?.includes('notice-leaving')) log('leaving', r.target);
        if (r.attributeName === 'data-paused' && !!r.target.dataset.paused !== (r.oldValue != null)) log(r.target.dataset.paused ? 'paused' : 'resumed', r.target);
        continue;
      }
      for (const n of r.addedNodes) if (n.nodeType === 1) for (const el of [n, ...n.querySelectorAll('.notice')]) if (el.matches('${NOTICE}')) log('in', el);
      for (const n of r.removedNodes) if (n.nodeType === 1) for (const el of [n, ...n.querySelectorAll('.notice')]) if (el.classList.contains('notice')) log('gone', el);
    }
    for (const el of document.querySelectorAll('${NOTICE}')) {
      const text = el.querySelector('.notice-text')?.textContent;
      if (el.loggedText !== undefined && el.loggedText !== text) log('text', el);
      el.loggedText = text;
    }
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'data-paused'], attributeOldValue: true });
})()`;

interface Logged { kind: "in" | "leaving" | "gone" | "paused" | "resumed" | "text"; at: number; text?: string; animation: string }
const log = (page: Page) => page.eval<Logged[]>("window.noticeLog");
const logged = async (page: Page, kind: Logged["kind"], text?: string) => {
  const found = (await log(page)).find((e) => e.kind === kind && (text === undefined || e.text === text));
  if (!found) throw new Error(`nothing logged as ${kind}${text ? ` "${text}"` : ""}: ${JSON.stringify(await log(page))}`);
  return found;
};
const text = (page: Page) => page.eval<string | null>(`document.querySelector(${JSON.stringify(`${NOTICE} .notice-text`)})?.textContent ?? null`);

async function open(runtimes: string[], { width = WIDTH, update = "" } = {}) {
  const page = await Page.open(chrome!.ws, "about:blank", width, 800, "true");
  await page.send("Page.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: WATCH });
  const query = new URLSearchParams({ noticeMs: String(NOTICE_MS), ...(update && { update }), ...(runtimes.length && { runtimes: runtimes.join() }) });
  await page.send("Page.navigate", { url: `${server!.url.href}?${query}` });
  await page.until("!!document.querySelector('.sidebar') && !!window.update?.getState().info", 15_000);
  // The mouse starts well away from the corner.
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 600 });
  return page;
}

/** Waits in the page for a notice, so a short one isn't missed between polls. */
const waitFor = (then: string) => `new Promise((resolve, reject) => {
  const fail = setTimeout(() => reject(new Error('no notice came')), 15000);
  const look = () => {
    const el = document.querySelector(${JSON.stringify(NOTICE)});
    if (!el) return setTimeout(look, 5);
    clearTimeout(fail);
    resolve((${then})(el));
  };
  look();
})`;

/**
 * The notice once it's in: its text and where its slide in starts from, taken as it comes, and its
 * box once the slide in is over.
 */
const shown = (page: Page) => page.eval<{ text: string; from: string; box: { top: number; right: number; left: number } }>(waitFor(`(el) => {
  const slide = el.getAnimations()[0];
  const text = el.querySelector('.notice-text').textContent, from = String(slide?.effect.getKeyframes()[0]?.transform);
  return (slide?.finished ?? Promise.resolve()).catch(() => {}).then(() => {
    const r = el.getBoundingClientRect();
    return { text, from, box: { top: r.top, right: r.right, left: r.left } };
  });
}`));

/**
 * Puts the mouse over the notice `after` ms into its time: near its right edge where it's coming to
 * rest, which the notice covers from the start of its slide in.
 */
async function hover(page: Page, after = 0) {
  const [x, y] = await page.eval<[number, number]>(waitFor(`(el) => {
    const shown = window.noticeLog.find((e) => e.kind === 'in').at;
    return new Promise((done) => setTimeout(done, Math.max(0, shown + ${after} - performance.now()))).then(() => {
      const r = el.getBoundingClientRect(), slid = new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
      return [r.right - slid - 8, r.top + r.height / 2];
    });
  }`));
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.until(`window.noticeLog.some((e) => e.kind === 'paused')`);
}
const leave = (page: Page) => page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 600 });

describe.skipIf(!browser)("update notices", () => {
  test("one harness: named without its version, sliding in at the top right and back out after its time", async () => {
    const page = await open(["claude"]);
    const notice = await shown(page);
    expect(notice.text).toBe("Claude Code has an update");
    const appeared = await logged(page, "in");
    expect(appeared.animation).toBe("notice-slide-in");
    // It comes from beyond the window's right edge.
    expect(notice.from).toContain("translateX");
    expect(notice.box.top).toBeLessThanOrEqual(16);
    expect(Math.abs(WIDTH - 12 - notice.box.right)).toBeLessThanOrEqual(1);
    expect(notice.box.left).toBeGreaterThan(WIDTH / 2);

    await page.until(`window.noticeLog.some((e) => e.kind === 'gone')`, NOTICE_MS + 4000);
    const leaving = await logged(page, "leaving");
    expect(leaving.animation).toBe("notice-slide-out");
    // Its time on screen, then out the way it came. A timer never fires early; a busy page fires it late.
    expect(leaving.at - appeared.at).toBeGreaterThanOrEqual(NOTICE_MS - 50);
    expect(leaving.at - appeared.at).toBeLessThan(NOTICE_MS + 1500);
    const gone = await logged(page, "gone");
    expect(gone.at - leaving.at).toBeGreaterThanOrEqual(LEAVE_MS - 20);
    expect(gone.at - leaving.at).toBeLessThan(LEAVE_MS + 1500);
    // Timed out, it stays away rather than coming straight back.
    await Bun.sleep(NOTICE_MS);
    expect(await text(page)).toBeNull();
  }, 40_000);

  test("several harnesses: up to two are named, then how many more", async () => {
    // UPDATABLE_RUNTIMES' order: Claude Code, OpenCode, Codex, Cursor.
    let page = await open(["claude", "opencode", "codex", "cursor"]);
    expect((await shown(page)).text).toBe("Claude Code, OpenCode, and 2 more providers have an update");

    page = await open(["codex", "cursor"]);
    expect((await shown(page)).text).toBe("Codex and Cursor have an update");

    // On a phone, it's in the corner and inside the window.
    page = await open(["codex", "cursor", "hermes"], { width: 390 });
    const notice = await shown(page);
    expect(notice.text).toBe("Codex, Cursor, and 1 more provider have an update");
    expect(notice.box.left).toBeGreaterThanOrEqual(12 - 1);
    expect(notice.box.right).toBeLessThanOrEqual(390 - 12 + 1);
  }, 60_000);

  test("hovering stops the clock and leaving starts it again where it was, and its Update button works meanwhile", async () => {
    const page = await open(["claude"]);
    await hover(page);
    const appeared = await logged(page, "in");
    // Held for well over its time.
    await Bun.sleep(2 * NOTICE_MS);
    expect(await text(page)).toBe("Claude Code has an update");
    expect((await log(page)).some((e) => e.kind === "leaving")).toBe(false);

    // Its button still answers, and the work in progress holds the notice whatever the mouse does.
    await page.click(`${NOTICE} .btn-primary`);
    await page.until("window.runtimes.calls.updates.length === 1");
    expect(await page.eval<string[]>("window.runtimes.calls.updates")).toEqual(["claude"]);
    await page.until(`document.querySelector(${JSON.stringify(`${NOTICE} .notice-text`)})?.textContent === 'Updating harnesses…'`);
    await leave(page);
    await Bun.sleep(2 * NOTICE_MS);
    expect(await text(page)).toBe("Updating harnesses…");
    await page.eval("(window.runtimes.finish(0), true)");
    // The result gets its own time, then goes.
    await page.until(`window.noticeLog.some((e) => e.kind === 'gone')`, NOTICE_MS + 4000);
    const done = await logged(page, "text", "Claude Code updated");
    const leaving = await logged(page, "leaving");
    expect(leaving.text).toBe("Claude Code updated");
    expect(leaving.at - done.at).toBeGreaterThanOrEqual(NOTICE_MS - 50);
    expect(leaving.at - appeared.at).toBeGreaterThan(4 * NOTICE_MS);
  }, 60_000);

  test("a pause goes on from where the clock stopped rather than starting over", async () => {
    const page = await open(["codex"]);
    // Halfway through its time.
    await hover(page, NOTICE_MS / 2);
    const appeared = await logged(page, "in");
    const stopped = await logged(page, "paused");
    expect((await log(page)).some((e) => e.kind === "leaving")).toBe(false);
    await Bun.sleep(NOTICE_MS);
    await leave(page);
    await page.until(`window.noticeLog.some((e) => e.kind === 'leaving')`, NOTICE_MS + 4000);
    const went = await logged(page, "resumed");
    const leaving = await logged(page, "leaving");
    expect(went.at - stopped.at).toBeGreaterThanOrEqual(NOTICE_MS);
    // What was left when the mouse came, not a whole new NOTICE_MS: nearer the one than the other.
    const left = NOTICE_MS - (stopped.at - appeared.at);
    expect(stopped.at - appeared.at).toBeGreaterThanOrEqual(NOTICE_MS / 2 - 20);
    expect(leaving.at - went.at).toBeGreaterThanOrEqual(left - 50);
    expect(leaving.at - went.at).toBeLessThan((left + NOTICE_MS) / 2);
  }, 40_000);

  test("an OpenBuild release waiting for a restart shows no notice", async () => {
    const page = await open([], { update: "ready" });
    await page.until("window.update.getState().info?.restart?.pending === true");
    await Bun.sleep(500);
    expect(await page.eval<number>("document.querySelectorAll('.notice').length")).toBe(0);
  }, 30_000);
});
