import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// Where a bot's computer runs, clicked at in a DOM: the "Runs on" and "Isolation" choices in
// Settings → Bots and the details panel, and the grants a paired server's bots get on this device
// in Settings → Devices. Each test file runs in its own process (scripts/test.ts), so the globals stay here.
const win = new Window({ url: "http://localhost/" });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(win)) if (!(key in g)) g[key] = (win as any)[key];
Object.assign(g, { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win) });
g.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
g.matchMedia = g.window.matchMedia;
g.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { enterWorkspace, useBots } = await import("../src/lib/bots/store");
const { useWorkspace } = await import("../src/lib/bots/workspace");
// This server's own workspace, where bots are managed.
useWorkspace.setState({ localId: "srv", localName: "Studio" });
enterWorkspace("srv");
const { BotAdvanced, BotComputer } = await import("../src/components/bots/BotAdvanced");
const { BotAccess } = await import("../src/components/BotAccess");
type Bot = import("../src/lib/bots/types").Bot;
type ComputerTarget = import("../shared/bots").ComputerTarget;

const all = { files: true, terminal: true, browser: true, unisolated: true };
const none = { files: false, terminal: false, browser: false, unisolated: false };
let targets: ComputerTarget[] = [];
let requests: { path: string; method: string; body: any }[] = [];
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  requests = [];
  targets = [
    { device: "local", name: "Studio iMac", status: "ready", grants: all, engines: ["podman"] },
    { device: "mbp", name: "MacBook", status: "access", grants: none },
    { device: "vm", name: "Cloud VM", status: "ready", grants: { files: true, terminal: true, browser: false, unisolated: false } },
    { device: "old", name: "Old Mini", status: "offline", message: "Old Mini is unreachable" },
  ];
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body });
    if (path === "/api/bots/targets") return Response.json({ targets });
    if (path.startsWith("/api/paired-clients/")) return Response.json({ botTools: { ...none, ...body.botTools } });
    return Response.json({});
  }) as unknown as typeof fetch;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const frames = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
const trigger = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-haspopup="listbox"][aria-label="${label}"]`)!;
const options = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(`[role="listbox"][aria-label="${label}"] [role="option"]`)];
const note = () => host.querySelector(".bot-target-note")?.textContent ?? "";
const click = (el: Element) => act(async () => { el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as any); });
const patches = () => requests.filter((r) => r.method === "PATCH");

async function mount(surface: "settings" | "advanced", computer?: Bot["computer"]) {
  useBots.setState({ bots: [{ id: "b1", name: "Scout", look: {} as Bot["look"], instructions: "", createdAt: 1, computer } as Bot] });
  const View = () => {
    const current = useBots((s) => s.bots[0]!);
    return createElement(surface === "advanced" ? BotAdvanced : BotComputer, { bot: current });
  };
  await act(async () => root.render(createElement(View)));
  await frames();
}

for (const surface of ["settings", "advanced"] as const) {
  test(`${surface}: an unset computer reads as this server's container, with where and isolation chosen apart`, async () => {
    await mount(surface);
    expect(trigger("Runs on").textContent).toBe("Studio iMac (this server)");
    expect(trigger("Isolation").textContent).toBe("Container");
    expect(note()).toBe("");
    await click(trigger("Runs on"));
    expect(options("Runs on").map((o) => o.textContent)).toEqual(["Studio iMac (this server)", "MacBook · access required", "Cloud VM", "Old Mini · unreachable"]);
  });

  test(`${surface}: choosing a device keeps the isolation, and choosing isolation keeps the device`, async () => {
    await mount(surface, { device: "local", kind: "host" });
    await click(trigger("Runs on"));
    await click(options("Runs on").find((o) => o.textContent === "Cloud VM")!);
    expect(patches().at(-1)).toMatchObject({ path: "/api/bots/b1", body: { computer: { device: "vm", kind: "host" } } });
    expect(useBots.getState().bots[0]!.computer).toEqual({ device: "vm", kind: "host" });
    // The VM only allows a container, and says how to change that on the VM.
    expect(note()).toContain("Cloud VM only allows a container");
    expect(note()).toContain("Using this device → Studio iMac");
    await click(trigger("Isolation"));
    await click(options("Isolation").find((o) => o.textContent === "Container")!);
    expect(patches().at(-1)!.body).toEqual({ computer: { device: "vm", kind: "container" } });
    expect(note()).toContain("Cloud VM doesn't allow browser");
  });

  test(`${surface}: a device that hasn't allowed anything stays selected and says access is required`, async () => {
    await mount(surface, { device: "mbp", kind: "container" });
    expect(trigger("Runs on").textContent).toBe("MacBook · access required");
    expect(note()).toContain("Access required. MacBook hasn't allowed this server's bots anything yet. On MacBook, open Settings → Devices → Using this device → Studio iMac");
    expect(note()).toContain("nothing runs here instead");
    expect(patches()).toEqual([]);
  });

  test(`${surface}: an offline device, or one no longer paired, stays the bot's choice with the reason`, async () => {
    await mount(surface, { device: "old", kind: "container" });
    expect(note()).toContain("Old Mini is unreachable. The bot's tools fail until it's back; nothing runs here instead.");
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(surface, { device: "gone", kind: "container" });
    expect(trigger("Runs on").textContent).toBe("A device · not paired");
    expect(host.querySelector(".bot-target-note-bad")?.textContent).toContain("isn't paired anymore");
    expect(patches()).toEqual([]);
  });
}

test("Settings → Devices: each grant is its own switch, all off after pairing, and unisolated asks first", async () => {
  const client = { id: "c1", name: "Studio iMac", createdAt: 1 };
  await act(async () => root.render(createElement(BotAccess, { client })));
  const switches = () => [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
  expect(switches().map((s) => s.getAttribute("aria-label"))).toEqual(["Files for bots from Studio iMac", "Terminal for bots from Studio iMac", "Browser for bots from Studio iMac", "Unisolated for bots from Studio iMac"]);
  expect(switches().every((s) => s.getAttribute("aria-checked") === "false")).toBe(true);

  await click(switches()[1]!);
  await frames();
  expect(patches()).toEqual([{ path: "/api/paired-clients/c1", method: "PATCH", body: { botTools: { terminal: true } } }]);
  expect(switches()[1]!.getAttribute("aria-checked")).toBe("true");

  let asked = "";
  g.confirm = (text: string) => ((asked = text), false);
  await click(switches()[3]!);
  await frames();
  expect(asked).toContain("outside a container");
  expect(patches()).toHaveLength(1);
  g.confirm = () => true;
  await click(switches()[3]!);
  await frames();
  expect(patches().at(-1)!.body).toEqual({ botTools: { unisolated: true } });
});
