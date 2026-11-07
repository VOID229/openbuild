// The GitHub sign-in panel's styling, in a real Chrome: the Open GitHub link reads as the primary
// pill it is, the sign-in spinner lines up with the buttons beside it, the token link answers a
// hover, and the access select's chevron sits inside its padding. On a desktop and on a phone.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrowser } from "../server/pi/extensions/html-render";

const browser = findBrowser();

/** Just enough of the DevTools protocol to load a page, hover it and read it back. */
class Page {
  private id = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  constructor(private ws: WebSocket, private session: string) {
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      const w = this.waiting.get(msg.id);
      if (!w || msg.sessionId !== (this.session || undefined)) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result);
    });
  }
  static async open(ws: WebSocket, url: string, width: number, height: number, mobile: boolean) {
    const root = new Page(ws, "");
    const { targetId } = await root.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await root.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(ws, sessionId);
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    await page.send("Page.navigate", { url });
    await page.until("!!document.querySelector('.app-guide .app-page-actions') && !!document.querySelector('select.input')");
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
}

let chrome: ChildProcess | undefined;
let ws: WebSocket;
let server: ReturnType<typeof Bun.serve> | undefined;
let profile = "";

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/githubSignIn/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page } });
  profile = await mkdtemp(join(tmpdir(), "openbuild-github-signin-"));
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

const sizes = [["a desktop", 1280, 900, false], ["a phone", 390, 844, true]] as const;

for (const [name, width, height, mobile] of sizes) {
  test.skipIf(!browser)(`on ${name}, Open GitHub is a legible primary pill and the spinner lines up with it`, async () => {
    const page = await Page.open(ws, `${server!.url}?state=pending`, width, height, mobile);
    const look = await page.eval<Record<string, any>>(`(() => {
      const row = document.querySelector('.app-guide .app-page-actions');
      const link = row.querySelector('a.bots-btn-primary');
      const cancel = row.querySelector('button.bots-btn');
      const spinner = row.querySelector('.spinner');
      const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
      const s = getComputedStyle(link);
      const probe = document.createElement('button');
      probe.className = 'btn bots-btn bots-btn-primary';
      row.appendChild(probe);
      const button = getComputedStyle(probe).color;
      probe.remove();
      return { color: s.color, background: s.backgroundColor, button, link: mid(link), cancel: mid(cancel), spinner: mid(spinner) };
    })()`);
    // The label isn't the pill's colour: it's the primary button's own.
    expect(look.color).not.toBe(look.background);
    expect(look.color).toBe(look.button);
    // The spinner sits on the buttons' centre line rather than at the top of the row.
    expect(Math.abs(look.spinner - look.link)).toBeLessThanOrEqual(1);
    expect(Math.abs(look.cancel - look.link)).toBeLessThanOrEqual(1);
  }, 20_000);

  test.skipIf(!browser)(`on ${name}, the token link has a hover and the select's chevron sits inside its padding`, async () => {
    const page = await Page.open(ws, `${server!.url}?state=idle`, width, height, mobile);
    // Headless Chrome can't hover (and a phone doesn't), so the hover rule is read from the page's own sheets.
    const hover = await page.eval<{ rest: string; hover?: string; decoration?: string; media?: string }>(`(() => {
      const el = [...document.querySelectorAll('.apps-link')].find((e) => e.textContent.includes('personal access token'));
      const rules = (list) => [...list].flatMap((r) => [r, ...(r.cssRules ? rules(r.cssRules) : [])]);
      const rule = [...document.styleSheets].flatMap((s) => rules(s.cssRules)).find((r) => r.selectorText === '.apps-link:hover:not(:disabled)');
      return { rest: getComputedStyle(el).color, hover: rule?.style.color, decoration: rule?.style.textDecorationThickness, media: rule?.parentRule?.conditionText };
    })()`);
    expect(hover).toMatchObject({ hover: "var(--text)", decoration: "2px", media: "(hover: hover)" });
    const select = await page.eval<{ appearance: string; paddingRight: string; position: string; font: string; body: string }>(`(() => {
      const s = getComputedStyle(document.querySelector('select.input'));
      return { appearance: s.appearance, paddingRight: s.paddingRight, position: s.backgroundPositionY, font: s.fontFamily, body: getComputedStyle(document.body).fontFamily };
    })()`);
    expect(select.appearance).toBe("none");
    expect(parseFloat(select.paddingRight)).toBeGreaterThanOrEqual(30);
    expect(select.position.split(",").every((p) => p.trim() === "50%")).toBe(true);
    expect(select.font).toBe(select.body);
  }, 20_000);
}
