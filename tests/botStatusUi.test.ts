import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// A bot's status in the app, rendered in a DOM and fed through the real event stream: the chat's
// working row, the header's line on a phone and the sidebar all read the same status, show each step
// as its event arrives, keep the last one through plain words, and never say "Thinking". Three dots
// only with nothing at all to name, briefly, and in every place at once.
// Each test file runs in its own process (scripts/test.ts), so the globals stay here.
const win = new Window({ url: "http://localhost/" });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(win)) if (!(key in g)) g[key] = (win as any)[key];
Object.assign(g, { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, sessionStorage: win.sessionStorage, location: win.location, history: win.history, getComputedStyle: win.getComputedStyle.bind(win) });
let phone = false;
g.window.matchMedia = (q: string) => ({ matches: q.includes("reduced-motion") || (phone && q.includes("max-width: 768px")), addEventListener() {}, removeEventListener() {} });
g.matchMedia = g.window.matchMedia;
g.IS_REACT_ACT_ENVIRONMENT = true;

const look = { shape: "puff", color: "blue" };
const scout = { id: "scout", name: "Scout", look, instructions: "", memory: [], routines: [], createdAt: 1 };
let snapshot: any;
// The server's event stream, which the test writes to as the server would.
let feed: ReadableStreamDefaultController<Uint8Array> | undefined;
const enc = new TextEncoder();
globalThis.fetch = (async (input: string) => {
  const path = String(input).replace(/^http:\/\/localhost/, "");
  if (path === "/api/config") return Response.json({ mode: "local", serverId: "srv", machine: "Studio" });
  const headers = { "x-openbuild-server": "srv" };
  if (path.endsWith("/api/bots")) return Response.json(snapshot, { headers });
  if (path.endsWith("/api/bots/stream")) {
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { feed = controller; controller.enqueue(enc.encode(JSON.stringify({ t: "hello", workspace: "srv" }) + "\n")); } }), { headers });
  }
  return Response.json({ ok: true }, { headers });
}) as unknown as typeof fetch;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useStore } = await import("../src/lib/store");
const { enterWorkspace, switchWorkspace, useBots } = await import("../src/lib/bots/store");
const { useWorkspace } = await import("../src/lib/bots/workspace");
const { BotsView } = await import("../src/components/bots/BotsView");
const { BotsSidebar } = await import("../src/components/bots/BotsSidebar");
const { DOTS_MAX, DOTS_SETTLE } = await import("../src/lib/bots/activity");

let root: ReturnType<typeof createRoot>;
const frames = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
/** One event down the stream, and the single tick it takes the app to read and render it. */
const event = (e: Record<string, unknown>) => act(async () => { feed!.enqueue(enc.encode(JSON.stringify(e) + "\n")); await new Promise((r) => setTimeout(r, 5)); });
const status = (next: Record<string, unknown>) => event({ t: "status", botId: "scout", status: next });
const working = (activity?: string, more: Record<string, unknown> = {}) => status({ state: "working", conversationId: "chat", ...(activity === undefined ? {} : { activity }), ...more });
const typing = (on: boolean) => event({ t: "typing", conversationId: "chat", botIds: on ? ["scout"] : [] });
/** The step the chat's working row shows: not one on its way out for the dots. */
const row = () => document.querySelector(".bm-working-text:not([data-gone])")?.textContent;
/** The working row's mascot is three dots, for plain work. */
const dotted = () => !!document.querySelector('.bm-working[data-dots] .bot[data-dots="in"]');
/** The header's line is three dots, for plain work. */
const headDots = () => document.querySelector(".bots-head-dots");
const head = () => document.querySelector(".bots-head-sub")?.textContent;

async function show(view: any = BotsView, statuses: Record<string, unknown> = {}) {
  snapshot = { bots: [scout], conversations: [{ id: "chat", kind: "direct", botIds: ["scout"], createdAt: 1, updatedAt: 1, messages: [{ id: "m1", author: "me", at: 1, text: "check the build" }] }], settings: { sections: [] }, typing: {}, drafts: [], status: statuses };
  await act(async () => void (await switchWorkspace("srv")));
  await frames();
  useBots.setState({ activeId: "chat" });
  await act(async () => root.render(h(view)));
  await frames();
}

beforeEach(() => {
  phone = false;
  useStore.setState({ devices: [{ id: "srv", serverId: "srv", name: "Studio", local: true, mode: "lan", urls: [], online: true }], devicesLoaded: true, chats: [] } as any);
  useWorkspace.setState({ localId: "srv", localName: "Studio", problem: undefined, switching: undefined });
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  feed = undefined;
  enterWorkspace("away");
});

test("the chat's working row shows each step as its status arrives, keeps the last one through plain words, and shows nothing once it's over", async () => {
  await show();
  expect(row()).toBeUndefined();
  // A turn opens on what it's reading: the mascot, with that line.
  await working("Reading your message");
  expect(row()).toBe("Reading your message");
  expect(dotted()).toBe(false);
  // Each step replaces the last in the tick it arrives: the line is a new element, not a stale one
  // fading out.
  for (const step of ["Running a command", "Checking why the build failed", "Reading notes.md"]) {
    const before = document.querySelector(".bm-working-text");
    await working(step);
    expect(row()).toBe(step);
    expect(dotted()).toBe(false);
    expect(document.querySelectorAll(".bm-working-text").length).toBe(1);
    expect(document.querySelector(".bm-working-text")).not.toBe(before);
  }
  // Plain words between steps (an older server's): the last step stays, and it never turns into dots.
  for (const plain of ["Getting it done", "Sorting it out", "Keeping at it", "Making progress"]) {
    await working(plain);
    await frames(DOTS_SETTLE + 50);
    expect(row()).toBe("Reading notes.md");
    expect(dotted()).toBe(false);
  }
  await working("Running the tests");
  expect(row()).toBe("Running the tests");
  // (The new step's swell plays out first.)
  await frames(1400);
  // Writing: the same row, so the same mascot, thinking, with "Typing…" beside it.
  const mascot = document.querySelector(".bm-working .bot");
  await typing(true);
  expect(document.querySelectorAll(".bm-working").length).toBe(1);
  expect(document.querySelector(".bm-working .bot")).toBe(mascot);
  expect(dotted()).toBe(false);
  expect(mascot!.getAttribute("data-mood")).toBe("thinking");
  expect(row()).toBeUndefined();
  const indicator = document.querySelector(".bm-working .bm-typing")!;
  expect(indicator.textContent).toBe("Typing…");
  expect(indicator.children.length).toBe(0);
  expect(document.querySelector(".bm-working")!.getAttribute("aria-label")).toBe("Scout is typing");
  // Its words, once there are some, take the row's place as a bubble.
  await act(async () => useBots.setState({ drafts: [{ conversationId: "chat", botId: "scout", text: "Here's the plan" }] }));
  expect(document.querySelector(".bm-working")).toBeNull();
  expect([...document.querySelectorAll(".bm-bubble")].some((b) => b.textContent === "Here's the plan")).toBe(true);
  await act(async () => useBots.setState({ drafts: [] }));
  await typing(false);
  // Quiet work (after a message went out) shows no row, and an idle bot none either.
  await working("Sorting it out", { quiet: true });
  expect(document.querySelector(".bm-working")).toBeNull();
  await working("Running the tests");
  expect(row()).toBe("Running the tests");
  await status({ state: "idle" });
  expect(document.querySelector(".bm-working")).toBeNull();
  // A new spell of work keeps nothing of the last one's.
  await working("Working on it");
  expect(row()).toBeUndefined();
});

test("with nothing at all to name, the mascot is three dots for a moment, then back with the plain words", async () => {
  await show();
  await working("Working on it");
  // A moment to settle first, so a step close behind doesn't set it going back and forth.
  expect(dotted()).toBe(false);
  expect(row()).toBeUndefined();
  await frames(DOTS_SETTLE + 50);
  expect(dotted()).toBe(true);
  expect(row()).toBeUndefined();
  expect(document.querySelector(".bm-working")!.getAttribute("aria-label")).toBe("Scout: Working on it");
  // Another plain phrase is the same wait: the dots don't start over.
  await working("Getting it done");
  expect(dotted()).toBe(true);
  // Never for long: the mascot comes back, saying the plain words.
  await frames(DOTS_MAX);
  expect(dotted()).toBe(false);
  expect(row()).toBe("Getting it done");
  // A step brings it back at once, and comes in after the mascot.
  await status({ state: "idle" });
  await working();
  await frames(DOTS_SETTLE + 50);
  expect(dotted()).toBe(true);
  await working("Running the tests");
  expect(row()).toBe("Running the tests");
  expect(dotted()).toBe(false);
  expect(document.querySelector(".bm-working-text")!.hasAttribute("data-back")).toBe(true);
});

test("a holding line is a step of its own: it keeps its words", async () => {
  await show(BotsView, { scout: { state: "working", conversationId: "elsewhere", activity: "Running the tests", waiting: ["chat"] } });
  expect(row()).toMatch(/^(Hold on a second|Finishing up something|One moment, wrapping something up|Be right with you)$/);
  expect(dotted()).toBe(false);
});

test("a status with no line, or an older server's Thinking, reads as plain work, and the app never says Thinking", async () => {
  await show(BotsView, { scout: { state: "working", conversationId: "chat", activity: "Thinking" } });
  await frames(DOTS_SETTLE + 50);
  expect(dotted()).toBe(true);
  expect(row()).toBeUndefined();
  await working();
  expect(dotted()).toBe(true);
  await working("Thinking…");
  expect(dotted()).toBe(true);
  await working("Reading notes.md");
  expect(row()).toBe("Reading notes.md");
  await working("Thinking");
  expect(row()).toBe("Reading notes.md");
  expect(document.body.textContent).not.toMatch(/thinking/i);
});

test("on a phone the header's line under the name is the live step, kept through plain words, three dots only with it, and Typing… while it types", async () => {
  phone = true;
  await show();
  // Nothing going on: no live line (a direct chat has no member list to show either).
  expect(document.querySelector(".bots-head-sub-live")).toBeNull();
  expect(headDots()).toBeNull();
  await working("Thinking");
  await frames(DOTS_SETTLE + 50);
  // Nothing to name: three dots and no words, named for a screen reader, while the row's mascot is dots.
  expect(headDots()!.children.length).toBe(3);
  expect(headDots()!.textContent).toBe("");
  expect(headDots()!.getAttribute("aria-label")).toBe("Working on it");
  expect(dotted()).toBe(true);
  expect(document.querySelector(".bots-head-sub-live")).toBeNull();
  await working("Watching CI on #115");
  expect(headDots()).toBeNull();
  expect(head()).toBe("Watching CI on #115");
  expect(document.querySelector(".bots-head-sub")!.classList.contains("bots-head-sub-live")).toBe(true);
  // The same words as the chat's row beneath it.
  expect(row()).toBe("Watching CI on #115");
  await typing(true);
  expect(head()).toBe("Typing…");
  await typing(false);
  expect(head()).toBe("Watching CI on #115");
  // Plain words after a step: the header keeps the step, as the row does.
  await working("Getting it done");
  await frames(DOTS_SETTLE + 50);
  expect(head()).toBe("Watching CI on #115");
  expect(headDots()).toBeNull();
  expect(row()).toBe("Watching CI on #115");
  await status({ state: "idle" });
  expect(document.querySelector(".bots-head-sub-live")).toBeNull();
  expect(headDots()).toBeNull();
  expect(document.body.textContent).not.toMatch(/thinking|typing…|getting it done|working on it/i);
});

test("the chat and the sidebar show a bot the same way at every moment: three dots in both or neither", async () => {
  const Both = () => h("div", null, h(BotsSidebar), h(BotsView));
  await show(Both);
  /** The bot's mascot in the sidebar's row is three dots. */
  const sideDots = () => !!document.querySelector('.bots-row .bot[data-dots="in"]');
  /** Each place, as [chat's row, sidebar]. */
  const both = () => [dotted(), sideDots()];
  await working("Working on it");
  expect(both()).toEqual([false, false]);
  await frames(DOTS_SETTLE + 50);
  expect(both()).toEqual([true, true]);
  // Still plain a while later (a new phrase from the server, so a fresh since): still the same in both.
  await frames(1600);
  await working("Getting it done", { since: Date.now() });
  expect(both()).toEqual([true, true]);
  // Past the dots' time, both have the mascot back together.
  await frames(DOTS_MAX - 1600 + 100);
  expect(both()).toEqual([false, false]);
  // A step, then plain words: the mascot and the step, in both, however long the plain words stand.
  await working("Checking the build");
  await working("Making progress", { since: Date.now() });
  for (let i = 0; i < 3; i++) {
    await frames(DOTS_SETTLE);
    expect(both()).toEqual([false, false]);
  }
  expect(row()).toBe("Checking the build");
  // Typing in the chat: neither.
  await status({ state: "idle" });
  await working("Working on it");
  await frames(DOTS_SETTLE + 50);
  expect(both()).toEqual([true, true]);
  await typing(true);
  expect(both()).toEqual([false, false]);
  await typing(false);
  await status({ state: "idle" });
  expect(both()).toEqual([false, false]);
});

test("the sidebar's preview says Typing… while a bot types, then goes back to the last message", async () => {
  await show(BotsSidebar);
  const preview = () => document.querySelector(".bots-row-preview")!;
  expect(preview().textContent).toBe("You: check the build");
  await typing(true);
  expect(preview().textContent).toBe("Typing…");
  expect(preview().classList.contains("bots-row-typing")).toBe(true);
  await typing(false);
  expect(preview().textContent).toBe("You: check the build");
  expect(preview().classList.contains("bots-row-typing")).toBe(false);
});
