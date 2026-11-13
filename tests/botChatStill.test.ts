// An OpenBots chat holding still in a real Chrome (the OpenBots pane, fixtures/botScroll): what's on
// screen doesn't move as bots react, start and stop work, change what they're doing, or as the line
// under a bot's name in a phone's header comes and goes. A bot's new message opens its room over a
// moment rather than all at once, its draft or working row handing over the room they had. Each step
// is watched frame by frame, so a jump that's put right a frame later still counts.
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

/** How the rows on screen moved while a step ran: the most in one frame, in all, and in how many frames. */
type Moves = { most: number; net: number; frames: number };

class StillPage extends Page {
  /** Runs `change` on the bots store and watches every message row on screen for the next `ms`, and
   *  on until whatever it set moving has come to rest (a busy machine can start it late). */
  async step(change: string, ms = 450): Promise<Moves> {
    return this.eval<Moves>(`new Promise((done) => {
      const el = document.querySelector('.bots-messages');
      const view = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll('.bm-row[data-id]')].filter((r) => { const b = r.getBoundingClientRect(); return b.bottom > view.top && b.top < view.bottom; });
      const at = () => rows.map((r) => r.getBoundingClientRect().top);
      const start = at();
      let last = start, most = 0, net = 0, frames = 0;
      const ends = performance.now() + ${ms};
      // Animations that end (not the mascots breathing or a status glowing, which loop).
      const moving = () => el.getAnimations({ subtree: true }).some((a) => a.playState !== "finished" && a.effect?.getComputedTiming().endTime !== Infinity);
      const tick = () => {
        const now = at();
        let moved = 0;
        now.forEach((y, i) => { moved = Math.max(moved, Math.abs(y - last[i])); net = Math.max(net, Math.abs(y - start[i])); });
        if (moved >= 0.5) frames++;
        most = Math.max(most, moved);
        last = now;
        if (performance.now() < ends || (moving() && performance.now() < ends + 4000)) requestAnimationFrame(tick);
        else done({ most, net, frames });
      };
      bots.setState(${change});
      requestAnimationFrame(tick);
    })`);
  }
  gap() {
    return this.eval<number>("(() => { const el = document.querySelector('.bots-messages'); return el.scrollHeight - el.scrollTop - el.clientHeight; })()");
  }
}

const open = async (chat: "a" | "b", width = 1000, height = 700) => {
  const page = await StillPage.open(chrome!.ws, server!.url.href, width, height, "!!document.querySelector('.bm-group')");
  if (chat !== "a") {
    await page.eval(`bots.getState().select("${chat}")`);
    await page.until(`!!document.querySelector('.bm-row[data-id^="${chat}-"]')`);
  }
  await page.finished(".bots-messages");
  expect(await page.gap()).toBeLessThan(1);
  return page;
};

const status = (bot: string, chat: string, activity?: string) =>
  activity ? `{ status: { ...bots.getState().status, ${bot}: { state: "working", conversationId: "${chat}", activity: ${JSON.stringify(activity)}, since: Date.now() } } }` : `{ status: { ...bots.getState().status, ${bot}: { state: "idle" } } }`;
const react = (chat: string, id: string, reactions: object[]) =>
  `(s) => ({ conversations: s.conversations.map((c) => c.id !== "${chat}" ? c : { ...c, messages: c.messages.map((m) => m.id === ${JSON.stringify(id)} ? { ...m, reactions: ${JSON.stringify(reactions)} } : m) }) })`;
/** A bot's message coming in, and with it the bot stopping work and its draft going. */
const reply = (chat: string, bot: string, id: string) =>
  `(s) => ({ typing: {}, drafts: [], status: { ...s.status, ${bot}: { state: "idle" } }, conversations: s.conversations.map((c) => c.id !== "${chat}" ? c : { ...c, messages: [...c.messages, { id: "${id}", author: "${bot}", at: Date.now(), text: "Here's what I found, and what I'd do about it. ".repeat(6) }] }) })`;
const lastId = (page: Page, chat: string) => page.eval<string>(`bots.getState().conversations.find((c) => c.id === "${chat}").messages.at(-1).id`);

/** Nothing on screen moved, in any frame. */
const still = (m: Moves) => {
  expect(m.most).toBeLessThan(0.5);
  expect(m.net).toBeLessThan(0.5);
};
/** It moved, but over several frames, no one of them doing most of it (a frame dropped on a busy
 *  machine can carry a good part of a short move; all at once, as a jump, is what this rules out). */
const glided = (m: Moves) => {
  expect(m.net).toBeGreaterThan(20);
  expect(m.frames).toBeGreaterThanOrEqual(3);
  expect(m.most).toBeLessThan(m.net * 0.7);
};

for (const [label, width, height] of [["desktop", 1000, 700], ["phone", 390, 760]] as const) {
  describe.skipIf(!browser)(`an OpenBots chat at its latest message, on a ${label}`, () => {
    test("a bot reacting, and taking it back, moves nothing", async () => {
      const page = await open("a", width, height);
      const id = await lastId(page, "a");
      still(await page.step(react("a", id, [{ id: "r1", emoji: "👍", by: "manager", at: 1 }])));
      still(await page.step(react("a", id, [{ id: "r1", emoji: "👍", by: "manager", at: 1 }, { id: "r2", emoji: "🔥", by: "me", at: 2 }])));
      still(await page.step(react("a", id, [])));
    }, 60_000);

    test("a bot starting work, changing step, typing and stopping moves nothing", async () => {
      const page = await open("a", width, height);
      still(await page.step(status("manager", "a", "Opening example.com")));
      still(await page.step(status("manager", "a", "Reading the release notes for a while")));
      // Plain working words: its mascot turns into three dots.
      still(await page.step(status("manager", "a", "Working")));
      still(await page.step(`{ typing: { a: ["manager"] } }`));
      still(await page.step(`{ typing: {} }`));
      still(await page.step(status("manager", "a")));
    }, 60_000);

    test("a bot's reply opens its room over a moment, taking over its working row's", async () => {
      const page = await open("a", width, height);
      still(await page.step(status("manager", "a", "Opening example.com")));
      glided(await page.step(reply("a", "manager", "a-reply")));
      expect(await page.gap()).toBeLessThan(1);
      // Its next reply, after a draft it showed as it wrote: the draft's room goes to the message.
      still(await page.step(status("manager", "a", "Writing a reply")));
      glided(await page.step(`{ typing: { a: ["manager"] }, drafts: [{ conversationId: "a", botId: "manager", text: "Here's what I found, and what I'd do about it. ".repeat(3) }] }`));
      const handOver = await page.step(reply("a", "manager", "a-reply-2"));
      expect(handOver.most).toBeLessThan(Math.max(1, handOver.net * 0.7));
      expect(await page.gap()).toBeLessThan(1);
    }, 60_000);

    test("in a group, a second bot at work eases its row in and out", async () => {
      const page = await open("b", width, height);
      still(await page.step(status("manager", "b", "Opening example.com")));
      glided(await page.step(status("helper", "b", "Checking the logs")));
      glided(await page.step(status("helper", "b")));
      still(await page.step(status("manager", "b")));
    }, 60_000);
  });
}

describe.skipIf(!browser)("an OpenBots chat scrolled up", () => {
  test("holds still as a bot reacts in view, works and replies below", async () => {
    const page = await open("b");
    await page.wheel(-900);
    expect(await page.gap()).toBeGreaterThan(400);
    // A message in view.
    const inView = await page.eval<string>(`(() => { const el = document.querySelector('.bots-messages'), v = el.getBoundingClientRect(); return [...el.querySelectorAll('.bm-row[data-id]')].find((r) => { const b = r.getBoundingClientRect(); return b.top > v.top + 100 && b.bottom < v.bottom - 100; }).dataset.id; })()`);
    still(await page.step(react("b", inView, [{ id: "r1", emoji: "😂", by: "helper", at: 1 }])));
    still(await page.step(status("manager", "b", "Opening example.com")));
    still(await page.step(reply("b", "manager", "b-reply")));
    still(await page.step(react("b", inView, [])));
  }, 60_000);
});

describe.skipIf(!browser)("a phone's header", () => {
  test("keeps the bot's name where it is as the line under it comes and goes", async () => {
    const page = await open("a", 390, 760);
    const name = () => page.eval<number>("document.querySelector('.bots-head-name').getBoundingClientRect().top");
    const before = await name();
    for (const change of [status("manager", "a", "Opening example.com"), status("manager", "a", "Working"), `{ typing: { a: ["manager"] } }`, `{ typing: {} }`, status("manager", "a")]) {
      await page.step(change, 400);
      expect(await name()).toBe(before);
    }
  }, 60_000);
});
