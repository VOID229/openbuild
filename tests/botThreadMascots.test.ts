// The mascots beside a group's coding threads (its details panel's Threads tab), and the "zzz" over
// dozing bots, in a real Chrome: a thread's mascot only says whose thread it is, held still whatever its
// bot is doing; each row shows its harness and its model's provider; a finished thread leaves the
// list; and dozing bots and huddles in the sidebars
// show a small zzz that still reads there, still while motion is reduced, and none beside the chat.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotAvatar, BotHuddle } from "../src/components/bots/BotAvatar";
import { threadActivity, threadBrands } from "../src/lib/bots/activity";
import type { PlanId } from "../shared/types";
import type { Chat, Message } from "../src/lib/types";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";
import { still, stillness, watchMascots } from "./stillMascots";

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

  test("names the thread's harness, with its account, and the provider behind its model", () => {
    const account = (name: string, runtime: "codex" | "claude") => ({ id: name, name, runtime, configDir: "/x" });
    const answered = (plan: PlanId, id: string) => ({ ...reply("done"), model: { plan, id, name: id } });
    expect(threadBrands({ runtime: "codex", runtimeAccount: account("codex2", "codex"), messages: [] })).toEqual({ runtime: "codex", harness: "Codex · codex2", provider: { id: "openai", name: "OpenAI" } });
    expect(threadBrands({ runtime: "claude", runtimeAccount: account("claude2", "claude"), messages: [] })).toEqual({ runtime: "claude", harness: "Claude Code · claude2", provider: { id: "anthropic", name: "Anthropic" } });
    // Both marks even when one company makes both.
    expect(threadBrands({ runtime: "claude", messages: [answered("claude", "claude/opus")] })).toEqual({ runtime: "claude", harness: "Claude Code", provider: { id: "anthropic", name: "Anthropic" } });
    expect(threadBrands({ runtime: "codex", messages: [answered("codex", "codex2/gpt-6.1-sol")] }).provider).toEqual({ id: "openai", name: "OpenAI" });
    // Pi: the provider in the model's id.
    expect(threadBrands({ messages: [answered("pi", "openrouter/moonshotai/kimi-k3")] })).toEqual({ runtime: "pi", harness: "Pi", provider: { id: "openrouter", name: "OpenRouter" } });
    expect(threadBrands({ runtime: "durable", messages: [answered("pi", "anthropic/claude-opus")] })).toEqual({ runtime: "durable", harness: "Durable", provider: { id: "anthropic", name: "Anthropic" } });
    expect(threadBrands({ messages: [answered("zen", "kimi-k3")] }).provider?.id).toBe("opencode");
    // Not answered yet, a Pi thread's provider isn't known.
    expect(threadBrands({ messages: [] })).toEqual({ runtime: "pi", harness: "Pi", provider: undefined });
    // OpenCode, fx and Hermes name the provider after the harness; without one, the harness's own serves it.
    expect(threadBrands({ runtime: "opencode", messages: [answered("opencode", "opencode/anthropic/claude-opus")] }).provider?.id).toBe("anthropic");
    expect(threadBrands({ runtime: "fx", messages: [answered("fx", "fx/gpt-6")] }).provider?.id).toBe("vercel");
    expect(threadBrands({ runtime: "grok", messages: [] }).provider).toEqual({ id: "xai", name: "xAI" });
    expect(threadBrands({ runtime: "cursor", messages: [answered("cursor", "cursor/composer-2")] }).provider).toEqual({ id: "cursor", name: "Cursor" });
  });
});

describe("where the zzz shows", () => {
  const looks = [{ shape: "puff", color: "white" }, { shape: "orb", color: "green" }];
  test("off unless asked for, on a dozing bot or huddle", () => {
    expect(renderToStaticMarkup(createElement(BotAvatar, { look: looks[0]!, size: 28, asleep: true }))).not.toContain("bot-zzz");
    expect(renderToStaticMarkup(createElement(BotHuddle, { looks, size: 96, active: [false, false] }))).not.toContain("bot-zzz");
    expect(renderToStaticMarkup(createElement(BotAvatar, { look: looks[0]!, size: 28, asleep: true, zzz: true }))).toContain("bot-zzz");
    expect(renderToStaticMarkup(createElement(BotHuddle, { looks, size: 96, active: [false, false], zzz: true }))).toContain("bot-zzz");
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
  { id: "t-work", title: "Fix the flaky test", runtime: "codex", runtimeAccount: { id: "c2", name: "codex2", runtime: "codex", configDir: "/x" }, startedBy: { conversation: "dev", bot: "moss" }, workspace: { projectName: "openbuild" }, messages: [{ id: "t1", role: "assistant", content: "", status: "streaming", createdAt: 1 }] },
  { id: "t-ask", title: "Migrate the database", startedBy: { conversation: "dev", bot: "boo" }, messages: [{ id: "t2", role: "assistant", content: "", status: "streaming", createdAt: 1, model: { plan: "pi", id: "openrouter/moonshotai/kimi-k3", name: "Kimi K3" }, parts: [{ type: "ask", id: "q", method: "confirm", title: "Run it?" }] }] },
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
  test("lists the threads at work or waiting, each with its bot's mascot", async () => {
    const page = await Page.open(chrome!.ws, server!.url.href, 1180, 760, READY);
    await openThreads(page);
    const rows = await page.eval<string[]>(`[...document.querySelectorAll('.bots-details .bots-member')].map((r) => r.textContent)`);
    expect(rows).toEqual(["Fix the flaky testMoss · openbuild", "Migrate the databaseBoo · Waiting for you"]);
    // At each row's right, the harness's mark and then the provider's, each named, and drawn.
    const marks = await page.eval<{ names: string[]; drawn: boolean }[]>(`[...document.querySelectorAll('.bots-details .bots-thread-brands')].map((b) => ({ names: [...b.children].map((m) => m.getAttribute('aria-label') + '|' + m.dataset.tooltip), drawn: [...b.children].every((m) => !!m.querySelector('svg, img')) }))`);
    expect(marks).toEqual([
      { names: ["Codex · codex2|Codex · codex2", "OpenAI|OpenAI"], drawn: true },
      { names: ["Pi|Pi", "OpenRouter|OpenRouter"], drawn: true },
    ]);
    // They sit at the row's right edge, small, side by side.
    const brands = await page.eval<{ right: number; row: number; height: number; width: number }>(`(() => { const h = document.querySelector('.bots-details .bots-thread-brands'); const r = h.getBoundingClientRect(); return { right: r.right, row: h.parentElement.getBoundingClientRect().right, height: r.height, width: r.width }; })()`);
    expect(brands.row - brands.right).toBeLessThan(16);
    expect(brands.height).toBeLessThan(20);
    expect(brands.width).toBeLessThan(44);
    // Each row's mascot is its bot's own.
    expect(await page.eval<unknown>(`[${rowBot("Fix the flaky test")}.dataset.color, ${rowBot("Migrate the database")}.dataset.color]`)).toEqual(["green", "amber"]);
    // Done, the thread leaves the list.
    await page.eval(`store.setState((s) => ({ chats: s.chats.map((c) => c.id === "t-work" ? { ...c, messages: [{ ...c.messages[0], status: "done" }] } : c) }))`);
    await page.until("document.querySelectorAll('.bots-details .bots-member .bot').length === 1");
  }, 20_000);

  test("a thread's mascot only says whose it is: still, whatever its bot does, with no zzz and no following the pointer", async () => {
    const page = await Page.open(chrome!.ws, server!.url.href, 1180, 760, READY);
    await openThreads(page);
    await watchMascots(page, "document.querySelector('.bots-details .bots-cards')");
    // Moss is at work in the group (the fixture), and now on its very thread, and reacts; Boo starts on something.
    await page.eval(`bots.setState((s) => ({ status: { ...s.status, moss: { state: "working", conversationId: "dev", thread: "t-work" }, boo: { state: "working", conversationId: "dev", since: Date.now() } } }))`);
    await page.eval(`bots.getState().pulse("moss")`);
    // The pointer crosses each row's mascot and rests beside it.
    for (const title of ["Fix the flaky test", "Migrate the database"]) {
      const [x, y] = await page.eval<[number, number]>(`(() => { const r = (${rowBot(title)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      for (const dx of [-40, 0, 40]) {
        await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + dx, y: y + dx / 4 });
        await Bun.sleep(400);
      }
    }
    await Bun.sleep(1500);
    expect(await stillness(page)).toEqual(still(2));
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
    await page.finish();
    // In the details panel's member list: Moss is at work, with none; the three dozing have one each.
    const members = await zzzs(page, ".bots-details .bots-member .bot > .bot-zzz");
    expect(members.length).toBe(4);
    const moss = await page.eval<number>(`Number(getComputedStyle(document.querySelector('.bots-details .bots-member .bot[data-color="green"] > .bot-zzz')).opacity)`);
    expect(moss).toBe(0);
    const dozing = members.filter((z) => z.opacity > 0.99);
    expect(dozing.length).toBe(3);
    // Small, but still letters: the smallest at about 7px, the three no taller than the 28px avatar's half.
    for (const z of dozing) {
      expect(z.font).toBeGreaterThanOrEqual(6.5);
      expect(z.height).toBeGreaterThanOrEqual(12);
      expect(z.height).toBeLessThanOrEqual(16);
      expect(z.running).toBe(3);
    }
    // A huddle in the sidebar has one, over its corner: its members, a dozen pixels across, have none.
    const tile = `[...document.querySelectorAll('.bots-tile')].find((t) => t.textContent.includes('OpenBuild Dev'))`;
    expect(await page.eval<number>(`(${tile}).querySelectorAll('.bot > .bot-zzz').length`)).toBe(0);
    const huddle = await page.eval<Zzz[]>(`[...(${tile}).querySelectorAll('.bot-huddle-box > .bot-zzz')].map((z) => ({ opacity: Number(getComputedStyle(z).opacity), font: parseFloat(getComputedStyle(z.firstElementChild).fontSize), height: z.getBoundingClientRect().height, running: 0 }))`);
    expect(huddle.length).toBe(1);
    expect(huddle[0]!.opacity).toBe(1);
    // A footnote on the big tile, not a headline: no bigger than at the members' 28px.
    expect(huddle[0]!.font).toBeGreaterThanOrEqual(6.5);
    expect(huddle[0]!.font).toBeLessThanOrEqual(10);
    // Everyone at work in the group: no zzz over it at all.
    await page.eval(`bots.setState({ status: Object.fromEntries(["egg", "moss", "boo", "pill"].map((id) => [id, { state: "working", conversationId: "dev" }])) })`);
    // It fades out over 160 ms: wait for that rather than a fixed while, which slow frames outlast.
    await page.until(`Number(getComputedStyle((${tile}).querySelector('.bot-huddle-box > .bot-zzz')).opacity) === 0`);
    expect(await page.eval<number>(`Number(getComputedStyle((${tile}).querySelector('.bot-huddle-box > .bot-zzz')).opacity)`)).toBe(0);
    expect((await zzzs(page, ".bots-details .bots-member .bot > .bot-zzz")).every((z) => z.opacity === 0 && z.running === 0)).toBe(true);
  }, 20_000);

  test("none beside the chat: its messages' dozing avatars and its header just shut their eyes", async () => {
    const page = await Page.open(chrome!.ws, server!.url.href, 1180, 760, READY);
    await page.settle();
    // Pill, who wrote in the group and isn't at work, dozes beside the message: eyes shut, no zzz.
    const pill = `[...document.querySelectorAll('.bm-avatar .bot')].find((b) => b.dataset.color === 'blue')`;
    expect(await page.eval<boolean>(`'asleep' in (${pill}).dataset`)).toBe(true);
    expect(await page.eval<number>(`document.querySelectorAll('.bm-avatar .bot-zzz').length`)).toBe(0);
    // Nor in the chat's header, though its huddle dozes: every zzz on the page is in one of the sidebars.
    expect(await page.eval<number>(`document.querySelectorAll('.bots-head-pill .bot[data-asleep]').length`)).toBeGreaterThan(0);
    expect(await page.eval<number>(`[...document.querySelectorAll('.bot-zzz')].filter((z) => !z.closest('.bots-sidebar, .bots-details')).length`)).toBe(0);
    // While the sidebars do show it.
    expect(await page.eval<number>(`document.querySelectorAll('.bots-sidebar .bot-zzz').length`)).toBeGreaterThan(0);
    expect(await page.eval<number>(`document.querySelectorAll('.bots-details .bot-zzz').length`)).toBeGreaterThan(0);
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
