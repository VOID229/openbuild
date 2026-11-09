// The closed OpenBots sidebar's rail of avatars, in a real Chrome, with more bots than fit. Where the
// list is cut short its avatars fade into the sidebar's background, in either theme, instead of being
// sliced off with a hard edge; only at an end with more past it. The fade lets clicks through, and
// the buttons under the list stay crisp and clickable.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botsSidebar/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const LIST = ".bots-rail-list";

/** The rail, in `theme`, with the fixture's chats plus `more` of a bot's own. */
const open = async (theme: "light" | "dark", more: number) => {
  const page = await Page.open(chrome!.ws, server!.url.href, 1000, 520, "document.querySelectorAll('.bots-row, .bots-tile').length >= 5");
  await page.eval(`(() => {
    document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    const at = Date.now() - 60_000, ids = ["pip", "manager", "tracer", "scout"];
    const more = Array.from({ length: ${more} }, (_, i) => ({ id: "more-" + i, kind: "direct", botIds: [ids[i % 4]], createdAt: at, updatedAt: at - 1000 - i, messages: [{ id: "more-m" + i, author: "me", at, text: "hi" }] }));
    bots.setState({ conversations: [...bots.getState().conversations, ...more] });
    store.setState({ botsSidebarOpen: false });
  })()`);
  await page.until(`document.querySelectorAll('.bots-rail-item').length === ${5 + more}`);
  await rest(page);
  return page;
};

/** Long enough for the fade to grow or shrink to its size. */
const rest = async (page: Page) => {
  await Bun.sleep(300);
  await page.settle();
};

const scrollTo = async (page: Page, top: number | "end") => {
  await page.eval(`(() => { const l = document.querySelector('${LIST}'); l.scrollTop = ${top === "end" ? "l.scrollHeight" : top}; })()`);
  await rest(page);
};

const edges = (page: Page) =>
  page.eval<{ above: boolean; below: boolean; top: string; bottom: string }>(`(() => {
    const l = document.querySelector('${LIST}'), s = getComputedStyle(l);
    return { above: l.hasAttribute('data-more-above'), below: l.hasAttribute('data-more-below'), top: s.getPropertyValue('--rail-fade-top'), bottom: s.getPropertyValue('--rail-fade-bottom') };
  })()`);

const box = (page: Page, find: string) => page.eval<{ x: number; y: number; width: number; height: number }>(`(() => { const r = (${find}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);

/** Scrolls so the list's bottom edge cuts through the middle of an avatar, as the screenshot in the report had it. */
async function cutThroughAvatar(page: Page) {
  await scrollTo(page, 0);
  await page.eval(`(() => {
    const l = document.querySelector('${LIST}'), bottom = l.getBoundingClientRect().bottom;
    const cut = [...l.querySelectorAll('.bots-rail-item')].find((i) => i.getBoundingClientRect().bottom > bottom);
    const r = cut.getBoundingClientRect();
    l.scrollTop += r.y + r.height / 2 - bottom;
  })()`);
  await rest(page);
}

/** The painted pixels of the page's row at `y`, from a real screenshot, as [r, g, b] for x = 0 up to `width`. */
async function pixels(page: Page, y: number, width: number) {
  const shot = await page.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: Math.floor(y), width, height: 1, scale: 1 } });
  return page.eval<[number, number, number][]>(`new Promise((done) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = 1;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, 1).data;
      done(Array.from({ length: img.width }, (_, x) => [d[x * 4], d[x * 4 + 1], d[x * 4 + 2]]));
    };
    img.src = 'data:image/png;base64,${shot.data}';
  })`);
}

/** How far the row at `y` strays from the sidebar's background beside the avatars, at its worst. */
async function strayFromBackground(page: Page, y: number) {
  const list = await box(page, `document.querySelector('${LIST}')`);
  const row = await pixels(page, y, Math.ceil(list.x + list.width));
  const bg = row[2]!;
  return Math.max(...row.map((p) => Math.max(...p.map((v, i) => Math.abs(v - bg[i]!)))));
}

describe.skipIf(!browser)("the OpenBots rail's fade", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`a cut-off avatar fades into the ${theme} background, rather than being sliced off`, async () => {
      const page = await open(theme, 12);
      await cutThroughAvatar(page);
      const list = await box(page, `document.querySelector('${LIST}')`);
      // At the very edge it's the background, though an avatar runs on past it…
      expect(await strayFromBackground(page, list.y + list.height - 1)).toBeLessThan(10);
      // …while further up, clear of the fade, the avatars are there in full.
      expect(await strayFromBackground(page, list.y + list.height - 60)).toBeGreaterThan(60);
    }, 30_000);
  }

  test("the fade shows only at an end with more past it", async () => {
    const page = await open("dark", 12);
    expect(await edges(page)).toEqual({ above: false, below: true, top: "0px", bottom: "36px" });

    await scrollTo(page, 80);
    expect(await edges(page)).toEqual({ above: true, below: true, top: "28px", bottom: "36px" });

    await scrollTo(page, "end");
    expect(await edges(page)).toEqual({ above: true, below: false, top: "28px", bottom: "0px" });

    await scrollTo(page, 0);
    expect(await edges(page)).toMatchObject({ above: false, below: true });

    // With few enough bots to fit, there's no fade at all, and none left over from before.
    const fits = () => page.eval<boolean>(`(() => { const l = document.querySelector('${LIST}'); return l.scrollHeight <= l.clientHeight; })()`);
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.eval(`bots.setState({ conversations: bots.getState().conversations.filter((c) => !c.id.startsWith('more-')) })`);
    await page.until("document.querySelectorAll('.bots-rail-item').length === 5");
    await rest(page);
    expect(await fits()).toBe(true);
    expect(await edges(page)).toEqual({ above: false, below: false, top: "0px", bottom: "0px" });

    // A shorter window cuts the same list short again, and the fade comes back.
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 400, deviceScaleFactor: 1, mobile: false });
    await rest(page);
    expect(await fits()).toBe(false);
    expect(await edges(page)).toMatchObject({ above: false, below: true, bottom: "36px" });
  }, 30_000);

  test("an avatar in the fade still takes the click", async () => {
    const page = await open("dark", 12);
    await cutThroughAvatar(page);
    const list = await box(page, `document.querySelector('${LIST}')`);
    const x = list.x + list.width / 2, y = list.y + list.height - 8;
    const target = await page.eval<string | null>(`document.elementFromPoint(${x}, ${y})?.closest('.bots-rail-item')?.getAttribute('aria-label') ?? null`);
    expect(target).not.toBeNull();
    expect(target).not.toBe(await page.eval<string>(`document.querySelector('.bots-rail-item-active').getAttribute('aria-label')`));
    for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    await page.settle();
    expect(await page.eval<string>(`document.querySelector('.bots-rail-item-active').getAttribute('aria-label')`)).toBe(target!);
  }, 30_000);

  test("the buttons under the list stay crisp and clickable", async () => {
    const page = await open("light", 12);
    await cutThroughAvatar(page);
    // Nothing between them and the page is masked or see-through.
    expect(await page.eval<string[]>(`(() => {
      const out = [];
      for (let el = document.querySelector('.bots-rail-foot'); el; el = el.parentElement) {
        const s = getComputedStyle(el);
        if (s.maskImage !== 'none' || s.webkitMaskImage !== 'none' || Number(s.opacity) < 1) out.push(el.className);
      }
      return out;
    })()`)).toEqual([]);
    // Each takes the pointer, unobstructed.
    expect(await page.eval<boolean[]>(`[...document.querySelectorAll('.bots-rail-foot > *')].map((b) => {
      const r = b.getBoundingClientRect();
      return b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    })`)).toEqual([true, true, true, true]);
    await page.click(".bots-rail-foot [aria-label='New']");
    expect(await page.eval<boolean>(`!!document.querySelector('.bots-new-menu')`)).toBe(true);
  }, 30_000);
});
