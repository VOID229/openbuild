// A bot at work in an OpenBots chat shows what it's doing with a soft highlight sweeping through the
// words: the shimmer's moving gradient paints the text, so the text itself must stay transparent (a
// colour of its own sits on top and hides the highlight). In a real Chrome with the whole app on a fake
// server (fixtures/groupThreads).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/groupThreads/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page, "/bots": page, "/bots/*": page } });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

describe.skipIf(!browser)("a bot's working line", () => {
  test("shimmers: the gradient paints the words, which have no colour of their own", async () => {
    const page = await Page.open(chrome!.ws, `${server!.url.href}bots`, 1280, 800, "window.store?.getState().chatsLoaded && window.bots?.getState().loaded");
    await page.eval(`(() => {
      const s = bots.getState();
      const chat = s.conversations.find((c) => c.kind === 'group');
      bots.setState({ activeId: chat.id, status: { ...s.status, [chat.botIds[0]]: { state: 'working', conversationId: chat.id, activity: 'Checking the live install page' } } });
      store.setState({ botsOpen: true });
      return true;
    })()`);
    await page.until("!!document.querySelector('.bm-working-text')");
    const look = await page.eval<{ text: string; color: string; clip: string; image: string; animations: string[]; size: string }>(`(() => {
      const el = document.querySelector('.bm-working-text'), s = getComputedStyle(el);
      return { text: el.textContent, color: s.color, clip: s.backgroundClip || s.webkitBackgroundClip, image: s.backgroundImage, animations: s.animationName.split(', '), size: s.fontSize };
    })()`);
    expect(look.text).toBe("Checking the live install page");
    expect(look.color).toBe("rgba(0, 0, 0, 0)");
    expect(look.clip).toBe("text");
    expect(look.image).toStartWith("linear-gradient");
    expect(look.animations).toContain("shimmer");
    expect(look.size).toBe("14px");
    // And it moves: the highlight's place changes from one moment to the next.
    const at = () => page.eval<string>("getComputedStyle(document.querySelector('.bm-working-text')).backgroundPosition");
    const first = await at();
    await Bun.sleep(300);
    expect(await at()).not.toBe(first);
  }, 60_000);
});
