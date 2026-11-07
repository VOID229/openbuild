import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// No workspace picker, another device's references and the host's grant, clicked at in a DOM. Each
// test file runs in its own process (scripts/test.ts), so the globals stay here.
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
const all = { files: true, terminal: true, browser: true, unisolated: true };
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
  if (path === "/api/devices") return Response.json({ devices });
  if (path === "/api/paired-clients") return Response.json({ clients: [{ id: "c1", name: "Laptop", createdAt: 1, workspace: true }] });
  if (path.startsWith("/api/paired-clients/")) return Response.json({ botTools: { ...all, ...requests.at(-1)!.body.botTools } });
  if (path === "/api/bots/targets") return Response.json({ targets: [{ device: "local", name: "Studio", status: "ready", grants: all }, { device: "host", name: "Host Box", status: "ready", grants: all }] });
  return Response.json({});
}) as unknown as typeof fetch;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useStore } = await import("../src/lib/store");
const { enterWorkspace, switchWorkspace, useBots } = await import("../src/lib/bots/store");
const { useWorkspace } = await import("../src/lib/bots/workspace");
const { BotsSidebar } = await import("../src/components/bots/BotsSidebar");
const { BotsView } = await import("../src/components/bots/BotsView");
const { DevicesSection } = await import("../src/components/DeviceSettings");
const { BotComputer } = await import("../src/components/bots/BotAdvanced");

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
  localStorage.clear();
});

test("the sidebar has no workspace picker, even with paired devices online, and lists this server's chats", async () => {
  useStore.setState({ botsSidebarOpen: true } as any);
  useBots.setState({ bots: [bot], conversations: [chat("local-chat")], loaded: true } as any);
  await act(async () => root.render(h(BotsSidebar)));
  await frames();
  expect(document.querySelector(".bots-workspace, .bots-workspace-menu, [aria-label^='Workspace:']")).toBeNull();
  expect(document.querySelector("[role='menuitemradio']")).toBeNull();
  expect(document.body.textContent).not.toContain("Host Box");
  expect(document.body.textContent).not.toContain("Old Mini");
  expect(document.body.textContent).toContain("Scout");
  expect(useBots.getState().workspace).toBe("srv");
  expect(requests.filter((r) => r.path.startsWith("/api/workspace/via/"))).toEqual([]);
});

test("without the picker, a bot in this server's workspace still runs its tools on a paired device", async () => {
  useBots.setState({ bots: [bot] } as any);
  const View = () => h(BotComputer, { bot: useBots((s) => s.bots[0]!) });
  await act(async () => root.render(h(View)));
  await frames();
  await click(document.querySelector('button[aria-label="Runs on"]')!);
  const host = [...document.querySelectorAll('[role="listbox"][aria-label="Runs on"] [role="option"]')].find((o) => o.textContent === "Host Box")!;
  await click(host);
  await frames();
  // Saved on this server, through its own bound route, not through the host's workspace.
  expect(requests.filter((r) => r.method === "PATCH").at(-1)).toMatchObject({ path: "/api/workspace/to/srv/api/bots/bot", body: { computer: { device: "host", kind: "container" } } });
  expect(useBots.getState().bots[0]!.computer).toEqual({ device: "host", kind: "container" });
  expect(useBots.getState().workspace).toBe("srv");
});

test("the picker's component and styles are gone", async () => {
  expect(await Bun.file("src/components/bots/WorkspacePicker.tsx").exists()).toBe(false);
  for (const file of ["src/bots.css", "src/mobile.css"]) {
    const css = await Bun.file(file).text();
    expect(css).not.toMatch(/\.bots-workspace(-(menu|item|list|check|label|title|note|status|name|open|remote))?\b(?!-trouble)/);
  }
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

test("Settings → Devices has no OpenBots workspace switch for a device using this one, and keeps its bot tool grants", async () => {
  await act(async () => root.render(h(DevicesSection)));
  await frames();
  expect(el.textContent).toContain("Laptop");
  expect(el.textContent).not.toContain("Use OpenBots workspace");
  expect(document.querySelector('[aria-label="Let Laptop use OpenBots workspace"]')).toBeNull();
  // The bot tool grants stay, each its own switch, and saving one doesn't touch the workspace grant.
  const terminal = [...document.querySelectorAll<HTMLElement>("[role='switch'], button[aria-checked]")].find((t) => /terminal/i.test(t.getAttribute("aria-label") ?? ""))!;
  expect(terminal).toBeTruthy();
  g.confirm = () => true;
  await click(terminal);
  await frames();
  const patch = requests.filter((r) => r.method === "PATCH").at(-1)!;
  expect(patch.path).toBe("/api/paired-clients/c1");
  expect(patch.body).toEqual({ botTools: { terminal: true } });
});

// What a tab left in this browser for the host's workspace, from when it could open it.
const kept = [
  { id: "u1", workspace: "host", at: 1_700_000_000_000, label: "Message “ship the fix”", method: "POST", path: "/api/bots/conversations/host-chat/messages", body: { id: "m-host", author: "me", text: "ship the fix" }, check: { kind: "message", conversationId: "host-chat", messageId: "m-host" }, error: "Host Box is unreachable" },
  { id: "u2", workspace: "host", at: 1_700_000_100_000, label: "Reaction 👍", method: "PATCH", path: "/api/bots/conversations/host-chat/messages/m1", body: { emoji: "👍", on: true }, check: { kind: "reaction", conversationId: "host-chat", messageId: "m1", emoji: "👍", on: true }, error: "No answer" },
];

test("changes kept for another device's workspace stay discoverable here, named for their owner, and are never sent here or there", async () => {
  localStorage.setItem("openbuild.bots.unconfirmed:host", JSON.stringify(kept));
  const stored = localStorage.getItem("openbuild.bots.unconfirmed:host");
  useBots.setState({ conversations: [chat("local-chat")], loaded: true, activeId: "local-chat" } as any);
  await act(async () => root.render(h(BotsView)));
  await frames();
  const notice = document.querySelector<HTMLElement>('[aria-label="Kept for Host Box"]')!;
  expect(notice).toBeTruthy();
  expect(notice.textContent).toContain("2 changes kept for Host Box");
  expect(notice.textContent).toContain("they aren't sent to this server");
  expect(notice.textContent).toContain("ship the fix");
  expect(notice.textContent).toContain("Reaction 👍");
  // This workspace's own not-confirmed list doesn't take them on, and nothing offers a retry.
  expect(useBots.getState().unconfirmed).toEqual([]);
  expect(notice.querySelector("button[aria-label^='Dismiss']")).toBeNull();
  expect(byText("button", "Retry")).toBeUndefined();
  // A copy can be saved, as a download in this browser only.
  let saved: Blob | undefined;
  const create = URL.createObjectURL;
  URL.createObjectURL = (b: Blob) => ((saved = b), "blob:kept");
  try {
    await click(byText("button", "Save a copy")!);
  } finally {
    URL.createObjectURL = create;
  }
  expect(JSON.parse(await saved!.text())).toEqual({ workspace: "host", name: "Host Box", entries: kept });
  // Nothing went to the host or to this server's conversations, and what's kept is as it was.
  expect(requests.filter((r) => r.path.includes("/host/") || (r.method !== "GET" && r.path.includes("/conversations/")))).toEqual([]);
  expect(localStorage.getItem("openbuild.bots.unconfirmed:host")).toBe(stored);
});

test("this workspace's own not-confirmed changes aren't listed as kept for another device", async () => {
  localStorage.setItem("openbuild.bots.unconfirmed:srv", JSON.stringify([{ ...kept[0], workspace: "srv" }]));
  useBots.setState({ conversations: [chat("local-chat")], loaded: true } as any);
  await act(async () => root.render(h(BotsView)));
  await frames();
  expect(document.querySelector(".bots-kept")).toBeNull();
});
