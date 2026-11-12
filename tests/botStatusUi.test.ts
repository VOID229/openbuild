import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// A bot's status in the app, rendered in a DOM and fed through the real event stream: the chat's
// working row, the header's line on a phone and the sidebar's preview all read the same status, show
// each step as its event arrives, and never say "Thinking".
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

test("the chat's working row shows each step as its status arrives, three dots for plain work, and nothing once it's over", async () => {
  await show();
  expect(row()).toBeUndefined();
  await working("Working on it");
  // Plain work: no words, only the mascot turned into three dots. The row still says it for a screen reader.
  expect(row()).toBeUndefined();
  expect(dotted()).toBe(true);
  expect(document.querySelector(".bm-working-text")).toBeNull();
  expect(document.querySelector(".bm-working")!.getAttribute("aria-label")).toBe("Scout: Working on it");
  // Each step replaces the last in the tick it arrives: the line is a new element, not a stale one
  // fading out, and the dots are the mascot again at once.
  for (const step of ["Running a command", "Checking why the build failed", "Reading notes.md"]) {
    const before = document.querySelector(".bm-working-text");
    await working(step);
    expect(row()).toBe(step);
    expect(dotted()).toBe(false);
    expect(document.querySelectorAll(".bm-working-text").length).toBe(1);
    expect(document.querySelector(".bm-working-text")).not.toBe(before);
  }
  // Plain words between steps: the last step stays a moment, then goes as the mascot turns into dots.
  await working("Getting it done");
  expect(row()).toBe("Reading notes.md");
  expect(dotted()).toBe(false);
  await frames(400);
  expect(row()).toBeUndefined();
  expect(dotted()).toBe(true);
  expect(document.querySelector(".bm-working-text[data-gone]")!.getAttribute("aria-hidden")).toBe("true");
  // A step that's over in a moment doesn't set the mascot going back and forth.
  await working("Running the tests");
  expect(row()).toBe("Running the tests");
  expect(dotted()).toBe(false);
  // It comes back in after the mascot, once it's itself again.
  expect(document.querySelector(".bm-working-text")!.hasAttribute("data-back")).toBe(true);
  await working("Making progress");
  await working("Reading a file");
  expect(row()).toBe("Reading a file");
  expect(dotted()).toBe(false);
  expect(document.querySelector(".bm-working-text")!.hasAttribute("data-back")).toBe(false);
  // No generic words anywhere in the chat, whichever of them the status says.
  for (const plain of ["Sorting it out", "Keeping at it", "Making progress"]) {
    await working(plain);
    await frames(400);
    expect(dotted()).toBe(true);
    expect(row()).toBeUndefined();
  }
  // Writing: "Typing…" takes over from the row, in words where the dots used to be.
  await typing(true);
  expect(document.querySelector(".bm-working")).toBeNull();
  const indicator = document.querySelector(".bm-typing")!;
  expect(indicator.textContent).toBe("Typing…");
  expect(indicator.getAttribute("aria-label")).toBe("Scout is typing");
  expect(indicator.children.length).toBe(0);
  await typing(false);
  // Quiet work (after a message went out) shows no row, and an idle bot none either.
  await working("Sorting it out", { quiet: true });
  expect(document.querySelector(".bm-working")).toBeNull();
  await working("Running the tests");
  expect(row()).toBe("Running the tests");
  await status({ state: "idle" });
  expect(document.querySelector(".bm-working")).toBeNull();
});

test("a holding line is a step of its own: it keeps its words", async () => {
  await show(BotsView, { scout: { state: "working", conversationId: "elsewhere", activity: "Running the tests", waiting: ["chat"] } });
  expect(row()).toMatch(/^(Hold on a second|Finishing up something|One moment, wrapping something up|Be right with you)$/);
  expect(dotted()).toBe(false);
});

test("a status with no line, or an older server's Thinking, reads as plain work: dots, and the app never says Thinking", async () => {
  await show(BotsView, { scout: { state: "working", conversationId: "chat", activity: "Thinking" } });
  expect(dotted()).toBe(true);
  expect(row()).toBeUndefined();
  await working();
  expect(dotted()).toBe(true);
  await working("Thinking…");
  expect(dotted()).toBe(true);
  await working("Reading notes.md");
  expect(row()).toBe("Reading notes.md");
  expect(document.body.textContent).not.toMatch(/thinking/i);
});

test("on a phone the header's line under the name is the live step, three dots for plain work, and Typing… while it types", async () => {
  phone = true;
  await show();
  // Nothing going on: no live line (a direct chat has no member list to show either).
  expect(document.querySelector(".bots-head-sub-live")).toBeNull();
  expect(headDots()).toBeNull();
  await working("Thinking");
  // Plain work: three dots and no words, named for a screen reader.
  expect(headDots()!.children.length).toBe(3);
  expect(headDots()!.textContent).toBe("");
  expect(headDots()!.getAttribute("aria-label")).toBe("Working on it");
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
  await working("Getting it done");
  expect(head()).toBe("");
  expect(headDots()).not.toBeNull();
  await status({ state: "idle" });
  expect(document.querySelector(".bots-head-sub-live")).toBeNull();
  expect(headDots()).toBeNull();
  expect(document.body.textContent).not.toMatch(/thinking|typing…|getting it done|working on it/i);
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
