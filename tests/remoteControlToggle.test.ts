// Remote Control in a real Chrome, desktop and phone: a plain "Remote control" switch on a row of its
// own beside the composer (under it for a new thread, above it in a thread), never in its option row. Claude Code's switches the new thread's opt-in;
// Codex has none (it's set for the machine in Settings → General).
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
      above: r.bottom <= composer.top,
      stashLine: (() => {
        const tab = document.querySelector('.stash-tab');
        if (!tab) return undefined;
        const t = tab.getBoundingClientRect();
        return { sameLine: r.bottom > t.top && r.top < t.bottom, apart: r.right <= t.left, onBox: Math.abs(t.bottom - composer.top) <= 2 };
      })(),
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

    test(`Codex (${size}): no switch under the composer, it's set for the machine in Settings`, async () => {
      const page = await open("runtime=codex", size);
      expect(await read(page)).toBeNull();
      expect(await page.eval<number>("document.querySelectorAll('.remote-control-row').length")).toBe(0);
      await shoot(page, `remote-codex-${size}`);
    }, 60_000);
  }

  for (const size of ["desktop", "phone"] as const) {
    test(`Settings → General (${size}): a Remote control group with Claude Code's default, Codex's machine switch and where Cursor's is set`, async () => {
      const [width, height] = SIZES[size];
      const page = await Page.open(chrome!.ws, `${server!.url}?settings=general`, width, height, "!!document.querySelector('[aria-label=\"Codex Remote Control\"]:not([disabled])')");
      await page.settle();
      const group = () => page.eval<any>(`(() => {
        const g = [...document.querySelectorAll('.sgroup')].find((s) => s.querySelector('.sgroup-title')?.textContent === 'Remote control');
        if (!g) return null;
        const rows = [...g.querySelectorAll('.setting-row')];
        return {
          labels: rows.map((r) => r.querySelector('.setting-label').textContent),
          claude: g.querySelector('[aria-label="Claude Code Remote Control for new threads"]')?.textContent,
          codex: g.querySelector('[aria-label="Codex Remote Control"]')?.getAttribute('aria-checked'),
          cursor: rows[2]?.querySelector('a')?.href,
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      })()`);
      const g = await group();
      expect(g).toMatchObject({ labels: ["Claude Code", "Codex", "Cursor"], claude: expect.stringContaining("Off"), codex: "false", overflow: 0 });
      expect(g.cursor).toStartWith("https://cursor.com/");
      await page.eval(`document.querySelector('[aria-label="Codex Remote Control"]').scrollIntoView({ block: "center" })`);
      await page.settle();
      await shoot(page, `remote-settings-${size}`);
      // Codex's switch turns the daemon's Remote Control on for the machine.
      await page.click('[aria-label="Codex Remote Control"]');
      await page.until(`document.querySelector('[aria-label="Codex Remote Control"]').getAttribute('aria-checked') === 'true'`);
      expect(await page.eval<any[]>("codexPosts")).toEqual([{ enabled: true }]);
      // Claude Code's default: picking On starts the next new thread with it on.
      await page.eval(`store.getState().updateSettings({ remoteControlDefault: "on" })`);
      await page.settle();
      expect((await group()).claude).toContain("On");
    }, 60_000);
  }

  test("a Claude Code thread that started with it on shows it on, above the composer, and fixed", async () => {
    const page = await open("thread=on", "desktop");
    expect(await read(page)).toMatchObject({ checked: "true", disabled: true, note: "On since this thread started", insideComposer: false, inBar: false, above: true, below: false });
    await shoot(page, "remote-claude-thread");
  }, 60_000);

  for (const size of ["desktop", "phone"] as const) {
    test(`a thread with stashed messages (${size}): the switch and the stash tab share the line above the box`, async () => {
      const page = await open("thread=on&stash=2", size);
      expect(await read(page)).toMatchObject({ above: true, overflow: 0, stashLine: { sameLine: true, apart: true, onBox: true } });
      await shoot(page, `remote-claude-thread-stash-${size}`);
      // Opened, the list spans the box as before, not just the stash's share of the line.
      await page.eval(`document.querySelector('.stash-tab-btn').click()`);
      await page.settle();
      const inset = await page.eval<number[]>(`(() => {
        const c = document.querySelector('.composer').getBoundingClientRect();
        const p = document.querySelector('.stash-panel').getBoundingClientRect();
        return [Math.round(p.left - c.left), Math.round(c.right - p.right)];
      })()`);
      expect(inset[0]).toBe(inset[1]);
      await shoot(page, `remote-claude-thread-stash-open-${size}`);
    }, 60_000);
  }
});
