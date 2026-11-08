// A bot's rename, in a real Chrome: the chat it happened in says so, with the draft and the chat in front left alone.
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

describe.skipIf(!browser)("renaming a bot", () => {
  for (const [label, width] of [["on a desktop", 1000], ["on a phone", 390]] as const) {
    test(`is said in the group it happened in, leaving the draft alone, ${label}`, async () => {
      const page = await Page.open(chrome!.ws, server!.url.href, width, 700, "!!document.querySelector('.bm-group')");
      await page.eval(`bots.getState().select("b")`);
      await page.until(`document.querySelector('.bots-composer-textarea') !== null`);
      await page.eval(`(() => {
        const el = document.querySelector('.bots-composer-textarea');
        el.focus();
        document.execCommand("insertText", false, "half-written thought");
      })()`);
      await page.settle();
      const before = await page.eval<{ draft: string }>(`({ draft: document.querySelector('.bots-composer-textarea').textContent || document.querySelector('.bots-composer-textarea').value })`);
      expect(before.draft).toContain("half-written thought");

      // What the server's stream brings back for the rename.
      await page.eval(`bots.setState((s) => ({ conversations: s.conversations.map((c) => c.id === "b" ? { ...c, messages: [...c.messages, { id: "b-renamed", author: "me", at: Date.now(), text: "", event: { kind: "renamed", text: "helper is now Atlas", bot: "helper" } }] } : c) }))`);
      await page.until(`document.querySelector('.bm-event[data-id="b-renamed"]') !== null`);
      await page.settle();

      const after = await page.eval<{ text: string; active: string; draft: string; wide: boolean; unread: boolean }>(`({
        text: document.querySelector('.bm-event[data-id="b-renamed"] .bm-event-text').textContent,
        active: bots.getState().activeId,
        draft: document.querySelector('.bots-composer-textarea').textContent || document.querySelector('.bots-composer-textarea').value,
        wide: document.documentElement.scrollWidth > innerWidth,
        unread: !!bots.getState().conversations.find((c) => c.id === "b").unread,
      })`);
      expect(after.text).toContain("Atlas");
      expect(after.text).toContain("helper is now");
      expect(after.active).toBe("b");
      expect(after.draft).toContain("half-written thought");
      expect(after.wide).toBe(false);
      expect(after.unread).toBe(false);
    }, 60_000);
  }
});
