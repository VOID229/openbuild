// The mascots beside a group's coding threads (its details panel's Threads tab), and the "zzz" over
// dozing ones, in a real Chrome: a thread at work fidgets visibly even at 28px, one waiting on the
// user looks up wide-eyed, a finished one leaves the list, and dozing bots and huddles show a zzz big
// enough to read in the sidebar, still while motion is reduced.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { threadActivity, threadMascot } from "../src/lib/bots/activity";
import type { Chat, Message } from "../src/lib/types";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

const reply = (status: Message["status"], parts?: Message["parts"]): Message => ({ id: "r", role: "assistant", content: "", status, parts, createdAt: 1 } as Message);
const thread = (...messages: Message[]) => ({ messages }) as Pick<Chat, "messages">;
const ask = { type: "ask" as const, id: "a", method: "confirm" as const, title: "Run the migration?" };

describe("a thread's mascot", () => {
  test("follows the thread's latest reply: working, waiting on the user, or done", () => {
    expect(threadActivity(thread())).toBe("idle");
    expect(threadActivity(thread(reply("streaming")))).toBe("working");
    expect(threadActivity(thread(reply("streaming", [{ type: "text", text: "Looking" }])))).toBe("working");
    expect(threadActivity(thread(reply("streaming", [ask])))).toBe("waiting");
    // Answered, it's back at work.
    expect(threadActivity(thread(reply("streaming", [{ ...ask, answer: "yes" }])))).toBe("working");
    expect(threadActivity(thread(reply("done")))).toBe("idle");
    expect(threadActivity(thread(reply("error")))).toBe("idle");
    // A command the user ran after the reply doesn't hide it.
    expect(threadActivity(thread(reply("streaming"), { id: "u", role: "user", content: "!ls", createdAt: 2 } as Message))).toBe("working");
  });

  test("fidgets at work, looks up waiting, and dozes when done", () => {
    expect(threadMascot("working")).toEqual({ busy: true, asleep: false, mood: "idle" });
    expect(threadMascot("waiting")).toEqual({ busy: false, asleep: false, mood: "surprised" });
    expect(threadMascot("idle")).toEqual({ busy: false, asleep: true, mood: "idle" });
  });
});

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

const READY = "document.querySelectorAll('.bots-tile').length >= 5 && !!document.querySelector('.bots-details .bots-member')";

/** Coding threads Moss and Boo started from the "OpenBuild Dev" group: one at work, one asking the user, one done. */
const THREADS = `[
  { id: "t-work", title: "Fix the flaky test", startedBy: { conversation: "dev", bot: "moss" }, workspace: { projectName: "openbuild" }, messages: [{ id: "t1", role: "assistant", content: "", status: "streaming", createdAt: 1 }] },
  { id: "t-ask", title: "Migrate the database", startedBy: { conversation: "dev", bot: "boo" }, messages: [{ id: "t2", role: "assistant", content: "", status: "streaming", createdAt: 1, parts: [{ type: "ask", id: "q", method: "confirm", title: "Run it?" }] }] },
  { id: "t-done", title: "Bump the version", startedBy: { conversation: "dev", bot: "pill" }, messages: [{ id: "t3", role: "assistant", content: "Done", status: "done", createdAt: 1 }] },
]`;

const openThreads = async (page: Page) => {
  await page.eval(`store.setState({ chats: ${THREADS} })`);
  await page.eval(`[...document.querySelectorAll('.bots-details button')].find((b) => b.textContent.startsWith('Threads')).click()`);
  await page.until("document.querySelectorAll('.bots-details .bots-member .bot').length === 2");
  await page.settle();
};

/** The mascot on the thread row titled `title`. */
const rowBot = (title: string) => `[...document.querySelectorAll('.bots-details .bots-member')].find((r) => r.textContent.includes(${JSON.stringify(title)})).querySelector('.bot')`;

describe.skipIf(!browser)("mascots in the Threads tab", () => {
  test("lists the threads at work or waiting, each mascot showing which", async () => {
    const page = await Page.open(chrome!.ws, server!.url.href, 1180, 760, READY);
    await openThreads(page);
    const rows = await page.eval<string[]>(`[...document.querySelectorAll('.bots-details .bots-member')].map((r) => r.textContent)`);
    expect(rows).toEqual(["Fix the flaky testMoss · openbuild", "Migrate the databaseBoo · Waiting for you"]);
    const state = (title: string) => page.eval<object>(`(() => { const b = ${rowBot(title)}; return { alive: b.classList.contains('bot-alive'), busy: 'busy' in b.dataset, asleep: 'asleep' in b.dataset, mood: b.dataset.mood }; })()`);
    expect(await state("Fix the flaky test")).toEqual({ alive: true, busy: true, asleep: false, mood: "idle" });
    expect(await state("Migrate the database")).toEqual({ alive: true, busy: false, asleep: false, mood: "surprised" });
    // Done, the thread leaves the list.
    await page.eval(`store.setState((s) => ({ chats: s.chats.map((c) => c.id === "t-work" ? { ...c, messages: [{ ...c.messages[0], status: "done" }] } : c) }))`);
    await page.until("document.querySelectorAll('.bots-details .bots-member .bot').length === 1");
  }, 20_000);

  test("a thread at work visibly moves at 28px, not just a blink", async () => {
    const page = await Page.open(chrome!.ws, server!.url.href, 1180, 760, READY);
    await openThreads(page);
    // Where its eyes are and how its head is tilted, on screen, every 100ms for a few seconds.
    const samples = await page.eval<{ x: number; y: number; tilt: string }[]>(`new Promise((done) => {
      const bot = ${rowBot("Fix the flaky test")};
      const out = [];
      const timer = setInterval(() => {
        const r = bot.querySelector('.bot-look').getBoundingClientRect();
        out.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, tilt: getComputedStyle(bot.querySelector('.bot-tilt')).transform });
        if (out.length >= 60) { clearInterval(timer); done(out); }
      }, 100);
    })`);
    const xs = samples.map((s) => s.x);
    const ys = samples.map((s) => s.y);
    // The face travels a few real pixels as it looks about and turns its head (a blink moves nothing).
    expect(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))).toBeGreaterThanOrEqual(2);
    expect(new Set(samples.map((s) => `${s.x.toFixed(1)},${s.y.toFixed(1)},${s.tilt}`)).size).toBeGreaterThan(5);
  }, 20_000);
});

/** Each "zzz" under `selector`: how opaque it is, its letters' size on screen, and what's animating it. */
type Zzz = { opacity: number; font: number; height: number; running: number };
const zzzs = (page: Page, selector: string) =>
  page.eval<Zzz[]>(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((z) => ({
    opacity: Number(getComputedStyle(z).opacity),
    font: parseFloat(getComputedStyle(z.firstElementChild).fontSize),
    height: z.getBoundingClientRect().height,
    running: z.getAnimations({ subtree: true }).filter((a) => a.playState === 'running' && a.animationName === 'bot-zzz').length,
  }))`);

describe.skipIf(!browser)("the zzz over dozing bots", () => {
  test("floats over dozing members and huddles, one per huddle, readable at the sidebar's size", async () => {
    const page = await Page.open(chrome!.ws, server!.url.href, 1180, 760, READY);
    // Let them nod off: the zzz comes in once the eyes have shut.
    await Bun.sleep(1800);
    // In the details panel's member list: Moss is at work, with none; the three dozing have one each.
    const members = await zzzs(page, ".bots-details .bots-member .bot > .bot-zzz");
    expect(members.length).toBe(4);
    const moss = await page.eval<number>(`Number(getComputedStyle(document.querySelector('.bots-details .bots-member .bot[data-color="green"] > .bot-zzz')).opacity)`);
    expect(moss).toBe(0);
    const dozing = members.filter((z) => z.opacity > 0.99);
    expect(dozing.length).toBe(3);
    for (const z of dozing) {
      expect(z.font).toBeGreaterThanOrEqual(8);
      expect(z.height).toBeGreaterThanOrEqual(14);
      expect(z.running).toBe(3);
    }
    // A huddle in the sidebar has one, over its corner: its members, a dozen pixels across, have none.
    const tile = `[...document.querySelectorAll('.bots-tile')].find((t) => t.textContent.includes('OpenBuild Dev'))`;
    expect(await page.eval<number>(`(${tile}).querySelectorAll('.bot > .bot-zzz').length`)).toBe(0);
    const huddle = await page.eval<Zzz[]>(`[...(${tile}).querySelectorAll('.bot-huddle-box > .bot-zzz')].map((z) => ({ opacity: Number(getComputedStyle(z).opacity), font: parseFloat(getComputedStyle(z.firstElementChild).fontSize), height: z.getBoundingClientRect().height, running: 0 }))`);
    expect(huddle.length).toBe(1);
    expect(huddle[0]!.opacity).toBe(1);
    expect(huddle[0]!.font).toBeGreaterThanOrEqual(8);
    // Everyone at work in the group: no zzz over it at all.
    await page.eval(`bots.setState({ status: Object.fromEntries(["egg", "moss", "boo", "pill"].map((id) => [id, { state: "working", conversationId: "dev" }])) })`);
    await Bun.sleep(400);
    expect(await page.eval<number>(`Number(getComputedStyle((${tile}).querySelector('.bot-huddle-box > .bot-zzz')).opacity)`)).toBe(0);
    expect((await zzzs(page, ".bots-details .bots-member .bot > .bot-zzz")).every((z) => z.opacity === 0 && z.running === 0)).toBe(true);
  }, 20_000);

  test("with reduced motion, the zzz is there but holds still", async () => {
    const page = await Page.open(chrome!.ws, "about:blank", 1180, 760, "true");
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await page.send("Page.navigate", { url: server!.url.href });
    await page.until(READY);
    await page.settle();
    const shown = (await zzzs(page, ".bot[data-asleep] > .bot-zzz, .bot-huddle-box[data-dozing] > .bot-zzz"));
    expect(shown.length).toBeGreaterThan(3);
    for (const z of shown) expect({ opacity: z.opacity, running: z.running }).toEqual({ opacity: 1, running: 0 });
    // Each letter in full, not caught part way through fading in.
    expect(await page.eval<number[]>(`[...document.querySelectorAll('.bot[data-asleep] > .bot-zzz > span')].map((l) => Number(getComputedStyle(l).opacity))`)).not.toContain(0);
  }, 20_000);
});
