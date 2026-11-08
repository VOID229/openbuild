// Remote Control in a real Chrome, desktop and phone: a plain "Remote control" switch on a row of its
// own under the composer, never in its option row. Claude Code's switches the new thread's opt-in;
// Codex's is off and disabled with one short line, and no panel opens over the composer.
// Set OPENBUILD_SCREENSHOTS to a folder to keep a picture of each state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { browser, launchChrome, Page } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const shots = process.env.OPENBUILD_SCREENSHOTS;

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/remoteControl/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page } });
  chrome = await launchChrome();
  if (shots) await mkdir(shots, { recursive: true });
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

const SIZES = { desktop: [1000, 700], phone: [340, 760] } as const;

async function open(query: string, size: keyof typeof SIZES) {
  const [width, height] = SIZES[size];
  const page = await Page.open(chrome!.ws, `${server!.url}?${query}`, width, height, "!!document.querySelector('.composer-bar')");
  await page.settle();
  return page;
}

async function shoot(page: Page, name: string) {
  if (!shots) return;
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(shots, `${name}.png`), Buffer.from(data, "base64"));
}

/** The switch, its row and where both sit against the composer. */
const read = (page: Page) =>
  page.eval<any>(`(() => {
    const sw = document.querySelector('[role="switch"][aria-label="Remote control"]');
    if (!sw) return null;
    const row = sw.closest('.remote-control-row');
    const composer = document.querySelector('.composer').getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const note = document.getElementById(sw.getAttribute('aria-describedby'));
    return {
      checked: sw.getAttribute('aria-checked'),
      disabled: sw.disabled,
      label: row.querySelector('label').textContent,
      labelFor: row.querySelector('label').htmlFor === sw.id,
      note: note.textContent,
      oneLine: note.getClientRects().length === 1 && note.getBoundingClientRect().height < 22,
      insideComposer: !!sw.closest('.composer'),
      inBar: !!document.querySelector('.composer-bar').textContent.match(/Remote/),
      below: r.top >= composer.bottom,
      left: Math.round(r.left - composer.left),
      overflow: document.documentElement.scrollWidth - innerWidth,
      openPanels: document.querySelectorAll('.popover, [role="dialog"], [role="listbox"]').length,
    };
  })()`);

describe.skipIf(!browser)("Remote Control under the composer", () => {
  for (const size of ["desktop", "phone"] as const) {
    test(`Claude Code (${size}): a working switch under the composer, out of its option row`, async () => {
      const page = await open("runtime=claude", size);
      const before = await read(page);
      expect(before).toMatchObject({ checked: "false", disabled: false, label: "Remote control", labelFor: true, note: "Needs a claude.ai sign-in", insideComposer: false, inBar: false, below: true, overflow: 0, openPanels: 0 });
      expect(before.left).toBeLessThan(24);
      expect(before.oneLine).toBe(true);
      await shoot(page, `remote-claude-off-${size}`);
      // Clicking the switch turns the new thread's opt-in on, and back off; no panel opens.
      await page.click('[role="switch"][aria-label="Remote control"]');
      expect(await read(page)).toMatchObject({ checked: "true", openPanels: 0 });
      expect(await page.eval<boolean>("store.getState().draftRemoteControl")).toBe(true);
      await shoot(page, `remote-claude-on-${size}`);
      // The label switches it too.
      await page.click(".remote-control-label");
      expect((await read(page)).checked).toBe("false");
      expect(await page.eval<boolean>("store.getState().draftRemoteControl")).toBe(false);
      // And the keyboard: Space on the focused switch.
      await page.eval(`document.querySelector('[role="switch"][aria-label="Remote control"]').focus()`);
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
      await page.settle();
      expect(await page.eval<boolean>("store.getState().draftRemoteControl")).toBe(true);
    }, 60_000);

    test(`Codex (${size}): off and disabled, one short line, and nothing opens over the composer`, async () => {
      const page = await open("runtime=codex", size);
      const state = await read(page);
      expect(state).toMatchObject({ checked: "false", disabled: true, label: "Remote control", note: "Set per machine, not per thread", insideComposer: false, inBar: false, below: true, overflow: 0, openPanels: 0 });
      expect(state.oneLine).toBe(true);
      await page.click('[role="switch"][aria-label="Remote control"]');
      await page.click(".remote-control-label");
      expect(await read(page)).toMatchObject({ checked: "false", openPanels: 0 });
      expect(await page.eval<boolean>("store.getState().draftRemoteControl")).toBe(false);
      await shoot(page, `remote-codex-${size}`);
    }, 60_000);
  }

  test("a Claude Code thread that started with it on shows it on, below the composer, and fixed", async () => {
    const page = await open("thread=on", "desktop");
    expect(await read(page)).toMatchObject({ checked: "true", disabled: true, note: "On since this thread started", insideComposer: false, inBar: false, below: true });
    await shoot(page, "remote-claude-thread");
  }, 60_000);
});
