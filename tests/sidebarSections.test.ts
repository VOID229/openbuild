import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Chat } from "../src/lib/types";

// The thread list in a DOM: a shut section builds no rows (on a long-used install "Closed" is most
// threads, and its rows were most of a page load's work), opens with them, keeps them while it folds
// shut, and still marks a thread filed into it while it's shut. Its own process (scripts/test.ts).
const win = new Window({ url: "http://localhost/" });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(win)) if (!(key in g)) g[key] = (win as any)[key];
Object.assign(g, { window: win, Event: win.Event, document: win.document, navigator: win.navigator, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win) });
g.window.matchMedia = g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
g.IS_REACT_ACT_ENVIRONMENT = true;
(win as any).fetch = g.fetch = async () => Response.json({});

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useStore } = await import("../src/lib/store");
const { Sidebar } = await import("../src/components/Sidebar");

const DAY = 86_400_000;
const thread = (id: string, extra: Partial<Chat> = {}): Chat => ({ id, title: `Thread ${id}`, createdAt: 1, updatedAt: Date.now() - 2 * DAY, runtime: "pi", messages: [], ...extra });
const closed = Array.from({ length: 300 }, (_, i) => thread(`closed-${i}`, { archived: true }));
const rows = (host: HTMLElement, label: string) => {
  const section = [...host.querySelectorAll(".history-group")].find((s) => s.querySelector(".history-heading")?.textContent?.startsWith(label))!;
  return { section, heading: section.querySelector<HTMLElement>(".history-heading")!, rows: section.querySelectorAll(".history-row").length };
};

test("a shut section has no rows until it opens, and keeps them while it folds shut", async () => {
  useStore.setState({ chats: [thread("pinned", { pinned: true, updatedAt: Date.now() }), ...closed], chatsLoaded: true, sidebarOpen: true, activeChatId: "pinned" });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(h(Sidebar)));
  expect(rows(host, "Pinned").rows).toBe(1);
  expect(rows(host, "Closed").heading.textContent).toContain("Closed 300");
  expect(rows(host, "Closed").rows).toBe(0);

  await act(async () => rows(host, "Closed").heading.click());
  expect(rows(host, "Closed").rows).toBe(300);

  // Shutting it folds the rows away before they go.
  await act(async () => rows(host, "Closed").heading.click());
  expect(rows(host, "Closed").section.querySelector(".collapse-open")).toBeNull();
  expect(rows(host, "Closed").rows).toBe(300);
  await act(() => Bun.sleep(320));
  expect(rows(host, "Closed").rows).toBe(0);

  // Closing a thread plays its row out and files it under the shut "Closed", whose heading marks the spot.
  await act(async () => host.querySelector<HTMLElement>('.history-row[data-thread="pinned"] [aria-label="Close"]')!.click());
  await act(() => Bun.sleep(340));
  const after = rows(host, "Closed");
  expect(after.heading.textContent).toContain("Closed 301");
  expect(after.rows).toBe(0);
  expect(after.heading.dataset.landed).toBe("");
  await act(() => Bun.sleep(500));
  expect(rows(host, "Closed").heading.dataset.landed).toBeUndefined();
  await act(async () => root.unmount());
});
