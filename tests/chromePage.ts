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
  /** The page's last few console errors, uncaught exceptions and failed requests, for a timeout's report. */
  private events: string[] = [];
  constructor(private ws: WebSocket, private session: string) {
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.sessionId === this.session && this.session) {
        const p = msg.params;
        const line = msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(p.type) ? `console.${p.type}: ${p.args.map((a: any) => a.value ?? a.description).join(" ")}`
          : msg.method === "Runtime.exceptionThrown" ? `exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`
          : msg.method === "Network.loadingFailed" ? `request failed: ${p.errorText}`
          : undefined;
        if (line) this.events = [...this.events, line.slice(0, 300)].slice(-10);
      }
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result);
    });
  }
  /** The tab the last `open` made, closed by the next: a file's tests use one page at a time. */
  private static last?: { ws: WebSocket; targetId: string; browserContextId: string };
  /** Opens `url` in a tab of its own and waits until `ready` holds. The tab opened before it is closed. */
  static async open<T extends Page>(this: new (ws: WebSocket, session: string) => T, ws: WebSocket, url: string, width: number, height: number, ready: string): Promise<T> {
    const root = new Page(ws, "");
    // Left open, a test's page keeps animating behind the next one's and takes its frames.
    const before = Page.last;
    if (before?.ws === ws) {
      await root.send("Target.closeTarget", { targetId: before.targetId }).catch(() => {});
      await root.send("Target.disposeBrowserContext", { browserContextId: before.browserContextId }).catch(() => {});
    }
    // A context of its own, so what one test saves isn't restored in the next.
    const { browserContextId } = await root.send("Target.createBrowserContext");
    const { targetId } = await root.send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await root.send("Target.attachToTarget", { targetId, flatten: true });
    Page.last = { ws, targetId, browserContextId };
    const page = new this(ws, sessionId);
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await page.send("Runtime.enable");
    await page.send("Network.enable");
    await page.send("Page.navigate", { url });
    // A whole app's first load on a busy machine can take longer than a wait inside a test should.
    await page.until(ready, 15_000);
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
  async until(expression: string, within = 5000) {
    for (const deadline = performance.now() + within; ;) {
      if (await this.eval(expression).catch(() => false)) return;
      if (performance.now() > deadline) break;
      await Bun.sleep(25);
    }
    throw new Error(`timed out waiting for ${expression}\n${await this.report()}`);
  }
  /** Why a wait may have timed out: whether the tab is shown and still gets frames, and what it logged. */
  private async report() {
    const state = await this.eval<string>(`new Promise((resolve) => {
      let frame = false;
      requestAnimationFrame(() => (frame = true));
      setTimeout(() => resolve(JSON.stringify({ visibility: document.visibilityState, focused: document.hasFocus(), readyState: document.readyState, frameWithin500ms: frame })), 500);
    })`).catch((e) => `page unreachable: ${e.message}`);
    return `page: ${state}\nrecent: ${JSON.stringify(this.events)}`;
  }
  /** Two frames, so React has rendered and the resize observers have run. */
  settle() {
    return this.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
  }
  /**
   * Jumps every transition and animation under `selector` that ends to its end (ones that loop keep
   * looping), for a test that reads where things come to rest, not how they get there.
   */
  async finish(selector = "html") {
    // A transition only exists once the change that starts it has been styled.
    await this.settle();
    await this.eval(`(() => { for (const a of document.querySelector(${JSON.stringify(selector)})?.getAnimations({ subtree: true }) ?? []) if (a.effect?.getComputedTiming().endTime !== Infinity) a.finish(); return true; })()`);
    await this.settle();
  }
  /** Waits for those to end on their own, where the motion itself is part of the test. */
  async finished(selector = "html") {
    await this.settle();
    await this.eval(`Promise.all((document.querySelector(${JSON.stringify(selector)})?.getAnimations({ subtree: true }) ?? []).filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => {}))).then(() => true)`);
    await this.settle();
  }
  /** A real mouse wheel over the middle of `selector`. */
  async wheel(deltaY: number, selector = ".bots-messages") {
    const [x, y, from] = await this.eval<[number, number, number]>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}), r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, el.scrollTop]; })()`);
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
    // A wheel scrolls smoothly, and on a slow machine it's still going: wait until it has started (or
    // clearly isn't going to, at an end) and has come to rest.
    await this.eval(`new Promise((done) => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const started = performance.now();
      let last = el.scrollTop, still = 0, frames = 0;
      const tick = () => {
        still = el.scrollTop === last ? still + 1 : 0;
        last = el.scrollTop;
        if ((still >= 5 && (last !== ${from} || performance.now() - started > 200)) || ++frames > 300) done(true);
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

/** Says so in the file's output when setup took long: that time shows in no test's own. */
const slow = (what: string, started: number) => {
  const seconds = (performance.now() - started) / 1000;
  if (seconds > 2) console.log(`[chromePage] ${what} took ${seconds.toFixed(1)} s`);
};

/** Starts Chrome; `close` stops it and removes its profile. */
export async function launchChrome(): Promise<{ ws: WebSocket; close: () => Promise<void> }> {
  const started = performance.now();
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
  slow("Chrome's start", started);
  return {
    ws,
    close: async () => {
      ws.close();
      if (chrome.pid) try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* already gone */ }
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Serves a fixture page built ahead by `bun build`, in a process of its own: an HTML import route,
 * or Bun.build inside `bun test`, can fail to resolve imports of a large page at random on some
 * machines. `/api/*` answers `{}`; `routes` adds or overrides others. `stop` removes the build.
 */
export async function serveFixture(html: string, routes: Record<string, (req: Request) => Response | Promise<Response>> = {}) {
  const started = performance.now();
  const out = await mkdtemp(join(tmpdir(), "openbuild-fixture-"));
  // Now and then `bun build` doesn't exit: a build takes well under a second, so give up on one that
  // hasn't after a few and start again.
  for (let attempt = 1; ; attempt++) {
    const build = Bun.spawn([process.execPath, "build", html, "--outdir", out, "--target", "browser", "--public-path", "/"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const stuck = setTimeout(() => build.kill("SIGKILL"), 5000);
    const [code, err] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    clearTimeout(stuck);
    if (code === 0) break;
    if (build.signalCode !== "SIGKILL" || attempt === 3) throw new Error(`Couldn't build ${html}:\n${err}`);
    console.log(`[chromePage] a build of ${html} was stuck after 5 s: starting it again`);
  }
  slow(`building ${html}`, started);
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      const route = Object.entries(routes).find(([p]) => p === path || (p.endsWith("*") && path.startsWith(p.slice(0, -1))));
      if (route) return route[1](req);
      if (path.startsWith("/api/")) return Response.json({});
      const file = Bun.file(join(out, path === "/" ? "index.html" : path.slice(1)));
      return (await file.exists()) && !path.includes("..") ? new Response(file) : new Response("Not found", { status: 404 });
    },
  });
  return { url: server.url, stop: async () => { server.stop(true); await rm(out, { recursive: true, force: true }); } };
}
