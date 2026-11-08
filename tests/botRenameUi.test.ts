import { expect, test } from "bun:test";
import { Window } from "happy-dom";

// The app's request for a rename says which chat it was made in; other edits don't carry one.
// Each test file runs in its own process (scripts/test.ts), so the globals stay here.
const win = new Window({ url: "http://localhost/" });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(win)) if (!(key in g)) g[key] = (win as any)[key];
Object.assign(g, { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, sessionStorage: win.sessionStorage, location: win.location, history: win.history });

const look = { shape: "puff", color: "blue" };
const snapshot = { bots: [{ id: "scout", name: "Scout", look, instructions: "", memory: [], routines: [], createdAt: 1 }], conversations: [{ id: "chat", kind: "direct", botIds: ["scout"], createdAt: 1, updatedAt: 1, messages: [] }], settings: { sections: [] }, typing: {}, drafts: [], status: {} };
const patches: any[] = [];
globalThis.fetch = (async (input: string, init?: RequestInit) => {
  const path = String(input).replace(/^http:\/\/localhost/, "");
  if (path === "/api/config") return Response.json({ mode: "local", serverId: "srv", machine: "Studio" });
  const headers = { "x-openbuild-server": "srv" };
  if (path.endsWith("/api/bots")) return Response.json(snapshot, { headers });
  if (path.endsWith("/api/bots/stream")) return new Response(new ReadableStream(), { headers });
  if (init?.method === "PATCH") patches.push({ path, body: JSON.parse(String(init.body)) });
  return Response.json({ ok: true }, { headers });
}) as unknown as typeof fetch;

const { useStore } = await import("../src/lib/store");
const { switchWorkspace, useBots } = await import("../src/lib/bots/store");
const { useWorkspace } = await import("../src/lib/bots/workspace");

test("a rename names the chat it was made in, and nothing else does", async () => {
  useStore.setState({ devices: [{ id: "srv", serverId: "srv", name: "Studio", local: true, mode: "lan", urls: [], online: true }], devicesLoaded: true } as any);
  useWorkspace.setState({ localId: "srv", localName: "Studio", problem: undefined, switching: undefined });
  await switchWorkspace("srv");
  const st = useBots.getState();
  st.updateBot("scout", { name: "Atlas" }, "chat");
  st.updateBot("scout", { instructions: "Be brief." }, "chat");
  st.updateBot("scout", { name: "Scout" });
  await new Promise((r) => setTimeout(r, 100));
  expect(patches.map((p) => p.body)).toEqual([{ name: "Atlas", conversationId: "chat" }, { instructions: "Be brief." }, { name: "Scout" }]);
  expect(useBots.getState().bots[0]!.name).toBe("Scout");
});
