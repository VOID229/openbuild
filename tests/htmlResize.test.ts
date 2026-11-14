// Pages (html_render) following their frame's width, in a real Chrome (fixtures/htmlResize): an OpenBots
// chat narrows as its details panel opens beside it, and a coding thread opened inside the panel is
// narrower still. A page lays itself out again at the new width and says how tall it is now, so nothing
// is cut off at the bottom; one that's wider than its frame is zoomed out to fit, not cut off at the
// right, and goes back to its own size when there's room again. Set OPENBUILD_SCREENSHOTS to a folder
// to keep a picture of each state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;
const shots = process.env.OPENBUILD_SCREENSHOTS;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/htmlResize/index.html`);
  chrome = await launchChrome();
  if (shots) await mkdir(shots, { recursive: true });
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

async function shoot(page: Page, name: string) {
  if (!shots) return;
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(shots, `${name}.png`), Buffer.from(data, "base64"));
}

const open = async (kind: "flow" | "wide", width: number) => {
  const page = await Page.open(chrome!.ws, `${server!.url.href}?page=${kind}`, width, 800, "!!document.querySelector('.bm-page iframe.html-render-frame')");
  await page.settle();
  return page;
};

/** A page as it sits in its frame: the frame's size, and where the page's last line ends. */
interface Fit {
  where: "chat" | "thread";
  frame: { w: number; h: number };
  end: { right: number; bottom: number };
}

/** Every page on screen, as it measures itself (see the fixture). */
const fits = (page: Page) => page.eval<(Fit | null)[]>("measure()").then((all) => all.filter((f): f is Fit => !!f).sort((a, b) => a.where.localeCompare(b.where)));

/** The pages once they've settled into their frames: `n` of them, sized as the last two reads agree. */
async function settled(page: Page, n: number) {
  let last = "";
  for (let i = 0; i < 120; i++) {
    await page.settle();
    const now = await fits(page).catch(() => []);
    const key = JSON.stringify(now);
    if (now.length === n && key === last) return now;
    last = key;
    await Bun.sleep(50);
  }
  throw new Error(`the pages never settled: ${last}`);
}

/** Nothing of the page hangs past its frame, at the right or the bottom. */
function inside(fit: Fit) {
  expect(fit.end.right).toBeLessThanOrEqual(fit.frame.w);
  expect(fit.end.bottom).toBeLessThanOrEqual(fit.frame.h);
}

describe.skipIf(!browser)("a page follows its frame's width", () => {
  test("a page wider than its frame is zoomed out to fit as panels open, and back to its size as they close", async () => {
    const page = await open("wide", 960);
    // With nothing beside the chat, the 580px chart fits as it is.
    const [alone] = await settled(page, 1);
    expect(alone!.frame.w).toBeGreaterThan(580);
    expect(alone!.end.right).toBe(580);
    inside(alone!);
    await shoot(page, "wide-alone");

    // The details panel narrows the chat: the chart is drawn smaller, whole, and the frame shorter with it.
    await page.eval("bots.getState().setDetailsOpen(true)");
    await page.until("!!document.querySelector('.bots-details-open')");
    const [beside] = await settled(page, 1);
    expect(beside!.frame.w).toBeLessThan(580);
    inside(beside!);
    expect(beside!.end.right).toBeGreaterThan(beside!.frame.w - 2);
    expect(beside!.frame.h).toBeLessThan(alone!.frame.h);
    await shoot(page, "wide-details");

    // A thread inside the panel: narrower again, and its own page fits the panel too.
    await page.eval("openThread()");
    await page.until("!!document.querySelector('.bots-details-threadpane .html-render-frame')");
    const both = await settled(page, 2);
    expect(both.map((f) => f.where)).toEqual(["chat", "thread"]);
    for (const fit of both) {
      expect(fit.frame.w).toBeLessThan(500);
      inside(fit);
      expect(fit.end.right).toBeGreaterThan(fit.frame.w - 2);
    }
    await shoot(page, "wide-thread");

    // Closed again: the chart is back at its own size, and the frame at its height.
    await page.eval("bots.getState().setDetailsOpen(false)");
    await page.until("!document.querySelector('.bots-details-open')");
    const [again] = await settled(page, 1);
    expect(again).toEqual(alone!);
  }, 60_000);

  test("a page that wraps grows taller as its frame narrows, with its last line still in view", async () => {
    const page = await open("flow", 960);
    const [alone] = await settled(page, 1);
    inside(alone!);
    await page.eval("openThread()");
    await page.until("!!document.querySelector('.bots-details-threadpane .html-render-frame')");
    const both = await settled(page, 2);
    for (const fit of both) {
      inside(fit);
      // Taller, not zoomed: the text wraps onto more lines and the cards onto more rows.
      expect(fit.frame.h).toBeGreaterThan(alone!.frame.h);
      expect(fit.end.right).toBe(fit.frame.w);
    }
    await page.eval("bots.getState().setDetailsOpen(false)");
    await page.until("!document.querySelector('.bots-details-open')");
    expect(await settled(page, 1)).toEqual([alone!]);
  }, 60_000);

  test("on a phone, a page wider than the screen fits it, in the chat and in a thread", async () => {
    const page = await open("wide", 390);
    const [chat] = await settled(page, 1);
    expect(chat!.frame.w).toBeLessThan(580);
    inside(chat!);
    expect(chat!.end.right).toBeGreaterThan(chat!.frame.w - 2);
    expect(await page.eval<number>("document.documentElement.scrollWidth - innerWidth")).toBe(0);
    await shoot(page, "phone-chat");
    await page.eval("openThread()");
    await page.until("!!document.querySelector('.bots-details-threadpane .html-render-frame')");
    const both = await settled(page, 2);
    for (const fit of both) {
      inside(fit);
      expect(fit.end.right).toBeGreaterThan(fit.frame.w - 2);
    }
    await shoot(page, "phone-thread");
  }, 60_000);
});
