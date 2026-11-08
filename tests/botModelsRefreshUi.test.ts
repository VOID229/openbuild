import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// Settings → Bots, clicked at in a DOM: switching a custom extension off or on changes the models a
// bot's picker offers straight away, and a bot left on a model that went with it is named.
// Each test file runs in its own process (scripts/test.ts), so the globals stay here.
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
useWorkspace.setState({ localId: "srv", localName: "Studio" });
enterWorkspace("srv");
const { BotModelSelect } = await import("../src/components/bots/BotAdvanced");
const { BotExtensions } = await import("../src/components/bots/BotExtensions");
type Bot = import("../src/lib/bots/types").Bot;

const mock = { id: "mock/m", name: "Mock", provider: "mock" };
const bridged = { id: "bridge/x", name: "Bridged X", provider: "bridge" };
// What the server would list: the bridge's model only while its extension is on.
let loaded: string[] = [];
let asked: string[] = [];
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  asked = [];
  loaded = ["extensions/bridge.ts"];
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path.startsWith("/api/bots/models")) {
      asked.push(path);
      return Response.json({ models: loaded.length ? [mock, bridged] : [mock], defaultModel: "mock/m", checkedAt: 1 });
    }
    if (path === "/api/bots/extensions") return Response.json({ extensions: [{ id: "extensions/bridge.ts", name: "Bridge", kind: "extension" }] });
    if (method === "PATCH" && path.endsWith("/api/bots/settings")) {
      const { enabled, ids } = JSON.parse(String(init!.body)).customExtensions;
      loaded = enabled ? ids : [];
      return Response.json({});
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  useBots.setState({
    bots: [{ id: "b1", name: "Scout", look: {} as Bot["look"], instructions: "", createdAt: 1, model: "bridge/x" } as Bot],
    customExtensions: { enabled: true, ids: ["extensions/bridge.ts"] },
    defaultModel: undefined,
    defaultFallbackModels: [],
  });
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
const picker = () => document.querySelector<HTMLButtonElement>('button[aria-label="Scout model"]')!;
const alert = () => host.querySelector('[role="alert"]')?.textContent ?? "";

async function mount() {
  const View = () => {
    const bot = useBots((s) => s.bots[0]!);
    return createElement("div", null, createElement(BotExtensions), createElement(BotModelSelect, { label: "Scout model", value: bot.model, onChange() {} }));
  };
  await act(async () => root.render(createElement(View)));
  await frames();
}

test("switching an extension off refreshes an open picker and names the bot left on its model", async () => {
  await mount();
  expect(picker().textContent).toContain("Bridged X");
  expect(alert()).toBe("");

  await click(document.querySelector('[role="switch"][aria-label="Load Bridge"]')!);
  await frames();
  // The picker already on screen took the fresh listing, without being remounted.
  expect(asked.at(-1)).toBe("/api/bots/models?fresh=1");
  expect(picker().textContent).toContain("bridge/x (unavailable)");
  expect(alert()).toContain("Bots can't use bridge/x (Scout) with the extensions loaded now");
  expect(host.querySelector(".pi-subhead-note")!.textContent).toBe("1 model unavailable");

  // Back on, it's offered again and the warning goes.
  await click(document.querySelector('[role="switch"][aria-label="Load Bridge"]')!);
  await frames();
  expect(picker().textContent).toContain("Bridged X");
  expect(alert()).toBe("");
});

test("switching every custom extension off at once does the same", async () => {
  await mount();
  await click(document.querySelector('[role="switch"][aria-label="Load my Pi extensions too"]')!);
  await frames();
  expect(useBots.getState().customExtensions).toEqual({ enabled: false, ids: ["extensions/bridge.ts"] });
  expect(picker().textContent).toContain("bridge/x (unavailable)");
  expect(alert()).toContain("Bots can't use bridge/x (Scout)");
});
