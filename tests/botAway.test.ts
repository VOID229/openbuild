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
