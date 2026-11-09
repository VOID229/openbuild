// The chat's header, in a real Chrome and in both themes: a solid bar above the conversation (never over
// it) holding a pill of the bots, one by one in a row, with the name and a chevron beside them. It
// doesn't change size on hover, nothing in it animates layout, and a click (or Enter from the keyboard)
// toggles the details.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botMascots/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const READY = "!!document.querySelector('.bots-head-pill .bot') && !!document.querySelector('.bots-tile')";
const PILL = "document.querySelector('.bots-head-pill')";

/** OpenBuild Dev's chat, its details closed. `before` runs on the blank tab, to emulate media first. */
const open = async (theme: "light" | "dark", before?: (page: Page) => Promise<unknown>) => {
  const page = await Page.open(chrome!.ws, "about:blank", 1180, 760, "true");
  await before?.(page);
  await page.send("Page.navigate", { url: `${server!.url.href}?theme=${theme}` });
  await page.until(READY);
  await page.eval("bots.setState({ detailsOpen: false })");
  await page.settle();
  await done(page);
  return page;
};

/** Until the pill's transitions have finished. */
const done = (page: Page) =>
  page.eval(`Promise.all(${PILL}.getAnimations({ subtree: true }).filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {}))).then(() => true)`);

type Pill = { width: number; height: number; nameInside: boolean; nameClipped: boolean; chevron: { width: number; inside: boolean } | null; bots: { left: number; right: number; top: number; bottom: number }[]; huddles: number; bg: string; text: string };
const pill = (page: Page) =>
  page.eval<Pill>(`(() => {
    const p = ${PILL}, r = p.getBoundingClientRect();
    const inside = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.left >= r.left && b.right <= r.right; };
    const name = p.querySelector('.bots-head-name'), chev = p.querySelector('.bots-head-chevron');
    return {
      width: r.width, height: r.height,
      nameInside: inside(name),
      nameClipped: name.scrollWidth > name.clientWidth + 0.5,
      chevron: chev && { width: chev.getBoundingClientRect().width, inside: inside(chev) },
      bots: [...p.querySelectorAll('.bot')].map((b) => { const x = b.getBoundingClientRect(); return { left: x.left, right: x.right, top: x.top, bottom: x.bottom }; }),
      huddles: p.querySelectorAll('.bot-huddle').length,
      bg: getComputedStyle(document.querySelector('.bots-head')).backgroundColor, text: getComputedStyle(name).color,
    };
  })()`);

const center = (page: Page) => page.eval<[number, number]>(`(() => { const r = ${PILL}.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
const hover = async (page: Page) => {
  const [x, y] = await center(page);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
};
const leave = (page: Page) => page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 700 });

/** The whole name and the chevron inside the pill. */
const expectShown = (p: Pill, chevron = true) => {
  expect(p.nameInside).toBe(true);
  expect(p.nameClipped).toBe(false);
  if (chevron) expect(p.chevron?.inside).toBe(true);
};

describe.skipIf(!browser)("the chat's header", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`shows the group's bots one by one in a row, the name and a chevron, and holds its size on hover (${theme})`, async () => {
      const page = await open(theme);
      const rest = await pill(page);
      expectShown(rest);
      // Each member its own mascot, side by side on one line, not a huddle.
      expect(rest.huddles).toBe(0);
      expect(rest.bots).toHaveLength(4);
      for (let i = 1; i < rest.bots.length; i++) {
        expect(rest.bots[i]!.left).toBeGreaterThanOrEqual(rest.bots[i - 1]!.right - 0.5);
        expect(Math.abs(rest.bots[i]!.top - rest.bots[0]!.top)).toBeLessThan(1);
      }
      expect(rest.height).toBeLessThanOrEqual(36);
      // Readable in this theme, on a solid bar.
      expect(rest.text).not.toBe(rest.bg);
      expect(rest.bg).not.toBe("rgba(0, 0, 0, 0)");

      await hover(page);
      await done(page);
      const hovered = await pill(page);
      expectShown(hovered);
      expect(hovered.width).toBe(rest.width);
      expect(hovered.height).toBe(rest.height);

      await leave(page);
      await done(page);
      expect((await pill(page)).width).toBe(rest.width);
    }, 20_000);
  }

  test("sits above the conversation, not over it, and animates no layout", async () => {
    const page = await open("dark");
    const [head, messages] = await page.eval<[{ bottom: number }, { top: number }]>(`[{ bottom: document.querySelector('.bots-head').getBoundingClientRect().bottom }, { top: document.querySelector('.bots-messages').getBoundingClientRect().top }]`);
    // The conversation's scrolling area starts where the bar ends, so nothing readable sits under it.
    expect(messages.top).toBeGreaterThanOrEqual(head.bottom - 0.5);
    await hover(page);
    const moving = await page.eval<string[]>(`${PILL}.getAnimations({ subtree: true }).filter((a) => a instanceof CSSTransition && !a.effect.target.closest('.bot')).map((a) => a.transitionProperty)`);
    for (const property of moving) expect(["grid-template-columns", "transform", "filter", "width", "padding-right", "backdrop-filter"]).not.toContain(property);
    const blur = await page.eval<string>(`getComputedStyle(${PILL}).backdropFilter`);
    expect(blur).toBe("none");
  }, 20_000);

  test("reached by keyboard, Enter opens the details", async () => {
    const page = await open("dark");
    for (let i = 0; i < 40 && !(await page.eval<boolean>(`document.activeElement === ${PILL}`)); i++) {
      for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    }
    expect(await page.eval<boolean>(`document.activeElement === ${PILL} && ${PILL}.matches(':focus-visible')`)).toBe(true);
    await page.settle();
    expectShown(await pill(page));
    for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" && { text: "\r" }) });
    await page.settle();
    expect(await page.eval<boolean>("bots.getState().detailsOpen")).toBe(true);
  }, 20_000);

  test("a click toggles the details, and the pill says so", async () => {
    const page = await open("light");
    await page.click(".bots-head-pill");
    expect(await page.eval<boolean>("bots.getState().detailsOpen")).toBe(true);
    expect(await page.eval<string | null>(`${PILL}.getAttribute('aria-expanded')`)).toBe("true");
    await leave(page);
    await page.settle();
    await done(page);
    expectShown(await pill(page));
    await page.click(".bots-head-pill");
    expect(await page.eval<boolean>("bots.getState().detailsOpen")).toBe(false);
  }, 20_000);

  test("on a touch screen the name and chevron show too", async () => {
    const page = await open("dark", (p) => p.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }));
    expect(await page.eval<boolean>("matchMedia('(hover: none) and (pointer: coarse)').matches")).toBe(true);
    expectShown(await pill(page));
  }, 20_000);

  test("a bot's own chat shows its one mascot, and a long name ends in an ellipsis inside the pill, chevron and all", async () => {
    const page = await open("dark");
    await page.eval(`bots.getState().select("dm")`);
    await page.until(`!!document.querySelector('.bots-head-pill .bot') && document.querySelector('.bots-head-name').textContent === 'Dr Eggbot'`);
    await page.settle();
    expect((await pill(page)).bots).toHaveLength(1);
    await page.eval(`bots.getState().select("dev")`);
    await page.eval(`bots.setState((s) => ({ conversations: s.conversations.map((c) => c.id === "dev" ? { ...c, name: "A group with a name far too long to fit in the header pill at all" } : c) }))`);
    await page.settle();
    const p = await pill(page);
    // Its max-width: min(480px, the pane less room either side).
    expect(p.width).toBeLessThanOrEqual(480.5);
    expect(p.nameClipped).toBe(true);
    expect(p.chevron?.inside).toBe(true);
  }, 20_000);
});

describe.skipIf(!browser)("the sidebar's hover card", () => {
  /** Hovers the collapsed rail's avatar for `name`, and reads the card that comes up beside it. */
  const peek = async (page: Page, name: string) => {
    const item = `document.querySelector('.bots-rail-item[aria-label="${name}"]')`;
    await page.eval("bots.getState().select('dm')");
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 700 });
    await page.until(`!document.querySelector('.bots-peek')`);
    const [x, y] = await page.eval<[number, number]>(`(() => { const r = (${item}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await page.until(`!!document.querySelector('.bots-peek[data-state="open"] .bot') && document.querySelector('.bots-peek-name').textContent === ${JSON.stringify(name)}`);
    return page.eval<{ huddles: number; bots: { left: number; right: number; top: number }[]; count: string | null; railHuddles: number; railCount: string | null }>(`(() => {
      const head = document.querySelector('.bots-peek .bots-peek-head'), rail = ${item};
      return {
        huddles: head.querySelectorAll('.bot-huddle').length,
        bots: [...head.querySelectorAll('.bot')].map((b) => { const r = b.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top }; }),
        count: head.querySelector('.bot-lineup-more')?.textContent ?? null,
        railHuddles: rail.querySelectorAll('.bot-huddle').length,
        railCount: rail.querySelector('.bot-huddle-more')?.textContent ?? null,
      };
    })()`);
  };

  for (const theme of ["light", "dark"] as const) {
    test(`lines a group's bots up side by side, counting the same hidden bots as its own avatar (${theme})`, async () => {
      const page = await open(theme);
      // The collapsed sidebar's rail, where the card shows over a group's avatar, once it has folded away.
      await page.eval("store.setState({ botsSidebarOpen: false })");
      await page.until(`!!document.querySelector('.bots-rail-item[aria-label="Everyone"] .bot')`);
      await page.settle();
      await page.eval(`Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {}))).then(() => true)`);

      for (const [name, shown, count] of [["OpenBuild Dev", 4, null], ["Everyone", 3, "+3"]] as const) {
        const card = await peek(page, name);
        expect(card.huddles).toBe(0);
        expect(card.bots).toHaveLength(shown);
        for (let i = 1; i < card.bots.length; i++) {
          expect(card.bots[i]!.left).toBeGreaterThanOrEqual(card.bots[i - 1]!.right - 0.5);
          expect(Math.abs(card.bots[i]!.top - card.bots[0]!.top)).toBeLessThan(1);
        }
        // The avatar in the rail is still a huddle, and its count of the hidden bots is the card's.
        expect(card.railHuddles).toBe(1);
        expect({ name, count: card.count }).toEqual({ name, count });
        expect({ name, count: card.railCount }).toEqual({ name, count });
      }
    }, 30_000);
  }

  test("the chat's header counts the same hidden bots as the sidebar", async () => {
    const page = await open("dark");
    await page.eval("bots.getState().select('crowd')");
    await page.until(`document.querySelector('.bots-head-name')?.textContent === 'Everyone'`);
    const [head, tile] = await page.eval<[string | null, string | null]>(`[document.querySelector('.bots-head-pill .bot-lineup-more')?.textContent ?? null, [...document.querySelectorAll('.bots-tile')].find((t) => t.textContent.includes('Everyone')).querySelector('.bot-huddle-more')?.textContent ?? null]`);
    expect(head).toBe("+3");
    expect(tile).toBe(head);
  });
});
