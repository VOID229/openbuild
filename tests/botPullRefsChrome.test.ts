// "#n" pull request references in an OpenBots chat, in a real Chrome (tests/fixtures/botPullRefs): in
// messages and activity lines they link to the pull request in the repository the chat's threads are
// in, styled as thread links are, while code, colours, addresses, headings and labels stay text. Set
// OPENBUILD_SCREENSHOTS to a folder to keep a picture in each theme.
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
      const page = await Page.open(chrome!.ws, `${server!.url}?theme=${theme}`, 760, 620, "document.querySelectorAll('.bm-row, .bm-event').length >= 4");
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
