// The startup popup for a server without Pi, in a real Chrome on a desktop and a phone, light and
// dark: it fits the screen, the Pi mark is prominent, the keyboard starts on Install, and Install
// shows its progress, a failure with Try again, and success once the server finds Pi, after which
// closing it keeps it closed. The server is faked (fixtures/harnessSetup/fakeServer.ts): nothing installs.
// Set OPENBUILD_SCREENSHOTS to a folder to keep a picture of each state.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { browser, launchChrome, Page } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const shots = process.env.OPENBUILD_SCREENSHOTS;

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/harnessSetup/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page } });
  chrome = await launchChrome();
  if (shots) await mkdir(shots, { recursive: true });
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

const OPEN = "document.querySelector('.hs-root')?.dataset.state === 'open'";

async function open(query: string, width: number, height: number, ready = OPEN) {
  const page = await Page.open(chrome!.ws, `${server!.url}?${query}`, width, height, ready);
  // The opening transition has finished.
  await Bun.sleep(350);
  await page.settle();
  return page;
}

async function shoot(page: Page, name: string) {
  if (!shots) return;
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(shots, `${name}.png`), Buffer.from(data, "base64"));
}

/** Where the dialog, the mark and the buttons are, and whether anything spills sideways. */
const layout = (page: Page) =>
  page.eval<Record<string, any>>(`(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const dialog = document.querySelector('[role="dialog"]');
    return {
      dialog: box(dialog),
      mark: box(dialog.querySelector('.hs-mark svg')),
      close: box(dialog.querySelector('.modal-close')),
      tile: box(dialog.querySelector('.hs-mark')),
      buttons: [...dialog.querySelectorAll('.hs-actions .btn')].map((b) => ({ text: b.textContent, ...box(b) })),
      title: dialog.querySelector('.hs-title').textContent,
      focused: document.activeElement?.textContent,
      background: getComputedStyle(dialog).backgroundColor,
      color: getComputedStyle(dialog.querySelector('.hs-title')).color,
      overflow: document.documentElement.scrollWidth - innerWidth,
      vw: innerWidth, vh: innerHeight,
    };
  })()`);

const sizes = [["desktop", 1280, 860], ["phone", 390, 844]] as const;

for (const [device, width, height] of sizes) {
  for (const theme of ["light", "dark"] as const) {
    test.skipIf(!browser)(`on a ${device} in ${theme}: no harness at all, everything fits and Install has the focus`, async () => {
      const page = await open(`case=hermes&theme=${theme}`, width, height);
      const look = await layout(page);
      await shoot(page, `${device}-${theme}-none`);
      expect(look.title).toBe("No coding harness is installed");
      expect(await page.eval<unknown>("document.querySelector('.hs-body').textContent")).toContain("Hermes on its own isn't enough.");
      expect(look.focused).toBe("Install Pi");
      expect(look.overflow).toBeLessThanOrEqual(0);
      expect(look.dialog.left).toBeGreaterThanOrEqual(0);
      expect(look.dialog.right).toBeLessThanOrEqual(look.vw);
      expect(look.dialog.top).toBeGreaterThanOrEqual(0);
      expect(look.dialog.bottom).toBeLessThanOrEqual(look.vh + 0.5);
      // The Pi mark is the largest thing in it, bigger than the 14–18px it is everywhere else.
      expect(look.mark.width).toBeGreaterThanOrEqual(60);
      for (const b of look.buttons) expect(b.height).toBeGreaterThanOrEqual(device === "phone" ? 44 : 40);
      // Close sits in the top-right corner, clear of the mark.
      expect(look.close.right).toBeGreaterThan(look.dialog.right - 60);
      expect(look.close.left).toBeGreaterThan(look.tile.right);
      if (device === "phone") {
        // A bottom sheet, edge to edge, like Settings on a phone.
        expect(look.dialog.width).toBe(look.vw);
        expect(Math.abs(look.dialog.bottom - look.vh)).toBeLessThanOrEqual(1);
      } else {
        expect(look.dialog.width).toBeLessThanOrEqual(460);
      }
      // Each theme paints its own surface and text.
      expect(look.background).toBe(theme === "dark" ? "rgb(26, 26, 26)" : "rgb(255, 255, 255)");
      expect(look.color).not.toBe(look.background);
    }, 30_000);
  }

  test.skipIf(!browser)(`on a ${device}: another harness is there, so only OpenBots is warned about`, async () => {
    const page = await open("case=codex", width, height);
    expect((await layout(page)).title).toBe("Pi isn't installed");
    const body = await page.eval<string>("document.querySelector('.hs-body').textContent");
    expect(body).toContain("OpenBots needs Pi installed to work.");
    expect(body).toContain("Threads can still run on Codex and Claude Code");
    expect(body).not.toContain("OpenBuild also needs");
    await shoot(page, `${device}-light-pi`);
  }, 30_000);

  test.skipIf(!browser)(`on a ${device}: Install shows progress, a failure with Try again, then success after the server is asked again`, async () => {
    const page = await open("case=none&install=fail-then-ok", width, height);
    expect(await page.eval<unknown>("window.calls['/api/pi/install'] ?? 0")).toBe(0);
    await page.click(".hs-actions .btn-primary");
    await page.until("document.querySelector('.hs-status')?.textContent.includes('Installing Pi on imac')");
    expect(await page.eval<unknown>("document.querySelector('.hs-actions .btn-primary').disabled")).toBe(true);
    await shoot(page, `${device}-light-installing`);
    await page.until("!!document.querySelector('.hs-error')");
    await page.settle();
    expect(await page.eval<unknown>("document.querySelector('[role=alert]').textContent")).toBe("Pi's installer failed (exit code 1).");
    // Said once, with the installer's own output folded under it.
    expect(await page.eval<unknown>("document.querySelectorAll('[role=alert]').length")).toBe(1);
    expect(await page.eval<unknown>("!!document.querySelector('.pi-job-head')")).toBe(false);
    expect(await page.eval<unknown>("document.querySelector('.hs-log .pi-job-log').textContent")).toContain("Could not resolve host");
    expect(await page.eval<unknown>("document.activeElement.textContent")).toBe("Try again");
    await shoot(page, `${device}-light-failed`);
    const asked = await page.eval<number>("window.calls['/api/runtimes']");
    await page.click(".hs-actions .btn-primary");
    await page.until("document.querySelector('.hs-title')?.textContent === 'Pi is installed'");
    await page.settle();
    // Two installs, each checked afterwards against the server's own detection.
    expect(await page.eval<unknown>("window.calls['/api/pi/install']")).toBe(2);
    expect(await page.eval<number>("window.calls['/api/runtimes']")).toBeGreaterThan(asked);
    expect(await page.eval<unknown>("document.activeElement.textContent")).toBe("Connect a provider");
    expect(await page.eval<unknown>("!!document.querySelector('.hs-mark-badge')")).toBe(true);
    await shoot(page, `${device}-light-done`);
  }, 30_000);
}

test.skipIf(!browser)("Escape closes it, and a reload in the same tab doesn't bring it back", async () => {
  const page = await open("case=none", 1280, 860);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.until("!document.querySelector('.hs-root')");
  await page.send("Page.reload");
  await page.until("window.calls?.['/api/config'] >= 1");
  await Bun.sleep(300);
  expect(await page.eval<unknown>("!!document.querySelector('.hs-root')")).toBe(false);
  // Closed before asking: it doesn't even look again.
  expect(await page.eval<unknown>("window.calls['/api/runtimes'] ?? 0")).toBe(0);
}, 30_000);

test.skipIf(!browser)("Tab stays inside the dialog", async () => {
  const page = await open("case=none", 1280, 860);
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    seen.add(await page.eval("document.activeElement.closest('[role=dialog]') ? 'in' : 'out'"));
  }
  expect([...seen]).toEqual(["in"]);
}, 30_000);

for (const [name, query] of [["Pi installed", "case=installed"], ["detection failed", "case=error"]] as const) {
  test.skipIf(!browser)(`${name}: no popup`, async () => {
    const page = await Page.open(chrome!.ws, `${server!.url}?${query}`, 1280, 860, "window.calls?.['/api/runtimes'] >= 1");
    await Bun.sleep(300);
    await page.settle();
    expect(await page.eval<unknown>("!!document.querySelector('.hs-root')")).toBe(false);
  }, 30_000);
}
