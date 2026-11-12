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
const row = () => document.querySelector(".bm-working-text")?.textContent;
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

test("the chat's working row shows each step as its status arrives, and nothing of it once it's over", async () => {
  await show();
  expect(row()).toBeUndefined();
  await working("Working on it");
  expect(row()).toBe("Working on it");
  expect(document.querySelector(".bm-working")!.getAttribute("aria-label")).toBe("Scout: Working on it");
  // Each status replaces the last in the tick it arrives: the line is a new element, not a stale one fading out.
  const steps = ["Running a command", "Checking why the build failed", "Getting it done", "Reading notes.md", "Making progress"];
  for (const step of steps) {
    const before = document.querySelector(".bm-working-text");
    await working(step);
    expect(row()).toBe(step);
    expect(document.querySelectorAll(".bm-working-text").length).toBe(1);
    expect(document.querySelector(".bm-working-text")).not.toBe(before);
  }
  // Writing: "Typing…" takes over from the row, in words where the dots used to be.
  await typing(true);
  expect(row()).toBeUndefined();
  const indicator = document.querySelector(".bm-typing")!;
  expect(indicator.textContent).toBe("Typing…");
  expect(indicator.getAttribute("aria-label")).toBe("Scout is typing");
  expect(indicator.children.length).toBe(0);
  await typing(false);
  // Quiet work (after a message went out) shows no row, and an idle bot none either.
  await working("Sorting it out", { quiet: true });
  expect(row()).toBeUndefined();
  await working("Running the tests");
  expect(row()).toBe("Running the tests");
  await status({ state: "idle" });
  expect(row()).toBeUndefined();
});

test("a status with no line, or an older server's Thinking, reads as plain work: the app never says Thinking", async () => {
  await show(BotsView, { scout: { state: "working", conversationId: "chat", activity: "Thinking" } });
  expect(row()).toBe("Working on it");
  await working();
  expect(row()).toBe("Working on it");
  await working("Thinking…");
  expect(row()).toBe("Working on it");
  await working("Reading notes.md");
  expect(row()).toBe("Reading notes.md");
  expect(document.body.textContent).not.toMatch(/thinking/i);
});

test("on a phone the header's line under the name is the live step, and Typing… while it types", async () => {
  phone = true;
  await show();
  // Nothing going on: no live line (a direct chat has no member list to show either).
  expect(document.querySelector(".bots-head-sub-live")).toBeNull();
  await working("Thinking");
  expect(head()).toBe("Working on it");
  expect(document.querySelector(".bots-head-sub")!.classList.contains("bots-head-sub-live")).toBe(true);
  await working("Watching CI on #115");
  expect(head()).toBe("Watching CI on #115");
  // The same words as the chat's row beneath it.
  expect(row()).toBe("Watching CI on #115");
  await typing(true);
  expect(head()).toBe("Typing…");
  await typing(false);
  expect(head()).toBe("Watching CI on #115");
  await working("Getting it done");
  expect(head()).toBe("Getting it done");
  await status({ state: "idle" });
  expect(document.querySelector(".bots-head-sub-live")).toBeNull();
  expect(document.body.textContent).not.toMatch(/thinking|typing…/i);
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
