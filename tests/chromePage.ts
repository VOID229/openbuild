// A headless Chrome for the tests that need real layout and scrolling, driven over the DevTools protocol.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrowser } from "../server/pi/extensions/html-render";

export const browser = findBrowser();

/** Just enough of the DevTools protocol to load a page, type into it and read it back. */
export class Page {
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
  /** Opens `url` in a tab of its own and waits until `ready` holds. */
  static async open<T extends Page>(this: new (ws: WebSocket, session: string) => T, ws: WebSocket, url: string, width: number, height: number, ready: string): Promise<T> {
    const root = new Page(ws, "");
    // A context of its own, so what one test saves isn't restored in the next.
    const { browserContextId } = await root.send("Target.createBrowserContext");
    const { targetId } = await root.send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await root.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new this(ws, sessionId);
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.navigate", { url });
    await page.until(ready);
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
  /** A real mouse wheel over the middle of `selector`. */
  async wheel(deltaY: number, selector = ".bots-messages") {
    const [x, y] = await this.eval<[number, number]>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
    await Bun.sleep(150);
    await this.settle();
    // A wheel scrolls smoothly, and on a slow machine it's still going: wait until it has come to rest.
    await this.eval(`new Promise((done) => {
      const el = document.querySelector(${JSON.stringify(selector)});
      let last = el.scrollTop, still = 0, frames = 0;
      const tick = () => {
        still = el.scrollTop === last ? still + 1 : 0;
        last = el.scrollTop;
        if (still >= 5 || ++frames > 300) done(true);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })`);
  }
  /** A real click in the middle of `selector`. */
  async click(selector: string) {
    const [x, y] = await this.eval<[number, number]>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    await this.settle();
  }
}

/** Starts Chrome; `close` stops it and removes its profile. */
export async function launchChrome(): Promise<{ ws: WebSocket; close: () => Promise<void> }> {
  const profile = await mkdtemp(join(tmpdir(), "openbuild-chrome-"));
  const env = { ...process.env };
  // See html-render.ts: current Chrome can't parse the runner's `disabled:` bus address.
  delete env.DBUS_SESSION_BUS_ADDRESS;
  delete env.DBUS_SYSTEM_BUS_ADDRESS;
  const chrome: ChildProcess = spawn(browser!, [
    "--headless", "--disable-gpu", "--use-gl=stub", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--hide-scrollbars", `--user-data-dir=${profile}`, "--remote-debugging-port=0",
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  ], { detached: true, stdio: ["ignore", "ignore", "pipe"], env });
  const url = await new Promise<string>((resolve, reject) => {
    let err = "";
    chrome.stderr!.on("data", (chunk) => {
      err += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) resolve(m[1]!);
    });
    chrome.once("exit", () => reject(new Error(`Chrome exited: ${err}`)));
  });
  const ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  return {
    ws,
    close: async () => {
      ws.close();
      if (chrome.pid) try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* already gone */ }
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}
