// A bot at work in another chat, measured in a real Chrome: each place that says what it's doing there
// (the chat's row, its sidebar row, the phone header) takes the most exact way of saying it that fits
// its box, so a long group name is left out whole for "another group" and nothing is cut mid-word.
// Its mascot is calm, not at work, and does move.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botAway/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const open = async (width: number) => {
  const page = await Page.open(chrome!.ws, server!.url.href, width, 760, "!!document.querySelector('.bots-chat')");
  await page.settle();
  return page;
};
/** Scout at work in `where`, on `activity`. */
const work = (page: Page, where: string, activity: string) =>
  page.eval(`(window.bots.setState({ status: { scout: { state: "working", conversationId: ${JSON.stringify(where)}, activity: ${JSON.stringify(activity)}, since: Date.now() } } }), true)`);
/** What each place shows, and whether it all fits its box. */
const read = (page: Page) =>
  page.eval<{ text: string; fits: boolean }[]>(`[".bm-away-text", ".bots-row-away", ".bots-head-sub-away"].flatMap((sel) => [...document.querySelectorAll(sel)].map((el) => ({ sel, text: el.textContent, fits: el.scrollWidth <= el.clientWidth + 1 })))`);

test.skipIf(!browser)("on a laptop the chat row names the group in full, and the narrow sidebar row says it without the name", async () => {
  const page = await open(900);
  await work(page, "dev", "Running the test suite");
  await page.until("!!document.querySelector('.bm-away-text')");
  await page.settle();
  const shown = await read(page);
  expect(shown.find((s: any) => s.sel === ".bm-away-text")!.text).toBe("Running the test suite in the OpenBuild Dev group");
  // The sidebar row hasn't the room for it all: a shorter way of saying it, whole, and never cut.
  const row = shown.find((s: any) => s.sel === ".bots-row-away")!;
  expect(["Running the test suite in another group", "Doing something in the OpenBuild Dev group", "Doing something in another group", "Busy elsewhere"]).toContain(row.text);
  for (const s of shown) if (s.text !== "Busy elsewhere") expect(s.fits).toBe(true);
  // A group name too long for the chat's row is left out whole, never cut.
  await work(page, "long", "Running the test suite");
  await page.settle();
  await page.settle();
  const long = await read(page);
  expect(long.find((s: any) => s.sel === ".bm-away-text")!.text).toBe("Running the test suite in another group");
  for (const s of long) expect(s.text).not.toContain("Quarterly");
  // The mascot beside it is calm and alive: it isn't at work here, and it moves.
  expect(await page.eval<boolean>(`document.querySelector(".bm-away .bot").hasAttribute("data-away") && !document.querySelector(".bm-away .bot").hasAttribute("data-busy")`)).toBe(true);
  // Its turn ends: nothing of it is left.
  await page.eval(`(window.bots.setState({ status: {} }), true)`);
  await page.settle();
  expect(await read(page)).toEqual([]);
}, 30_000);

test.skipIf(!browser)("a phone's header takes the most exact line that fits under the name, and grows back to it with room", async () => {
  const page = await open(360);
  await work(page, "dev", "Running the test suite");
  await page.until("!!document.querySelector('.bots-head-sub-away')");
  await page.settle();
  const first = (await read(page)).find((s: any) => s.sel === ".bots-head-sub-away")!;
  expect(first.fits).toBe(true);
  expect(first.text).not.toBe("Running the test suite in the OpenBuild Dev group");
  expect(first.text.startsWith("Running the test suite") || first.text.startsWith("Doing something")).toBe(true);
  // Wider, it says it all.
  await page.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 760, deviceScaleFactor: 1, mobile: false });
  await page.settle();
  await page.settle();
  const wide = (await read(page)).find((s: any) => s.sel === ".bots-head-sub-away")!;
  expect(wide.text).toBe("Running the test suite in the OpenBuild Dev group");
  expect(wide.fits).toBe(true);
}, 30_000);

test.skipIf(!browser)("the hover card's two lines say as much as they hold, a long group name left out whole", async () => {
  const page = await open(1180);
  /** Hovers Scout's row with a real mouse and reads the card's line once it's open and placed. */
  const peek = async () => {
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
    await page.until("!document.querySelector('.bots-peek')");
    const [x, y] = await page.eval<[number, number]>(`(() => { const r = [...document.querySelectorAll(".bots-row-main")].find((b) => b.querySelector(".bots-row-title")?.textContent === "Scout").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await page.until("document.querySelector('.bots-peek')?.dataset.state === 'open' && !!document.querySelector('.bots-peek-away')", 5000);
    await page.settle();
    return page.eval<{ text: string; fits: boolean; lines: number; inView: boolean }>(`(() => {
      const el = document.querySelector(".bots-peek-away"), card = document.querySelector(".bots-peek").getBoundingClientRect();
      return { text: el.textContent, fits: el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1, lines: Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)), inView: card.top >= 0 && card.bottom <= innerHeight };
    })()`);
  };
  // A name that fits its two lines is said in full.
  await work(page, "dev", "Running the test suite");
  expect(await peek()).toEqual({ text: "Running the test suite in the OpenBuild Dev group", fits: true, lines: expect.any(Number), inView: true });
  // One that doesn't is left out whole for "another group": never cut by the clamp.
  await work(page, "long", "Running the test suite");
  const long = await peek();
  expect(long.text).toBe("Running the test suite in another group");
  expect(long.fits).toBe(true);
  expect(long.lines).toBeLessThanOrEqual(2);
  expect(long.inView).toBe(true);
}, 30_000);

/** How the line of the row at the chat's end is drawn, and how far that row sits above the composer. */
const lineAndGap = (page: Page, text: string) =>
  page.eval<{ anim: string; clip: string; color: string; rest: string; gap: number; textW: number; rowW: number }>(`(() => {
    const scroller = document.querySelector(".bots-messages");
    scroller.scrollTop = scroller.scrollHeight;
    const el = document.querySelector(${JSON.stringify(text)}), cs = getComputedStyle(el);
    const row = el.closest(".bm-working").getBoundingClientRect(), composer = document.querySelector(".bots-composer").getBoundingClientRect();
    return { anim: cs.animationName.split(",")[0].trim(), clip: cs.backgroundClip, color: cs.color, rest: cs.getPropertyValue("--bots-glow-rest").trim(), gap: Math.round(composer.top - row.bottom), textW: el.getBoundingClientRect().width, rowW: row.width };
  })()`);
/** Scout's chat, long enough to scroll, so its end sits on the composer. */
const fill = (page: Page) =>
  page.eval(`(window.bots.setState((s) => ({ conversations: s.conversations.map((c) => c.id !== "dm" ? c : { ...c, messages: Array.from({ length: 24 }, (_, i) => ({ id: "fill-" + i, author: i % 2 ? "scout" : "me", at: Date.now() - 60000 + i, text: "Message " + i + " about the build" })) }) })), true)`);

for (const [label, width, gap] of [["a laptop", 900, 24], ["a phone", 390, 16]] as const) {
  test.skipIf(!browser)(`on ${label}, busy elsewhere glows as work here does, and both rows sit ${gap}px above the composer`, async () => {
    const page = await open(width);
    await fill(page);
    await work(page, "dm", "Running the test suite");
    await page.until("!!document.querySelector('.bm-working-text')");
    await page.finish(".bots-chat");
    const working = await lineAndGap(page, ".bm-working-text");
    await work(page, "dev", "Running the test suite");
    await page.until("!!document.querySelector('.bm-away-text')");
    await page.finish(".bots-chat");
    const away = await lineAndGap(page, ".bm-away-text");
    // The same sweep, painting the words, from the same resting colour.
    expect(working.anim).toBe("bots-glow");
    expect(away).toMatchObject({ anim: "bots-glow", clip: "text", color: "rgba(0, 0, 0, 0)", rest: working.rest });
    // As wide as its words, as the working line is, so the band crosses them at the same pace.
    expect(away.textW).toBeLessThan(away.rowW - 40);
    // A clear step above the composer, as before the chat kept a working row's room (#304).
    expect(working.gap).toBe(gap);
    expect(away.gap).toBe(gap);
    if (width < 768) {
      // Under the name in a phone's header too, as the live step there does.
      const head = await page.eval<{ anim: string; clip: string }>(`(() => { const cs = getComputedStyle(document.querySelector(".bots-head-sub-away")); return { anim: cs.animationName, clip: cs.backgroundClip }; })()`);
      expect(head).toEqual({ anim: "bots-glow", clip: "text" });
    }
    // With motion reduced it holds still, like the working line.
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await page.settle();
    expect(await page.eval<string[]>(`[".bm-away-text", ".bots-head-sub-away"].flatMap((s) => [...document.querySelectorAll(s)].map((el) => getComputedStyle(el).animationName))`)).toEqual(width < 768 ? ["none", "none"] : ["none"]);
  }, 30_000);
}
