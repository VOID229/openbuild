import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// A bot's two switches, Spawn minions and Merge PRs, clicked in a DOM: Settings → Bots and the details
// panel's Advanced tab. Each test file runs in its own process (scripts/test.ts), so the globals stay here.
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
const { BotAdvanced } = await import("../src/components/bots/BotAdvanced");
const { BotSwitches, MERGE_PRS_DESC, SPAWN_MINIONS_DESC } = await import("../src/components/bots/BotSwitches");
type Bot = import("../src/lib/bots/types").Bot;

const bot = (extra: Partial<Bot> = {}): Bot => ({ id: "b1", name: "designer", look: {} as Bot["look"], instructions: "", createdAt: 1, memory: [], routines: [], ...extra }) as Bot;

let patches: { path: string; body: any }[] = [];
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  patches = [];
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (init?.method === "PATCH") patches.push({ path, body: JSON.parse(String(init.body)) });
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

async function mount(surface: "settings" | "advanced", extra?: Partial<Bot>) {
  useBots.setState({ bots: [bot(extra)] });
  const View = () => {
    const current = useBots((s) => s.bots[0]!);
    return surface === "advanced" ? createElement(BotAdvanced, { bot: current }) : createElement("section", null, createElement(BotSwitches, { bot: current }));
  };
  await act(async () => root.render(createElement(View)));
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

const rowLabels = () => [...host.querySelectorAll(".setting-row .setting-label")].map((el) => el.textContent);
const toggle = (label: string) => host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!;
async function press(el: HTMLElement) {
  await act(async () => { el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 0 }) as any); });
}

for (const surface of ["settings", "advanced"] as const) {
  test(`${surface}: two switches, Spawn minions on and Merge PRs off for a bot that never set them`, async () => {
    await mount(surface, { threads: { enabled: true, scope: "all", projects: [] } });
    const labels = rowLabels();
    expect(labels.slice(-2)).toEqual(["Spawn minions", "Merge PRs"]);
    // Nothing of the access to the user's threads is left: Build is the user's own.
    for (const old of ["Projects", "Chosen", "Excluded", "Run coding agents", "Merge pull requests"]) expect(labels).not.toContain(old);
    expect(host.querySelector('button[aria-haspopup="listbox"][aria-label="Projects this bot can work in"]')).toBeNull();
    expect(toggle("Spawn minions").getAttribute("aria-checked")).toBe("true");
    expect(toggle("Merge PRs").getAttribute("aria-checked")).toBe("false");
    if (surface === "advanced") {
      expect([...host.querySelectorAll(".bots-adv-title")].map((t) => t.textContent)).toEqual(["Model", "Works in", "Machines", "Permissions"]);
      // Compact rows put the description in the label's tooltip.
      expect(host.querySelector('[data-tooltip="' + SPAWN_MINIONS_DESC + '"]')).not.toBeNull();
      expect(host.querySelector('[data-tooltip="' + MERGE_PRS_DESC + '"]')).not.toBeNull();
    } else {
      expect([...host.querySelectorAll(".setting-desc")].map((d) => d.textContent)).toEqual([SPAWN_MINIONS_DESC, MERGE_PRS_DESC]);
    }
  });

  test(`${surface}: each switch saves on its own, and reads what's saved`, async () => {
    const threads = { enabled: true, scope: "choose" as const, projects: ["alpha"], excluded: [], merge: true };
    await mount(surface, { threads, spawnMinions: false });
    expect(toggle("Merge PRs").getAttribute("aria-checked")).toBe("true");
    expect(toggle("Spawn minions").getAttribute("aria-checked")).toBe("false");
    await press(toggle("Spawn minions"));
    expect(patches.at(-1)).toEqual({ path: "/api/workspace/to/srv/api/bots/b1", body: { spawnMinions: true } });
    expect(toggle("Spawn minions").getAttribute("aria-checked")).toBe("true");
    // Merge PRs is kept on the thread grant: the rest of the grant goes back as it was.
    await press(toggle("Merge PRs"));
    expect(patches.at(-1)).toEqual({ path: "/api/workspace/to/srv/api/bots/b1", body: { threads: { ...threads, merge: false } } });
    expect(toggle("Merge PRs").getAttribute("aria-checked")).toBe("false");
    await press(toggle("Spawn minions"));
    expect(patches.at(-1)).toEqual({ path: "/api/workspace/to/srv/api/bots/b1", body: { spawnMinions: false } });
  });
}

test("Merge PRs on for a bot with no grant gives it no access to the user's threads", async () => {
  await mount("settings");
  expect(toggle("Merge PRs").getAttribute("aria-checked")).toBe("false");
  await press(toggle("Merge PRs"));
  expect(patches.at(-1)!.body.threads).toMatchObject({ enabled: false, merge: true });
});

test("a retired bot's switches show what's saved and can't be changed", async () => {
  await mount("settings", { retiredAt: 5 });
  expect(toggle("Spawn minions").disabled).toBe(true);
  expect(toggle("Merge PRs").disabled).toBe(true);
});

// Kept from the Projects dropdown these switches replaced: OptionSelect, opened with the mouse.
test("opening a dropdown with the mouse leaves focus where it was", async () => {
  const { OptionSelect } = await import("../src/components/ModelSelect");
  const options = [{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" }];
  await act(async () => root.render(createElement(OptionSelect, { label: "Pick one", value: "a", options, onChange: () => {} })));
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
  await act(async () => { trigger.dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 1 }) as any); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  const listed = [...document.querySelectorAll<HTMLButtonElement>('[role="listbox"][aria-label="Pick one"] [role="option"]')];
  expect(listed).toHaveLength(3);
  expect(document.activeElement).not.toBe(listed[0]!);
});
