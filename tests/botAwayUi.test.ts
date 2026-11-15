import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// A bot at work in another chat than the one open, rendered in a DOM and fed through the real event
// stream: the chat it isn't in says what it's doing there (a row with its mascot, calmer than at work,
// the header's line, its sidebar row), by names the viewer can see, and goes back to normal when the
// turn ends. A chat the viewer can't see is only "another chat".
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
/** Scout at work in `where`. */
const at = (where: string, activity: string, more: Record<string, unknown> = {}) => status({ state: "working", conversationId: where, activity, since: Date.now(), ...more });
const typing = (where: string, on: boolean) => event({ t: "typing", conversationId: where, botIds: on ? ["scout"] : [] });
const head = () => document.querySelector(".bots-head-sub")?.textContent;

const pip = { id: "pip", name: "Pip", look: { shape: "cloud", color: "orange" }, instructions: "", memory: [], routines: [], createdAt: 1 };
const conv = (c: Record<string, unknown>) => ({ createdAt: 1, updatedAt: 1, messages: [], ...c });
async function show(view: any = BotsView, active = "chat") {
  snapshot = {
    bots: [scout, pip],
    conversations: [
      conv({ id: "chat", kind: "direct", botIds: ["scout"], messages: [{ id: "m1", author: "me", at: 1, text: "check the build" }] }),
      conv({ id: "pipchat", kind: "direct", botIds: ["pip"], messages: [{ id: "m2", author: "pip", at: 1, text: "Will do." }] }),
      conv({ id: "dev", kind: "group", name: "OpenBuild Dev", botIds: ["scout", "pip"], messages: [{ id: "m3", author: "me", at: 1, text: "ship it" }] }),
      conv({ id: "secret", kind: "group", name: "Surprise party", botIds: ["scout", "pip"], hidden: true }),
      conv({ id: "ask", kind: "side", botIds: ["scout", "pip"] }),
    ],
    settings: { sections: [] }, typing: {}, drafts: [], status: {},
  };
  await act(async () => void (await switchWorkspace("srv")));
  await frames();
  useBots.setState({ activeId: active });
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

/** The away row in the chat: its words, and its mascot. */
const awayRow = () => document.querySelector(".bm-away .bm-away-text")?.textContent;
const awayMascot = () => document.querySelector(".bm-away .bot");
/** Scout's row in the sidebar: what it says under the name, and its mascot. */
const scoutRow = () => [...document.querySelectorAll(".bots-row")].find((r) => r.querySelector(".bots-row-title")?.textContent === "Scout")!;
const scoutPreview = () => scoutRow().querySelector(".bots-row-preview")!.textContent;
const scoutMascot = () => scoutRow().querySelector(".bot")!;
const Both = () => h("div", null, h(BotsSidebar), h(BotsView));

test("busy in a group, its own chat says what it's doing there, everywhere its status shows, with a calm mascot, until the turn ends", async () => {
  phone = true;
  await show(Both);
  expect(document.querySelector(".bm-away")).toBeNull();
  expect(scoutPreview()).toBe("You: check the build");
  await at("dev", "Running the test suite");
  // The chat: a row with its mascot, calm (not at work here), and what it's doing where.
  expect(awayRow()).toBe("Running the test suite in the OpenBuild Dev group");
  expect(awayMascot()!.hasAttribute("data-away")).toBe(true);
  expect(awayMascot()!.hasAttribute("data-busy")).toBe(false);
  expect(document.querySelector(".bm-away")!.getAttribute("aria-label")).toBe("Running the test suite in the OpenBuild Dev group");
  // Nothing says it's at work here: no working row, no live line.
  expect(document.querySelector(".bm-working:not(.bm-away)")).toBeNull();
  expect(document.querySelector(".bots-head-sub-live")).toBeNull();
  // The header's line, and its sidebar row, say the same; its mascots there are calm too.
  expect(head()).toBe("Running the test suite in the OpenBuild Dev group");
  expect(scoutPreview()).toBe("Running the test suite in the OpenBuild Dev group");
  expect(scoutMascot().hasAttribute("data-away")).toBe(true);
  expect(document.querySelector(".bots-head .bot")!.hasAttribute("data-away")).toBe(true);
  // In the group itself it's at work, not away.
  const devMascots = [...document.querySelectorAll(".bots-row")].find((r) => r.querySelector(".bots-row-title")?.textContent === "OpenBuild Dev")!.querySelectorAll(".bot[data-busy]");
  expect(devMascots.length).toBe(1);
  // Its next step there, and writing there.
  await at("dev", "Writing a reply");
  expect(awayRow()).toBe("Posting in the OpenBuild Dev group");
  await at("dev", "Reading the logs", { from: "chat" });
  expect(awayRow()).toBe("Reading the logs for this in the OpenBuild Dev group");
  await typing("dev", true);
  expect(awayRow()).toBe("Posting about this in the OpenBuild Dev group");
  await typing("dev", false);
  // Its turn ends: everything as it was.
  await status({ state: "idle" });
  expect(document.querySelector(".bm-away")).toBeNull();
  expect(scoutPreview()).toBe("You: check the build");
  expect(scoutMascot().hasAttribute("data-away")).toBe(false);
  expect(document.body.textContent).not.toMatch(/OpenBuild Dev group/);
});

test("in a group, a member busy messaging another bot is said by name, and coming here to type ends it", async () => {
  phone = true;
  await show(BotsView, "dev");
  await at("ask", "Writing a reply", { from: "dev" });
  expect(awayRow()).toBe("Scout is messaging Pip about this");
  expect(head()).toBe("Scout is messaging Pip about this");
  // Pip, at rest, dozes in the group's huddle; Scout is awake and calm, not at work.
  expect(awayMascot()!.hasAttribute("data-away")).toBe(true);
  // Typing here, it's here.
  await typing("dev", true);
  expect(document.querySelector(".bm-away")).toBeNull();
  await typing("dev", false);
  await status({ state: "idle" });
  expect(document.querySelector(".bm-away")).toBeNull();
});

test("a chat the viewer can't see is never named, and nothing of what's going on there shows", async () => {
  phone = true;
  await show(Both);
  await at("secret", "Ordering the cake");
  expect(awayRow()).toBe("Busy in another chat");
  expect(head()).toBe("Busy in another chat");
  expect(scoutPreview()).toBe("Busy in another chat");
  // (A hidden chat is still listed under Hidden in the sidebar, as ever; nothing busy says where it is.)
  for (const el of document.querySelectorAll(".bm-away, .bots-head, .bots-row-away")) expect(el.textContent + (el.getAttribute("aria-label") ?? "")).not.toMatch(/Surprise|cake/i);
  expect(document.body.textContent).not.toMatch(/cake/i);
  // Nor a chat that isn't loaded here at all.
  await at("elsewhere-entirely", "Ordering the cake");
  expect(awayRow()).toBe("Busy in another chat");
  expect(document.body.textContent).not.toMatch(/cake/i);
});

test("with its message next in line here, it's holding on, not away", async () => {
  await show();
  await at("dev", "Running the test suite", { waiting: ["chat"] });
  expect(document.querySelector(".bm-away")).toBeNull();
  expect(document.querySelector(".bm-working-text")!.textContent).toMatch(/^(Hold on a second|Finishing up something|One moment, wrapping something up|Be right with you)$/);
});
