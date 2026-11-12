// A bot typing in an OpenBots chat, in a real Chrome: the chat says "Typing…" in words where the
// three hopping dots used to be, breathing gently, and holds still for reduced motion. (The sidebar's
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

type Shown = { text: string; children: number; label: string | null; height: number; animation: string; color: string; size: string };
const shown = (page: Page) =>
  page.eval<Shown>(`(() => {
    const el = document.querySelector('.bm-typing');
    const css = getComputedStyle(el);
    return { text: el.textContent, children: el.children.length, label: el.getAttribute('aria-label'), height: el.getBoundingClientRect().height,
      animation: css.animationName, color: css.color, size: css.fontSize };
  })()`);

describe.skipIf(!browser)("a bot typing", () => {
  test("reads Typing… in words that breathe, and the reply takes their place", async () => {
    const page = await open();
    await page.eval(`bots.setState((s) => ({ typing: { ...s.typing, a: ["manager"] } }))`);
    await page.until("!!document.querySelector('.bm-typing')");
    const typing = await shown(page);
    expect(typing).toMatchObject({ text: "Typing…", children: 0, label: "manager is typing", height: 34, animation: "bots-typing-text", size: "14px" });
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
