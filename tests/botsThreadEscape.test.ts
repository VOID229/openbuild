import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// Escape in a thread opened inside OpenBots (/bots/thread-<id>), pressed in a DOM: it goes back like
// the Back button, after anything on top of the thread has had it. Each test file runs in its own
// process (scripts/test.ts), so the globals stay here.
const win = new Window({ url: "http://localhost/" });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(win)) if (!(key in g)) g[key] = (win as any)[key];
Object.assign(g, { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win) });
g.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
g.matchMedia = g.window.matchMedia;
g.IS_REACT_ACT_ENVIRONMENT = true;
// The store loads saved settings from /api/state as it's imported, retrying for a few seconds. Answer
// it before the import, and let it finish before the tests count what they send.
globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;

const { act, Activity, createElement: h, useRef, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useStore } = await import("../src/lib/store");
const { useBots } = await import("../src/lib/bots/store");
const { startRouting } = await import("../src/lib/routes");
const { useDismiss } = await import("../src/lib/ui");
const { Lightbox, openLightbox, useLightbox } = await import("../src/components/Lightbox");
const { closeBotsThread, useBotsThreadEscape } = await import("../src/lib/botsThread");

let fetches: string[] = [];
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let stopRouting: () => void;

/** A menu that, like every popover here, closes on Escape through useDismiss. */
function Menu() {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), [ref]);
  return open ? h("div", { ref, role: "menu", className: "test-menu" }, h("button", { role: "menuitem" }, "Item")) : null;
}

/** The composer's Escape: it closes an open suggestion list (preventing the key), and otherwise lets it go. */
function Composer() {
  const [suggesting, setSuggesting] = useState(false);
  return h("textarea", {
    className: "composer-input",
    defaultValue: "half-written draft",
    "data-suggesting": String(suggesting),
    onInput: () => setSuggesting(true),
    onKeyDown: (e: KeyboardEvent & { preventDefault(): void }) => {
      if (e.key === "Escape" && suggesting) {
        e.preventDefault();
        setSuggesting(false);
      }
    },
  });
}

/** App's shape: the bot chat and the thread both stay mounted, one hidden, with the hook and the Back button. */
function App({ menu }: { menu?: boolean }) {
  const botsThread = useStore((s) => s.botsOpen && s.botsThread && !s.usageOpen);
  useBotsThreadEscape(botsThread);
  return h("div", null,
    botsThread && h("button", { "aria-label": "Back to chat", onClick: closeBotsThread }),
    h(Activity, { mode: botsThread ? "hidden" : "visible", children: h("section", { className: "bot-chat" }, h("textarea", { className: "bot-draft", defaultValue: "bot draft" })) }),
    h(Activity, { mode: botsThread ? "visible" : "hidden", children:
      h("section", { className: "thread" },
        h("div", { className: "thread-scroll", style: { height: "100px", overflow: "auto" } }, h("div", { style: { height: "2000px" } })),
        h("input", { className: "file-search", defaultValue: "query" }),
        h(Composer),
        menu && h(Menu)) }),
    h(Lightbox));
}

/** A browser history, so where Escape lands is checked as a URL. */
function browser() {
  const location = new URL("http://localhost/bots/thread-t1");
  const entries: string[] = [location.pathname];
  return {
    location,
    entries,
    history: {
      state: null as any,
      replaceState(state: any, _: string, url: string) { this.state = state; entries[entries.length - 1] = url; location.href = new URL(url, location.origin).href; },
      pushState(state: any, _: string, url: string) { this.state = state; entries.push(url); location.href = new URL(url, location.origin).href; },
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

beforeAll(async () => {
  if (!useStore.persist.hasHydrated()) await new Promise<void>((resolve) => useStore.persist.onFinishHydration(() => resolve()));
});

beforeEach(() => {
  fetches = [];
  globalThis.fetch = (async (path: string) => {
    fetches.push(String(path));
    return Response.json({});
  }) as unknown as typeof fetch;
  useStore.setState({ chats: [{ id: "t1", title: "Fix README", messages: [{ id: "m1", role: "assistant", content: "", status: "streaming" }] } as any], activeChatId: "t1", settingsOpen: false, usageOpen: false, botsOpen: true, botsThread: true });
  useBots.setState({ activeId: "conv-manager" } as any);
  useLightbox.setState({ open: false, images: [], index: 0 });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  stopRouting?.();
  act(() => root.unmount());
  document.body.innerHTML = "";
});

async function mount(props: { menu?: boolean } = {}) {
  await act(async () => root.render(h(App, props)));
}
async function escape(el: Element = document.body, init: Record<string, unknown> = {}) {
  const e = new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
  await act(async () => { el.dispatchEvent(e as any); });
  return e;
}
const inThread = () => useStore.getState().botsThread;
const composer = () => document.querySelector<HTMLTextAreaElement>(".composer-input")!;

test("Escape returns to the OpenBots conversation the thread was opened from, as Back does", async () => {
  const b = browser();
  stopRouting = startRouting({ getState: useStore.getState, setState: useStore.setState, subscribe: useStore.subscribe, selectChat: (id: string) => useStore.setState({ activeChatId: id }) } as any, b as any);
  expect(b.location.pathname).toBe("/bots/thread-t1");
  await mount();
  const e = await escape();
  expect(inThread()).toBe(false);
  expect(e.defaultPrevented).toBe(true);
  // The bot chat comes back: same OpenBots conversation, URL back on /bots, OpenBots still open.
  expect(b.location.pathname).toBe("/bots");
  expect(useStore.getState().botsOpen).toBe(true);
  expect(useBots.getState().activeId).toBe("conv-manager");
  expect(useStore.getState().activeChatId).toBe("t1");
  // Nothing was sent: the thread's agent keeps working.
  expect(fetches).toEqual([]);
  expect(useStore.getState().chats[0]!.messages[0]!.status).toBe("streaming");
  // Back does the same.
  await act(async () => useStore.setState({ botsThread: true }));
  await act(async () => { document.querySelector<HTMLButtonElement>("[aria-label='Back to chat']")!.click(); });
  expect(inThread()).toBe(false);
});

test("from the focused composer Escape goes back too, keeping the thread's and the bot chat's drafts and scroll", async () => {
  await mount();
  const scroll = document.querySelector<HTMLElement>(".thread-scroll")!;
  scroll.scrollTop = 600;
  const input = composer();
  input.focus();
  expect(document.activeElement).toBe(input);
  await escape(input);
  expect(inThread()).toBe(false);
  // Both panes stayed mounted, so coming back finds everything where it was.
  expect(document.querySelector<HTMLTextAreaElement>(".bot-draft")!.value).toBe("bot draft");
  await act(async () => useStore.setState({ botsThread: true }));
  expect(composer()).toBe(input);
  expect(composer().value).toBe("half-written draft");
  expect(document.querySelector<HTMLElement>(".thread-scroll")).toBe(scroll);
  expect(scroll.scrollTop).toBe(600);
});

test("the composer's own Escape (closing its suggestions) comes first, and the next one goes back", async () => {
  await mount();
  const input = composer();
  input.focus();
  await act(async () => { input.dispatchEvent(new win.Event("input", { bubbles: true }) as any); });
  expect(input.dataset.suggesting).toBe("true");
  await escape(input);
  expect(input.dataset.suggesting).toBe("false");
  expect(inThread()).toBe(true);
  await escape(input);
  expect(inThread()).toBe(false);
});

test("while an IME is composing, Escape cancels the composition and stays", async () => {
  await mount();
  composer().focus();
  await escape(composer(), { isComposing: true });
  expect(inThread()).toBe(true);
  await escape(composer(), { keyCode: 229 });
  expect(inThread()).toBe(true);
});

test("an open menu takes the first Escape, then the next goes back", async () => {
  await mount({ menu: true });
  composer().focus();
  expect(document.querySelector(".test-menu")).not.toBeNull();
  await escape(composer());
  expect(document.querySelector(".test-menu")).toBeNull();
  expect(inThread()).toBe(true);
  await escape(composer());
  expect(inThread()).toBe(false);
});

test("the image viewer takes the first Escape, then the next goes back", async () => {
  await mount();
  await act(async () => openLightbox([{ id: "i1", name: "shot.png", dataUrl: "data:," }], "i1"));
  await escape();
  expect(useLightbox.getState().open).toBe(false);
  expect(inThread()).toBe(true);
  // Its exit transition still covers the thread; once it's gone, Escape goes back.
  await act(async () => { await new Promise((r) => setTimeout(r, 260)); });
  await escape();
  expect(inThread()).toBe(false);
});

test("an open dialog, a focused popover, Settings and Usage all keep Escape", async () => {
  await mount();
  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  document.body.appendChild(dialog);
  await escape();
  expect(inThread()).toBe(true);
  dialog.remove();

  const popover = document.createElement("div");
  popover.setAttribute("role", "listbox");
  const option = document.createElement("button");
  popover.appendChild(option);
  document.body.appendChild(popover);
  option.focus();
  await escape(option);
  expect(inThread()).toBe(true);
  popover.remove();

  await act(async () => useStore.setState({ settingsOpen: true }));
  await escape();
  expect(inThread()).toBe(true);
  await act(async () => useStore.setState({ settingsOpen: false, usageOpen: true }));
  await escape();
  expect(useStore.getState().botsThread).toBe(true);
  await act(async () => useStore.setState({ usageOpen: false }));
});

test("other fields in the thread, and modified or held Escapes, keep their own behaviour", async () => {
  await mount();
  const search = document.querySelector<HTMLInputElement>(".file-search")!;
  search.focus();
  await escape(search);
  expect(inThread()).toBe(true);
  search.blur();
  await escape(document.body, { shiftKey: true });
  await escape(document.body, { metaKey: true });
  await escape(document.body, { repeat: true });
  expect(inThread()).toBe(true);
});

test("a normal OpenBuild thread, and the bot chat itself, leave Escape alone", async () => {
  await act(async () => useStore.setState({ botsOpen: false, botsThread: false }));
  await mount();
  composer().focus();
  const e = await escape(composer());
  expect(e.defaultPrevented).toBe(false);
  expect(useStore.getState()).toMatchObject({ botsOpen: false, botsThread: false, activeChatId: "t1" });
  // In the bot chat, Escape stays the bot chat's (it closes the details panel there).
  await act(async () => useStore.setState({ botsOpen: true }));
  expect((await escape()).defaultPrevented).toBe(false);
  expect(useStore.getState().botsOpen).toBe(true);
});
