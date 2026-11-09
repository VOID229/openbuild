// The chat's header pill, in a real Chrome and in both themes: at rest just the bots, one by one in a
// row, with the name and chevron tucked away; hovered or reached by keyboard, it widens smoothly to
// show them, and a click still opens the details. A touch screen keeps it open, as do the details,
// and with reduced motion it opens at once.
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

type Pill = { width: number; height: number; reveal: number; opacity: number; nameClipped: boolean; nameInside: boolean; chevron: { width: number; inside: boolean } | null; bots: { left: number; right: number; top: number; bottom: number }[]; huddles: number; bg: string; text: string };
const pill = (page: Page) =>
  page.eval<Pill>(`(() => {
    const p = ${PILL}, r = p.getBoundingClientRect();
    const inside = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.left >= r.left && b.right <= r.right; };
    const name = p.querySelector('.bots-head-name'), chev = p.querySelector('.bots-head-chevron');
    const shown = p.querySelector('.bots-head-reveal-clip').getBoundingClientRect(), chevClip = chev?.closest('.bots-head-reveal-clip').getBoundingClientRect();
    return {
      width: r.width, height: r.height, reveal: shown.width,
      opacity: Number(getComputedStyle(p.querySelector('.bots-head-reveal-body')).opacity),
      nameClipped: name.scrollWidth > name.clientWidth + 0.5 || name.getBoundingClientRect().right > shown.right - 9.5,
      nameInside: inside(name),
      chevron: chev && { width: chev.getBoundingClientRect().width, inside: inside(chev) && chev.getBoundingClientRect().right <= chevClip.right + 0.5 },
      bots: [...p.querySelectorAll('.bot')].map((b) => { const x = b.getBoundingClientRect(); return { left: x.left, right: x.right, top: x.top, bottom: x.bottom }; }),
      huddles: p.querySelectorAll('.bot-huddle').length,
      bg: getComputedStyle(p).backgroundColor, text: getComputedStyle(name).color,
    };
  })()`);

const center = (page: Page) => page.eval<[number, number]>(`(() => { const r = ${PILL}.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
const hover = async (page: Page) => {
  const [x, y] = await center(page);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
};
const leave = (page: Page) => page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 700 });

/** Collapsed: only the bots show, nothing of the name or chevron. */
const expectRest = (p: Pill) => {
  expect(p.reveal).toBeLessThan(0.5);
  expect(p.opacity).toBe(0);
  expect(p.nameInside).toBe(false);
};
/** Open: the whole name and the chevron inside the pill. */
const expectOpen = (p: Pill, chevron = true) => {
  expect(p.opacity).toBe(1);
  expect(p.nameInside).toBe(true);
  expect(p.nameClipped).toBe(false);
  if (chevron) expect(p.chevron?.inside).toBe(true);
};

describe.skipIf(!browser)("the chat's header pill", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`at rest, the group's bots one by one in a row and no name; hovered, the name and a chevron (${theme})`, async () => {
      const page = await open(theme);
      const rest = await pill(page);
      expectRest(rest);
      // Each member its own mascot, side by side on one line, not a huddle.
      expect(rest.huddles).toBe(0);
      expect(rest.bots).toHaveLength(4);
      for (let i = 1; i < rest.bots.length; i++) {
        expect(rest.bots[i]!.left).toBeGreaterThanOrEqual(rest.bots[i - 1]!.right - 0.5);
        expect(Math.abs(rest.bots[i]!.top - rest.bots[0]!.top)).toBeLessThan(1);
      }
      expect(rest.height).toBeLessThanOrEqual(36);
      // Readable in this theme.
      expect(rest.text).not.toBe(rest.bg);

      await hover(page);
      await done(page);
      const opened = await pill(page);
      expectOpen(opened);
      expect(opened.width).toBeGreaterThan(rest.width + 60);
      expect(opened.height).toBe(rest.height);
      // The bots stay put relative to each other.
      expect(opened.bots.map((b) => Math.round(b.right - b.left))).toEqual(rest.bots.map((b) => Math.round(b.right - b.left)));

      await leave(page);
      await done(page);
      expectRest(await pill(page));
    }, 20_000);
  }

  test("it widens smoothly, frame by frame, rather than jumping", async () => {
    const page = await open("dark");
    const start = (await pill(page)).width;
    await hover(page);
    const widths = await page.eval<number[]>(`new Promise((resolve) => {
      const seen = [], p = ${PILL}, t0 = performance.now();
      const tick = () => { seen.push(p.getBoundingClientRect().width); performance.now() - t0 < 600 ? requestAnimationFrame(tick) : resolve(seen); };
      requestAnimationFrame(tick);
    })`);
    const end = widths.at(-1)!;
    expect(end).toBeGreaterThan(start + 60);
    // Many steps in between, each no narrower than the last.
    expect(new Set(widths.filter((w) => w > start + 1 && w < end - 1).map(Math.round)).size).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThanOrEqual(widths[i - 1]! - 0.5);
    const eased = await page.eval<boolean>(`getComputedStyle(document.querySelector('.bots-head-reveal')).transitionProperty.includes('grid-template-columns')`);
    expect(eased).toBe(true);
  }, 20_000);

  test("reached by keyboard it opens, and Enter still opens the details", async () => {
    const page = await open("dark");
    for (let i = 0; i < 40 && !(await page.eval<boolean>(`document.activeElement === ${PILL}`)); i++) {
      for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    }
    expect(await page.eval<boolean>(`document.activeElement === ${PILL} && ${PILL}.matches(':focus-visible')`)).toBe(true);
    await page.settle();
    await done(page);
    expectOpen(await pill(page));
    for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" && { text: "\r" }) });
    await page.settle();
    expect(await page.eval<boolean>("bots.getState().detailsOpen")).toBe(true);
  }, 20_000);

  test("a click still toggles the details, and while they're open it stays wide", async () => {
    const page = await open("light");
    await page.click(".bots-head-pill");
    expect(await page.eval<boolean>("bots.getState().detailsOpen")).toBe(true);
    await leave(page);
    await page.settle();
    await done(page);
    const opened = await pill(page);
    expectOpen(opened);
    await page.click(".bots-head-pill");
    expect(await page.eval<boolean>("bots.getState().detailsOpen")).toBe(false);
  }, 20_000);

  test("on a touch screen, with no hover, the name and chevron stay out", async () => {
    const page = await open("dark", (p) => p.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }));
    expect(await page.eval<boolean>("matchMedia('(hover: none) and (pointer: coarse)').matches")).toBe(true);
    expectOpen(await pill(page));
  }, 20_000);

  test("with reduced motion it opens at once, without sliding", async () => {
    const page = await open("dark", (p) => p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }));
    await hover(page);
    await page.settle();
    // Laid out wide straight away: nothing grows, slides or blurs, the words only fade.
    const moving = await page.eval<string[]>(`${PILL}.getAnimations({ subtree: true }).filter((a) => a instanceof CSSTransition && !a.effect.target.closest('.bot')).map((a) => a.transitionProperty)`);
    for (const property of moving) expect(["grid-template-columns", "transform", "filter", "width", "padding-right"]).not.toContain(property);
    expect((await pill(page)).reveal).toBeGreaterThan(60);
    await done(page);
    expectOpen(await pill(page));
  }, 20_000);

  test("a bot's own chat shows its one mascot, and a long name fades out inside the pill, chevron and all", async () => {
    const page = await open("dark");
    await page.eval(`bots.getState().select("dm")`);
    await page.until(`!!document.querySelector('.bots-head-pill .bot') && document.querySelector('.bots-head-name').textContent === 'Dr Eggbot'`);
    await page.settle();
    expect((await pill(page)).bots).toHaveLength(1);
    await page.eval(`bots.getState().select("dev")`);
    await page.eval(`bots.setState((s) => ({ conversations: s.conversations.map((c) => c.id === "dev" ? { ...c, name: "A group with a name far too long to fit in the header pill at all" } : c) }))`);
    await page.settle();
    await hover(page);
    await done(page);
    const [p, clipped] = await page.eval<[number, boolean]>(`(() => { const p = ${PILL}, c = p.querySelector('.bots-head-reveal-clip'); return [p.getBoundingClientRect().width, c.scrollWidth > c.clientWidth]; })()`);
    // Its max-width: min(420px, the pane less room either side).
    expect(p).toBeLessThanOrEqual(420.5);
    expect(clipped).toBe(true);
    expect((await pill(page)).chevron?.inside).toBe(true);
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
