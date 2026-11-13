import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// A bot reading something, in the app, rendered in a DOM and fed through the real event stream: its
// mascot reads along wherever it shows (the sidebar, the chat's header, the working row, a group's
// huddle) for as long as its status says it's reading, and goes back to its working life the
// moment the step is over. Typing, it's typing, not reading. (Motion is reduced here, so a reading
// mascot is held looking down at the page: tests/botAvatarLife.test.ts watches it move in Chrome.)
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


const readers = (scope = document) => [...scope.querySelectorAll(".bot[data-reading]")];
const both = () => h("div", null, h(BotsSidebar), h(BotsView));
const where = () => ({
  sidebar: readers().filter((b) => b.closest(".bots-sidebar-avatar")).length,
  head: readers().filter((b) => b.closest(".bots-head")).length,
  row: readers().filter((b) => b.closest(".bm-working")).length,
});

test("while its status says it's reading, its mascot reads in the sidebar, the chat's header and the working row, and stops when that's over", async () => {
  await show(both);
  await working("Running a command");
  expect(document.querySelector(".bm-working .bot[data-busy]")).not.toBeNull();
  expect(where()).toEqual({ sidebar: 0, head: 0, row: 0 });
  await working("Reading notes.md", { reading: true });
  expect(where()).toEqual({ sidebar: 1, head: 1, row: 1 });
  // Its eyes are lowered onto the page, looking down.
  for (const b of readers()) expect(b.getAttribute("data-eyes")).toBe("read");
  expect(readers().every((b) => /rotateX\(-/.test((b.querySelector(".bot-body") as HTMLElement).style.transform))).toBe(true);
  // The step is over: back to work, its eyes the big ones of a bot at work.
  await working("Getting it done");
  expect(where()).toEqual({ sidebar: 0, head: 0, row: 0 });
  expect(document.querySelector('.bm-working .bot[data-eyes="read"]')).toBeNull();
  // Typing a reply while a read runs beside it: it's typing.
  await working("Reading notes.md", { reading: true });
  await typing(true);
  expect(where().row).toBe(0);
  await typing(false);
  expect(where().row).toBe(1);
  // Done: nothing reads.
  await status({ state: "idle" });
  expect(readers()).toEqual([]);
});

test("a bot still deciding whether a group message is its own doesn't read, however it reads", async () => {
  await show(both);
  await working("Reading notes.md", { reading: true, deciding: true });
  expect(readers()).toEqual([]);
  await working("Reading notes.md", { reading: true });
  expect(readers().length).toBeGreaterThan(0);
});
