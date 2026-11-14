// The stash shortcuts in a real Chrome (tests/fixtures/stashShortcut), in a thread's composer and in
// an OpenBots chat: ⌘⇧S / Ctrl+Shift+S pastes the newest stash straight away, as picking it from the
// list does, with no list in between; with nothing stashed it says so. ⌘S / Ctrl+S is unchanged. The
// page takes both keys, so the browser's own Save As never opens.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/stashShortcut/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page } });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

const SIDES = {
  thread: { field: ".composer-input", notice: ".composer-notice" },
  bots: { field: ".bots-composer-textarea", notice: ".bots-composer-notice" },
} as const;

class StashPage extends Page {
  field = "";
  notice = "";
  /** ⌘ (Ctrl off a Mac) with S, and Shift too when `shift`. */
  async press(shift: boolean) {
    const mod = await this.eval<number>("/Mac/.test(navigator.platform) ? 4 : 2");
    for (const type of ["rawKeyDown", "keyUp"]) {
      await this.send("Input.dispatchKeyEvent", { type, key: shift ? "S" : "s", code: "KeyS", windowsVirtualKeyCode: 83, modifiers: mod | (shift ? 8 : 0) });
    }
    await this.settle();
  }
  read() {
    return this.eval<{ value: string; focused: boolean; list: boolean; count: string | null; notice: string | null; prevented: boolean }>(`({
      value: document.querySelector('${this.field}').value,
      focused: document.activeElement === document.querySelector('${this.field}'),
      list: !!document.querySelector('.stash-panel'),
      count: document.querySelector('.stash-count')?.textContent ?? null,
      notice: document.querySelector('${this.notice}')?.textContent ?? null,
      prevented: window.lastKey?.code === "KeyS" && window.lastKey.prevented,
    })`);
  }
  stashed() {
    return this.eval<string[]>(`(${this.field === SIDES.bots.field ? "botStash" : "threadStash"}).use.getState().items.map((i) => i.text)`);
  }
}

for (const side of ["thread", "bots"] as const) {
  describe.skipIf(!browser)(`the stash shortcuts in ${side === "thread" ? "a thread's composer" : "an OpenBots chat"}`, () => {
    const open = async (stashes: string[]) => {
      const { field, notice } = SIDES[side];
      const page = await StashPage.open(chrome!.ws, `${server!.url}?side=${side}`, 1000, 700, `!!document.querySelector('${field}')`);
      page.field = field;
      page.notice = notice;
      await page.eval(`stashAll(${JSON.stringify(stashes)})`);
      if (stashes.length) await page.until("!!document.querySelector('.stash-tab')");
      await page.eval(`document.querySelector('${field}').focus()`);
      return page;
    };

    // One page a side: each load is a whole app's bundle, and a busy machine makes that slow.
    test("⌘⇧S pastes the newest stash with no list in between, and says so when there's none; ⌘S is unchanged", async () => {
      const page = await open(["older", "newer"]);
      await page.press(true);
      expect(await page.read()).toMatchObject({ value: "newer", focused: true, list: false, count: "1", notice: null, prevented: true });
      // Used, as a pick from the list would be: it's gone from the stash, and the older one is next.
      expect(await page.stashed()).toEqual(["older"]);
      // What's already in the box stays, ahead of it.
      await page.press(true);
      expect(await page.read()).toMatchObject({ value: "newer\nolder", focused: true, list: false, notice: null, prevented: true });
      expect(await page.stashed()).toEqual([]);
      expect(await page.eval<boolean>("!document.querySelector('.stash')")).toBe(true);

      // Nothing left: it says so, and the box stays as it was.
      await page.press(true);
      expect(await page.read()).toMatchObject({ value: "newer\nolder", focused: true, notice: "Nothing in the stash yet.", prevented: true });

      // ⌘S still stashes a draft, and over several stashes opens the list rather than pasting one.
      await page.press(false);
      expect(await page.read()).toMatchObject({ value: "", prevented: true });
      expect(await page.stashed()).toEqual(["newer\nolder"]);
      await page.eval(`stashAll(["third"])`);
      await page.press(false);
      expect(await page.read()).toMatchObject({ value: "", list: true, prevented: true });
      // And with the list open, ⌘⇧S still takes the newest.
      await page.press(true);
      expect(await page.read()).toMatchObject({ value: "third", list: false });
      expect(await page.stashed()).toEqual(["newer\nolder"]);
    }, 60_000);
  });
}
