// The New project dialog's folder field in a real Chrome: typing searches the folder it's in (names
// that start with what's typed first, then those that have it anywhere), the list is compact, Tab
// completes, and Escape closes the list before the dialog.
// Set OPENBUILD_SCREENSHOTS to a folder to keep a picture of each state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;
const shots = process.env.OPENBUILD_SCREENSHOTS;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/newProject/index.html`);
  chrome = await launchChrome();
  if (shots) await mkdir(shots, { recursive: true });
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

class DialogPage extends Page {
  async key(key: string, code = key, keyCode = 0) {
    for (const type of ["rawKeyDown", "keyUp"]) await this.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode });
    await this.settle();
  }
  async type(text: string) {
    await this.send("Input.insertText", { text });
    await this.settle();
  }
  async shoot(name: string) {
    if (!shots) return;
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(shots, `${name}.png`), Buffer.from(data, "base64"));
  }
  /** The folders the list shows, the part of each the search found, and the list's rows. */
  list() {
    return this.eval<{ open: boolean; names: string[]; found: (string | null)[]; rows: number[]; height: number; value: string }>(`(() => {
      const menu = document.querySelector('.path-menu');
      const items = [...document.querySelectorAll('.path-item')];
      return {
        open: menu?.getAttribute('data-state') === 'open',
        names: items.map((el) => el.textContent),
        found: items.map((el) => el.querySelector('.path-match')?.textContent ?? null),
        rows: items.map((el) => el.getBoundingClientRect().height),
        height: menu?.getBoundingClientRect().height ?? 0,
        value: document.querySelector('.np-path').value,
      };
    })()`);
  }
}

async function open(theme = "dark") {
  const page = await DialogPage.open(chrome!.ws, `${server!.url.href}?theme=${theme}`, 1000, 760, "!!document.querySelector('.np-path')");
  await page.finish();
  await page.click(".np-path");
  await page.until("document.querySelector('.path-menu')?.getAttribute('data-state') === 'open'");
  await page.finish();
  return page;
}

describe.skipIf(!browser)("new project folder field", () => {
  test("the folder's list is compact, and typing searches it", async () => {
    const page = await open();
    await page.shoot("path-list-dark");
    let l = await page.list();
    expect(l.names.slice(0, 3)).toEqual(["durable-extensions", "openbuild", "portfolio"]);
    expect(Math.max(...l.rows)).toBeLessThanOrEqual(28);
    expect(l.height).toBeLessThanOrEqual(260);

    // "tool" finds the folder that starts with it first, then the one with it further in.
    await page.type("tool");
    l = await page.list();
    expect(l.names).toEqual(["tools", "my-tools"]);
    expect(l.found).toEqual(["tool", "tool"]);
    await page.shoot("path-search-dark");

    // Tab completes the one that starts with it.
    await page.key("Tab", "Tab", 9);
    expect((await page.list()).value).toBe("~/tools/");
  }, 30_000);

  test("typing opens the list after Escape closed it; Escape closes the list, then the dialog", async () => {
    const page = await open("light");
    await page.key("Escape", "Escape", 27);
    expect((await page.list()).open).toBe(false);
    expect(await page.eval<number>("window.dialogClosed")).toBe(0);

    await page.type("build");
    await page.until("document.querySelector('.path-menu')?.getAttribute('data-state') === 'open'");
    await page.finish();
    expect((await page.list()).names).toEqual(["openbuild"]);
    await page.shoot("path-search-light");
    await page.key("Tab", "Tab", 9);
    expect((await page.list()).value).toBe("~/openbuild/");
    await page.until("document.querySelector('.path-item')?.textContent === 'bin'");

    await page.key("Escape", "Escape", 27);
    expect((await page.list()).open).toBe(false);
    expect(await page.eval<number>("window.dialogClosed")).toBe(0);
    await page.key("Escape", "Escape", 27);
    expect(await page.eval<number>("window.dialogClosed")).toBe(1);
  }, 30_000);
});
