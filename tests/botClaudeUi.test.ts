// Settings → Bots → Claude in a real Chrome: each login's state, connecting one through Claude
// Code's sign-in (open Claude, paste the code), and disconnecting with or without signing out.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;
const READY = "document.querySelectorAll('.setting-row').length === 2";

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botClaude/index.html`);
  chrome = await launchChrome();
}, 60_000);
afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const rows = `[...document.querySelectorAll('.setting-row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())`;
const button = (row: number, text: string) => `[...document.querySelectorAll('.setting-row')[${row}].querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
const calls = (action: string) => `window.calls.filter((c) => c.path.endsWith('/${action}'))`;

test.skipIf(!browser)("each login shows whether bots use it, and a signed-out one connects through Claude Code", async () => {
  const page = await Page.open(chrome!.ws, String(server!.url), 1280, 900, READY);
  const [first, second] = await page.eval<string[]>(rows);
  expect(first).toContain("Claude Connected");
  expect(first).toContain("me@example.com · Max plan · ~/.claude");
  expect(second).toContain("Claude (2) Not signed in");
  expect(await page.eval<string>(`document.querySelector('.bots-claude-head').textContent`)).toBe("1 connected");

  await page.eval(`${button(1, "Connect")}.click()`);
  await page.until(`!!document.querySelector('.bots-claude-signin')`);
  const link = await page.eval<{ href: string; target: string; rel: string }>(`(() => { const a = document.querySelector('.bots-claude-signin a'); return { href: a.href, target: a.target, rel: a.rel }; })()`);
  expect(link).toEqual({ href: "https://claude.com/cai/oauth/authorize?code=true&state=s", target: "_blank", rel: "noreferrer noopener" });
  // Nothing to send until there's a code.
  expect(await page.eval<boolean>(`document.querySelector('.bots-claude-code button[type=submit]').disabled`)).toBe(true);

  const type = (value: string) => page.eval(`(() => {
    const input = document.querySelector('.bots-claude-code input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await type("bad-code");
  await page.eval(`document.querySelector('.bots-claude-code button[type=submit]').click()`);
  await page.until(`[...document.querySelectorAll('[role=alert]')].some((e) => e.textContent.includes("That code wasn't accepted."))`);
  expect(await page.eval<boolean>(`!!document.querySelector('.bots-claude-signin')`)).toBe(false);

  await page.eval(`${button(1, "Connect")}.click()`);
  await page.until(`!!document.querySelector('.bots-claude-code input')`);
  await type("  good-code ");
  await page.eval(`document.querySelector('.bots-claude-code button[type=submit]').click()`);
  await page.until(`document.querySelector('.bots-claude-head').textContent === '2 connected'`);
  expect((await page.eval<string[]>(rows))[1]).toContain("Claude (2) Connected");
  // The code went once per try, trimmed, with the sign-in it belongs to.
  expect(await page.eval<unknown>(`${calls("code")}.map((c) => c.body)`)).toEqual([
    { flowId: "flow-1", code: "bad-code" },
    { flowId: "flow-1", code: "good-code" },
  ]);
}, 30_000);

test.skipIf(!browser)("disconnecting asks first, and only signs Claude Code out when that's ticked", async () => {
  const page = await Page.open(chrome!.ws, String(server!.url), 1280, 900, READY);
  await page.eval(`${button(0, "Disconnect")}.click()`);
  await page.until(`!!document.querySelector('dialog[open]')`);
  const dialog = await page.eval<string>(`document.querySelector('dialog[open]').innerText`);
  expect(dialog).toContain("Claude Code stays signed in");
  expect(await page.eval<boolean>(`document.querySelector('dialog[open] input[type=checkbox]').checked`)).toBe(false);
  // Cancel changes nothing.
  await page.eval(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Cancel').click()`);
  await page.until(`!document.querySelector('dialog[open]')`);
  expect(await page.eval<number>(`${calls("disconnect")}.length`)).toBe(0);

  await page.eval(`${button(0, "Disconnect")}.click()`);
  await page.until(`!!document.querySelector('dialog[open]')`);
  await page.eval(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Disconnect').click()`);
  await page.until(`document.querySelector('.bots-claude-head').textContent === 'Not connected'`);
  expect((await page.eval<string[]>(rows))[0]).toContain("Claude Off for bots");
  expect(await page.eval<unknown>(`${calls("disconnect")}.map((c) => c.body)`)).toEqual([{ signOut: false }]);

  // Connecting a signed-in login needs no sign-in.
  await page.eval(`${button(0, "Connect")}.click()`);
  await page.until(`document.querySelector('.bots-claude-head').textContent === '1 connected'`);
  expect(await page.eval<boolean>(`!!document.querySelector('.bots-claude-signin')`)).toBe(false);

  await page.eval(`${button(0, "Disconnect")}.click()`);
  await page.until(`!!document.querySelector('dialog[open] input[type=checkbox]')`);
  await page.eval(`document.querySelector('dialog[open] input[type=checkbox]').click()`);
  await page.until(`[...document.querySelectorAll('dialog[open] button')].some((b) => b.textContent === 'Disconnect and sign out')`);
  await page.eval(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Disconnect and sign out').click()`);
  await page.until(`(${rows})[0].includes('Not signed in')`);
  expect(await page.eval<unknown>(`${calls("disconnect")}.map((c) => c.body)`)).toEqual([{ signOut: false }, { signOut: true }]);
}, 30_000);

test.skipIf(!browser)("without Claude Code it says how to install it, and on a phone nothing runs off the side", async () => {
  const page = await Page.open(chrome!.ws, `${server!.url}?installed=no`, 390, 844, READY);
  expect(await page.eval<boolean>(`${button(1, "Connect")}.disabled`)).toBe(true);
  expect(await page.eval<string>(`document.querySelector('[role=alert]').textContent`)).toContain("Claude Code isn't installed on this server");
  expect(await page.eval<boolean>(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
}, 30_000);
