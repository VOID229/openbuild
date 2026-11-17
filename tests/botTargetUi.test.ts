import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// A bot's "Works in" picker, clicked at in a DOM: it offers the bot's own chat and the groups it's
// in, not a group it isn't in or one shared with a friend, shows the target that's set, and picking
// saves it (PATCH /api/bots/:id { target }), back to its own chat as an empty target.
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
const { BotWorksIn } = await import("../src/components/bots/BotAdvanced");
type Bot = import("../src/lib/bots/types").Bot;
type Conversation = import("../src/lib/bots/types").Conversation;

let patches: { path: string; body: unknown }[] = [];
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;

const chat = (c: Partial<Conversation> & Pick<Conversation, "id" | "kind" | "botIds">) => ({ createdAt: 1, updatedAt: 1, messages: [], ...c }) as Conversation;

beforeEach(() => {
  patches = [];
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (init?.method === "PATCH") patches.push({ path: path.replace(/^.*(?=\/api\/bots\/)/, ""), body: JSON.parse(String(init.body)) });
    return Response.json({});
  }) as unknown as typeof fetch;
  useBots.setState({
    bots: [{ id: "pip", name: "Pip", look: {} as Bot["look"], instructions: "", memory: [], routines: [], createdAt: 1 } as Bot],
    conversations: [
      chat({ id: "own", kind: "direct", botIds: ["pip"] }),
      chat({ id: "dev", kind: "group", name: "Dev", botIds: ["pip", "egg"] }),
      chat({ id: "ops", kind: "group", name: "Ops", botIds: ["egg", "tally"] }),
      chat({ id: "alice", kind: "group", name: "With Alice", botIds: ["pip"], friend: { friend: "f1", friendName: "Alice", members: [] } as never }),
    ],
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
const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-label="Works in"]')!;
const options = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim());

async function mount() {
  const View = () => createElement(BotWorksIn, { bot: useBots((s) => s.bots[0]!) });
  await act(async () => root.render(createElement(View)));
  await frames();
}

test("offers its own chat and its groups, and saves the one picked", async () => {
  await mount();
  expect(trigger().textContent).toBe("Its own chat");
  await click(trigger());
  await frames();
  expect(options()).toEqual(["Its own chat", "Dev"]);
  await click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.trim() === "Dev")!);
  await frames();
  expect(patches).toEqual([{ path: "/api/bots/pip", body: { target: "dev" } }]);
  expect(trigger().textContent).toBe("Dev");
  // And back to its own chat: an empty target, which the server clears.
  await click(trigger());
  await frames();
  await click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.trim() === "Its own chat")!);
  await frames();
  expect(patches.at(-1)).toEqual({ path: "/api/bots/pip", body: { target: "" } });
  expect(trigger().textContent).toBe("Its own chat");
});

test("a bot in no group has nothing to pick, and a target it can't use reads as its own chat", async () => {
  useBots.setState((s) => ({ conversations: s.conversations.filter((c) => c.id !== "dev"), bots: s.bots.map((b) => ({ ...b, target: "ops" })) }));
  await mount();
  expect(trigger().textContent).toBe("Its own chat");
  expect(trigger().disabled).toBe(true);
});
