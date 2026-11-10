// The Model card of a bot's details panel (Advanced tab), at the panel's own width in a real Chrome,
// on a desktop and a phone: each setting's label over a control that takes the card's width, and the
// fallbacks in one set of columns (number, picker, try earlier, remove) with pickers of one size. The
// server is faked (fixtures/botAdvanced/page.tsx). Set OPENBUILD_SCREENSHOTS to a folder to keep a
// picture of each.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let fixture: Awaited<ReturnType<typeof serveFixture>> | undefined;
const shots = process.env.OPENBUILD_SCREENSHOTS;

beforeAll(async () => {
  if (!browser) return;
  fixture = await serveFixture(join(import.meta.dir, "fixtures/botAdvanced/index.html"));
  chrome = await launchChrome();
  if (shots) await mkdir(shots, { recursive: true });
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await fixture?.stop();
});

const LISTED = "document.querySelectorAll('.bots-fallbacks .naming-row').length === 4 && !!document.querySelector('.bots-fallbacks .select-hint')";

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const boxes = (page: Page, selector: string) =>
  page.eval<Box[]>(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })`);

for (const [device, width, height] of [["desktop", 1280, 860], ["phone", 390, 844]] as const) {
  test.skipIf(!browser)(`on a ${device}: the Model card stacks each label over a full-width control, and its fallbacks line up`, async () => {
    const page = await Page.open(chrome!.ws, `${fixture!.url}`, width, height, LISTED);
    await page.settle();
    if (shots) {
      const { data } = await page.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 360, height: 520, scale: 2 } });
      await Bun.write(join(shots, `advanced-model-${device}.png`), Buffer.from(data, "base64"));
    }
    const [card] = await boxes(page, ".bots-adv-model .bots-adv-card");
    // Model, Effort and Fallbacks: each label sits above its control, and the controls share both edges.
    const labels = await boxes(page, ".bots-adv-model .setting-row > .setting-label");
    const controls = await boxes(page, ".bots-adv-model .setting-row > .select-wrap");
    expect(labels).toHaveLength(3);
    expect(controls).toHaveLength(3);
    controls.forEach((c, i) => {
      expect(c.top).toBeGreaterThanOrEqual(labels[i]!.bottom);
      expect(c.left).toBeCloseTo(controls[0]!.left, 0);
      expect(c.right).toBeCloseTo(controls[0]!.right, 0);
      expect(c.left).toBeCloseTo(labels[i]!.left, 0);
    });
    expect(controls[0]!.width).toBeGreaterThan(card!.width - 30);
    // Every fallback picker, the one to add included, is the same size and starts at the same place,
    // a long model name included, and each row's number lines up with the labels above.
    const pickers = await boxes(page, ".bots-fallbacks .naming-row .select-trigger");
    expect(pickers).toHaveLength(4);
    for (const p of pickers) {
      expect(p.left).toBeCloseTo(pickers[0]!.left, 0);
      expect(p.width).toBeCloseTo(pickers[0]!.width, 0);
      expect(p.height).toBeCloseTo(pickers[0]!.height, 0);
    }
    for (const n of await boxes(page, ".bots-fallbacks .naming-index")) expect(n.left).toBeCloseTo(labels[0]!.left, 0);
    // The remove buttons share a column that ends where the selects above do.
    const removes = await boxes(page, '.bots-fallbacks button[aria-label="Remove"]');
    expect(removes).toHaveLength(3);
    for (const r of removes) expect(r.right).toBeCloseTo(removes[0]!.right, 0);
    expect(Math.abs(removes[0]!.right - controls[0]!.right)).toBeLessThanOrEqual(6);
    // Nothing spills out of the card.
    for (const b of [...controls, ...pickers, ...removes]) expect(b.right).toBeLessThanOrEqual(card!.right);
    // Still the same list: the third tries earlier, and the list is saved in its new order.
    await page.click('.bots-fallbacks .naming-row:nth-child(3) button[aria-label="Try earlier"]');
    await page.until("window.saved.length === 1");
    expect(await page.eval<unknown>("window.saved[0].fallbackModels")).toEqual(["openai-codex/gpt-6.1-sol", "opencode-go/glm-5.3-long-context-preview", "openai-codex-2/gpt-6.1-sol"]);
  });
}
