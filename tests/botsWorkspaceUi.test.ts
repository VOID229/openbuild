import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// The workspace picker, the switch dialog, another device's references and the host's grant, clicked
// at in a DOM. Each test file runs in its own process (scripts/test.ts), so the globals stay here.
const win = new Window({ url: "http://localhost/" });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(win)) if (!(key in g)) g[key] = (win as any)[key];
Object.assign(g, { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, sessionStorage: win.sessionStorage, location: win.location, history: win.history, getComputedStyle: win.getComputedStyle.bind(win) });
// A desktop that asks for less motion (the spinner then has no animation for happy-dom to cancel).
g.window.matchMedia = (q: string) => ({ matches: q.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} });
g.matchMedia = g.window.matchMedia;
g.IS_REACT_ACT_ENVIRONMENT = true;

let requests: { method: string; path: string; body?: any }[] = [];
let hold: (path: string, method: string) => Promise<Response> | undefined = () => undefined;
const chat = (id: string, messages: any[] = []) => ({ id, kind: "direct", botIds: ["bot"], createdAt: 1, updatedAt: 1, messages });
const bot = { id: "bot", name: "Scout", look: { shape: "puff", color: "blue" }, instructions: "", memory: [], routines: [], createdAt: 1, computer: { device: "local", kind: "container" } };
const snapshots: Record<string, any> = {};
globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
  const path = String(input).replace(/^http:\/\/localhost/, "");
  const method = init.method ?? "GET";
  requests.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
  if (path === "/api/config") return Response.json({ mode: "local", serverId: "srv", machine: "Studio" });
  const held = hold(path, method);
  if (held) return held;
  const m = /^\/api\/workspace\/(?:to|via)\/([^/]+)(\/.*)$/.exec(path);
  if (m) {
    const headers = { "x-openbuild-server": m[1]! };
    if (m[2] === "/api/bots") return Response.json(snapshots[m[1]!], { headers });
    if (m[2] === "/api/bots/stream") return new Response(new ReadableStream(), { headers });
    return Response.json({ ok: true }, { headers });
  }
  if (path.startsWith("/api/paired-clients/")) return Response.json({ workspace: requests.at(-1)!.body.workspace });
  return Response.json({});
}) as unknown as typeof fetch;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useStore } = await import("../src/lib/store");
const { enterWorkspace, switchWorkspace, useBots } = await import("../src/lib/bots/store");
const { useWorkspace } = await import("../src/lib/bots/workspace");
const { WorkspacePicker, WorkspaceSwitchDialog } = await import("../src/components/bots/WorkspacePicker");
const { BotsView } = await import("../src/components/bots/BotsView");
const { WorkspaceAccess } = await import("../src/components/BotAccess");

const devices = [
  { id: "srv", serverId: "srv", name: "Studio", local: true, mode: "lan", urls: [], online: true },
  { id: "host", serverId: "host", name: "Host Box", mode: "lan", urls: ["http://host"], status: "online", online: true },
  { id: "mini", serverId: "mini", name: "Old Mini", mode: "lan", urls: ["http://mini"], status: "offline", online: false },
];
let root: ReturnType<typeof createRoot>;
let el: HTMLElement;
const frames = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const click = (target: Element) => act(async () => { target.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as any); });
const byText = (selector: string, text: string) => [...document.querySelectorAll(selector)].find((e) => e.textContent?.includes(text));

beforeEach(async () => {
  requests = [];
  hold = () => undefined;
  snapshots.srv = { bots: [bot], conversations: [chat("local-chat")], settings: { sections: [] }, typing: {}, drafts: [], status: {} };
  snapshots.host = { bots: [bot], conversations: [chat("host-chat")], settings: { sections: [] }, typing: {}, drafts: [], status: {} };
  useStore.setState({ devices, devicesLoaded: true } as any);
  useWorkspace.setState({ localId: "srv", localName: "Studio", problem: undefined, switching: undefined });
  enterWorkspace("srv");
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

test("the picker lists this device and each paired one, and choosing one moves this tab there", async () => {
  await act(async () => root.render(h(WorkspacePicker)));
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Workspace: Studio"]')!;
  expect(trigger).toBeTruthy();
  await click(trigger);
  const items = [...document.querySelectorAll('[role="menuitemradio"]')];
  expect(items.map((i) => i.textContent)).toEqual(["StudioThis device", "Host Box", "Old MiniOffline"]);
  expect(items[0]!.getAttribute("aria-checked")).toBe("true");
  await click(items[1]!);
  await frames();
  expect(useBots.getState().workspace).toBe("host");
  expect(useBots.getState().conversations.map((c) => c.id)).toEqual(["host-chat"]);
  expect(sessionStorage.getItem("openbuild.workspace")).toBe("host");
  expect(new URL(location.href).searchParams.get("workspace")).toBe("host");
  expect(document.querySelector('button[aria-label="Workspace: Host Box"]')).toBeTruthy();
  // Back on this device, the address no longer names a workspace.
  await act(async () => void (await switchWorkspace("srv")));
  expect(new URL(location.href).searchParams.get("workspace")).toBeNull();
});

test("a switch with a change on its way shows what it waits for, and Cancel stays put", async () => {
  await frames();
  let answer!: (r: Response) => void;
  hold = (path, method) => (method === "POST" && path.endsWith("/messages") ? new Promise((r) => (answer = r)) : undefined);
  await act(async () => root.render(h("div", null, h(WorkspacePicker), h(WorkspaceSwitchDialog))));
  const sent = useBots.getState().post("local-chat", { author: "me", text: "still sending" });
  await frames();
  await click(document.querySelector('button[aria-label="Workspace: Studio"]')!);
  await click(byText('[role="menuitemradio"]', "Host Box")!);
  await frames();
  const dialog = document.querySelector('dialog[aria-label="Switching to Host Box"]')!;
  expect(dialog.textContent).toContain("Waiting for 1 change to Studio…");
  await click(byText("dialog button", "Cancel")!);
  await frames();
  expect(document.querySelector("dialog")).toBeNull();
  expect(useBots.getState().workspace).toBe("srv");
  // The write wasn't cut short: it still gets its answer here.
  answer(Response.json({ ok: true }, { headers: { "x-openbuild-server": "srv" } }));
  expect((await sent)?.text).toBe("still sending");
  expect(useBots.getState().workspace).toBe("srv");
});

test("in another device's workspace, its threads, files and apps resolve there or say they can't be opened here", async () => {
  snapshots.host = {
    bots: [bot],
    conversations: [chat("host-chat", [
      { id: "e1", author: "bot", at: 1, text: "", event: { kind: "thread", text: "Started a thread", detail: "Fix the build", threadId: "t-on-host" } },
      { id: "m1", author: "bot", at: 2, text: "Here's the log: file:///home/bot/build.log" },
      { id: "m2", author: "bot", at: 3, text: "", connect: { app: "github" } },
    ])],
    settings: { sections: [] }, typing: {}, drafts: [], status: {},
  };
  // A thread with that id on this device too: it mustn't be what the link opens.
  useStore.setState({ chats: [{ id: "t-on-host", title: "Local namesake", messages: [], createdAt: 1, updatedAt: 1 }] } as any);
  await act(async () => void (await switchWorkspace("host")));
  await frames();
  useBots.setState({ activeId: "host-chat" });
  await act(async () => root.render(h(BotsView)));
  await frames();
  const unavailable = document.querySelector(".bm-unavailable")!;
  expect(unavailable.textContent).toContain("Fix the build");
  expect(unavailable.textContent).toContain("(on Host Box)");
  expect(document.querySelector('a[href*="t-on-host"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Local namesake");
  const file = [...document.querySelectorAll("a")].find((a) => a.textContent?.includes("build.log"))!;
  expect(file.getAttribute("href")).toBe(`/api/workspace/via/host/api/bots/bot/file?url=${encodeURIComponent("file:///home/bot/build.log")}`);
  expect(document.body.textContent).toContain("Apps for these bots are connected on Host Box");
  expect(document.querySelector('img[src*="/api/bots/apps/"]')).toBeNull();
  expect(byText("button", "Connect")).toBeUndefined();
  // Setting the bot up stays on the host: no details panel here.
  expect(document.querySelector(".bots-details")).toBeNull();
  expect(requests.filter((r) => r.path.startsWith("/api/bots/apps"))).toEqual([]);
});

test("a workspace that isn't here anymore shows nothing of its own or this server's, with a way back home", async () => {
  hold = (path) => (path.startsWith("/api/workspace/via/gone-srv/") ? Promise.resolve(Response.json({ error: "not paired", reason: "unpaired" }, { status: 404 })) : undefined);
  await act(async () => void (await switchWorkspace("gone-srv")));
  await frames();
  await act(async () => root.render(h(BotsView)));
  await frames();
  expect(useWorkspace.getState().problem?.kind).toBe("gone");
  expect(document.body.textContent).toContain("This workspace is no longer here");
  expect(document.body.textContent).not.toContain("local-chat");
  await click(byText("button", "Open Studio's workspace")!);
  await frames();
  expect(useBots.getState().workspace).toBe("srv");
});

test("the host's grant is off until its own session turns it on, and says bots act with all their permissions", async () => {
  let asked = "";
  g.confirm = (q: string) => ((asked = q), true);
  await act(async () => root.render(h(WorkspaceAccess, { client: { id: "c1", name: "Laptop", createdAt: 1 } })));
  const toggle = document.querySelector<HTMLElement>('[aria-label="Let Laptop use OpenBots workspace"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  const text = el.textContent!;
  expect(text).toContain("Use OpenBots workspace");
  expect(text).toContain("all their permissions here");
  expect(text.toLowerCase()).not.toContain("read-only");
  await click(toggle);
  await frames();
  expect(asked).toContain("all the access they have here");
  expect(requests.at(-1)).toEqual({ method: "PATCH", path: "/api/paired-clients/c1", body: { workspace: true } });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});
