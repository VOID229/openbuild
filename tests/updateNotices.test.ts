// The update notices over the window, in a real Chrome: the whole app on the release fixture's fake
// server (tests/fixtures/releaseUpdate), with harnesses that have a newer version out. They slide in
// at the top right, name the harnesses without versions, and slide back out after four seconds,
// the clock stopping while the mouse is over one so its button can still be pressed. A newer
// OpenBuild release has no notice: the sidebar's footer offers it (tests/releaseUpdate.test.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
/** As long as a notice stays (NOTICE_MS in src/components/Notices.tsx). */
const NOTICE_MS = 4000;
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

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
 * it starts with), when it starts to leave (and how), and when it's gone.
 */
const WATCH = `(() => {
  window.noticeLog = [];
  const log = (kind, el) => window.noticeLog.push({ kind, at: performance.now(), text: el.querySelector('.notice-text')?.textContent, animation: el.getAnimations().map((a) => a.animationName).join() });
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') { if (r.target.matches('${NOTICE}.notice-leaving') && !r.oldValue?.includes('notice-leaving')) log('leaving', r.target); continue; }
      for (const n of r.addedNodes) if (n.nodeType === 1) for (const el of [n, ...n.querySelectorAll('.notice')]) if (el.matches('${NOTICE}')) log('in', el);
      for (const n of r.removedNodes) if (n.nodeType === 1) for (const el of [n, ...n.querySelectorAll('.notice')]) if (el.classList.contains('notice')) log('gone', el);
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
})()`;

interface Logged { kind: "in" | "leaving" | "gone"; at: number; text?: string; animation: string }
const log = (page: Page) => page.eval<Logged[]>("window.noticeLog");
const text = (page: Page) => page.eval<string | null>(`document.querySelector(${JSON.stringify(`${NOTICE} .notice-text`)})?.textContent ?? null`);
const now = (page: Page) => page.eval<number>("performance.now()");

async function open(runtimes: string[], { width = WIDTH, update = "" } = {}) {
  const page = await Page.open(chrome!.ws, "about:blank", width, 800, "true");
  await page.send("Page.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: WATCH });
  const query = new URLSearchParams({ ...(update && { update }), ...(runtimes.length && { runtimes: runtimes.join() }) });
  await page.send("Page.navigate", { url: `${server!.url.href}?${query}` });
  await page.until("!!document.querySelector('.sidebar') && !!window.update?.getState().info", 15_000);
  // The mouse starts well away from the corner.
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 600 });
  return page;
}

const hover = async (page: Page) => {
  const [x, y] = await page.eval<[number, number]>(`(() => { const r = document.querySelector(${JSON.stringify(`${NOTICE} .notice-text`)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
};
const leave = (page: Page) => page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 600 });

describe.skipIf(!browser)("update notices", () => {
  test("one harness: named without its version, sliding in at the top right and back out after four seconds", async () => {
    const page = await open(["claude"]);
    await page.until(`!!document.querySelector(${JSON.stringify(NOTICE)})`, 15_000);
    expect(await text(page)).toBe("Claude Code has an update");
    const [shown] = await log(page);
    expect(shown).toMatchObject({ kind: "in", animation: "notice-slide-in" });
    // It comes from beyond the window's right edge.
    const from = await page.eval<string>(`String(document.querySelector(${JSON.stringify(NOTICE)}).getAnimations()[0]?.effect.getKeyframes()[0]?.transform)`);
    expect(from).toContain("translateX");
    await page.finished(NOTICE);
    const box = await page.eval<{ top: number; right: number; left: number }>(`(() => { const r = document.querySelector(${JSON.stringify(NOTICE)}).getBoundingClientRect(); return { top: r.top, right: r.right, left: r.left }; })()`);
    expect(box.top).toBeLessThanOrEqual(16);
    expect(Math.abs(WIDTH - 12 - box.right)).toBeLessThanOrEqual(1);
    expect(box.left).toBeGreaterThan(WIDTH / 2);

    await page.until(`window.noticeLog.some((e) => e.kind === 'gone')`, NOTICE_MS + 4000);
    const events = await log(page);
    const leaving = events.find((e) => e.kind === "leaving")!;
    expect(leaving.animation).toBe("notice-slide-out");
    // Four seconds on screen, then out the way it came.
    expect(leaving.at - shown!.at).toBeGreaterThanOrEqual(NOTICE_MS - 50);
    expect(leaving.at - shown!.at).toBeLessThan(NOTICE_MS + 1500);
    expect(events.find((e) => e.kind === "gone")!.at - leaving.at).toBeLessThan(1000);
    // Timed out, it stays away rather than coming straight back.
    await Bun.sleep(300);
    expect(await text(page)).toBeNull();
  }, 40_000);

  test("several harnesses: up to two are named, then how many more", async () => {
    // UPDATABLE_RUNTIMES' order: Claude Code, OpenCode, Codex, Cursor.
    let page = await open(["claude", "opencode", "codex", "cursor"]);
    await page.until(`!!document.querySelector(${JSON.stringify(NOTICE)})`, 15_000);
    expect(await text(page)).toBe("Claude Code, OpenCode, and 2 more providers have an update");

    page = await open(["codex", "cursor"]);
    await page.until(`!!document.querySelector(${JSON.stringify(NOTICE)})`, 15_000);
    expect(await text(page)).toBe("Codex and Cursor have an update");

    // On a phone, it's in the corner and inside the window.
    page = await open(["codex", "cursor", "hermes"], { width: 390 });
    await page.until(`!!document.querySelector(${JSON.stringify(NOTICE)})`, 15_000);
    expect(await text(page)).toBe("Codex, Cursor, and 1 more provider have an update");
    await page.finished(NOTICE);
    const box = await page.eval<{ left: number; right: number }>(`(() => { const r = document.querySelector(${JSON.stringify(NOTICE)}).getBoundingClientRect(); return { left: r.left, right: r.right }; })()`);
    expect(box.left).toBeGreaterThanOrEqual(12 - 1);
    expect(box.right).toBeLessThanOrEqual(390 - 12 + 1);
  }, 60_000);

  test("hovering stops the clock and leaving starts it again where it was, and its Update button works meanwhile", async () => {
    const page = await open(["claude"]);
    await page.until(`!!document.querySelector(${JSON.stringify(NOTICE)})`, 15_000);
    const [shown] = await log(page);
    await page.finished(NOTICE);
    // Held for longer than it would have stayed.
    await hover(page);
    await page.until(`!!document.querySelector(${JSON.stringify(NOTICE)})?.dataset.paused`);
    await Bun.sleep(NOTICE_MS + 500);
    expect(await text(page)).toBe("Claude Code has an update");
    expect((await log(page)).some((e) => e.kind === "leaving")).toBe(false);

    // Its button still answers, and the work in progress holds the notice whatever the mouse does.
    await page.click(`${NOTICE} .btn-primary`);
    await page.until("window.runtimes.calls.updates.length === 1");
    expect(await page.eval<string[]>("window.runtimes.calls.updates")).toEqual(["claude"]);
    await page.until(`document.querySelector(${JSON.stringify(`${NOTICE} .notice-text`)})?.textContent === 'Updating harnesses…'`);
    await leave(page);
    await Bun.sleep(NOTICE_MS + 300);
    expect(await text(page)).toBe("Updating harnesses…");
    await page.eval("(window.runtimes.finish(0), true)");
    await page.until(`document.querySelector(${JSON.stringify(`${NOTICE} .notice-text`)})?.textContent === 'Claude Code updated'`);
    const done = await now(page);
    // The result gets its own four seconds, then goes.
    await page.until(`window.noticeLog.some((e) => e.kind === 'gone')`, NOTICE_MS + 4000);
    const leaving = (await log(page)).find((e) => e.kind === "leaving")!;
    expect(leaving.at - done).toBeGreaterThanOrEqual(NOTICE_MS - 300);
    expect(leaving.at - shown!.at).toBeGreaterThan(2 * NOTICE_MS);
  }, 60_000);

  test("a pause goes on from where the clock stopped rather than starting over", async () => {
    const page = await open(["codex"]);
    await page.until(`!!document.querySelector(${JSON.stringify(NOTICE)})`, 15_000);
    const [shown] = await log(page);
    await Bun.sleep(2500);
    await hover(page);
    await page.until(`!!document.querySelector(${JSON.stringify(NOTICE)})?.dataset.paused`);
    const stopped = await now(page);
    await Bun.sleep(1500);
    await leave(page);
    const went = await now(page);
    await page.until(`window.noticeLog.some((e) => e.kind === 'leaving')`, NOTICE_MS + 2000);
    const leaving = (await log(page)).find((e) => e.kind === "leaving")!;
    // What was left when the mouse came, not a whole new four seconds.
    const left = NOTICE_MS - (stopped - shown!.at);
    expect(leaving.at - went).toBeGreaterThanOrEqual(left - 300);
    expect(leaving.at - went).toBeLessThan(NOTICE_MS - 500);
  }, 40_000);

  test("an OpenBuild release waiting for a restart shows no notice", async () => {
    const page = await open([], { update: "ready" });
    await page.until("window.update.getState().info?.restart?.pending === true");
    await Bun.sleep(500);
    expect(await page.eval<number>("document.querySelectorAll('.notice').length")).toBe(0);
  }, 30_000);
});
