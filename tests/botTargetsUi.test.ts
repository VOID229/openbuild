import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// The machines bots reach, clicked at in a DOM: the read-only list in Settings → Bots and the details
// panel, each machine opening its device in Settings → Devices; the isolation chosen per machine
// there; and the grants a paired server's bots get on this device. Each test file runs in its own
// process (scripts/test.ts), so the globals stay here. tests/botMachinesChrome.test.ts drives the
// same in a real Chrome.
const win = new Window({ url: "http://localhost/" });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(win)) if (!(key in g)) g[key] = (win as any)[key];
Object.assign(g, { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, sessionStorage: win.sessionStorage, location: win.location, history: win.history, getComputedStyle: win.getComputedStyle.bind(win) });
g.window.matchMedia = (q: string) => ({ matches: q.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} });
g.matchMedia = g.window.matchMedia;
g.IS_REACT_ACT_ENVIRONMENT = true;
g.HTMLElement.prototype.scrollIntoView ??= function () {};

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useStore } = await import("../src/lib/store");
const { enterWorkspace, useBots } = await import("../src/lib/bots/store");
const { useWorkspace } = await import("../src/lib/bots/workspace");
const { useDeviceFocus } = await import("../src/lib/bots/targets");
// This server's own workspace, where bots are managed.
useWorkspace.setState({ localId: "srv", localName: "Studio" });
enterWorkspace("srv");
const { BotAdvanced, BotMachines } = await import("../src/components/bots/BotAdvanced");
const { BotAccess } = await import("../src/components/BotAccess");
const { DevicesSection } = await import("../src/components/DeviceSettings");
type Bot = import("../src/lib/bots/types").Bot;
type ComputerTarget = import("../shared/bots").ComputerTarget;

const all = { files: true, terminal: true, browser: true, unisolated: true };
const none = { files: false, terminal: false, browser: false, unisolated: false };
let targets: ComputerTarget[] = [];
let requests: { path: string; method: string; body: any }[] = [];
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;

const devices = [
  { id: "srv", name: "Studio iMac", local: true, mode: "lan", urls: [], online: true },
  { id: "mbp", name: "MacBook", mode: "lan", urls: ["http://mbp"], status: "online", online: true },
  { id: "vm", name: "Cloud VM", mode: "lan", urls: ["http://vm"], status: "online", online: true },
  { id: "old", name: "Old Mini", mode: "lan", urls: ["http://old"], status: "offline", online: false },
];

beforeEach(() => {
  requests = [];
  targets = [
    // What the server reports with nothing chosen: the host where it's allowed, a container where it isn't.
    { device: "local", name: "Studio iMac", status: "ready", grants: all, engines: ["podman"], isolation: "host" },
    { device: "mbp", name: "MacBook", status: "access", grants: none, isolation: "container" },
    { device: "vm", name: "Cloud VM", status: "ready", grants: { files: true, terminal: true, browser: false, unisolated: false }, isolation: "container" },
    { device: "old", name: "Old Mini", status: "offline", message: "Old Mini is unreachable", isolation: "container" },
  ];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const path = String(input).replace(/^http:\/\/localhost/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body });
    if (path === "/api/bots/targets") return Response.json({ targets });
    const isolation = /^\/api\/bots\/targets\/([^/]+)$/.exec(path);
    if (isolation && method === "PATCH") return Response.json({ device: decodeURIComponent(isolation[1]!), isolation: body.isolation });
    if (path === "/api/devices") return Response.json({ devices });
    if (path === "/api/paired-clients") return Response.json({ clients: [] });
    if (path.startsWith("/api/paired-clients/")) return Response.json({ botTools: { ...none, ...body.botTools } });
    return Response.json({});
  }) as unknown as typeof fetch;
  useStore.setState({ devices, devicesLoaded: true, settingsOpen: false, settingsSection: "profile", settingsPage: undefined } as any);
  useDeviceFocus.setState({ device: undefined });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const frames = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
const click = (el: Element) => act(async () => { el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as any); });
const patches = () => requests.filter((r) => r.method === "PATCH");
const machineRows = () => [...host.querySelectorAll<HTMLElement>(".bot-machine")];
const rowText = (name: string) => machineRows().find((r) => r.querySelector(".pi-row-name")?.firstChild?.textContent === name)?.textContent ?? "";
/** Why a machine can't run every tool: a few words in the row, the whole of it in their tooltip (and the row's label). */
const noteOf = (name: string) => {
  const row = machineRows().find((r) => r.querySelector(".pi-row-name")?.firstChild?.textContent === name);
  const note = row?.querySelector<HTMLElement>(".bot-machine-note");
  return { short: note?.textContent ?? "", full: note?.dataset.tooltip ?? "", label: row?.querySelector("button")?.getAttribute("aria-label") ?? "" };
};

async function mount(surface: "settings" | "advanced", computer?: Bot["computer"]) {
  useBots.setState({ bots: [{ id: "b1", name: "Scout", look: {} as Bot["look"], instructions: "", createdAt: 1, computer } as Bot] });
  const View = () => {
    const current = useBots((s) => s.bots[0]!);
    return surface === "advanced" ? createElement(BotAdvanced, { bot: current }) : createElement(BotMachines);
  };
  await act(async () => root.render(createElement(View)));
  await frames();
}

for (const surface of ["settings", "advanced"] as const) {
  test(`${surface}: every machine is listed at once, read-only, with what it allows and why not`, async () => {
    await mount(surface);
    expect(machineRows().map((r) => r.querySelector(".pi-row-name")!.firstChild!.textContent)).toEqual(["Studio iMac", "MacBook", "Cloud VM", "Old Mini"]);
    expect(rowText("Studio iMac")).toContain("This server");
    expect(rowText("Studio iMac")).toContain("Files, terminal and browser · Host (unisolated)");
    expect(rowText("MacBook")).toContain("Doesn't allow bots");
    expect(noteOf("MacBook").short).toBe("How to allow");
    expect(noteOf("MacBook").full).toContain("On MacBook, open Settings → Devices → Using this device → Studio iMac");
    expect(noteOf("MacBook").label).toContain("On MacBook, open Settings → Devices → Using this device → Studio iMac");
    expect(rowText("Cloud VM")).toContain("Files and terminal · Container");
    expect(noteOf("Cloud VM").short).toBe("How to allow browser");
    expect(noteOf("Cloud VM").full).toContain("Cloud VM doesn't allow browser");
    expect(rowText("Old Mini")).toContain("Unreachable");
    expect(noteOf("Old Mini").full).toContain("nothing runs elsewhere instead");
    // The long explanation stays out of the row itself.
    expect(rowText("MacBook")).not.toContain("Using this device");
    expect(noteOf("Studio iMac").full).toBe("");
    // Nothing here to pick: no device or isolation select, and nothing saved.
    expect(host.querySelector('button[aria-haspopup="listbox"][aria-label="Runs on"], button[aria-haspopup="listbox"][aria-label="Isolation"]')).toBeNull();
    expect(patches()).toEqual([]);
  });

  test(`${surface}: a computer saved by an earlier build changes nothing in the list`, async () => {
    await mount(surface, { device: "mbp", kind: "host" });
    expect(machineRows()).toHaveLength(4);
    expect(rowText("MacBook")).not.toContain("Host");
    expect(patches()).toEqual([]);
  });

  test(`${surface}: a machine opens its own device in Settings → Devices`, async () => {
    await mount(surface);
    await click(machineRows()[2]!.querySelector("button.bot-machine-link")!);
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useStore.getState().settingsSection).toBe("devices");
    // Straight to that device's own page.
    expect(useStore.getState().settingsPage).toBe("device/vm");
    expect(useDeviceFocus.getState().device).toBe("vm");
  });
}

/** Settings → Devices at its list, or at one device's page. */
const devicePage = (id?: string) => act(async () => useStore.setState({ settingsPage: id && `device/${id}` }));

test("Settings → Devices: each device says what this server's bots may do there, and its page has the details, the linked one marked", async () => {
  useDeviceFocus.setState({ device: "vm" });
  await act(async () => root.render(createElement(DevicesSection)));
  await frames();
  const row = (id: string) => host.querySelector<HTMLElement>(`#device-${id}`)!;
  // The list: one line each.
  expect(row("local").textContent).toContain("Bots always allowed");
  expect(row("mbp").textContent).toContain("Doesn't allow bots");
  expect(row("vm").textContent).toContain("Allows bots · Files and terminal · Container");
  expect(row("old").textContent).toContain("Unreachable");
  expect(host.querySelector(".bot-on-device")).toBeNull();
  // Each device's page.
  await devicePage("vm");
  await frames();
  expect(host.querySelectorAll(".device-row")).toHaveLength(1);
  expect(row("vm").textContent).toContain("Studio iMac's bots · Allows bots · Files and terminal · Container");
  expect(row("vm").classList.contains("device-row-focused")).toBe(true);
  expect(document.activeElement).toBe(row("vm"));
  await devicePage("mbp");
  expect(row("mbp").textContent).toContain("Studio iMac's bots · Doesn't allow bots");
  expect(row("mbp").textContent).toContain("On MacBook, open Settings → Devices → Using this device → Studio iMac");
  await devicePage("local");
  expect(row("local").textContent).toContain("This server's bots · always allowed");
  await devicePage("old");
  expect(row("old").textContent).toContain("Unreachable");
  await devicePage();
});

test("Settings → Devices: isolation is per machine, the host is the default, choosing it asks first, and a device without Unisolated offers only a container", async () => {
  await act(async () => root.render(createElement(DevicesSection)));
  await frames();
  const trigger = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-haspopup="listbox"][aria-label="Isolation on ${name}"]`)!;
  const options = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(`[role="listbox"][aria-label="Isolation on ${name}"] [role="option"]`)];
  // The Cloud VM hasn't allowed Unisolated: there's nothing else to choose.
  await devicePage("vm");
  expect(trigger("Cloud VM").disabled).toBe(true);
  expect(host.querySelector("#device-vm")!.textContent).toContain("Container only: Cloud VM hasn't allowed Unisolated");
  // A device that hasn't answered or allowed anything has no grants to go by yet: nothing to choose there.
  await devicePage("old");
  expect(trigger("Old Mini")).toBeNull();
  await devicePage("mbp");
  expect(trigger("MacBook")).toBeNull();

  // This server starts on the host, the default, listed first; a container keeps bots apart from it.
  await devicePage("local");
  expect(trigger("Studio iMac").textContent).toBe("Host (unisolated)");
  expect(host.querySelector("#device-local")!.textContent).toContain("Host is the default: bots run as the user running OpenBuild. A container isolates them.");
  let asked = "";
  g.confirm = (text: string) => ((asked = text), true);
  await click(trigger("Studio iMac"));
  expect(options("Studio iMac").map((o) => o.textContent)).toEqual(["Host (unisolated)", "Container"]);
  await click(options("Studio iMac")[1]!);
  await frames();
  // A container needs no asking, and is saved as a choice of its own.
  expect(asked).toBe("");
  expect(patches()).toEqual([{ path: "/api/bots/targets/local", method: "PATCH", body: { isolation: "container" } }]);
  expect(trigger("Studio iMac").textContent).toBe("Container");
  // Back to the host asks first.
  g.confirm = (text: string) => ((asked = text), false);
  await click(trigger("Studio iMac"));
  await click(options("Studio iMac")[0]!);
  await frames();
  expect(asked).toContain("Run bots unisolated on Studio iMac");
  expect(patches()).toHaveLength(1);
  g.confirm = () => true;
  await click(trigger("Studio iMac"));
  await click(options("Studio iMac")[0]!);
  await frames();
  expect(patches().at(-1)).toEqual({ path: "/api/bots/targets/local", method: "PATCH", body: { isolation: "host" } });
  expect(trigger("Studio iMac").textContent).toBe("Host (unisolated)");
  // Only that machine changed.
  await devicePage("vm");
  expect(trigger("Cloud VM").textContent).toBe("Container");
  await devicePage();
});

test("Settings → Devices: this server without a container engine is fine on the host, and says so once a container is chosen", async () => {
  targets[0] = { ...targets[0]!, engines: [] };
  await act(async () => root.render(createElement(DevicesSection)));
  await frames();
  await devicePage("local");
  expect(host.querySelector("#device-local")!.textContent).not.toContain("There's no container engine here");
  await devicePage();
  targets[0] = { ...targets[0]!, isolation: "container" };
  act(() => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(createElement(DevicesSection)));
  await frames();
  await devicePage("local");
  expect(host.querySelector("#device-local")!.textContent).toContain("There's no container engine here");
  await devicePage();
});

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
  expect(asked).toContain("Their server runs them that way unless its user chooses a container");
  expect(patches()).toHaveLength(1);
  g.confirm = () => true;
  await click(switches()[3]!);
  await frames();
  expect(patches().at(-1)!.body).toEqual({ botTools: { unisolated: true } });
});
