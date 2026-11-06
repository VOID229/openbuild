// The OpenBots composer growing and shrinking as a draft is typed, in a real Chrome: the conversation
// stays at the bottom when it was there, and stays where the user scrolled it when it wasn't.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrowser } from "../server/pi/extensions/html-render";

const browser = findBrowser();

/** Just enough of the DevTools protocol to load a page, type into it and read it back. */
class Page {
  private id = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  constructor(private ws: WebSocket, private session: string) {
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result);
    });
  }
  static async open(ws: WebSocket, url: string, width: number, height: number) {
    const root = new Page(ws, "");
    // A context of its own, so a draft saved by one test isn't restored in the next.
    const { browserContextId } = await root.send("Target.createBrowserContext");
    const { targetId } = await root.send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await root.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(ws, sessionId);
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.navigate", { url });
    await page.until("!!document.querySelector('.bots-composer-textarea') && !!document.querySelector('.bm-group')");
    return page;
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.id + (this.session ? 0 : 1e6);
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(this.session && { sessionId: this.session }) }));
    });
  }
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async until(expression: string) {
    for (let i = 0; i < 200; i++) {
      if (await this.eval(expression).catch(() => false)) return;
      await Bun.sleep(25);
    }
    throw new Error(`timed out waiting for ${expression}`);
  }
  /** Two frames, so React has rendered and the resize observers have run. */
  settle() {
    return this.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
  }
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
  async wheel(deltaY: number) {
    const [x, y] = await this.eval<[number, number]>("(() => { const r = document.querySelector('.bots-messages').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()");
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
    await Bun.sleep(150);
    await this.settle();
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

let chrome: ChildProcess | undefined;
let ws: WebSocket;
let server: ReturnType<typeof Bun.serve> | undefined;
let profile = "";

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/botComposer/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page } });
  profile = await mkdtemp(join(tmpdir(), "openbuild-composer-"));
  const env = { ...process.env };
  // See html-render.ts: current Chrome can't parse the runner's `disabled:` bus address.
  delete env.DBUS_SESSION_BUS_ADDRESS;
  delete env.DBUS_SYSTEM_BUS_ADDRESS;
  chrome = spawn(browser, [
    "--headless", "--disable-gpu", "--use-gl=stub", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--hide-scrollbars", `--user-data-dir=${profile}`, "--remote-debugging-port=0",
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  ], { detached: true, stdio: ["ignore", "ignore", "pipe"], env });
  const url = await new Promise<string>((resolve, reject) => {
    let err = "";
    chrome!.stderr!.on("data", (chunk) => {
      err += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) resolve(m[1]!);
    });
    chrome!.once("exit", () => reject(new Error(`Chrome exited: ${err}`)));
  });
  ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
}, 60_000);

afterAll(async () => {
  ws?.close();
  if (chrome?.pid) try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* already gone */ }
  server?.stop(true);
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
});

const LINE = 22;
const words = "let's combine them actually, keep that previous twenty minute thing where it keeps sending to the same bot ";

for (const kind of ["direct", "group"] as const) {
  describe.skipIf(!browser)(`the composer in a ${kind} chat`, () => {
    const open = async (width = 1000) => {
      const page = await Page.open(ws, `${server!.url}?kind=${kind}`, width, 700);
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
