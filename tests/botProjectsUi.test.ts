import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// The bot's OpenBuild controls, clicked and typed at in a DOM: Settings → Bots and the details
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
const { useStore } = await import("../src/lib/store");
const { enterWorkspace, useBots } = await import("../src/lib/bots/store");
const { useWorkspace } = await import("../src/lib/bots/workspace");
// This server's own workspace, where bots are managed.
useWorkspace.setState({ localId: "srv", localName: "Studio" });
enterWorkspace("srv");
const { BotAdvanced } = await import("../src/components/bots/BotAdvanced");
const { BotThreads } = await import("../src/components/bots/BotThreads");
type Bot = import("../src/lib/bots/types").Bot;
type Access = NonNullable<Bot["threads"]>;

const projects = [
  { id: "alpha", name: "Alpha", path: "/p/alpha" },
  { id: "beta", name: "Beta", path: "/p/beta" },
  { id: "gamma", name: "Gamma", path: "/p/gamma" },
];
const bot = (threads?: Access): Bot => ({ id: "b1", name: "manager", look: {} as Bot["look"], instructions: "", createdAt: 1, threads }) as Bot;

let patches: { path: string; body: any }[] = [];
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  patches = [];
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (init?.method === "PATCH") patches.push({ path, body: JSON.parse(String(init.body)) });
    return Response.json({});
  }) as unknown as typeof fetch;
  useStore.setState({ projects: projects as any });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

/** Renders a surface with the bot in the store, re-rendering as saves change it. */
async function mount(surface: "settings" | "advanced", threads?: Access) {
  useBots.setState({ bots: [bot(threads)] });
  const View = () => {
    const current = useBots((s) => s.bots[0]!);
    return surface === "advanced" ? createElement(BotAdvanced, { bot: current }) : createElement("section", null, createElement(BotThreads, { bot: current }));
  };
  await act(async () => root.render(createElement(View)));
  await frames();
}

const saved = () => useBots.getState().bots[0]!.threads;
const trigger = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-haspopup="listbox"][aria-label="${label}"]`);
const rowLabels = () => [...host.querySelectorAll(".setting-row .setting-label")].map((el) => el.textContent);
const options = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(`[role="listbox"][aria-label="${label}"] [role="option"]`)];
const frames = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
async function key(el: Element, k: string) {
  await act(async () => { el.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true }) as any); });
}
/** Enter or Space on a button: the browser clicks it with no pointer, so detail is 0. */
async function press(el: HTMLElement) {
  el.focus();
  await act(async () => { el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 0 }) as any); });
}

for (const surface of ["settings", "advanced"] as const) {
  test(`${surface}: Projects is a dropdown above Use OpenBuild, with no pill selector`, async () => {
    await mount(surface, { enabled: true, scope: "all", projects: [] });
    const labels = rowLabels();
    expect(labels.indexOf("Projects")).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf("Projects")).toBeLessThan(labels.indexOf("Use OpenBuild"));
    expect(trigger("Projects this bot can work in")?.textContent).toBe("All projects");
    expect(host.querySelector(".segmented, [role=radiogroup]")).toBeNull();
  });

  test(`${surface}: with OpenBuild off, Projects is greyed out and disabled but keeps its saved selection`, async () => {
    const threads = { enabled: false, scope: "exclude", projects: ["alpha"], excluded: ["beta", "gone"] } as Access;
    await mount(surface, threads);
    const scope = trigger("Projects this bot can work in")!;
    const picker = trigger("Projects to exclude")!;
    expect(scope.textContent).toBe("Exclude projects");
    expect(picker.textContent).toBe("Beta");
    for (const el of [scope, picker]) {
      expect(el.disabled).toBe(true);
      expect(el.closest(".setting-row")!.classList.contains("setting-row-disabled")).toBe(true);
      await press(el);
      await key(el, "ArrowDown");
    }
    await frames();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    // The other permissions stay hidden until access is on.
    expect(rowLabels()).not.toContain("Merge pull requests");
    expect(patches).toEqual([]);

    // Turning access on keeps exactly what was saved, including ids of projects since removed.
    await press(host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Use OpenBuild"]')!);
    expect(saved()).toEqual({ ...threads, enabled: true });
    expect(patches.at(-1)!.body.threads).toEqual({ ...threads, enabled: true });
    expect(trigger("Projects this bot can work in")!.disabled).toBe(false);
    expect(host.querySelector(".setting-row-disabled")).toBeNull();

    // And turning it off again greys it out without touching the scope.
    await press(host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Use OpenBuild"]')!);
    expect(saved()).toEqual(threads);
    expect(trigger("Projects this bot can work in")!.disabled).toBe(true);
  });

  test(`${surface}: a grant from before scopes reads as chosen projects, never all`, async () => {
    await mount(surface, { enabled: true, projects: ["alpha", "gamma"] } as Access);
    expect(trigger("Projects this bot can work in")!.textContent).toBe("Choose projects");
    expect(trigger("Projects to choose")!.textContent).toBe("Alpha, Gamma");
    // Saving something else leaves the scope as it was, not "all".
    await press(host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Merge pull requests"]')!);
    expect(saved()!.scope).toBeUndefined();
    expect(saved()!.projects).toEqual(["alpha", "gamma"]);
  });

  test(`${surface}: the scope and project dropdowns work from the keyboard and save`, async () => {
    await mount(surface, { enabled: true, scope: "choose", projects: ["alpha"], excluded: ["gamma"] });
    const scope = trigger("Projects this bot can work in")!;

    // Enter opens it on the chosen option; arrows move; Enter picks and hands focus back.
    await press(scope);
    await frames();
    const list = options("Projects this bot can work in");
    expect(list.map((o) => o.textContent)).toEqual(["All projects", "Choose projects", "Exclude projects"]);
    expect(document.activeElement).toBe(list[1]!);
    await key(list[1]!, "ArrowDown");
    expect(document.activeElement).toBe(list[2]!);
    await press(list[2]!);
    expect(saved()).toMatchObject({ scope: "exclude", projects: ["alpha"], excluded: ["gamma"] });
    expect(patches.at(-1)).toEqual({ path: "/api/workspace/to/srv/api/bots/b1", body: { threads: saved() } });
    expect(document.activeElement).toBe(trigger("Projects this bot can work in")!);
    // Each scope keeps its own list, so switching never loses or merges them.
    expect(trigger("Projects to exclude")!.textContent).toBe("Gamma");

    // ↓ opens the project picker too; it stays open while several are ticked, Escape closes it.
    const picker = trigger("Projects to exclude")!;
    picker.focus();
    await key(picker, "ArrowDown");
    await frames();
    let items = options("Projects to exclude");
    expect(items.map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
    expect(document.activeElement).toBe(items[2]!);
    await key(items[2]!, "ArrowUp");
    await key(items[1]!, "ArrowUp");
    expect(document.activeElement).toBe(items[0]!);
    await press(items[0]!);
    items = options("Projects to exclude");
    expect(items.map((o) => o.getAttribute("aria-selected"))).toEqual(["true", "false", "true"]);
    await press(items[2]!);
    expect(saved()!.excluded).toEqual(["alpha"]);
    expect(saved()!.projects).toEqual(["alpha"]);
    await key(document.activeElement!, "Escape");
    expect(document.activeElement).toBe(trigger("Projects to exclude")!);
    expect(trigger("Projects to exclude")!.textContent).toBe("Alpha");

    // Back to choose: its own list is still there.
    await press(trigger("Projects this bot can work in")!);
    await frames();
    await press(options("Projects this bot can work in")[1]!);
    expect(saved()).toMatchObject({ scope: "choose", projects: ["alpha"], excluded: ["alpha"] });
    expect(trigger("Projects to choose")!.textContent).toBe("Alpha");

    // All hides the picker, and every save reached the server.
    await press(trigger("Projects this bot can work in")!);
    await frames();
    await press(options("Projects this bot can work in")[0]!);
    expect(saved()!.scope).toBe("all");
    expect(trigger("Projects to choose")).toBeNull();
    expect(patches.map((p) => p.body.threads.scope)).toEqual(["exclude", "exclude", "exclude", "choose", "all"]);
  });
}

test("opening a dropdown with the mouse leaves focus where it was", async () => {
  await mount("settings", { enabled: true, scope: "all", projects: [] });
  const scope = trigger("Projects this bot can work in")!;
  await act(async () => { scope.dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 1 }) as any); });
  await frames();
  expect(options("Projects this bot can work in")).toHaveLength(3);
  expect(document.activeElement).not.toBe(options("Projects this bot can work in")[0]!);
});
