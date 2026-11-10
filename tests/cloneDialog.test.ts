import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// The Clone repository dialog, typed at in a DOM against a pretend file system: an existing folder
// gets the clone in a subfolder named after the repository, and only a taken final path stops it.
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
const { NewProjectDialog } = await import("../src/components/NewProject");

/** Folders on the pretend server, and whether each is empty. */
let folders: Record<string, boolean> = {};
let clones: { url: string; path: string }[] = [];
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  clones = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/fs") {
      const dir = (url.searchParams.get("dir") ?? "").replace(/\/+$/, "");
      return dir in folders ? Response.json({ dir, empty: folders[dir], entries: [] }) : Response.json({ error: "No folder" }, { status: 400 });
    }
    if (url.pathname === "/api/projects/clone") {
      clones.push(JSON.parse(String(init?.body)));
      return Response.json({ project: { id: "p1", name: "kodbot", path: "/x" } });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  useStore.setState({ devices: [], settings: { ...useStore.getState().settings, projectsDir: "~/code" } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

/** Waits out the dialog's checks, one after another: React flushes each as its act() ends. */
async function settle() {
  for (let i = 0; i < 4; i++) await act(() => new Promise((r) => setTimeout(r, 300)));
}
const hint = () => document.querySelector(".np-hint")!.textContent!.trim();
const cloneButton = () => document.querySelector<HTMLButtonElement>("button[type=submit]")!;
function type(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new (win as any).Event("input", { bubbles: true }));
  });
}
async function open(path: string) {
  act(() => root.render(createElement(NewProjectDialog, { start: { clone: true }, onClose: () => {} })));
  type(".np-url", "https://github.com/dkod-ai/kodbot.git");
  type("input.np-path", path);
  await settle();
}

test("an existing folder gets the clone in a subfolder named after the repository", async () => {
  folders = { "~/Efforts/active": false };
  await open("~/Efforts/active");
  expect(hint()).toBe("Will clone to ~/Efforts/active/kodbot");
  expect(cloneButton().disabled).toBe(false);
  await act(async () => cloneButton().click());
  expect(clones).toEqual([{ url: "https://github.com/dkod-ai/kodbot.git", path: "~/Efforts/active/kodbot" }]);
}, 10_000);

test("a path that isn't there is the clone's own folder", async () => {
  folders = { "~/Efforts": false };
  await open("~/Efforts/kb");
  expect(hint()).toBe("Will clone to ~/Efforts/kb");
  expect(cloneButton().disabled).toBe(false);
}, 10_000);

test("only a final path with something in it stops the clone", async () => {
  folders = { "~/Efforts/active": false, "~/Efforts/active/kodbot": false };
  await open("~/Efforts/active");
  expect(hint()).toBe("~/Efforts/active/kodbot already exists and isn't empty");
  expect(cloneButton().disabled).toBe(true);
  // Empty, it takes the clone.
  folders["~/Efforts/active/kodbot"] = true;
  await open("~/Efforts/active/");
  expect(hint()).toBe("Will clone to ~/Efforts/active/kodbot");
  expect(cloneButton().disabled).toBe(false);
}, 10_000);
