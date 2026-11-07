// A bot's mascot in a group chat, in a real Chrome: it sits beside the message it sent and scrolls
// with it, never held at the bottom of the view while a long message goes past.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/botScroll/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page, "/api/*": () => Response.json({}) } });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

const LONG = "The investigation keeps running on its own, so it can carry on while the other session is stuck. ".repeat(40);

/** Group chat "b", ending with a message from manager long enough to scroll through. */
const open = async (width = 1000, height = 700) => {
  const page = await Page.open(chrome!.ws, server!.url.href, width, height, "!!document.querySelector('.bm-group')");
  await page.eval(`bots.setState((s) => ({ conversations: s.conversations.map((c) => c.id === "b" ? { ...c, messages: [...c.messages, { id: "b-long", author: "manager", at: Date.now(), text: ${JSON.stringify(LONG)} }, { id: "b-after", author: "helper", at: Date.now(), text: "Short one after." }] } : c) }))`);
  await page.eval(`bots.getState().select("b")`);
  await page.until(`document.querySelector('[data-id="b-long"]') !== null`);
  await page.settle();
  return page;
};

/** Where the long message's mascot is, against the bubble it belongs to. */
const place = (page: Page) =>
  page.eval<{ avatar: number; bubble: number; view: number }>(`(() => {
    const group = document.querySelector('[data-id="b-long"]').closest('.bm-group');
    const avatar = group.querySelector('.bm-avatar').getBoundingClientRect();
    const stack = group.querySelector('.bm-stack').getBoundingClientRect();
    const view = document.querySelector('.bots-messages').getBoundingClientRect();
    return { avatar: Math.round(avatar.bottom), bubble: Math.round(stack.bottom), view: Math.round(view.bottom) };
  })()`);

/** Scrolls the conversation so the long message's middle is in the middle of the view. */
const toMiddle = (page: Page) =>
  page.eval(`(() => {
    const el = document.querySelector('.bots-messages');
    const r = document.querySelector('[data-id="b-long"]').getBoundingClientRect();
    el.scrollTop += r.top + r.height / 2 - (el.getBoundingClientRect().top + el.clientHeight / 2);
  })()`);

describe.skipIf(!browser)("a bot's mascot in a group chat", () => {
  for (const [label, width] of [["on a desktop", 1000], ["on a phone", 390]] as const) {
    test(`stays beside the end of its message while scrolling through it, ${label}`, async () => {
      const page = await open(width, 700);
      const atRest = await place(page);
      const offset = atRest.bubble - atRest.avatar;
      await toMiddle(page);
      await page.settle();
      const mid = await place(page);
      // The message runs off below the view, and its mascot goes with it.
      expect(mid.bubble).toBeGreaterThan(mid.view + 50);
      expect(mid.bubble - mid.avatar).toBe(offset);
      // A real wheel, a step at a time towards the end, never picks it up.
      for (let i = 0; i < 6; i++) {
        await page.wheel(120);
        const now = await place(page);
        expect(now.bubble - now.avatar).toBe(offset);
      }
    }, 60_000);
  }

  test("stays put with a tall draft and images in the composer", async () => {
    const page = await open();
    await page.eval(`(() => {
      const el = document.querySelector('.bots-composer-textarea');
      el.focus();
      document.execCommand("insertText", false, ${JSON.stringify("there's a bug where scrolling picks up the mascot. ".repeat(8))});
    })()`);
    await page.eval(`(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 40;
      canvas.getContext("2d").fillRect(0, 0, 40, 40);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      const data = new DataTransfer();
      data.items.add(new File([blob], "shot.png", { type: "image/png" }));
      document.querySelector('.bots-composer-textarea').dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    })()`);
    await page.until("document.querySelectorAll('.bots-composer-image-open').length === 1");
    await page.settle();
    const atRest = await place(page);
    await toMiddle(page);
    await page.settle();
    const mid = await place(page);
    expect(mid.bubble).toBeGreaterThan(mid.view + 50);
    expect(mid.bubble - mid.avatar).toBe(atRest.bubble - atRest.avatar);
  }, 60_000);
});
