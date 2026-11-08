// Just enough of the DevTools protocol to time the app in a real Chrome: pages in contexts of their
// own (cold: empty cache and storage), network accounting, and frame-accurate milestones.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Waiter = { resolve: (v: any) => void; reject: (e: Error) => void };

export class Browser {
  private id = 0;
  private waiting = new Map<number, Waiter>();
  private listeners = new Set<(msg: any) => void>();
  private constructor(private ws: WebSocket, private chrome: ChildProcess, private profile: string) {
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.id !== undefined) {
        const w = this.waiting.get(msg.id);
        if (!w) return;
        this.waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(msg.error.message));
        else w.resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
  }
  static async launch(executable: string, extra: string[] = []): Promise<Browser> {
    const profile = await mkdtemp(join(tmpdir(), "ob-bench-chrome-"));
    const env = { ...process.env };
    delete env.DBUS_SESSION_BUS_ADDRESS;
    delete env.DBUS_SYSTEM_BUS_ADDRESS;
    const chrome = spawn(executable, [
      "--headless=new", "--disable-gpu", "--use-gl=swiftshader", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
      `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-sandbox", ...extra,
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
    return new Browser(ws, chrome, profile);
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    });
  }
  on(fn: (msg: any) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** A tab in a context of its own: nothing cached, nothing stored. */
  async page(width = 1440, height = 900): Promise<Tab> {
    const { browserContextId } = await this.send("Target.createBrowserContext");
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const tab = new Tab(this, sessionId, targetId, browserContextId);
    await tab.init(width, height);
    return tab;
  }
  async close() {
    this.ws.close();
    if (this.chrome.pid) try { process.kill(-this.chrome.pid, "SIGKILL"); } catch {}
    await rm(this.profile, { recursive: true, force: true }).catch(() => {});
  }
}

export interface Request { url: string; type?: string; status?: number; bytes: number; start: number; end?: number; fromCache?: boolean; failed?: string }

/** Watches each frame for named conditions and records when each first held (ms since navigation). */
const MILESTONES = `(() => {
  const marks = {}; const longtasks = []; let checks = {};
  window.__bench = { marks, longtasks, watch(next) { checks = next; for (const k in marks) delete marks[k]; longtasks.length = 0; } };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) longtasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true }); } catch {}
  const tick = () => {
    for (const [name, test] of Object.entries(checks)) {
      if (marks[name] !== undefined) continue;
      try { if ((0, eval)(test)) marks[name] = performance.now(); } catch {}
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;

export class Tab {
  requests = new Map<string, Request>();
  console: string[] = [];
  constructor(readonly browser: Browser, readonly session: string, readonly targetId: string, readonly contextId: string) {
    browser.on((msg) => {
      if (msg.sessionId !== session) return;
      const p = msg.params;
      switch (msg.method) {
        case "Network.requestWillBeSent":
          this.requests.set(p.requestId, { url: p.request.url, type: p.type, bytes: 0, start: p.timestamp * 1000 });
          break;
        case "Network.responseReceived": {
          const r = this.requests.get(p.requestId);
          if (r) { r.status = p.response.status; r.fromCache = p.response.fromDiskCache || p.response.fromServiceWorker || p.response.fromPrefetchCache; }
          break;
        }
        case "Network.requestServedFromCache": {
          const r = this.requests.get(p.requestId);
          if (r) r.fromCache = true;
          break;
        }
        case "Network.loadingFinished": {
          const r = this.requests.get(p.requestId);
          if (r) { r.bytes = p.encodedDataLength; r.end = p.timestamp * 1000; }
          break;
        }
        case "Network.loadingFailed": {
          const r = this.requests.get(p.requestId);
          if (r) { r.failed = p.errorText; r.end = p.timestamp * 1000; }
          break;
        }
        case "Runtime.consoleAPICalled":
          if (p.type === "error" || p.type === "warning") this.console.push(`${p.type}: ${p.args.map((a: any) => a.value ?? a.description).join(" ")}`.slice(0, 300));
          break;
        case "Runtime.exceptionThrown":
          this.console.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`.slice(0, 300));
          break;
      }
    });
  }
  send(method: string, params: object = {}) { return this.browser.send(method, params, this.session); }
  async init(width: number, height: number) {
    await this.send("Page.enable");
    await this.send("Network.enable", { maxTotalBufferSize: 0 });
    await this.send("Runtime.enable");
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: MILESTONES });
  }
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async until(expression: string, timeout = 30_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.eval(expression).catch(() => false)) return;
      await Bun.sleep(10);
    }
    throw new Error(`timed out waiting for ${expression}`);
  }
  /**
   * Navigate (or reload) and time named conditions from the navigation's start. Resolves once
   * every one held, with each one's time in ms.
   */
  async load(url: string | "reload", checks: Record<string, string>, timeout = 60_000): Promise<Record<string, number>> {
    this.requests.clear();
    const json = JSON.stringify(checks);
    // Set again on the new document, before any of its scripts run.
    const { identifier } = await this.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__bench.watch(${json})` });
    try {
      if (url === "reload") await this.send("Page.reload", { ignoreCache: false });
      else await this.send("Page.navigate", { url });
      const names = Object.keys(checks);
      await this.until(`(() => { const m = window.__bench?.marks; return !!m && ${JSON.stringify(names)}.every((n) => m[n] !== undefined); })()`, timeout);
    } finally {
      await this.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    }
    const marks = await this.eval<Record<string, number>>("({ ...window.__bench.marks, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime })");
    return Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, Math.round(v ?? NaN)]));
  }
  /**
   * Time an interaction: `act` runs (a click, a key), then `ready` is checked every frame. Returns
   * ms from just before the input to the first frame where `ready` held, plus long tasks meanwhile.
   */
  async interact(act: () => Promise<unknown>, ready: string, timeout = 30_000, before?: () => Promise<unknown>): Promise<{ ms: number; blocked: number }> {
    // Whatever leads up to the input (pointing at it first) happens before the clock starts.
    await before?.();
    await this.eval(`window.__t0 = performance.now(); window.__bench.longtasks.length = 0; window.__done = undefined;
      (() => { const tick = () => { let ok = false; try { ok = !!(0, eval)(${JSON.stringify(ready)}); } catch {} if (ok) window.__done = performance.now(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })(); true`);
    await act();
    await this.until("window.__done !== undefined", timeout).catch(() => { throw new Error(`timed out waiting for ${ready}`); });
    const { ms, blocked } = await this.eval<{ ms: number; blocked: number }>(
      "({ ms: window.__done - window.__t0, blocked: window.__bench.longtasks.filter(([s]) => s >= window.__t0 - 1).reduce((a, [, d]) => a + Math.max(0, d - 50), 0) })",
    );
    return { ms: Math.round(ms), blocked: Math.round(blocked) };
  }
  /** The pointer over the middle of `selector`, as a hand moving there. */
  async hover(selector: string) {
    const box = await this.eval<[number, number] | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center", behavior: "instant" }); return new Promise((done) => requestAnimationFrame(() => { const r = el.getBoundingClientRect(); done([r.x + r.width / 2, r.y + r.height / 2]); })); })()`);
    if (!box) throw new Error(`nothing matches ${selector}`);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box[0], y: box[1] });
  }
  click(selector: string) {
    return this.clickWhere(`document.querySelector(${JSON.stringify(selector)})`);
  }
  /** A real click in the middle of the element `find` (an expression) evaluates to. */
  async clickWhere(find: string) {
    // Scrolled into view at once (lists here scroll smoothly), and measured once that has laid out.
    const box = await this.eval<[number, number] | null>(`(() => { const el = ${find}; if (!el) return null; el.scrollIntoView({ block: "center", behavior: "instant" }); return new Promise((done) => requestAnimationFrame(() => { const r = el.getBoundingClientRect(); done([r.x + r.width / 2, r.y + r.height / 2]); })); })()`);
    if (!box) throw new Error(`nothing matches ${find}`);
    const [x, y] = box;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
  frames(n = 2) {
    return this.eval(`new Promise((r) => { let i = ${n}; const f = () => (--i ? requestAnimationFrame(f) : r(true)); requestAnimationFrame(f); })`);
  }
  /** What the last navigation transferred, split by kind. */
  network() {
    const all = [...this.requests.values()];
    const sum = (rs: Request[]) => Math.round(rs.reduce((a, r) => a + r.bytes, 0) / 1024);
    const api = all.filter((r) => new URL(r.url).pathname.startsWith("/api/"));
    const assets = all.filter((r) => /\.(js|css|woff2?|ttf|svg|png)$/.test(new URL(r.url).pathname));
    return {
      requests: all.length,
      cached: all.filter((r) => r.fromCache).length,
      kb: sum(all), apiKb: sum(api), assetKb: sum(assets),
      api: api.map((r) => `${new URL(r.url).pathname}${new URL(r.url).search} ${r.status ?? r.failed} ${Math.round(r.bytes / 1024)}KB ${r.end ? Math.round(r.end - r.start) : "-"}ms`),
    };
  }
  async close() {
    await this.browser.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
    await this.browser.send("Target.disposeBrowserContext", { browserContextId: this.contextId }).catch(() => {});
  }
}
