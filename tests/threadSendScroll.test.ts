// Sending in an OpenBuild thread scrolled up, in a real Chrome (the whole app on a fake server,
// fixtures/threadSend): the view stays exactly where the reader is through the message going out,
// the reply streaming in, a message queued from the composer, a steer landing in the reply, the
// server's copy coming back and the queued message going out. At the bottom, a send still follows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/threadSend/index.html`, {
    "/thread-*": (req) => fetch(new URL("/", req.url)),
  });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const READY = "!!document.querySelector('.messages [data-message-id]') && !!document.querySelector('.composer-input')";
const AT_BOTTOM = "(() => { const m = document.querySelector('.messages'); return m.scrollHeight - m.clientHeight - m.scrollTop <= 2; })()";

class ThreadPage extends Page {
  gap() {
    return this.eval<number>("(() => { const m = document.querySelector('.messages'); return m.scrollHeight - m.clientHeight - m.scrollTop; })()");
  }
  /** The message at the top of the view, and how far below the top of the view it starts. */
  top() {
    return this.eval<{ id: string; offset: number }>(`(() => {
      const el = document.querySelector('.messages');
      const top = el.getBoundingClientRect().top;
      const msg = [...el.querySelectorAll('.messages-inner > [data-message-id]')].find((m) => m.getBoundingClientRect().top >= top);
      return { id: msg.dataset.messageId, offset: msg.getBoundingClientRect().top - top };
    })()`);
  }
  /** Notes every frame how far the message at the top of the view moves from where it is now (see `moved`). */
  watch() {
    return this.eval(`(() => {
      const el = document.querySelector('.messages');
      const msg = [...el.querySelectorAll('.messages-inner > [data-message-id]')].find((m) => m.getBoundingClientRect().top >= el.getBoundingClientRect().top);
      const at = () => msg.getBoundingClientRect().top - el.getBoundingClientRect().top;
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
  /** Stops watching, a few frames on (a glide moves a little each frame), and says the most it was off by. */
  async moved() {
    for (let i = 0; i < 4; i++) await this.settle();
    return this.eval<number>("(window.watched.on = false, window.watched.most)");
  }
  /** Runs one of the fixture's store changes (send, write, steer, finish, confirm, drain). */
  async act(call: string) {
    await this.eval(`(${call}, true)`);
    await this.settle();
  }
  async type(text: string) {
    await this.eval("document.querySelector('.composer-input').focus()");
    await this.send("Input.insertText", { text });
    await this.settle();
  }
  async enter() {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await this.settle();
  }
}

const open = async () => {
  const page = await ThreadPage.open(chrome!.ws, `${server!.url.href}thread-t0`, 1200, 700, READY);
  await page.eval("document.fonts.ready.then(() => true)");
  await page.until(AT_BOTTOM);
  for (let i = 0; i < 3; i++) await page.settle();
  return page;
};

describe.skipIf(!browser)("sending in a thread", () => {
  for (const up of [4000, 150]) {
    test(`scrolled up ${up}px, the view stays where it is through the whole turn`, async () => {
      const page = await open();
      await page.wheel(-up, ".messages");
      for (let i = 0; i < 3; i++) await page.settle();
      const left = await page.top();
      expect(await page.gap()).toBeGreaterThan(Math.min(up, 2000) - 50);

      const steps = [
        "send('Can you look at the flaky test too?')",
        "write('Looking at it now. ')",
        "write('The test waits on a timer that '.repeat(20))",
      ];
      for (const step of steps) {
        await page.watch();
        await page.act(step);
        expect(await page.moved()).toBeLessThan(1);
      }
      // A message typed while the reply is coming in waits in the composer's queue.
      await page.watch();
      await page.type("and the other one after that");
      await page.enter();
      await page.until("queued() === 1");
      expect(await page.moved()).toBeLessThan(1);
      for (const step of ["steer('Also check the retry')", "write('Checked the retry as well. '.repeat(10))", "finish()", "confirm()", "drain()", "write('On to the other one. '.repeat(10))", "finish()"]) {
        await page.watch();
        await page.act(step);
        expect(await page.moved()).toBeLessThan(1);
      }

      const now = await page.top();
      expect(now.id).toBe(left.id);
      expect(Math.abs(now.offset - left.offset)).toBeLessThan(1);
    }, 60_000);
  }

  test("at the bottom, a send still follows the reply down", async () => {
    const page = await open();
    await page.act("send('Can you look at the flaky test too?')");
    await page.act("write('Looking at it now. '.repeat(30))");
    await page.until(AT_BOTTOM);
    await page.act("finish()");
    await page.until(AT_BOTTOM);
  }, 60_000);
});
