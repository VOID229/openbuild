// Reactions in a real Chrome: the mascots of the bots that reacted sit inside the emoji's pill, side
// by side after its count, never piled on each other; and a bot's reaction can be answered with the
// user's own from a tiny button beside it.
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

type Box = { left: number; right: number; top: number; bottom: number };
const box = (expr: string) => `(() => { const r = (${expr}).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`;
const overlap = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
/** The chip in message `id` with `emoji`, its button, pill, mascots and reply button. */
const chip = (id: string, emoji: string) => `[...document.querySelectorAll('[data-id="${id}"] .bm-reaction-link')].find((l) => l.querySelector('.bm-reaction-emoji').textContent === "${emoji}")`;

/**
 * Group chat "b" with four bots in it: the last message (from manager) has a 👍 from all four bots
 * and the user, and a 🔥 from helper alone; the one before it a ❤️ from the user alone.
 */
const open = async (theme: "dark" | "light" = "dark") => {
  const page = await Page.open(chrome!.ws, server!.url.href, 1000, 700, "!!document.querySelector('.bots-messages')");
  await page.eval(`document.documentElement.dataset.theme = "${theme}"`);
  await page.eval(`(() => {
    const s = bots.getState();
    const bot = (id, color) => ({ id, name: id, look: { shape: "ghost", color }, instructions: "", memory: [], routines: [], createdAt: 1 });
    const thumbs = ["manager", "helper", "scout", "sage", "me"].map((by, i) => ({ id: "t" + i, emoji: "👍", by, at: i + 1 }));
    bots.setState({
      activeId: "b",
      bots: [...s.bots, bot("scout", "green"), bot("sage", "purple")],
      conversations: s.conversations.map((c) => c.id !== "b" ? c : { ...c, botIds: [...c.botIds, "scout", "sage"], messages: c.messages.map((m) =>
        m.id === "b-59" ? { ...m, reactions: [...thumbs, { id: "f", emoji: "🔥", by: "helper", at: 9 }] } :
        m.id === "b-58" ? { ...m, reactions: [{ id: "h", emoji: "❤️", by: "me", at: 1 }] } : m) }),
    });
  })()`);
  await page.until(`!!document.querySelector('[data-id="b-59"] .bm-reaction-mascots')`);
  await page.eval(`document.querySelector('.bots-messages').scrollTop = 1e6`);
  // Past the chips' pop-in.
  await page.finish('.bots-messages');
  return page;
};

describe.skipIf(!browser)("reactions from bots", () => {
  test("show the reacting mascots inside the pill, side by side after the count, at most three", async () => {
    const page = await open();
    const thumbs = chip("b-59", "👍");
    // The pill reads as the emoji and the count; the mascots inside it have no text of their own.
    expect(await page.eval<unknown>(`${thumbs}.querySelector('.bm-reaction-pill').textContent`)).toBe("👍5");
    expect(await page.eval<unknown>(`${thumbs}.querySelectorAll('.bm-reaction-pill .bm-reaction-mascots .bot').length`)).toBe(3);
    const pill = await page.eval<Box>(box(`${thumbs}.querySelector('.bm-reaction-pill')`));
    const count = await page.eval<Box>(box(`${thumbs}.querySelector('.bm-reaction-count')`));
    const mascots = await page.eval<Box[]>(`[...${thumbs}.querySelectorAll('.bm-reaction-mascots .bot')].map((b) => ${box("b")})`);
    // Inside the pill, after the count, centred on it.
    for (const m of mascots) {
      expect(m.left).toBeGreaterThanOrEqual(count.right);
      expect(m.right).toBeLessThanOrEqual(pill.right);
      expect(m.top).toBeGreaterThanOrEqual(pill.top);
      expect(m.bottom).toBeLessThanOrEqual(pill.bottom);
      expect(Math.abs((m.top + m.bottom) / 2 - (pill.top + pill.bottom) / 2)).toBeLessThanOrEqual(1);
    }
    // One row, each clear of the one before rather than piled on it.
    for (let i = 1; i < mascots.length; i++) {
      expect(mascots[i]!.top).toBe(mascots[0]!.top);
      expect(mascots[i]!.left).toBeGreaterThanOrEqual(mascots[i - 1]!.right);
    }
    // A user's reaction alone has none.
    expect(await page.eval<unknown>(`${chip("b-58", "❤️")}.querySelector('.bm-reaction-mascots')`)).toBeNull();
  }, 60_000);

  test("keep each chip, its mascots and its reply button clear of the other chips and the next message", async () => {
    const page = await open();
    // Per chip: its pill, its mascots and its reply button.
    const chips = await page.eval<{ pill: Box; mascots: Box[]; reply: Box }[]>(`[...document.querySelectorAll('[data-id="b-59"] .bm-reaction-link')].map((l) => ({
      pill: ${box("l.querySelector('.bm-reaction-pill')")},
      mascots: [...l.querySelectorAll('.bm-reaction-mascots .bot')].map((b) => ${box("b")}),
      reply: ${box("l.querySelector('.bm-reaction-reply')")},
    }))`);
    expect(chips.length).toBe(2);
    for (const [i, c] of chips.entries()) {
      for (const m of c.mascots) expect(overlap(c.reply, m)).toBe(false);
      expect(overlap(c.reply, c.pill)).toBe(false);
      for (const [j, o] of chips.entries()) if (i !== j) for (const a of [o.pill, o.reply, ...o.mascots]) for (const b of [c.pill, c.reply, ...c.mascots]) expect(overlap(a, b)).toBe(false);
    }
    const all = chips.flatMap((c) => [c.reply, ...c.mascots]);
    const row = await page.eval<Box>(box(`document.querySelector('[data-id="b-59"]')`));
    const lowest = Math.max(...all.map((a) => a.bottom));
    expect(lowest).toBeLessThanOrEqual(row.bottom);
    // The message before has its own reactions' room too: its last mascot ends above the next row.
    const before = await page.eval<number>(`document.querySelector('[data-id="b-58"]').getBoundingClientRect().bottom`);
    const next = await page.eval<number>(`document.querySelector('[data-id="b-59"]').getBoundingClientRect().top`);
    expect(before).toBeLessThanOrEqual(next);
  }, 60_000);

  test("clicking a mascot toggles the reaction, and the chip names who reacted", async () => {
    const page = await open();
    const fire = chip("b-59", "🔥");
    expect(await page.eval<unknown>(`${fire}.querySelector('.bm-reaction').dataset.tooltip`)).toBe("helper");
    // The mascot is part of the button: the pointer is a hand over it and a click there is the chip's.
    expect(await page.eval<unknown>(`(() => { const r = ${fire}.querySelector('.bm-reaction-mascots .bot').getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2).closest('.bm-reaction') === ${fire}.querySelector('.bm-reaction'); })()`)).toBe(true);
    await page.click(`[data-id="b-59"] .bm-reaction-thread:nth-child(2) > .bm-reaction-link:first-child .bm-reaction-mascots .bot`);
    const mine = `bots.getState().conversations.find((c) => c.id === "b").messages.find((m) => m.id === "b-59").reactions.some((r) => r.by === "me" && r.emoji === "🔥" && !r.to)`;
    await page.until(mine);
    expect(await page.eval<unknown>(`${fire}.querySelector('.bm-reaction-pill').textContent`)).toBe("🔥2");
    await page.click(`[data-id="b-59"] .bm-reaction-thread:nth-child(2) > .bm-reaction-link:first-child .bm-reaction-mascots .bot`);
    await page.until(`!${mine}`);
  }, 60_000);

  test("keep the mascots clear of the emoji and the count, in light and dark", async () => {
    for (const theme of ["dark", "light"] as const) {
      const page = await open(theme);
      for (const emoji of ["👍", "🔥"]) {
        const parts = await page.eval<Box[]>(`[...${chip("b-59", emoji)}.querySelectorAll('.bm-reaction-emoji, .bm-reaction-count')].map((e) => ${box("e")})`);
        const mascots = await page.eval<Box[]>(`[...${chip("b-59", emoji)}.querySelectorAll('.bm-reaction-mascots .bot')].map((b) => ${box("b")})`);
        expect(mascots.length).toBeGreaterThan(0);
        for (const m of mascots) for (const p of parts) expect(overlap(m, p)).toBe(false);
      }
    }
  }, 60_000);

  test("don't pop in or grow on hover with reduced motion", async () => {
    const page = await open();
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await page.settle();
    expect(await page.eval<unknown>(`getComputedStyle(document.querySelector('.bm-reaction')).animationName`)).toBe("none");
    // Headless Chrome has no hover to try it with: a hovered chip only changes colour, and any rule that
    // would grow or move it asks for motion first.
    const hovers = await page.eval<{ media: string; moves: boolean }[]>(`[...document.styleSheets].flatMap((s) => [...s.cssRules]).filter((r) => r.cssText.includes(".bm-reaction:hover")).map((r) => ({ media: r.conditionText ?? "", moves: /transform|scale|translate/.test(r.cssText) }))`);
    expect(hovers.length).toBeGreaterThan(0);
    for (const { media, moves } of hovers) if (moves) expect(media).toContain("prefers-reduced-motion: no-preference");
  }, 60_000);
});

describe.skipIf(!browser)("answering a bot's reaction", () => {
  test("a tiny button on a bot's reaction opens the picker, and the answer hangs off it with an arrow", async () => {
    const page = await open();
    // Bots' reactions have one, the user's own don't.
    expect(await page.eval<unknown>(`document.querySelectorAll('[data-id="b-59"] .bm-reaction-reply').length`)).toBe(2);
    expect(await page.eval<unknown>(`!!document.querySelector('[data-id="b-58"] .bm-reaction-reply')`)).toBe(false);
    const reply = `${chip("b-59", "🔥")}.querySelector('.bm-reaction-reply')`;
    expect(await page.eval<unknown>(`${reply}.getAttribute('aria-label')`)).toBe("React to helper's 🔥");
    // Tiny, and beside the pill rather than on it or its mascots.
    const r = await page.eval<Box>(box(reply));
    expect(r.right - r.left).toBeLessThanOrEqual(16);
    expect(r.left).toBeGreaterThanOrEqual(await page.eval<number>(`${chip("b-59", "🔥")}.querySelector('.bm-reaction-pill').getBoundingClientRect().right`));
    // Touch screens have no hover: it's always there to tap.
    expect(await page.eval<unknown>(`matchMedia("(hover: none)").matches && getComputedStyle(${reply}).opacity`)).toBe("1");

    await page.click(`[data-id="b-59"] .bm-reaction-thread:nth-child(2) > .bm-reaction-link:first-child .bm-reaction-reply`);
    await page.until(`!!document.querySelector('.bm-react-pop .bm-react-btn')`);
    await page.click(`.bm-react-pop .bm-react-btn`);
    const answer = `bots.getState().conversations.find((c) => c.id === "b").messages.find((m) => m.id === "b-59").reactions.find((r) => r.by === "me" && r.to === "f")`;
    await page.until(`!!${answer}`);
    // Not a reaction on the message itself, which the picker would mark as picked.
    expect(await page.eval<unknown>(`bots.getState().conversations.find((c) => c.id === "b").messages.find((m) => m.id === "b-59").reactions.filter((r) => r.by === "me" && !r.to).map((r) => r.emoji)`)).toEqual(["👍"]);
    await page.until(`!document.querySelector('.bm-react-pop .bm-react-btn')`);
    // Shown after the 🔥 it answers, hooked back to it, with no button of its own: it's the user's.
    const thread = await page.eval<string[]>(`[...document.querySelectorAll('[data-id="b-59"] .bm-reaction-thread')[1].children].map((l) => (l.querySelector('.bm-reaction-arrow') ? "→" : "") + l.querySelector('.bm-reaction-emoji').textContent + (l.querySelector('.bm-reaction-reply') ? "+" : ""))`);
    expect(thread).toEqual(["🔥+", `→${await page.eval<string>(`${answer}.emoji`)}`]);

    // Opening it again marks the answer as picked, and picking it again takes it back.
    await page.click(`[data-id="b-59"] .bm-reaction-thread:nth-child(2) > .bm-reaction-link:first-child .bm-reaction-reply`);
    await page.until(`!!document.querySelector('.bm-react-pop .bm-react-btn-on')`);
    await page.click(`.bm-react-pop .bm-react-btn-on`);
    await page.until(`!${answer}`);
  }, 60_000);
});
