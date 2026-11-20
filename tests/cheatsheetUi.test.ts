// The ⌘K cheatsheet in a real Chrome, on a desktop and a phone, light and dark: it fits, the search
// has the focus and filters, the list scrolls, and Escape clears the search before it closes.
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
  const page = (await import("./fixtures/cheatsheet/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page } });
  chrome = await launchChrome();
  if (shots) await mkdir(shots, { recursive: true });
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

const OPEN = "document.querySelector('.cheatsheet-root')?.dataset.state === 'open'";

async function open(query: string, width: number, height: number) {
  const page = await Page.open(chrome!.ws, `${server!.url}?${query}`, width, height, OPEN);
  await page.finish();
  return page;
}

async function shoot(page: Page, name: string) {
  if (!shots) return;
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(shots, `cheatsheet-${name}.png`), Buffer.from(data, "base64"));
}

const key = (page: Page, key: string, code = key, vk = 0) =>
  page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk });

const type = (page: Page, text: string) => page.send("Input.insertText", { text });

const state = (page: Page) =>
  page.eval<Record<string, any>>(`(() => {
    const dialog = document.querySelector('.cheatsheet');
    const list = dialog?.querySelector('.cheatsheet-list');
    const r = dialog?.getBoundingClientRect();
    return {
      open: !!dialog,
      box: r && { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width },
      focused: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.id,
      query: dialog?.querySelector('input')?.value,
      groups: [...(dialog?.querySelectorAll('.cheatsheet-title') ?? [])].map((h) => h.textContent),
      rows: [...(dialog?.querySelectorAll('.cheatsheet-row') ?? [])].map((row) => row.querySelector('.cheatsheet-label').textContent + ' ' + [...row.querySelectorAll('kbd')].map((k) => k.textContent).join('')),
      empty: dialog?.querySelector('.cheatsheet-empty')?.textContent,
      scrollTop: list?.scrollTop, scrollable: list ? list.scrollHeight - list.clientHeight : 0,
      background: dialog && getComputedStyle(dialog).backgroundColor,
      overflow: document.documentElement.scrollWidth - innerWidth,
      vw: innerWidth, vh: innerHeight,
    };
  })()`);

for (const [device, width, height] of [["desktop", 1280, 800], ["phone", 390, 700]] as const) {
  for (const theme of ["light", "dark"] as const) {
    test.skipIf(!browser)(`on a ${device} in ${theme}: it fits, the search has the focus, and the list scrolls`, async () => {
      const page = await open(`theme=${theme}`, width, height);
      const look = await state(page);
      await shoot(page, `${device}-${theme}`);
      expect(look.focused).toBe("Search shortcuts");
      expect(look.groups).toEqual(["General", "Composer", "Side panel", "Terminal", "Elsewhere"]);
      expect(look.overflow).toBeLessThanOrEqual(0);
      expect(look.box.left).toBeGreaterThanOrEqual(0);
      expect(look.box.right).toBeLessThanOrEqual(look.vw);
      expect(look.box.bottom).toBeLessThanOrEqual(look.vh);
      if (device === "desktop") expect(look.box.width).toBeLessThanOrEqual(480);
      expect(look.background).toBe(theme === "dark" ? "rgb(18, 18, 18)" : "rgb(255, 255, 255)");
      // More than fits, so it scrolls, and ↓ from the search scrolls it.
      expect(look.scrollable).toBeGreaterThan(0);
      await key(page, "ArrowDown", "ArrowDown", 40);
      await page.until("document.querySelector('.cheatsheet-list').scrollTop > 0");
    }, 30_000);
  }
}

test.skipIf(!browser)("the search filters, says when nothing matches, and Escape clears it before closing", async () => {
  const page = await open("theme=light", 1280, 800);
  await type(page, "sidebar");
  await page.until("document.querySelectorAll('.cheatsheet-row').length === 2");
  const found = await state(page);
  expect(found.groups).toEqual(["General"]);
  expect(found.rows.map((r: string) => r.split(" ").slice(0, 3).join(" "))).toEqual(["Toggle left sidebar", "Toggle right sidebar"]);
  await shoot(page, "search");

  await key(page, "Escape", "Escape", 27);
  await page.until("document.querySelector('.cheatsheet input').value === ''");
  expect((await state(page)).open).toBe(true);

  await type(page, "zzz");
  await page.until("!!document.querySelector('.cheatsheet-empty')");
  expect((await state(page)).empty).toBe("No shortcuts match “zzz”");
  await key(page, "Escape", "Escape", 27);
  await key(page, "Escape", "Escape", 27);
  await page.until("!document.querySelector('.cheatsheet-root')");
  // Focus goes back where it was.
  expect((await state(page)).focused).toBe("before");

  // Opened again, it starts with an empty search.
  await page.eval("window.toggleCheatsheet()");
  await page.until(OPEN);
  expect((await state(page)).query).toBe("");
}, 30_000);

test.skipIf(!browser)("clicking outside closes it", async () => {
  const page = await open("theme=light", 1280, 800);
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 20, y: 780, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 20, y: 780, button: "left", clickCount: 1 });
  await page.until("!document.querySelector('.cheatsheet-root')");
}, 30_000);
