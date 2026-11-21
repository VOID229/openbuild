// The message composer shows a draft's Markdown while it is typed, and edits its lists: in a real
// Chrome, on a bot's chat with a fake workspace on the page (tests/fixtures/botSend). The edits
// themselves, as text in and text out: tests/smartInput.test.ts. What is bold, italic or a list:
// tests/chatText.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

const FIELD = "document.querySelector('.bots-composer-textarea')";
const MODULES = `${import.meta.dir}/../node_modules`;
/** The app's four fonts (Settings → Appearance), as main.tsx loads them: upright faces only. */
const FONTS = [
  { setting: "", family: "Inter Variable", file: `${MODULES}/@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2`, weight: "100 900" },
  { setting: "fun", family: "Comic Neue", file: `${MODULES}/@fontsource/comic-neue/files/comic-neue-latin-400-normal.woff2`, weight: "400" },
  { setting: "serif", family: "Newsreader Variable", file: `${MODULES}/@fontsource-variable/newsreader/files/newsreader-latin-wght-normal.woff2`, weight: "200 800" },
  { setting: "mono", family: "Geist Mono Variable", file: `${MODULES}/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2`, weight: "100 900" },
];
const KEYS = { Enter: 13, ArrowUp: 38, ArrowLeft: 37, End: 35, Backspace: 8, Delete: 46, x: 88, z: 90 } as const;

class DraftPage extends Page {
  async type(text: string) {
    await this.send("Input.insertText", { text });
    await this.settle();
  }
  /** A real key press. Enter carries its character, so a line break nobody handles is typed by the field itself. */
  async press(key: keyof typeof KEYS, { shift = false, commands = [] as string[] } = {}) {
    const event = { key, code: key, windowsVirtualKeyCode: KEYS[key], modifiers: shift ? 8 : 0 };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...event, ...(key === "Enter" ? { text: "\r" } : {}), commands });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
    await this.settle();
  }
  newLine() {
    return this.press("Enter", { shift: true });
  }
  /** The browser's own undo, as Ctrl+Z or ⌘Z does it. */
  undo() {
    return this.press("z", { commands: ["undo"] });
  }
  /** Selects from `start` to `end` in the field, as a drag or Shift and the arrows does. */
  select(start: number, end = start) {
    return this.eval(`(${FIELD}.setSelectionRange(${start}, ${end}), true)`);
  }
  /** The draft with its caret as "|". */
  draft() {
    return this.eval<string>(`(() => { const el = ${FIELD}; return el.selectionStart === el.selectionEnd ? el.value.slice(0, el.selectionStart) + "|" + el.value.slice(el.selectionStart) : "selection " + el.selectionStart + "-" + el.selectionEnd; })()`);
  }
  /** What the backdrop draws, stretch by stretch: how (its marks' names, in order) and the text. */
  drawn() {
    return this.eval<[string, string][]>(`[...document.querySelector('.bots-draft').childNodes].map((n) => [n.nodeType === 3 ? "" : [...n.classList].map((c) => c.replace("bots-draft-", "")).sort().join(" "), n.textContent]).filter(([, text]) => text !== "\\u200b")`);
  }
  posts() {
    return this.eval<string[]>("workspace.posts.map((p) => p.text)");
  }
}

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botSend/index.html`, Object.fromEntries(FONTS.map((f, i) => [`/font-${i}.woff2`, () => new Response(Bun.file(f.file))])));
  // With font hinting, as some Linux desktops have it: there a slanted run and an upright one are
  // laid out differently unless the composer says otherwise (bots.css), by pixels a line.
  chrome = await launchChrome(["--font-render-hinting=medium"]);
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const open = async ({ kind = "direct", phone = false } = {}) => {
  const [width, height] = phone ? [390, 844] : [1000, 700];
  const page = await DraftPage.open(chrome!.ws, `${server!.url.href}?kind=${kind}`, width, height, `!!${FIELD} && !!document.querySelector('.bm-row')`);
  if (phone) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true });
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }] });
    await page.until("matchMedia('(pointer: coarse)').matches");
  }
  await page.eval(`${FIELD}.focus()`);
  await page.settle();
  return page;
};

describe.skipIf(!browser)("the composer's Markdown", () => {
  test("a draft is drawn as its message will show it: bold, italic, code, and a list's bullets and numbers", async () => {
    const page = await open();
    await page.type("- ");
    // "- " is a bullet at once, before the item has any text.
    expect(await page.drawn()).toEqual([["bullet", "-"], ["", " "]]);
    expect(await page.eval<string>(`getComputedStyle(document.querySelector('.bots-draft-bullet'), '::after').content`)).toBe('"•"');
    await page.type("**bold** and _it_ and *it*");
    await page.newLine();
    await page.type("`ls` [docs](https://dkod.ai)");
    expect(await page.drawn()).toEqual([
      ["bullet", "-"], ["", " "],
      ["bold mark", "**"], ["bold", "bold"], ["bold mark", "**"], ["", " and "],
      ["italic mark", "_"], ["italic", "it"], ["italic mark", "_"], ["", " and "],
      ["italic mark", "*"], ["italic", "it"], ["italic mark", "*"], ["", "\n"],
      ["bullet", "-"], ["", " "],
      ["code mark", "`"], ["code", "ls"], ["code mark", "`"], ["", " "],
      ["mark", "["], ["link", "docs"], ["mark", "](https://dkod.ai)"],
    ]);
    // Character for character the textarea's text: the caret is the textarea's.
    expect(await page.eval<boolean>(`document.querySelector('.bots-draft').textContent === ${FIELD}.value + "\\u200b"`)).toBe(true);
    // A numbered list, and a code block that is still open.
    await page.eval(`(${FIELD}.select(), true)`);
    await page.type("1. one\n2) two\n```sh\nls **x**");
    expect(await page.drawn()).toEqual([["number", "1."], ["", " one\n"], ["number", "2)"], ["", " two\n"], ["fence mark", "```sh"], ["fence", "\nls **x**"]]);
  }, 60_000);

  test("Shift+Enter in a numbered item starts the next number, and one higher up moves the numbers below", async () => {
    const page = await open();
    await page.type("1. something");
    await page.newLine();
    expect(await page.draft()).toBe("1. something\n2. |");
    // Back up on the "1." line, the same key again: a new "2.", and the old "2." is "3.".
    await page.press("ArrowUp");
    await page.press("End");
    expect(await page.draft()).toBe("1. something|\n2. ");
    await page.newLine();
    expect(await page.draft()).toBe("1. something\n2. |\n3. ");
    await page.type("second");
    await page.newLine();
    expect(await page.draft()).toBe("1. something\n2. second\n3. |\n4. ");
    // The backdrop draws every number where the textarea has it.
    expect((await page.drawn()).filter(([how]) => how === "number").map(([, text]) => text)).toEqual(["1.", "2.", "3.", "4."]);
    // Nothing was sent by any of it.
    expect(await page.posts()).toEqual([]);
  }, 60_000);

  test("Shift+Enter in an empty item ends the list, and elsewhere it is a plain new line", async () => {
    const page = await open();
    await page.type("- one");
    await page.newLine();
    expect(await page.draft()).toBe("- one\n- |");
    await page.newLine();
    expect(await page.draft()).toBe("- one\n|");
    await page.type("after");
    await page.newLine();
    expect(await page.draft()).toBe("- one\nafter\n|");
    // In a code block a "-" is code.
    await page.type("```");
    await page.newLine();
    await page.type("- flag");
    await page.newLine();
    expect(await page.draft()).toBe("- one\nafter\n```\n- flag\n|");
  }, 60_000);

  test("Backspace on an item's mark takes the mark away whole, and the numbers below close up", async () => {
    const page = await open();
    await page.type("1. one\n2. two\n3. three");
    await page.press("ArrowUp");
    await page.eval(`(${FIELD}.setSelectionRange(10, 10), true)`);
    expect(await page.draft()).toBe("1. one\n2. |two\n3. three");
    await page.press("Backspace");
    expect(await page.draft()).toBe("1. one\n|two\n2. three");
  }, 60_000);

  test("an item deleted any other way closes the numbers up too: a selection, Delete, a word at once, a cut", async () => {
    const page = await open();
    await page.type("1. a\n2. b\n3. c\n4. d");
    // The line "2. b" selected with its line break and deleted.
    await page.select(5, 10);
    await page.press("Backspace", { commands: ["deleteBackward"] });
    expect(await page.draft()).toBe("1. a\n|2. c\n3. d");
    // Delete at the end of "1. a" pulls "2. c" up into it.
    await page.select(4);
    await page.press("Delete", { commands: ["deleteForward"] });
    expect(await page.draft()).toBe("1. a|2. c\n2. d");
    await page.type("\n5. ");
    expect(await page.draft()).toBe("1. a\n2. |2. c\n3. d");
    // A word deleted at once (Ctrl or Option+Backspace) right after a mark breaks the item.
    await page.eval(`(${FIELD}.value = "", ${FIELD}.dispatchEvent(new Event("input", { bubbles: true })), true)`);
    await page.type("1. a\n2. b\n3. c");
    await page.select(7);
    await page.press("Backspace", { commands: ["deleteWordBackward"] });
    const [, broken, last] = (await page.eval<string>(`${FIELD}.value`)).split("\n");
    expect(broken).not.toMatch(/^\d+[.)] /);
    expect(last).toBe("2. c");
    // A cut of a whole item.
    await page.eval(`(${FIELD}.value = "", ${FIELD}.dispatchEvent(new Event("input", { bubbles: true })), true)`);
    await page.type("1. a\n2. b\n3. c");
    await page.select(5, 10);
    await page.press("x", { commands: ["cut"] });
    expect(await page.draft()).toBe("1. a\n|2. c");
  }, 60_000);

  test("an item put back above and deleted again leaves the numbers as they were, and undo steps back through both", async () => {
    const page = await open();
    await page.type("1. foo\n2. bar\n3. baz");
    await page.select(6);
    await page.newLine();
    await page.type("new");
    expect(await page.draft()).toBe("1. foo\n2. new|\n3. bar\n4. baz");
    await page.select(7, 14);
    await page.press("Backspace", { commands: ["deleteBackward"] });
    expect(await page.draft()).toBe("1. foo\n|2. bar\n3. baz");
    // Undo takes the numbers back first, then the deleted item, and is never caught renumbering again.
    await page.undo();
    expect(await page.eval<string>(`${FIELD}.value`)).toBe("1. foo\n3. bar\n4. baz");
    await page.undo();
    expect(await page.eval<string>(`${FIELD}.value`)).toBe("1. foo\n2. new\n3. bar\n4. baz");
    // And the backdrop follows the field.
    expect((await page.drawn()).filter(([how]) => how === "number").map(([, text]) => text)).toEqual(["1.", "2.", "3.", "4."]);
  }, 60_000);

  test("a list's own edit is undone by the browser's undo, like anything typed", async () => {
    const page = await open();
    await page.type("1. one\n2. two");
    await page.press("ArrowUp");
    await page.press("End");
    await page.newLine();
    expect(await page.draft()).toBe("1. one\n2. |\n3. two");
    await page.undo();
    expect(await page.eval<string>(`${FIELD}.value`)).toBe("1. one\n2. two");
    // And the backdrop follows the field back.
    expect((await page.drawn()).filter(([how]) => how === "number").map(([, text]) => text)).toEqual(["1.", "2."]);
  }, 60_000);

  test("Enter still sends, the message is laid out as the draft was drawn, and an item left empty isn't sent", async () => {
    const page = await open();
    await page.type("Two **things** and _one_ more:");
    await page.newLine();
    await page.type("1. Run `bun test`");
    await page.newLine();
    await page.type("Ship *it*");
    await page.newLine();
    expect(await page.draft()).toBe("Two **things** and _one_ more:\n1. Run `bun test`\n2. Ship *it*\n3. |");
    await page.press("Enter");
    await page.until(`${FIELD}.value === ""`);
    expect(await page.posts()).toEqual(["Two **things** and _one_ more:\n1. Run `bun test`\n2. Ship *it*"]);
    // On a desktop too, the bubble shows a list as a list, with the same bold, italic and code.
    await page.until(`[...document.querySelectorAll('.bm-mine .bm-text')].at(-1)?.querySelectorAll('.chat-item').length === 2`);
    const bubble = await page.eval<{ items: string[]; bold: string[]; italic: string[]; code: string[]; text: string }>(`(() => {
      const el = [...document.querySelectorAll('.bm-mine .bm-text')].at(-1);
      const all = (sel) => [...el.querySelectorAll(sel)].map((n) => n.textContent);
      return { items: [...el.querySelectorAll('.chat-item')].map((n) => n.querySelector('.chat-item-mark').textContent + " " + n.querySelector('.chat-item-body').textContent), bold: all('strong'), italic: all('em'), code: all('code'), text: el.textContent };
    })()`);
    expect(bubble).toEqual({ items: ["1. Run bun test", "2. Ship it"], bold: ["things"], italic: ["one", "it"], code: ["bun test"], text: "Two things and one more:1.Run bun test2.Ship it" });
    // A list that was only started isn't a message.
    await page.type("- ");
    await page.press("Enter");
    await page.settle();
    expect(await page.posts()).toHaveLength(1);
    expect(await page.draft()).toBe("- |");
  }, 60_000);

  test("on a phone Enter is the new line, so it is what continues a list", async () => {
    const page = await open({ phone: true });
    await page.type("1. one");
    await page.press("Enter");
    expect(await page.draft()).toBe("1. one\n2. |");
    await page.press("Enter");
    expect(await page.draft()).toBe("1. one\n|");
    expect(await page.posts()).toEqual([]);
  }, 60_000);

  // One quote a mark ran the browser's stack out, and the chat with it: a friend's message can be
  // thousands of ">" and nothing else. Sixteen nest; the rest is text, as it was written.
  test("5,000 quote marks leave the chat standing, as a message and as a draft", async () => {
    const page = await open();
    const standing = () => page.eval<{ field: boolean; rows: number; quotes: number; rest: number }>(`({
      field: !!${FIELD},
      rows: document.querySelectorAll('.bm-row').length,
      quotes: document.querySelectorAll('.bm-row blockquote').length,
      rest: [...document.querySelectorAll('.bm-row blockquote .chat-p')].at(-1)?.textContent.length ?? 0,
    })`);
    const before = (await standing()).rows;
    await page.eval(`(() => {
      const s = window.bots.getState();
      window.bots.setState({ conversations: s.conversations.map((c) => ({ ...c, messages: [...c.messages, { id: "deep", author: "manager", at: Date.now(), text: ">".repeat(5000) }] })) });
      return true;
    })()`);
    await page.until(`!${FIELD} || document.querySelectorAll('.bm-row blockquote').length > 0`);
    expect(await standing()).toEqual({ field: true, rows: before + 1, quotes: 16, rest: 4984 });

    await page.type(">".repeat(5000));
    await page.until(`!${FIELD} || document.querySelectorAll('.bots-draft-mark').length > 0`);
    expect((await standing()).field).toBe(true);
    const drawn = await page.drawn();
    expect(drawn.slice(0, 16)).toEqual(Array.from({ length: 16 }, () => ["mark", ">"]));
    expect(drawn.slice(16).map(([how, text]) => [how, text.length])).toEqual([["", 4984]]);
    expect(await page.eval<number>(`${FIELD}.value.length`)).toBe(5000);
  }, 60_000);

  // The caret and the selection are the textarea's, whose text is all one face. What the backdrop
  // draws over it may be bold, slanted or boxed, but never wider or narrower, or the caret would
  // drift from the text, further along each line. (A heavier face is wider: bold is a stroke.)
  const DRAFT = `${"Some **bold words here**, _italic words here_, \`code words\`, *more italic*, ***both at once*** and [a link](https://dkod.ai). ".repeat(3)}\n- an **item**\n12. a _numbered_ one\n\`\`\`sh\nls -la\n\`\`\``;
  for (const [i, font] of FONTS.entries()) {
    test.skipIf(!existsSync(font.file))(`every character is drawn where the textarea has it, in ${font.family}`, async () => {
      const page = await open();
      await page.eval(`(async () => {
        document.fonts.add(await new FontFace(${JSON.stringify(font.family)}, "url(/font-${i}.woff2)", { weight: ${JSON.stringify(font.weight)} }).load());
        document.documentElement.dataset.font = ${JSON.stringify(font.setting)};
        return true;
      })()`);
      await page.type(DRAFT);
      const at = await page.eval<{ field: string; family: string; styled: number; lines: number; off: [number, string, number, number][]; stroke: string; slant: string }>(`(() => {
        const draft = document.querySelector('.bots-draft');
        // The same text with nothing drawn on it, laid out by the same box: where the textarea has each character.
        const plain = draft.cloneNode(false);
        plain.textContent = ${FIELD}.value + "\\u200b";
        draft.after(plain);
        // A draft this long is scrolled to its end, as the field is.
        plain.scrollTop = draft.scrollTop;
        const places = (root) => {
          const out = [];
          const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          const range = document.createRange();
          for (let node; (node = walk.nextNode()); ) for (let i = 0; i < node.length; i++) {
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            const box = range.getBoundingClientRect();
            out.push([node.data[i], box.left, box.top]);
          }
          return out;
        };
        const a = places(draft);
        const b = places(plain);
        plain.remove();
        const off = [];
        for (let i = 0; i < Math.max(a.length, b.length); i++) if (!a[i] || !b[i] || a[i][0] !== b[i][0] || Math.abs(a[i][1] - b[i][1]) > 0.5 || a[i][2] !== b[i][2]) off.push([i, a[i]?.[0] ?? "", a[i]?.[1] ?? -1, b[i]?.[1] ?? -1]);
        return {
          field: [getComputedStyle(${FIELD}).textRendering, getComputedStyle(${FIELD}).fontKerning, getComputedStyle(draft).textRendering, getComputedStyle(draft).fontKerning].join(" "),
          family: getComputedStyle(draft).fontFamily.split(",")[0].replaceAll('"', ""),
          styled: draft.querySelectorAll('span').length,
          lines: new Set(a.map((p) => p[2])).size,
          off: off.slice(0, 5),
          stroke: getComputedStyle(draft.querySelector('.bots-draft-bold:not(.bots-draft-mark)')).webkitTextStrokeWidth,
          slant: getComputedStyle(draft.querySelector('.bots-draft-italic:not(.bots-draft-mark)')).fontStyle,
        };
      })()`);
      // The font under test is the one in use, the draft wraps, and it is drawn bold and slanted...
      expect(at.family).toBe(font.family);
      expect(at.styled).toBeGreaterThan(40);
      expect(at.lines).toBeGreaterThan(6);
      expect(at.stroke).not.toBe("0px");
      expect(at.slant).toBe("italic");
      // ...with every character on the line, and at the place, it has without any of it. Within half a
      // pixel: Chrome rounds each stretch by itself, 1/64 px a time.
      expect(at.off).toEqual([]);
      // The textarea lays its text out the way the draft is: unhinted and unkerned, both.
      expect(at.field).toBe("geometricprecision none geometricprecision none");
    }, 60_000);
  }
});
