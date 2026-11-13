// What hangs under a bubble, in a real Chrome: its reactions start at the bubble's own left edge, on
// the user's bubbles too, and "Seen by" shares their line at the bubble's right edge. With many
// reactions, emoji and viewers, on a desktop and a phone, nothing piles up, overlaps or runs off;
// and reacting, or taking a reaction back, never changes a message's size or moves the chat.
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
const overlap = (a: Box, b: Box) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const middle = (b: Box) => (b.top + b.bottom) / 2;

const BOTS = ["pip", "bolt", "plum", "star", "moss", "rosa", "fern", "kit"];

/**
 * Group chat "b" with eight more bots. b-58 is the user's last message, so it shows "Seen by"; b-59
 * is manager's. `mine` and `theirs` replace their text and reactions; `seen` is who saw b-58.
 */
interface Setup {
  width?: number;
  height?: number;
  mine?: { text: string; reactions: [emoji: string, by: string[]][] };
  theirs?: { text: string; reactions: [emoji: string, by: string[]][] };
  seen?: string[];
}

const open = async ({ width = 1000, height = 760, mine, theirs, seen = [] }: Setup) => {
  const page = await Page.open(chrome!.ws, server!.url.href, width, height, "!!document.querySelector('.bots-messages')");
  await page.eval(`(() => {
    const s = bots.getState();
    const shapes = ["cloud", "teardrop", "blob", "star", "clover", "heart", "square", "flower"];
    const colors = ["white", "blue", "purple", "orange", "green", "pink", "teal", "amber"];
    const extra = ${JSON.stringify(BOTS)}.map((id, i) => ({ id, name: id, look: { shape: shapes[i], color: colors[i] }, instructions: "", memory: [], routines: [], createdAt: 1 }));
    const reactions = (list) => list.flatMap(([emoji, by], i) => by.map((who, j) => ({ id: emoji + who, emoji, by: who, at: i * 10 + j + 1 })));
    const mine = ${JSON.stringify(mine ?? null)};
    const theirs = ${JSON.stringify(theirs ?? null)};
    bots.setState({
      activeId: "b",
      bots: [...s.bots, ...extra],
      conversations: s.conversations.map((c) => c.id !== "b" ? c : { ...c, botIds: [...c.botIds, ...extra.map((b) => b.id)], messages: c.messages.map((m) =>
        m.id === "b-58" ? { ...m, ...(mine && { text: mine.text, reactions: reactions(mine.reactions) }), seenBy: ${JSON.stringify(seen)} } :
        m.id === "b-59" ? { ...m, ...(theirs && { text: theirs.text, reactions: reactions(theirs.reactions) }) } : m) }),
    });
  })()`);
  await page.until(`!!document.querySelector('[data-id="b-58"] :is(.bm-seen, .bm-reaction)')`);
  await page.eval(`document.querySelector('.bots-messages').scrollTop = 1e6`);
  // Past the chips' pop-in.
  await page.finish(".bots-messages");
  return page;
};

/** Where everything under message `id` sits. */
const measure = (page: Page, id: string) =>
  page.eval<{ bubble: Box; foot: Box; reactions: Box | null; seen: Box | null; chips: Box[]; mascots: Box[]; replies: Box[]; seenMascots: Box[]; row: Box; pane: Box }>(`(() => {
    const row = document.querySelector('[data-id="${id}"]');
    const one = (sel) => { const e = row.querySelector(sel); return e ? ${box("e")} : null; };
    const all = (sel) => [...row.querySelectorAll(sel)].map((e) => ${box("e")});
    return {
      bubble: one('.bm-bubble'), foot: one('.bm-foot') ?? one('.bm-reactions'), reactions: one('.bm-reactions'), seen: one('.bm-seen'),
      chips: all('.bm-reaction-pill'), mascots: all('.bm-reaction-mascots .bot'), replies: all('.bm-reaction-reply'),
      seenMascots: all('.bm-seen-mascots .bot'), row: ${box("row")},
      pane: ${box("document.querySelector('.bots-messages')")},
    };
  })()`);

/** The part of `b` the reactions' strip shows, if any: chips scrolled out of it are out of sight. */
const shown = (b: Box, strip: Box | null): Box | null => {
  if (!strip) return b;
  const c = { ...b, left: Math.max(b.left, strip.left), right: Math.min(b.right, strip.right) };
  return c.right - c.left > 0.5 ? c : null;
};

/** Nothing under the bubble overlaps anything else there, and what shows stays inside the pane. */
const tidy = (m: Awaited<ReturnType<typeof measure>>) => {
  const inStrip = (list: Box[]) => list.map((b) => shown(b, m.reactions)).filter((b): b is Box => !!b);
  const parts = [...inStrip(m.chips), ...inStrip(m.replies), ...(m.seen ? [m.seen] : [])];
  for (const [i, a] of parts.entries()) for (const b of parts.slice(i + 1)) expect(overlap(a, b)).toBe(false);
  // Under the bubble, never over it.
  for (const p of parts) expect(p.top).toBeGreaterThanOrEqual(m.bubble.bottom);
  for (const p of [...parts, m.bubble]) {
    expect(p.left).toBeGreaterThanOrEqual(m.pane.left);
    expect(p.right).toBeLessThanOrEqual(m.pane.right);
    expect(p.bottom).toBeLessThanOrEqual(m.row.bottom + 0.5);
  }
  // Each mascot inside its own chip, side by side with the others.
  for (const mascot of m.mascots) expect(m.chips.some((c) => mascot.left >= c.left && mascot.right <= c.right && mascot.top >= c.top && mascot.bottom <= c.bottom)).toBe(true);
  for (const [i, a] of m.mascots.entries()) for (const b of m.mascots.slice(i + 1)) expect(overlap(a, b)).toBe(false);
  for (const [i, a] of m.seenMascots.entries()) for (const b of m.seenMascots.slice(i + 1)) expect(overlap(a, b)).toBe(false);
};

describe.skipIf(!browser)("under the user's bubble", () => {
  test("reactions start at the bubble's left edge, with \"Seen by\" on the same line at its right", async () => {
    const page = await open({
      mine: { text: "@all react on this message if ur up, and say if the canary looks right to you", reactions: [["👍", ["pip", "bolt", "plum", "star"]]] },
      seen: ["pip", "plum", "star", "bolt"],
    });
    const m = await measure(page, "b-58");
    expect(m.chips.length).toBe(1);
    expect(m.seen).not.toBeNull();
    // Lined up with the bubble's left edge, a few pixels in, not with its right.
    expect(m.reactions!.left - m.bubble.left).toBeGreaterThanOrEqual(0);
    expect(m.reactions!.left - m.bubble.left).toBeLessThanOrEqual(8);
    expect(m.seen!.right).toBeLessThanOrEqual(m.bubble.right);
    expect(m.bubble.right - m.seen!.right).toBeLessThanOrEqual(8);
    // One line: "Seen by" sits beside the chip rather than in a row of its own below it.
    expect(Math.abs(middle(m.seen!) - middle(m.chips[0]!))).toBeLessThanOrEqual(2);
    expect(m.seen!.left).toBeGreaterThan(m.chips[0]!.right);
    // Every reactor shows, inside the chip, none piled on another.
    expect(m.mascots.length).toBe(3);
    expect(m.seenMascots.length).toBe(4);
    tidy(m);
  }, 60_000);

  test("a short bubble's line grows leftwards past it, still ending at its right edge", async () => {
    const page = await open({
      mine: { text: "ok", reactions: [["👍", ["pip", "bolt", "plum", "star", "moss"]], ["😂", ["rosa"]], ["🔥", ["pip"]], ["❤️", ["me"]]] },
      seen: BOTS,
    });
    const m = await measure(page, "b-58");
    expect(m.chips.length).toBe(4);
    // Wider than the bubble, and right-aligned with it: the reactions start further left.
    expect(m.foot.right - m.foot.left).toBeGreaterThan(m.bubble.right - m.bubble.left);
    expect(Math.abs(m.foot.right - (m.bubble.right - 6))).toBeLessThanOrEqual(1);
    expect(m.reactions!.left).toBeLessThan(m.bubble.left);
    expect(m.seen!.right).toBeLessThanOrEqual(m.bubble.right);
    // Many viewers: a few mascots and how many more.
    expect(m.seenMascots.length).toBe(5);
    expect(await page.eval<unknown>(`document.querySelector('[data-id="b-58"] .bm-seen-more').textContent`)).toBe("+3");
    expect(await page.eval<unknown>(`document.querySelector('[data-id="b-58"] .bm-seen').dataset.tooltip`)).toBe(BOTS.join(", "));
    tidy(m);
  }, 60_000);

  test("on a phone, too many to fit scroll sideways in one line, with \"Seen by\" kept at the right", async () => {
    const page = await open({
      width: 390,
      height: 760,
      mine: { text: "ok", reactions: [["👍", ["pip", "bolt", "plum", "star", "moss"]], ["😂", ["rosa"]], ["🔥", ["pip"]], ["❤️", ["me"]], ["🚀", ["moss"]], ["👀", ["kit", "fern"]]] },
      seen: BOTS,
    });
    const m = await measure(page, "b-58");
    expect(m.chips.length).toBe(6);
    // One line, never wrapped: the chips and "Seen by" share it, "Seen by" at the bubble's right.
    expect(new Set(m.chips.map((c) => Math.round(c.top))).size).toBe(1);
    expect(Math.abs(middle(m.seen!) - middle(m.chips[0]!))).toBeLessThanOrEqual(2);
    expect(m.bubble.right - m.seen!.right).toBeLessThanOrEqual(8);
    expect(m.seen!.right).toBeLessThanOrEqual(m.bubble.right);
    tidy(m);
    expect(await page.eval<unknown>(`(() => { const p = document.querySelector('.bots-messages'); return p.scrollWidth <= p.clientWidth; })()`)).toBe(true);
    // The rest are a sideways scroll away, faded at the edge they're hidden past, and the last one comes into view.
    const strip = `document.querySelector('[data-id="b-58"] .bm-reactions')`;
    expect(await page.eval<unknown>(`${strip}.scrollWidth > ${strip}.clientWidth`)).toBe(true);
    const fades = () => page.eval<string[]>(`["--bm-fade-start", "--bm-fade-end"].map((p) => getComputedStyle(${strip}).getPropertyValue(p))`);
    expect(await fades()).toEqual(["0px", "24px"]);
    await page.eval(`${strip}.scrollLeft = 1e6`);
    await page.settle();
    expect(await fades()).toEqual(["24px", "0px"]);
    const last = await page.eval<Box>(box(`[...document.querySelectorAll('[data-id="b-58"] .bm-reaction-pill')].at(-1)`));
    const end = await measure(page, "b-58");
    expect(last.left).toBeGreaterThanOrEqual(end.reactions!.left);
    expect(last.right).toBeLessThanOrEqual(end.reactions!.right);
    tidy(end);
  }, 60_000);

  test("\"Seen\" alone, with no reactions, still sits at the bubble's right", async () => {
    const page = await open({ seen: ["pip"] });
    const m = await measure(page, "b-58");
    expect(m.reactions).toBeNull();
    expect(m.bubble.right - m.seen!.right).toBeLessThanOrEqual(8);
    expect(m.seen!.right).toBeLessThanOrEqual(m.bubble.right);
    expect(m.seen!.top).toBeGreaterThanOrEqual(m.bubble.bottom);
  }, 60_000);
});

describe.skipIf(!browser)("under a bot's bubble", () => {
  test("reactions start at the bubble's left edge, on a desktop and a phone", async () => {
    for (const width of [1000, 390]) {
      const page = await open({
        width,
        theirs: { text: "Morning! I pushed the fix for the flaky upload test.", reactions: [["🎉", ["pip", "bolt", "plum", "star", "moss", "me"]], ["🔥", ["bolt"]], ["👀", ["star"]]] },
        seen: ["pip"],
      });
      const m = await measure(page, "b-59");
      expect(m.chips.length).toBe(3);
      expect(m.reactions!.left - m.bubble.left).toBeGreaterThanOrEqual(0);
      expect(m.reactions!.left - m.bubble.left).toBeLessThanOrEqual(8);
      // A bot's message is never "seen".
      expect(m.seen).toBeNull();
      // Three of the five bots behind 🎉, and the count says six.
      expect(await page.eval<unknown>(`document.querySelector('[data-id="b-59"] .bm-reaction-pill').textContent`)).toBe("🎉6");
      expect(m.mascots.length).toBe(5);
      tidy(m);
    }
  }, 60_000);
});

describe.skipIf(!browser)("with a mouse", () => {
  test("the hover actions float beside the bubble, so the reactions still start at its left edge", async () => {
    for (const width of [1000, 620]) {
      const page = await open({
        width,
        mine: { text: "Thanks all, merging the canary first. Let me know if anything looks off in the dashboards over the next hour.", reactions: [["👍", ["pip", "bolt"]], ["✅", ["star"]]] },
        theirs: { text: "Morning! I pushed the fix for the flaky upload test.", reactions: [["🎉", ["pip", "bolt", "plum"]], ["🔥", ["bolt"]]] },
        seen: ["pip", "bolt", "star"],
      });
      await page.emulateHover();
      for (const id of ["b-58", "b-59"]) {
        const m = await measure(page, id);
        const actions = await page.eval<Box>(box(`document.querySelector('[data-id="${id}"] .bm-actions')`));
        expect(actions.right - actions.left).toBeGreaterThan(80);
        // Beside the bubble, on the side away from the conversation's edge, centred on it, inside the pane.
        if (id === "b-58") expect(m.bubble.left - actions.right).toBeLessThanOrEqual(8);
        else expect(actions.left - m.bubble.right).toBeLessThanOrEqual(8);
        expect(actions.left).toBeGreaterThanOrEqual(m.pane.left);
        expect(actions.right).toBeLessThanOrEqual(m.pane.right);
        expect(Math.abs(middle(actions) - middle(m.bubble))).toBeLessThanOrEqual(1);
        // The reactions line up with the bubble, not with the actions beside it.
        expect(m.reactions!.left - m.bubble.left).toBeGreaterThanOrEqual(0);
        expect(m.reactions!.left - m.bubble.left).toBeLessThanOrEqual(8);
        for (const p of [...m.chips, ...(m.seen ? [m.seen] : [])]) expect(overlap(p, actions)).toBe(false);
        // The reply buttons wait over their pill's corner instead of keeping gaps between the chips.
        expect(m.chips[1]!.left - m.chips[0]!.right).toBeLessThanOrEqual(8);
        tidy({ ...m, replies: [] });
      }
      const mine = await measure(page, "b-58");
      expect(Math.abs(middle(mine.seen!) - middle(mine.chips[0]!))).toBeLessThanOrEqual(2);
    }
  }, 60_000);
});

/**
 * Every message row's box on screen, and how tall the pane's content is: what must not move. (The
 * pane's scrollTop can change when something outside it, a bot perking up at the user's reaction,
 * changes its height; the rows on screen stay put.)
 */
const layout = (page: Page) =>
  page.eval<{ rows: { id: string; top: number; height: number; bubble: Box | null }[]; scrollHeight: number }>(`(() => {
    const pane = document.querySelector('.bots-messages');
    return {
      rows: [...pane.querySelectorAll('.bm-row[data-id]')].map((row) => ({ id: row.dataset.id, top: row.getBoundingClientRect().top, height: row.getBoundingClientRect().height, bubble: row.querySelector('.bm-bubble') && ${box("row.querySelector('.bm-bubble')")} })),
      scrollHeight: pane.scrollHeight,
    };
  })()`);

describe.skipIf(!browser)("reacting", () => {
  test("never changes a message's size or moves the chat, from the first reaction to the last taken back", async () => {
    for (const width of [1000, 390]) {
      const page = await open({ width, seen: ["pip", "bolt"] });
      const react = async (id: string, list: [emoji: string, by: string[]][]) => {
        await page.eval(`(() => {
          const reactions = ${JSON.stringify(list)}.flatMap(([emoji, by], i) => by.map((who, j) => ({ id: emoji + who, emoji, by: who, at: i * 10 + j + 1 })));
          const s = bots.getState();
          bots.setState({ conversations: s.conversations.map((c) => c.id !== "b" ? c : { ...c, messages: c.messages.map((m) => m.id === "${id}" ? { ...m, reactions } : m) }) });
        })()`);
        await page.finish(".bots-messages");
      };
      const before = await layout(page);
      expect(before.rows.length).toBeGreaterThan(3);
      // Anything that moved or changed size, by so much as a fraction of a pixel.
      const same = async (what: string) => {
        const now = await layout(page);
        const moved: string[] = [];
        if (now.scrollHeight !== before.scrollHeight) moved.push(`pane content ${before.scrollHeight} → ${now.scrollHeight} high`);
        expect(now.rows.map((r) => r.id)).toEqual(before.rows.map((r) => r.id));
        for (const [i, r] of now.rows.entries()) {
          const b = before.rows[i]!;
          if (r.top !== b.top || r.height !== b.height) moved.push(`${r.id}: row ${b.top}+${b.height} → ${r.top}+${r.height}`);
          if (JSON.stringify(r.bubble) !== JSON.stringify(b.bubble)) moved.push(`${r.id}: bubble ${JSON.stringify(b.bubble)} → ${JSON.stringify(r.bubble)}`);
        }
        expect({ what, width, moved }).toEqual({ what, width, moved: [] });
      };
      // The first reaction on each, from a bot.
      await react("b-58", [["👍", ["pip"]]]);
      await react("b-59", [["🔥", ["bolt"]]]);
      await same("first reactions");
      // More reactors, then more emoji than fit in a line.
      await react("b-58", [["👍", ["pip", "bolt", "plum", "star", "moss"]], ["😂", ["rosa"]], ["🔥", ["pip"]], ["🚀", ["moss"]], ["👀", ["kit", "fern"]], ["🎉", ["plum"]]]);
      await react("b-59", [["🔥", ["bolt", "pip", "star"]], ["✅", ["plum"]], ["❤️", ["rosa"]], ["💯", ["kit"]], ["🙏", ["fern"]], ["👀", ["moss"]], ["🎯", ["star"]]]);
      await same("many reactions");
      // The user adds one of their own by tapping a chip, and takes it back.
      await page.click(`[data-id="b-59"] .bm-reaction`);
      await page.until(`bots.getState().conversations.find((c) => c.id === "b").messages.find((m) => m.id === "b-59").reactions.some((r) => r.by === "me")`);
      await page.finish(".bots-messages");
      await same("the user's own");
      await page.click(`[data-id="b-59"] .bm-reaction`);
      await page.until(`!bots.getState().conversations.find((c) => c.id === "b").messages.find((m) => m.id === "b-59").reactions.some((r) => r.by === "me")`);
      await page.finish(".bots-messages");
      await same("the user's own taken back");
      // Every reaction gone again.
      await react("b-58", []);
      await react("b-59", []);
      await same("all taken back");
    }
  }, 60_000);
});
