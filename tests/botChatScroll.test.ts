// Going between OpenBots chats in a real Chrome: a chat left at its latest message is at its latest
// message again on the way back, whatever arrives late, and one the user scrolled up in is where they
// left it, never another chat's place.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

/** A tiny PNG, sent only once the test lets it go: an image that loads after the chat has opened. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
let releaseImages: () => void = () => {};
let imagesHeld = Promise.resolve();
let releaseOlder: () => void = () => {};
let olderHeld = Promise.resolve();

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botScroll/index.html`, {
      "/slow.png": async () => {
        await imagesHeld;
        return new Response(PNG, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
      },
      // A page of older messages, sent only once the test lets it go.
      "/older/*": async (req) => {
        await olderHeld;
        const id = new URL(req.url).pathname.split("/").pop();
        const at = Date.now() - 7_200_000;
        const messages = Array.from({ length: 20 }, (_, i) => ({ id: `${id}-old-${i}`, author: i % 2 ? "manager" : "me", at: at + i * 1000, text: `Older ${i}. `.repeat(30) }));
        return Response.json({ messages, more: false });
      },
      // What the chat sends (marking it read) has nowhere to go here, and needn't: /api/* answers {}.
  });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const open = async (width = 1000, height = 700) => {
  const page = await Page.open(chrome!.ws, server!.url.href, width, height, "!!document.querySelector('.bm-group')");
  await page.settle();
  return page;
};

/** How far the open chat is from its bottom. */
const gap = (page: Page) => page.eval<number>("(() => { const el = document.querySelector('.bots-messages'); return el.scrollHeight - el.scrollTop - el.clientHeight; })()");
/** The message at the top of the open chat's view, and how far below the top of the view it starts. */
const topMessage = (page: Page) =>
  page.eval<{ id: string; offset: number }>(`(() => {
    const el = document.querySelector('.bots-messages');
    const top = el.getBoundingClientRect().top;
    const rows = [...el.querySelectorAll('.bm-row[data-id], .bm-event[data-id]')];
    const row = rows.find((r) => r.getBoundingClientRect().bottom > top + 1);
    return { id: row.dataset.id, offset: Math.round(row.getBoundingClientRect().top - top) };
  })()`);
/** The same message at the top of the view, give or take the pixel layout rounds to. */
const samePlace = async (page: Page, left: { id: string; offset: number }) => {
  const now = await topMessage(page);
  expect(now.id).toBe(left.id);
  expect(Math.abs(now.offset - left.offset)).toBeLessThanOrEqual(1);
};
/** How far below the top of the view a message starts. */
const offsetOf = (page: Page, id: string) =>
  page.eval<number>(`Math.round(document.querySelector('[data-id="${id}"]').getBoundingClientRect().top - document.querySelector('.bots-messages').getBoundingClientRect().top)`);
/** Wheels down to the latest message, as far as it takes. */
const wheelToBottom = async (page: Page) => {
  for (let i = 0; i < 20 && (await gap(page)) >= 1; i++) await page.wheel(3000);
};
/** Opens a chat as the sidebar does. */
const select = async (page: Page, id: string) => {
  await page.eval(`bots.getState().select(${JSON.stringify(id)})`);
  await page.until(`document.querySelector('.bm-row[data-id^="${id}-"]') !== null`);
  await page.settle();
};
const show = async (page: Page, shown: boolean) => {
  await page.eval(`show(${shown})`);
  await page.settle();
};
/** Replaces a chat's messages, as a snapshot from the server does. */
const snapshot = (page: Page, id: string, count: number, from = 0) =>
  page.eval(`bots.setState((s) => ({ conversations: s.conversations.map((c) => c.id === ${JSON.stringify(id)} ? { ...c, messages: messages(${JSON.stringify(id)}, ${count}, ${from}) } : c) }))`);
/** A message from the bot, as the stream brings one. */
const arrive = (page: Page, id: string, extra: object = {}) =>
  page.eval(`bots.setState((s) => ({ conversations: s.conversations.map((c) => c.id === ${JSON.stringify(id)} ? { ...c, messages: [...c.messages, { id: ${JSON.stringify(id)} + "-new-" + c.messages.length, author: "manager", at: Date.now(), text: "Just in. ".repeat(20), ...${JSON.stringify(extra)} }] } : c) }))`);

describe.skipIf(!browser)("switching OpenBots chats", () => {
  test("a chat left at the bottom opens at the bottom, every time", async () => {
    const page = await open();
    expect(await gap(page)).toBeLessThan(1);
    for (const id of ["b", "a", "c", "b", "a"]) {
      await select(page, id);
      expect(await gap(page)).toBeLessThan(1);
    }
  }, 60_000);

  test("a chat scrolled up in is where it was left, and the others aren't moved by it", async () => {
    const page = await open();
    await page.wheel(-900);
    const left = await topMessage(page);
    expect(await gap(page)).toBeGreaterThan(400);
    await select(page, "b");
    expect(await gap(page)).toBeLessThan(1);
    await select(page, "c");
    expect(await gap(page)).toBeLessThan(1);
    await select(page, "a");
    await samePlace(page, left);
    // Back at the bottom, it's at the bottom next time.
    await wheelToBottom(page);
    expect(await gap(page)).toBeLessThan(1);
    await select(page, "b");
    await select(page, "a");
    expect(await gap(page)).toBeLessThan(1);
  }, 60_000);

  test("a quoted message jumped to doesn't pull the chat back up on the way back", async () => {
    const page = await open();
    // A reply quoting an old message, at the bottom; following the quote scrolls up to it.
    await arrive(page, "a", { replyTo: "a-3" });
    await page.settle();
    await page.click(".bm-row:last-of-type .bm-quote");
    await Bun.sleep(800);
    expect(await gap(page)).toBeGreaterThan(400);
    // Then back down to the latest, and off to another chat and back.
    await wheelToBottom(page);
    expect(await gap(page)).toBeLessThan(1);
    await select(page, "b");
    await select(page, "a");
    await Bun.sleep(800);
    expect(await gap(page)).toBeLessThan(1);
    // Hidden behind a thread and shown again, too.
    await show(page, false);
    await show(page, true);
    await Bun.sleep(800);
    expect(await gap(page)).toBeLessThan(1);
  }, 60_000);

  test("hidden behind another view and shown again, each keeps its place", async () => {
    const page = await open();
    await show(page, false);
    // A message comes in while it's out of sight.
    await arrive(page, "a");
    await show(page, true);
    expect(await gap(page)).toBeLessThan(1);
    await page.wheel(-900);
    const left = await topMessage(page);
    await show(page, false);
    await show(page, true);
    await samePlace(page, left);
    await show(page, false);
    await arrive(page, "a");
    await show(page, true);
    await samePlace(page, left);
  }, 60_000);

  test("late content keeps a chat at the bottom: a snapshot, images, activity", async () => {
    const page = await open();
    await select(page, "b");
    // The server's snapshot replaces the cached copy, with more history above and a new message below.
    await snapshot(page, "b", 120);
    await page.settle();
    expect(await gap(page)).toBeLessThan(1);
    // An image that loads well after the chat opened.
    imagesHeld = new Promise((r) => (releaseImages = r));
    await arrive(page, "b", { images: [`${server!.url.href}slow.png`] });
    await page.settle();
    expect(await gap(page)).toBeLessThan(1);
    releaseImages();
    await page.until("[...document.querySelectorAll('.bm-image img')].every((i) => i.complete && i.naturalWidth > 0)");
    await page.settle();
    expect(await gap(page)).toBeLessThan(1);
    // A bot starting work shows its line under the last message.
    await page.eval(`bots.setState((s) => ({ typing: { ...s.typing, b: ["helper"] } }))`);
    await page.settle();
    expect(await gap(page)).toBeLessThan(1);
    await select(page, "a");
    await select(page, "b");
    expect(await gap(page)).toBeLessThan(1);
  }, 60_000);

  test("scrolled up, a late snapshot doesn't move what's being read", async () => {
    const page = await open();
    await select(page, "b");
    await page.wheel(-900);
    const left = await topMessage(page);
    // The same messages, with more history loaded above them and one more below.
    await snapshot(page, "b", 120, -40);
    await page.settle();
    await samePlace(page, left);
    await arrive(page, "b");
    await page.settle();
    await samePlace(page, left);
    await select(page, "a");
    await select(page, "b");
    await samePlace(page, left);
  }, 60_000);

  test("a message arriving while older ones load doesn't lose the place", async () => {
    const page = await open();
    await select(page, "b");
    await page.eval(`bots.setState((s) => ({ conversations: s.conversations.map((c) => c.id === "b" ? { ...c, more: true } : c) }))`);
    for (let i = 0; i < 20 && (await page.eval<number>("document.querySelector('.bots-messages').scrollTop")) > 0; i++) await page.wheel(-3000);
    const left = await topMessage(page);
    olderHeld = new Promise((r) => (releaseOlder = r));
    await page.click(".bots-messages-inner > .bots-btn");
    await arrive(page, "b");
    await page.settle();
    await samePlace(page, left);
    releaseOlder();
    await page.until(`!!document.querySelector('[data-id="b-old-0"]')`);
    await page.settle();
    // The older ones came in above, out of view; what was at the top is still there.
    expect(Math.abs((await offsetOf(page, left.id)) - left.offset)).toBeLessThanOrEqual(1);
    expect(await offsetOf(page, "b-old-19")).toBeLessThan(left.offset);
  }, 60_000);

  test("a chat with the same id in another workspace doesn't take this one's place", async () => {
    const page = await open();
    await page.wheel(-900);
    const left = await topMessage(page);
    const here = await page.eval("JSON.stringify(bots.getState().conversations)");
    // Left for another chat, so its place here is put away.
    await select(page, "b");
    // Another device's workspace, whose chat happens to have the same id and the same message ids:
    // only the workspace tells them apart.
    await page.eval(`bots.setState({ workspace: "elsewhere", conversations: [{ ...bots.getState().conversations[0], messages: messages("a", 40) }], activeId: "a" })`);
    await page.settle();
    await page.settle();
    expect(await gap(page)).toBeLessThan(1);
    await page.wheel(-400);
    // Back to this one's: where it was left here, not where it was left there.
    await page.eval(`bots.setState({ workspace: undefined, conversations: JSON.parse(${JSON.stringify(here)}), activeId: "a" })`);
    await page.settle();
    await page.settle();
    await samePlace(page, left);
  }, 60_000);

  test("on a phone, back to the list and into the chat again", async () => {
    const page = await open(390, 760);
    for (const id of ["b", "a", "c"]) {
      await select(page, id);
      expect(await gap(page)).toBeLessThan(1);
    }
    await page.wheel(-700);
    const left = await topMessage(page);
    await select(page, "a");
    await select(page, "c");
    await samePlace(page, left);
  }, 60_000);
});
