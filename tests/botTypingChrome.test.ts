// A bot typing in an OpenBots chat, in a real Chrome: its mascot stays, and beside it "Typing…" in
// words where the three hopping dots used to be, breathing gently, holding still for reduced motion. (The sidebar's
// preview and the header saying the same is tests/botStatusUi.test.ts's.)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botScroll/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const open = async () => {
  const page = await Page.open(chrome!.ws, server!.url.href, 1000, 700, "!!document.querySelector('.bm-group')");
  await page.settle();
  return page;
};

type Shown = { text: string; children: number; label: string | null; mascot: boolean; beside: boolean; animation: string; color: string; size: string };
const shown = (page: Page) =>
  page.eval<Shown>(`(() => {
    const el = document.querySelector('.bm-typing'), row = el.closest('.bm-working'), bot = row?.querySelector('.bot');
    const css = getComputedStyle(el), a = bot?.getBoundingClientRect(), t = el.getBoundingClientRect();
    return { text: el.textContent, children: el.children.length, label: row?.getAttribute('aria-label') ?? null, mascot: !!bot && !bot.querySelector('.bot-dots'),
      beside: !!a && t.left >= a.right && Math.abs((t.top + t.bottom) / 2 - (a.top + a.bottom) / 2) < 4,
      animation: css.animationName, color: css.color, size: css.fontSize };
  })()`);

describe.skipIf(!browser)("a bot typing", () => {
  test("keeps the mascot, with Typing… in words that breathe beside it, and the reply takes their place", async () => {
    const page = await open();
    // At work first: the mascot that's typing next is this one, kept where it is.
    await page.eval(`bots.setState((s) => ({ status: { ...s.status, manager: { state: "working", conversationId: "a", activity: "Reading notes.md", since: Date.now() - 60000 } } }))`);
    await page.until("!!document.querySelector('.bm-working .bot')");
    await page.eval("void (window.mascot = document.querySelector('.bm-working .bot'))");
    await page.eval(`bots.setState((s) => ({ typing: { ...s.typing, a: ["manager"] } }))`);
    await page.until("!!document.querySelector('.bm-typing')");
    expect(await page.eval<boolean>("document.querySelector('.bm-working .bot') === window.mascot")).toBe(true);
    const typing = await shown(page);
    expect(typing).toMatchObject({ text: "Typing…", children: 0, label: "manager is typing", mascot: true, beside: true, animation: "bots-typing-text", size: "14px" });
    // Its words are the app's secondary text, as the sidebar's preview is while a bot types.
    expect(typing.color).toBe(await page.eval<string>("(() => { const s = document.body.appendChild(document.createElement('span')); s.style.color = 'var(--text-2)'; const c = getComputedStyle(s).color; s.remove(); return c; })()"));
    // The words it's writing replace "Typing…" in a bubble.
    await page.eval(`bots.setState({ drafts: [{ conversationId: "a", botId: "manager", text: "Here's the plan" }] })`);
    await page.until("!document.querySelector('.bm-typing') && [...document.querySelectorAll('.bm-bubble')].some((b) => b.textContent === \"Here's the plan\")");
    await page.eval(`bots.setState({ drafts: [], typing: { a: [] } })`);
    await page.until("!document.querySelector('.bm-typing')");
  }, 60_000);

  test("holds still for reduced motion", async () => {
    const page = await open();
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await page.eval(`bots.setState((s) => ({ typing: { ...s.typing, a: ["manager"] } }))`);
    await page.until("!!document.querySelector('.bm-typing')");
    const typing = await shown(page);
    expect(typing.text).toBe("Typing…");
    expect(typing.animation).toBe("none");
    expect(await page.eval<string>("getComputedStyle(document.querySelector('.bm-typing')).opacity")).toBe("1");
  }, 60_000);
});
