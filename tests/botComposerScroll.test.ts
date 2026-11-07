// The OpenBots composer growing and shrinking as a draft is typed, in a real Chrome: the conversation
// stays at the bottom when it was there, and stays where the user scrolled it when it wasn't.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page } from "./chromePage";

/** The composer's field, to type into, delete from and measure. */
class ComposerPage extends Page {
  /** A word at a time, or a character at a time with `chars`: each is a keystroke the composer reacts to. */
  async type(text: string, each?: () => Promise<void>, chars = false) {
    for (const key of chars ? [...text] : text.match(/\S+\s*/g)!) {
      await this.send("Input.insertText", { text: key });
      await this.settle();
      await each?.();
    }
  }
  /** Deletes the draft's last word at a time, as Ctrl+Backspace does. */
  async deleteWords(times: number, each?: () => Promise<void>) {
    for (let i = 0; i < times; i++) {
      await this.eval(`(() => {
        const el = document.querySelector('.bots-composer-textarea');
        el.setSelectionRange(el.value.trimEnd().replace(/\\S+$/, "").length, el.value.length);
        document.execCommand("delete");
      })()`);
      await this.settle();
      await each?.();
    }
  }
  /** How far the conversation is from its bottom. */
  gap() {
    return this.eval<number>("(() => { const el = document.querySelector('.bots-messages'); return el.scrollHeight - el.scrollTop - el.clientHeight; })()");
  }
  composerHeight() {
    return this.eval<number>("document.querySelector('.bots-composer-textarea').offsetHeight");
  }
  focus() {
    return this.eval("document.querySelector('.bots-composer-textarea').focus()");
  }
}

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/botComposer/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page } });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

const LINE = 22;
const words = "let's combine them actually, keep that previous twenty minute thing where it keeps sending to the same bot ";

for (const kind of ["direct", "group"] as const) {
  describe.skipIf(!browser)(`the composer in a ${kind} chat`, () => {
    const open = async (width = 1000) => {
      const page = await ComposerPage.open(chrome!.ws, `${server!.url}?kind=${kind}`, width, 700, "!!document.querySelector('.bots-composer-textarea') && !!document.querySelector('.bm-group')");
      await page.focus();
      await page.settle();
      return page;
    };

    test("growing line by line keeps the latest message in view", async () => {
      const page = await open();
      expect(await page.gap()).toBeLessThan(1);
      const heights = new Set<number>();
      await page.type(words.repeat(3), async () => {
        heights.add(await page.composerHeight());
        expect(await page.gap()).toBeLessThan(1);
      });
      // It really did wrap, more than once.
      expect(Math.max(...heights)).toBeGreaterThanOrEqual(3 * LINE);
    }, 60_000);

    test("typing into a tall draft doesn't snap the conversation back", async () => {
      const page = await open();
      await page.type(words.repeat(3));
      // Scrolled to the very bottom, as the user does to read past the grown composer.
      await page.wheel(2000);
      expect(await page.gap()).toBeLessThan(1);
      await page.type("more", async () => expect(await page.gap()).toBeLessThan(1), true);
    }, 60_000);

    test("shrinking the draft keeps to the bottom", async () => {
      const page = await open();
      await page.type(words.repeat(3));
      const tall = await page.composerHeight();
      await page.deleteWords(60, async () => expect(await page.gap()).toBeLessThan(1));
      expect(tall).toBeGreaterThan(3 * LINE);
      expect(await page.composerHeight()).toBeLessThan(2 * LINE);
    }, 60_000);

    test("scrolled up, the conversation stays where the user left it", async () => {
      const page = await open();
      await page.wheel(-600);
      const gap = await page.gap();
      expect(gap).toBeGreaterThan(300);
      // What's just above the composer stays there as it grows and shrinks, a character at a time.
      await page.type(words.repeat(3), async () => expect(Math.abs((await page.gap()) - gap)).toBeLessThan(1));
      await page.deleteWords(60, async () => expect(Math.abs((await page.gap()) - gap)).toBeLessThan(1));
    }, 60_000);

    test("on a narrow window too", async () => {
      const page = await open(400);
      await page.type(words.repeat(2), async () => expect(await page.gap()).toBeLessThan(1));
      await page.wheel(2000);
      await page.type("more", async () => expect(await page.gap()).toBeLessThan(1), true);
    }, 60_000);
  });
}
