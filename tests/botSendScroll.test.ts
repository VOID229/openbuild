// Sending in an OpenBots chat scrolled up, in a real Chrome against a fake workspace on the page
// (tests/fixtures/botSend): the view stays exactly where the user is, through the message showing,
// the workspace taking it, the bot starting work and its reply, and a message sent while it works.
// At the bottom, a send still follows the chat down.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

const FIELD = ".bots-composer-textarea";

class SendPage extends Page {
  async type(text: string) {
    await this.eval(`document.querySelector('${FIELD}').focus()`);
    await this.send("Input.insertText", { text });
    await this.settle();
  }
  async enter() {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  }
  /** How far the chat is from its bottom. */
  gap() {
    return this.eval<number>("(() => { const el = document.querySelector('.bots-messages'); return el.scrollHeight - el.scrollTop - el.clientHeight; })()");
  }
  /** The message at the top of the view, and how far below the top of the view it starts. */
  top() {
    return this.eval<{ id: string; offset: number }>(`(() => {
      const el = document.querySelector('.bots-messages');
      const top = el.getBoundingClientRect().top;
      const row = [...el.querySelectorAll('.bm-row[data-id]')].find((r) => r.getBoundingClientRect().top >= top);
      return { id: row.dataset.id, offset: row.getBoundingClientRect().top - top };
    })()`);
  }
  /**
   * Starts noting, every frame, how far the message at the top of the view has moved from where it is
   * now; `moved` stops and says the most it was ever off by. Catches a jump that's put right a frame later.
   */
  watch() {
    return this.eval(`(() => {
      const el = document.querySelector('.bots-messages');
      const row = [...el.querySelectorAll('.bm-row[data-id]')].find((r) => r.getBoundingClientRect().top >= el.getBoundingClientRect().top);
      const at = () => row.getBoundingClientRect().top - el.getBoundingClientRect().top;
      const start = at();
      window.watched = { most: 0, on: true };
      const tick = () => {
        if (!window.watched.on) return;
        window.watched.most = Math.max(window.watched.most, Math.abs(at() - start));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    })()`);
  }
  async moved() {
    await this.settle();
    return this.eval<number>("(window.watched.on = false, Math.max(window.watched.most, 0))");
  }
  /** Something only the store changes: the bot's status, its typing, a reply from it. */
  bots(change: string) {
    return this.eval(`(bots.setState(${change}), true)`);
  }
  hold(on: boolean) {
    return this.eval(`(workspace.hold = ${on}, true)`);
  }
  release() {
    return this.eval("(workspace.release(), true)");
  }
}

const WORKING = `{ status: { manager: { state: "working", conversationId: "chat", activity: "Opening example.com", since: Date.now() } } }`;
const IDLE = `{ status: { manager: { state: "idle" } }, typing: {} }`;
const TYPING = `{ status: { manager: { state: "working", conversationId: "chat", activity: "Writing a reply", since: Date.now() } }, typing: { chat: ["manager"] } }`;
const REPLY = (n: number) =>
  `(s) => ({ conversations: s.conversations.map((c) => c.id === "chat" ? { ...c, messages: [...c.messages, { id: "reply-${n}", author: "manager", at: Date.now(), text: "Here's what I found. ".repeat(8) }] } : c) })`;

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botSend/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

for (const kind of ["direct", "group"] as const) {
  describe.skipIf(!browser)(`sending in a ${kind} chat`, () => {
    const open = async () => {
      const page = await SendPage.open(chrome!.ws, `${server!.url}?kind=${kind}&n=80`, 1000, 700, `!!document.querySelector('${FIELD}') && !!document.querySelector('.bm-row')`);
      await page.settle();
      expect(await page.gap()).toBeLessThan(1);
      return page;
    };

    for (const up of [1500, 120]) {
      test(`scrolled up ${up}px, the view stays where it is through the whole send`, async () => {
        const page = await open();
        await page.wheel(-up);
        const left = await page.top();
        expect(await page.gap()).toBeGreaterThan(up - 20);

        // The message shows straight away, before the workspace has taken it.
        await page.hold(true);
        await page.watch();
        await page.type("hello there");
        await page.enter();
        await page.until(`[...document.querySelectorAll('.bm-mine .bm-text')].some((t) => t.textContent === "hello there")`);
        expect(await page.moved()).toBeLessThan(1);

        // The workspace takes it, and the bot gets to work: its working row, then typing, then its reply.
        for (const step of [() => page.release(), () => page.bots(WORKING), () => page.bots(TYPING), () => page.bots(REPLY(1)), () => page.bots(IDLE)]) {
          await page.watch();
          await step();
          await page.settle();
          await page.settle();
          expect(await page.moved()).toBeLessThan(1);
        }

        // Another message while the bot's at work, which goes to it as it works.
        await page.hold(false);
        await page.bots(WORKING);
        await page.settle();
        await page.watch();
        await page.type("and one more thing");
        await page.enter();
        await page.until(`[...document.querySelectorAll('.bm-mine .bm-text')].some((t) => t.textContent === "and one more thing")`);
        await page.settle();
        expect(await page.moved()).toBeLessThan(1);

        const now = await page.top();
        expect(now.id).toBe(left.id);
        expect(Math.abs(now.offset - left.offset)).toBeLessThan(1);
        expect(await page.gap()).toBeGreaterThan(up - 20);
      }, 60_000);
    }

    test("at the bottom, a send still follows the chat down", async () => {
      const page = await open();
      await page.type("hello there");
      await page.enter();
      await page.until(`[...document.querySelectorAll('.bm-mine .bm-text')].some((t) => t.textContent === "hello there")`);
      await page.settle();
      expect(await page.gap()).toBeLessThan(1);
      await page.bots(TYPING);
      await page.settle();
      expect(await page.gap()).toBeLessThan(1);
      await page.bots(REPLY(1));
      await page.bots(IDLE);
      // The reply opens its room over a moment, the chat going down with it.
      await page.finished(".bots-messages");
      expect(await page.gap()).toBeLessThan(1);
    }, 60_000);
  });
}
