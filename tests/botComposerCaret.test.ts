// Going between OpenBots chats with drafts in them, in a real Chrome: each chat's draft comes back with
// the caret, selection and scroll it was left with, and a touch screen isn't handed the keyboard for it.
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

const FIELD = "document.querySelector('.bots-composer-textarea')";
const KEYS = { ArrowLeft: 37, ArrowUp: 38, Home: 36 } as const;

class CaretPage extends Page {
  async type(text: string) {
    await this.send("Input.insertText", { text });
    await this.settle();
  }
  /** A real key press, with Shift held when `shift`. */
  async press(key: keyof typeof KEYS, times = 1, shift = false) {
    for (let i = 0; i < times; i++) {
      for (const type of ["rawKeyDown", "keyUp"]) await this.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: KEYS[key], modifiers: shift ? 8 : 0 });
    }
    await this.settle();
  }
  /** Opens a chat as the sidebar does. */
  async select(id: string) {
    await this.eval(`bots.getState().select(${JSON.stringify(id)})`);
    await this.until(`document.querySelector('.bm-row[data-id^="${id}-"]') !== null`);
    await this.settle();
  }
  field() {
    return this.eval<{ value: string; start: number; end: number; direction: string; scroll: number; backdrop: number; focused: boolean }>(`(() => {
      const el = ${FIELD};
      return { value: el.value, start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection, scroll: el.scrollTop, backdrop: document.querySelector('.bots-draft').scrollTop, focused: document.activeElement === el };
    })()`);
  }
  /** Headless Chrome has no pointer at all: a mouse, as on a desktop, so chats focus their box on opening. */
  mouse() {
    return this.eval(`(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => real(q === "(pointer: fine)" ? "all" : q);
    })()`);
  }
  focusField() {
    return this.eval(`${FIELD}.focus()`);
  }
  async pasteImage() {
    const before = await this.eval<number>("document.querySelectorAll('.bots-composer-image-open').length");
    await this.eval(`(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 40;
      canvas.getContext("2d").fillRect(0, 0, 40, 40);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      const data = new DataTransfer();
      data.items.add(new File([blob], "shot.png", { type: "image/png" }));
      ${FIELD}.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    })()`);
    await this.until(`document.querySelectorAll('.bots-composer-image-open').length === ${before + 1}`);
    await this.settle();
  }
}

const open = async (width = 1000, height = 700) => {
  const page = await CaretPage.open(chrome!.ws, server!.url.href, width, height, `!!${FIELD} && !!document.querySelector('.bm-group')`);
  await page.focusField();
  await page.settle();
  return page;
};

const A = "there's a bug where scrolling in a group chat picks up the mascot";
const B = "draft for the crew, with a selection in it";

describe.skipIf(!browser)("an OpenBots draft's caret", () => {
  test("each chat keeps its own caret, between direct chats and groups", async () => {
    const page = await open();
    await page.mouse();
    await page.type(A);
    await page.press("ArrowLeft", 10);
    expect((await page.field()).start).toBe(A.length - 10);

    await page.select("b");
    expect((await page.field()).focused).toBe(true);
    await page.type(B);
    await page.press("ArrowLeft", 3);

    await page.select("c");
    expect((await page.field()).value).toBe("");

    await page.select("a");
    let f = await page.field();
    expect(f.value).toBe(A);
    expect([f.start, f.end]).toEqual([A.length - 10, A.length - 10]);
    expect(f.focused).toBe(true);
    // And typing carries on from there.
    await page.type("X");
    f = await page.field();
    expect(f.value).toBe(`${A.slice(0, -10)}X${A.slice(-10)}`);

    await page.select("b");
    f = await page.field();
    expect([f.value, f.start, f.end]).toEqual([B, B.length - 3, B.length - 3]);
  }, 60_000);

  test("a selection comes back, backwards selections and a caret at the very start too", async () => {
    const page = await open();
    await page.type(A);
    await page.press("ArrowLeft", 4, true);
    await page.select("b");
    await page.focusField();
    await page.type(B);
    await page.press("Home");
    expect((await page.field()).start).toBe(0);

    await page.select("a");
    let f = await page.field();
    expect([f.start, f.end, f.direction]).toEqual([A.length - 4, A.length, "backward"]);
    await page.select("b");
    f = await page.field();
    expect([f.start, f.end]).toEqual([0, 0]);
  }, 60_000);

  test("a long draft comes back scrolled where it was, with the images it had", async () => {
    const page = await open();
    const long = Array.from({ length: 20 }, (_, i) => `line ${i} of a draft long enough to scroll the composer`).join("\n");
    await page.pasteImage();
    await page.type(long);
    await page.press("ArrowUp", 8);
    const left = await page.field();
    expect(left.scroll).toBeGreaterThan(20);
    expect(left.scroll).toBeLessThan(await page.eval<number>(`${FIELD}.scrollHeight - ${FIELD}.clientHeight - 20`));

    await page.select("b");
    await page.select("a");
    const back = await page.field();
    expect([back.start, back.end]).toEqual([left.start, left.end]);
    expect(back.scroll).toBe(left.scroll);
    // The mentions drawn behind the text line up with it.
    expect(back.backdrop).toBe(back.scroll);
    expect(await page.eval<number>("document.querySelectorAll('.bots-composer-image-open').length")).toBe(1);
  }, 60_000);

  test("on a touch screen, switching back doesn't focus the field", async () => {
    const page = await open(390, 800);
    await page.type(A);
    await page.press("ArrowLeft", 5);
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.send("Emulation.setEmitTouchEventsForMouse", { enabled: true });
    expect(await page.eval<boolean>("matchMedia('(pointer: coarse)').matches")).toBe(true);
    await page.eval("document.activeElement.blur()");
    await page.select("b");
    await page.select("a");
    const f = await page.field();
    expect(f.focused).toBe(false);
    expect([f.value, f.start]).toEqual([A, A.length - 5]);
  }, 60_000);
});
