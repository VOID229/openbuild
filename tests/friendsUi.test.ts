import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// A chat shared with a friend, as the app shows it: whose each message is, the friend's name on the
// chat, a section of its own in the sidebar with who's connected, and the friend's bots in Members.
// Each test file runs in its own process (scripts/test.ts), so the globals stay here.
const win = new Window({ url: "http://localhost/" });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(win)) if (!(key in g)) g[key] = (win as any)[key];
Object.assign(g, { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, sessionStorage: win.sessionStorage, location: win.location, history: win.history, getComputedStyle: win.getComputedStyle.bind(win) });
g.window.matchMedia = (q: string) => ({ matches: q.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} });
g.matchMedia = g.window.matchMedia;
g.IS_REACT_ACT_ENVIRONMENT = true;

const FID = "a1b2c3d4e5f6a7b8c9d0e1f2";
const juniper = { id: "juniper", name: "Juniper", look: { shape: "puff", color: "green" }, instructions: "", memory: [], routines: [], createdAt: 1 };
const scout = { id: "scout", name: "Scout", look: { shape: "orb", color: "amber" }, instructions: "", memory: [], routines: [], createdAt: 2 };
const shared = {
  id: "shared",
  kind: "group",
  name: "Picnic",
  botIds: ["juniper"],
  createdAt: 1,
  updatedAt: 5,
  friend: { friend: FID, friendName: "Alice", chat: "chat-id", members: [{ id: "bolt", name: "Bolt", look: { shape: "pill", color: "blue" } }] },
  messages: [
    { id: "m1", author: `friend:${FID}:bolt`, at: 1, text: "Hello from Bolt", from: { friend: FID, name: "Bolt", friendName: "Alice", look: { shape: "pill", color: "blue" } } },
    { id: "m2", author: `friend:${FID}:owner`, at: 2, text: "Hi, Alice here", from: { friend: FID, owner: true, name: "Alice", friendName: "Alice" } },
    { id: "m3", author: "juniper", at: 3, text: "Hey both", replyTo: "m1" },
  ],
};
const friend = { id: FID, name: "Alice", role: "guest", mode: "tailscale", status: "online", fingerprint: "a1b2-c3d4-e5f6-a7b8", addedAt: 1 };
let snapshot: any;
globalThis.fetch = (async (input: string) => {
  const path = String(input).replace(/^http:\/\/localhost/, "");
  if (path === "/api/config") return Response.json({ mode: "local", serverId: "srv", machine: "Studio" });
  const headers = { "x-openbuild-server": "srv" };
  if (path.endsWith("/api/bots")) return Response.json(snapshot, { headers });
  if (path.endsWith("/api/bots/stream")) return new Response(new ReadableStream(), { headers });
  return Response.json({ ok: true }, { headers });
}) as unknown as typeof fetch;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useStore } = await import("../src/lib/store");
const { enterWorkspace, switchWorkspace, useBots } = await import("../src/lib/bots/store");
const { useWorkspace } = await import("../src/lib/bots/workspace");
const { BotsView } = await import("../src/components/bots/BotsView");
const { BotsSidebar } = await import("../src/components/bots/BotsSidebar");
const { Members } = await import("../src/components/bots/BotDetails");

let root: ReturnType<typeof createRoot>;
const frames = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

async function show(view: any) {
  snapshot = { bots: [juniper, scout], conversations: [shared], settings: { sections: [] }, typing: {}, drafts: [], status: {}, friends: [friend] };
  await act(async () => void (await switchWorkspace("srv")));
  await frames();
  useBots.setState({ activeId: "shared" });
  await act(async () => root.render(view));
  await frames();
}

beforeEach(() => {
  useStore.setState({ devices: [{ id: "srv", serverId: "srv", name: "Studio", local: true, mode: "lan", urls: [], online: true }], devicesLoaded: true, chats: [] } as any);
  useWorkspace.setState({ localId: "srv", localName: "Studio", problem: undefined, switching: undefined });
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  enterWorkspace("away");
});

test("a shared chat names each friend's message for who wrote it, and offers text only", async () => {
  await show(h(BotsView));
  const names = [...document.querySelectorAll(".bm-name")].map((n) => n.textContent);
  expect(names).toEqual(["Bolt · Alice", "Alice · friend", "Juniper"]);
  // The friend's part of the name is the quiet tag.
  expect([...document.querySelectorAll(".bm-name-friend")].map((n) => n.textContent)).toEqual([" · Alice", " · friend"]);
  // A reply quoting the friend's bot names it.
  expect(document.querySelector('.bm-row[data-id="m3"] .bm-quote-who')?.textContent).toBe("Bolt");
  expect(document.querySelector(".bots-head-name")?.textContent).toBe("Picnic · Alice");
  // Photos and polls don't cross to the friend, so they aren't offered.
  expect(document.querySelector('[aria-label="Add images"]')).toBeNull();
  expect(document.querySelector('[aria-label="New poll"]')).toBeNull();
  expect(document.querySelector('[aria-label="Add to message"]')).toBeNull();
});

test("the sidebar files shared chats under With friends, with who's connected", async () => {
  await show(h(BotsSidebar));
  const headings = [...document.querySelectorAll(".history-heading")].map((n) => n.textContent);
  expect(headings.some((t) => t?.startsWith("With friends"))).toBe(true);
  const row = [...document.querySelectorAll(".bots-row")].find((r) => r.querySelector(".bots-row-title")?.textContent === "Picnic")!;
  expect(row.querySelector(".bots-row-tag")?.textContent).toBe("· Alice");
  expect(row.querySelector(".bots-row-preview")?.textContent).toBe("Juniper: Hey both");
  const line = document.querySelector(".bots-friends-line")!;
  expect(line.textContent).toBe("Alice");
  expect(line.querySelector(".bots-friend-dot-on")?.getAttribute("aria-label")).toBe("Connected");
});

test("Members shows the friend's bots as theirs, and yours can all leave", async () => {
  await show(h(Members, { conversation: shared, bots: [juniper, scout] } as any));
  const labels = [...document.querySelectorAll(".bots-pane-label")].map((n) => n.textContent);
  expect(labels).toEqual(["Alice's bots", "Yours", "Bring in"]);
  const cards = [...document.querySelectorAll(".bots-card-text")].map((n) => n.textContent);
  expect(cards).toEqual(["Bolt", "Juniper", "Scout"]);
  // Down to one of yours, it can still go: the friend's bots are there.
  expect(document.querySelector('[aria-label="Remove from group"]')).not.toBeNull();
});
