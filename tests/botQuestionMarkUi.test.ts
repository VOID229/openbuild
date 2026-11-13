import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// A bot's question in reply quotes and previews: a plain muted "?", never the red ❓ that reads as an error.
// Each test file runs in its own process (scripts/test.ts), so the globals stay here.
const win = new Window({ url: "http://localhost/" });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(win)) if (!(key in g)) g[key] = (win as any)[key];
Object.assign(g, { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, sessionStorage: win.sessionStorage, location: win.location, history: win.history, getComputedStyle: win.getComputedStyle.bind(win) });
g.window.matchMedia = (q: string) => ({ matches: q.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} });
g.matchMedia = g.window.matchMedia;
g.IS_REACT_ACT_ENVIRONMENT = true;

const scout = { id: "scout", name: "Scout", look: { shape: "puff", color: "blue" }, instructions: "", memory: [], routines: [], createdAt: 1 };
const question = { id: "q1", author: "scout", at: 1, text: "", question: { title: "Which branch?", options: [{ key: "A", label: "main" }, { key: "B", label: "dev" }], answer: "A" } };
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
const { messageText } = await import("../src/components/bots/common");

let root: ReturnType<typeof createRoot>;
const frames = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

async function show(messages: any[], view: any = BotsView) {
  snapshot = { bots: [scout], conversations: [{ id: "chat", kind: "direct", botIds: ["scout"], createdAt: 1, updatedAt: 1, messages }], settings: { sections: [] }, typing: {}, drafts: [], status: {} };
  await act(async () => void (await switchWorkspace("srv")));
  await frames();
  useBots.setState({ activeId: "chat" });
  await act(async () => root.render(h(view)));
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

test("a reply quoting a question shows a muted ? before the question's title", async () => {
  await show([question, { id: "m2", author: "me", at: 2, text: "main, please", replyTo: "q1" }]);
  const quote = document.querySelector('.bm-row[data-id="m2"] .bm-quote-text')!;
  expect(quote.textContent).toBe("? Which branch?");
  expect(quote.querySelector(".bots-question-mark")?.textContent).toBe("?");
  expect(document.body.textContent).not.toContain("❓");
});

test("the sidebar previews a question with the same muted ?", async () => {
  await show([question], BotsSidebar);
  const preview = document.querySelector(".bots-row-preview")!;
  expect(preview.textContent).toBe("? Which branch?");
  expect(preview.querySelector(".bots-question-mark")).not.toBeNull();
});

test("a card of several questions previews its first one and says how many more there are", async () => {
  const steps = [{ title: "Which branch?", options: [] }, { title: "Squash?", options: [] }, { title: "Delete it after?", options: [] }];
  const many = { id: "q2", author: "scout", at: 1, text: "", question: { ...steps[0], steps } };
  expect(messageText(many as any)).toBe("? Which branch? (+2 more)");
  await show([many], BotsSidebar);
  expect(document.querySelector(".bots-row-preview")!.textContent).toBe("? Which branch? (+2 more)");
});

test("copied text keeps a plain ? and other previews keep their icons", () => {
  expect(messageText(question as any)).toBe("? Which branch?");
  expect(messageText({ id: "p", author: "scout", at: 1, text: "", plan: { title: "Ship it", steps: [] } } as any)).toBe("📋 Plan: Ship it");
});
