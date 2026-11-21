// The line under a bot's chat box (ComposerOptions), in a real Chrome: the model the bot runs on, by
// its name, opening the same list as its details' Advanced tab and saving the bot's own model with
// the same PATCH. Only in a direct chat with one of the user's own bots; one line on a desktop and on
// a phone, inside the box's width; reached and worked with the keyboard.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

const model = (id: string, name: string) => ({ id: `anthropic/${id}`, provider: "anthropic", name, protocol: "chat", input: ["text"], reasoning: { efforts: ["low", "medium", "high"], mode: "effort", toggle: false }, contextLimit: 1_000_000 });
const listing = { models: [model("claude-sonnet-5-5", "Claude Sonnet 5.5"), model("claude-opus-5-5", "Claude Opus 5.5"), model("claude-haiku-5-5", "Claude Haiku 5.5")], defaultModel: "anthropic/claude-sonnet-5-5", checkedAt: Date.now() };

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;
let patches: { path: string; body: unknown }[] = [];
/** Set to hold the listing back: what a slow server, or a Pi that's starting, looks like. */
let hold: Promise<void> | undefined;
let asks = 0;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/composerOptions/index.html`, {
    "/api/bots/models": async () => {
      asks++;
      await hold;
      return Response.json(listing);
    },
    "/api/workspace/*": async (req) => {
      if (req.method === "PATCH") patches.push({ path: new URL(req.url).pathname, body: await req.json() });
      return Response.json({});
    },
  });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

beforeEach(() => {
  patches = [];
  hold = undefined;
  asks = 0;
});

const READY = "!!document.querySelector('.bots-composer-textarea')";
const NAME = "document.querySelector('.bots-opts-model-name')";
const MENU = `document.querySelector('[role="listbox"][aria-label="Model"]')`;
const BOT = "/api/workspace/to/srv/api/bots/manager";
const open = (query = "", width = 1000, height = 700) => Page.open(chrome!.ws, `${server!.url}?${query}`, width, height, READY);
const withBot = (bot: object) => `bot=${encodeURIComponent(JSON.stringify(bot))}`;
const until = async (ok: () => boolean, what: string) => {
  for (const end = Date.now() + 3000; !ok(); await Bun.sleep(20)) if (Date.now() > end) throw new Error(`timed out: ${what}`);
};

class Keys {
  constructor(private page: Page) {}
  async press(key: string, code: string, keyCode: number, text?: string) {
    await this.page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
    await this.page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
    await this.page.settle();
  }
  tab = () => this.press("Tab", "Tab", 9);
  enter = () => this.press("Enter", "Enter", 13, "\r");
  escape = () => this.press("Escape", "Escape", 27);
}

describe.skipIf(!browser)("the model under a bot's chat box", () => {
  test("in a direct chat, right under the box in its dock: the model the bot follows, or its own", async () => {
    const page = await open();
    await page.until(`${NAME}?.textContent === 'Claude Sonnet 5.5'`);
    const row = await page.eval(`(() => {
      const opts = document.querySelector('.bots-opts');
      const btn = opts.querySelector('.bots-opts-model-btn');
      return { after: opts.previousElementSibling?.className, inDock: opts.parentElement.className, named: opts.getAttribute('aria-label'), button: [btn.tagName, btn.getAttribute('aria-label'), btn.getAttribute('aria-haspopup')], controls: opts.querySelectorAll('button, [role="switch"]').length };
    })()`);
    // The model alone: nothing else shares the line.
    expect(row).toEqual({ after: "bots-composer", inDock: "bots-dock", named: "Juniper's model", button: ["BUTTON", "Model: Claude Sonnet 5.5", "listbox"], controls: 1 });
    const own = await open(withBot({ model: "anthropic/claude-opus-5-5" }));
    await own.until(`${NAME}?.textContent === 'Claude Opus 5.5'`);
  });

  test("not in a group, whose bots each have a model of their own, nor in another device's workspace", async () => {
    for (const query of ["kind=group", "remote=1"]) {
      const page = await open(query);
      await page.settle();
      expect(await page.eval<boolean>("!!document.querySelector('.bots-composer') && !document.querySelector('.bots-opts')")).toBe(true);
    }
  });

  test("not in a window too short for it: the messages keep the room", async () => {
    const page = await open("", 390, 300);
    await page.settle();
    expect(await page.eval<boolean>("!!document.querySelector('.bots-opts') && getComputedStyle(document.querySelector('.bots-opts')).display === 'none'")).toBe(true);
  });

  for (const [width, height] of [[1000, 700], [390, 844], [360, 740]] as const) {
    test(`one line at ${width}px, under the box and inside its width, in muted words, in both themes`, async () => {
      for (const theme of ["dark", "light"]) {
        // A name too long for a phone is cut short, never widening the chat.
        const page = await open(`theme=${theme}&${withBot({ model: "anthropic/claude-haiku-5-5" })}`, width, height);
        await page.until(`${NAME}?.textContent === 'Claude Haiku 5.5'`);
        const fit = await page.eval(`(() => {
          const opts = document.querySelector('.bots-opts').getBoundingClientRect();
          const box = document.querySelector('.bots-composer').getBoundingClientRect();
          const btn = document.querySelector('.bots-opts-model-btn').getBoundingClientRect();
          return {
            oneLine: ${NAME}.getBoundingClientRect().height <= 17,
            inside: opts.left >= box.left - 0.5 && opts.right <= box.right + 0.5 && btn.left >= box.left && btn.right <= box.right,
            noScroll: document.documentElement.scrollWidth <= innerWidth,
            below: opts.top >= box.bottom,
            onScreen: btn.bottom <= innerHeight,
            muted: getComputedStyle(document.querySelector('.bots-opts')).color !== getComputedStyle(document.body).color,
            // On a phone, a row a finger can hit.
            tall: btn.height,
          };
        })()`);
        expect(fit).toEqual({ oneLine: true, inside: true, noScroll: true, below: true, onScreen: true, muted: true, tall: width > 768 ? 24 : 32 });
      }
    });
  }

  test("a click opens the bots' models above the row; a pick saves the bot's model, and Default clears it", async () => {
    const page = await open();
    await page.until(`${NAME}?.textContent === 'Claude Sonnet 5.5'`);
    await page.click(".bots-opts-model-btn");
    await page.until(`!!${MENU}?.querySelector('[role="option"]') && ${MENU}.style.position === 'fixed'`);
    const options = await page.eval<string[]>(`[...${MENU}.querySelectorAll('[role="option"]')].map((el) => el.querySelector('.menu-item-label')?.textContent ?? el.textContent)`);
    // Default first, reading as the model it follows; then every model bots can run on.
    expect(options[0]).toBe("Claude Sonnet 5.5");
    expect(options).toContain("Claude Opus 5.5");
    expect(options).toContain("Claude Haiku 5.5");
    // It opens upward, clear of the row, and stays on screen.
    expect(await page.eval<boolean>(`(() => { const m = ${MENU}.getBoundingClientRect(); return m.bottom <= document.querySelector('.bots-opts').getBoundingClientRect().top && m.top >= 0 && m.right <= innerWidth; })()`)).toBe(true);
    await page.eval(`[...${MENU}.querySelectorAll('[role="option"]')].find((el) => el.textContent.includes('Claude Opus 5.5')).click()`);
    await until(() => patches.length === 1, "the PATCH");
    expect(patches[0]).toEqual({ path: BOT, body: { model: "anthropic/claude-opus-5-5" } });
    await page.until(`${NAME}.textContent === 'Claude Opus 5.5' && !${MENU}`);
    expect(await page.eval<string>("document.querySelector('.bots-opts-model-btn').getAttribute('aria-label')")).toBe("Model: Claude Opus 5.5");
    // Default: the bots' default model, which the bot then follows.
    await page.click(".bots-opts-model-btn");
    await page.until(`!!${MENU}?.querySelector('[role="option"]')`);
    await page.eval(`${MENU}.querySelector('[role="option"]').click()`);
    await until(() => patches.length === 2, "the second PATCH");
    expect(patches[1]).toEqual({ path: BOT, body: { model: "" } });
    await page.until(`${NAME}.textContent === 'Claude Sonnet 5.5'`);
  });

  test("the keyboard reaches it after the box, opens its list and closes it with nothing saved", async () => {
    const page = await open();
    await page.until(`${NAME}?.textContent === 'Claude Sonnet 5.5'`);
    const keys = new Keys(page);
    await page.eval("document.querySelector('.bots-composer-textarea').focus()");
    // The box's own buttons come first, then the model.
    for (let i = 0; i < 6 && !(await page.eval<boolean>("document.activeElement?.classList.contains('bots-opts-model-btn')")); i++) await keys.tab();
    expect(await page.eval<string>("document.activeElement.getAttribute('aria-label')")).toBe("Model: Claude Sonnet 5.5");
    // A keyboard user sees where they are.
    expect(await page.eval<boolean>("document.documentElement.hasAttribute('data-keyboard-nav') && getComputedStyle(document.activeElement).outlineStyle !== 'none'")).toBe(true);
    await keys.enter();
    await page.until(`!!${MENU}?.querySelector('[role="option"]')`);
    await keys.escape();
    await page.until(`!${MENU}`);
    expect(patches).toHaveLength(0);
  });

  test("before the first listing ever comes, a quiet bar holds the name's place, never the model's id; a reload names it from the first frame", async () => {
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    const id = "anthropic/claude-opus-5-5";
    const page = await open(withBot({ model: id }));
    await page.until("!!document.querySelector('.bots-opts-model-name .model-name-pending')");
    const waiting = await page.eval<{ text: string; label: string; width: number }>(`({ text: document.querySelector('.bots-opts').textContent, label: document.querySelector('.bots-opts-model-btn').getAttribute('aria-label'), width: document.querySelector('.model-name-pending').getBoundingClientRect().width })`);
    expect(waiting.text).not.toContain("claude-opus");
    expect(waiting.label).toBe("Model: Loading model");
    expect(waiting.width).toBeGreaterThan(40);
    release();
    await page.until(`${NAME}?.textContent === 'Claude Opus 5.5'`);
    // The same browser, loaded again with the server slow: the kept copy names it at once.
    hold = new Promise((r) => (release = r));
    await page.send("Page.enable");
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `new MutationObserver(() => { const el = document.querySelector('.bots-opts-model-name'); if (el && window.firstName === undefined) window.firstName = el.textContent + '|' + !!el.querySelector('.model-name-pending'); }).observe(document, { childList: true, subtree: true });` });
    await page.send("Page.reload");
    await page.until("window.firstName !== undefined");
    expect(await page.eval<string>("window.firstName")).toBe("Claude Opus 5.5|false");
    release();
  });

  test("the chat's pickers share one request for the listing", async () => {
    const page = await open();
    await page.until(`${NAME}?.textContent === 'Claude Sonnet 5.5'`);
    await page.click(".bots-opts-model-btn");
    await page.until(`!!${MENU}?.querySelector('[role="option"]')`);
    await page.settle();
    expect(asks).toBe(1);
  });
});
