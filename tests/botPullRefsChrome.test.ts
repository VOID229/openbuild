// "#n" pull request references in an OpenBots chat, in a real Chrome (tests/fixtures/botPullRefs): in
// messages and activity lines they link to the pull request in the repository the chat's threads are
// in, styled as thread links are, while code, colours, addresses, headings and labels stay text. Links
// to GitHub lead with its mark, which never ends a line on its own. Set OPENBUILD_SCREENSHOTS to a folder
// to keep a picture in each theme.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;
const shots = process.env.OPENBUILD_SCREENSHOTS;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture("tests/fixtures/botPullRefs/index.html");
  chrome = await launchChrome();
  if (shots) await mkdir(shots, { recursive: true });
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const REPO = "https://github.com/VOID229/openbuild";

/** Each row's links, by text and where they go. */
const links = (page: Page) =>
  page.eval<{ row: string; text: string; href: string; cls: string }[]>(`[...document.querySelectorAll('.bots-messages a')].map((a) => ({
    row: a.closest('[data-id]')?.dataset.id ?? '', text: a.textContent, href: a.getAttribute('href'), cls: a.className,
  }))`);

describe.skipIf(!browser)("pull request references", () => {
  for (const theme of ["dark", "light"]) {
    test(`link in messages and activity lines, and nowhere else (${theme})`, async () => {
      const page = await Page.open(chrome!.ws, `${server!.url}?theme=${theme}`, 760, 620, "document.querySelectorAll('.bm-row, .bm-event').length >= 5");
      await page.settle();
      const found = await links(page);
      const pulls = found.filter((l) => l.text.startsWith("#"));
      expect(pulls).toEqual([
        { row: "m0", text: "#210", href: `${REPO}/pull/210`, cls: "link" },
        { row: "m1", text: "#213", href: `${REPO}/pull/213`, cls: "link" },
        { row: "m2", text: "#213", href: `${REPO}/pull/213`, cls: "link" },
        { row: "m2", text: "#210", href: `${REPO}/pull/210`, cls: "link" },
      ]);
      // The thread id beside them links as it did, with the same class.
      expect(found.find((l) => l.text === "f707f90a")).toMatchObject({ row: "m0", href: "/thread-f707f90a-0000-4000-8000-000000000000", cls: "link" });
      // Code, a colour, an address's fragment, a heading's marker and a model's label stay text.
      expect(found.filter((l) => l.row === "m3").map((l) => l.text)).toEqual(["https://example.com/page#12"]);
      expect(found.some((l) => l.text === "#2")).toBe(false);
      // Clicking a pull request in an activity line doesn't open the line as well.
      await page.eval(`document.querySelector('.bm-event a.link').addEventListener('click', (e) => e.preventDefault(), { once: true })`);
      await page.click(".bm-event a.link");
      expect(await page.eval<boolean>("document.querySelector('.bm-event').classList.contains('bm-event-open')")).toBe(false);
      if (shots) {
        const { data } = await page.send("Page.captureScreenshot", { format: "png" });
        await Bun.write(join(shots, `after-${theme}.png`), Buffer.from(data, "base64"));
      }
    }, 60_000);
  }
});

/** Each link with GitHub's mark: its text, and the mark's size and colour beside the link's. */
const marked = (page: Page) =>
  page.eval<{ text: string; href: string; mark: number; font: number; markColor: string; color: string }[]>(`[...document.querySelectorAll('.bots-messages a')].map((a) => {
    const svg = a.querySelector(':scope > .gh-lead > svg.gh-mark');
    if (!svg) return null;
    return { text: a.textContent, href: a.getAttribute('href'), mark: svg.getBoundingClientRect().height, font: parseFloat(getComputedStyle(a).fontSize),
      markColor: getComputedStyle(svg.querySelector('path')).fill, color: getComputedStyle(a).color };
  }).filter(Boolean)`);

/** Marks whose first character went to another line, and how many marks start a line, at this width. */
const wrapping = (page: Page) =>
  page.eval<{ split: string[]; lineStarts: number }>(`(() => {
    const split = [];
    let lineStarts = 0;
    for (const lead of document.querySelectorAll('.bots-messages .gh-lead')) {
      const mark = lead.querySelector('svg').getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(lead);
      range.setStartAfter(lead.querySelector('svg'));
      const first = range.getClientRects()[0];
      if (!first || Math.abs((first.top + first.bottom) / 2 - (mark.top + mark.bottom) / 2) > first.height / 2) split.push(lead.closest('a').textContent);
      const text = lead.closest('.bm-text');
      if (text && mark.left - text.getBoundingClientRect().left < 24) lineStarts++;
    }
    return { split, lineStarts };
  })()`);

describe.skipIf(!browser)("GitHub's mark", () => {
  for (const theme of ["dark", "light"]) {
    test(`leads links to GitHub, in their colour and size (${theme})`, async () => {
      const page = await Page.open(chrome!.ws, `${server!.url}?theme=${theme}`, 760, 620, "document.querySelectorAll('.bm-row, .bm-event').length >= 5");
      await page.settle();
      const found = await marked(page);
      expect(found.map((l) => l.text)).toEqual(["#210", "#213", "#213", "#210", "github.com/VOID229/openbuild", "abc1234"]);
      expect(found.every((l) => new URL(l.href).hostname === "github.com")).toBe(true);
      for (const l of found) {
        expect(l.markColor).toBe(l.color);
        expect(l.mark).toBeGreaterThan(l.font * 0.75);
        expect(l.mark).toBeLessThanOrEqual(l.font);
      }
      // Thread ids and other sites' links have none.
      const plain = await page.eval<string[]>(`[...document.querySelectorAll('.bots-messages a')].filter((a) => !a.querySelector('.gh-mark')).map((a) => a.textContent)`);
      expect(plain).toEqual(["f707f90a", "https://example.com/page#12", "write-up"]);
      // A click on the mark itself follows the link.
      await page.eval(`window.followed = []; for (const a of document.querySelectorAll('.bm-text a')) a.addEventListener('click', (e) => { e.preventDefault(); window.followed.push(a.getAttribute('href')); })`);
      const mark = `.bm-text a[href="${REPO}/commit/abc1234"] .gh-mark`;
      await page.eval(`document.querySelector(${JSON.stringify(mark)}).scrollIntoView({ block: "center" })`);
      await page.click(mark);
      expect(await page.eval<string[]>("window.followed")).toEqual([`${REPO}/commit/abc1234`]);
    }, 60_000);
  }

  test("never ends a line apart from the link's text", async () => {
    const page = await Page.open(chrome!.ws, `${server!.url}?theme=dark`, 760, 620, "document.querySelectorAll('.bm-row, .bm-event').length >= 5");
    await page.settle();
    let lineStarts = 0;
    for (let width = 760; width >= 320; width -= 3) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height: 620, deviceScaleFactor: 1, mobile: false });
      const at = await wrapping(page);
      expect({ width, split: at.split }).toEqual({ width, split: [] });
      lineStarts += at.lineStarts;
    }
    // Some widths put a mark at the start of a line, where it would otherwise have been left behind.
    expect(lineStarts).toBeGreaterThan(0);
  }, 60_000);
});
