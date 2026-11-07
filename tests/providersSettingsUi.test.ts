import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// Settings → Providers manages Pi only: no runtime picker and no other runtime's accounts, and
// every provider action goes to Pi on the chosen device, whatever other runtimes have saved.
// Each test file runs in its own process (scripts/test.ts), so the globals stay here.
const win = new Window({ url: "http://localhost/" });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(win)) if (!(key in g)) g[key] = (win as any)[key];
Object.assign(g, { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win) });
g.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
g.matchMedia = g.window.matchMedia;
g.IS_REACT_ACT_ENVIRONMENT = true;
g.confirm = () => true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useStore } = await import("../src/lib/store");
const { ProvidersSection } = await import("../src/components/PiSettings");

const providers = [
  { id: "xai", name: "xAI", oauth: { name: "xai", subscription: false }, status: { configured: true }, stored: "oauth", models: 4 },
  { id: "openrouter", name: "OpenRouter", apiKey: { name: "OPENROUTER_API_KEY", canLogin: true }, status: { configured: true }, stored: "api_key", models: 1 },
  { id: "bedrock", name: "Amazon Bedrock", apiKey: { name: "AWS", canLogin: true }, status: { configured: false }, models: 197 },
];

let calls: { url: string; method: string }[] = [];
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    if (String(url).endsWith("/api/pi/providers")) return Response.json({ providers });
    if (String(url).includes("/api/pi/models")) return Response.json({ models: [] });
    return Response.json({});
  }) as unknown as typeof fetch;
  useStore.setState({
    devices: [
      { id: "local", name: "imac", local: true },
      { id: "laptop", name: "laptop", online: true },
    ] as any,
    devicesLoaded: true,
    // Saved accounts for other runtimes stay theirs; this page neither lists nor uses them.
    settings: {
      ...useStore.getState().settings,
      runtimeAccounts: [{ id: "work", name: "Work", runtime: "claude", configDir: "/tmp/claude-work" }],
    } as any,
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
const pickers = () => [...host.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"]')].map((b) => b.getAttribute("aria-label"));
const removeButton = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

async function mount() {
  await act(async () => root.render(createElement(ProvidersSection)));
  await frames();
}

async function choose(label: string, option: string) {
  await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
  const item = [...document.querySelectorAll<HTMLElement>(`[role="listbox"] [role="option"]`)].find((o) => o.textContent?.includes(option));
  await act(async () => item!.click());
  await frames();
}

test("shows the device picker and Pi's providers, with no runtime picker or runtime accounts", async () => {
  await mount();
  expect(pickers()).toEqual(["Device whose Pi providers to manage"]);
  const text = host.textContent ?? "";
  expect(text).toContain("Providers & accounts");
  expect(text).toContain("Ready to use");
  expect(text).toContain("xAI");
  expect(text).toContain("Add a provider");
  expect(text).toContain("Amazon Bedrock");
  expect(host.querySelector('input[placeholder="Search providers…"]')).not.toBeNull();
  for (const other of ["claude auth login", "codex login", "cursor-agent login", "Add account", "Work"]) expect(text).not.toContain(other);
  expect(calls.every((c) => c.url.startsWith("/api/pi/"))).toBe(true);
});

test("a paired device's provider actions go to that device's Pi", async () => {
  await mount();
  await choose("Device whose Pi providers to manage", "laptop");
  expect(calls).toContainEqual({ url: "/api/devices/laptop/api/pi/providers", method: "GET" });
  await act(async () => removeButton("Remove OpenRouter's saved API key")!.click());
  await frames();
  expect(calls).toContainEqual({ url: "/api/devices/laptop/api/pi/providers/openrouter/logout", method: "POST" });
  expect(calls.filter((c) => c.method !== "GET").every((c) => c.url.includes("/api/pi/"))).toBe(true);
});

test("this device's provider actions go to the local Pi", async () => {
  await mount();
  await act(async () => removeButton("Sign out of xAI")!.click());
  await frames();
  expect(calls).toContainEqual({ url: "/api/pi/providers/xai/logout", method: "POST" });
});
