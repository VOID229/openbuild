import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// Activity lines in a bot's chat, rendered in a DOM: a bot's own activity names it first, by id.
// Each test file runs in its own process (scripts/test.ts), so the globals stay here.
const win = new Window({ url: "http://localhost/" });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(win)) if (!(key in g)) g[key] = (win as any)[key];
Object.assign(g, { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, sessionStorage: win.sessionStorage, location: win.location, history: win.history, getComputedStyle: win.getComputedStyle.bind(win) });
g.window.matchMedia = (q: string) => ({ matches: q.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} });
g.matchMedia = g.window.matchMedia;
g.IS_REACT_ACT_ENVIRONMENT = true;

const look = { shape: "puff", color: "blue" };
const scout = { id: "scout", name: "Scout", look, instructions: "", memory: [], routines: [], createdAt: 1 };
const juniper = { id: "juniper", name: "Juniper", look, instructions: "", memory: [], routines: [], createdAt: 1 };
let snapshot: any;
globalThis.fetch = (async (input: string) => {
  const path = String(input).replace(/^http:\/\/localhost/, "");
  if (path === "/api/config") return Response.json({ mode: "local", serverId: "srv", machine: "Studio" });
  const headers = { "x-openbuild-server": "srv" };
  if (path.endsWith("/api/bots")) return Response.json(snapshot, { headers });
  if (path.endsWith("/api/bots/stream")) return new Response(new ReadableStream(), { headers });
  return Response.json({ ok: true }, { headers });
}) as unknown as typeof fetch;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useStore } = await import("../src/lib/store");
const { enterWorkspace, switchWorkspace, useBots } = await import("../src/lib/bots/store");
const { useWorkspace } = await import("../src/lib/bots/workspace");
const { BotsView } = await import("../src/components/bots/BotsView");

let root: ReturnType<typeof createRoot>;
const frames = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const event = (id: string, author: string, e: Record<string, unknown>) => ({ id, author, at: Number(id.slice(1)), text: "", event: e });
const lines = () => [...document.querySelectorAll(".bm-event")];
const line = (id: string) => document.querySelector(`.bm-event[data-id="${id}"]`)!;
const lead = (id: string) => line(id).querySelector(".bm-event-text")!;

async function show(messages: any[], bots: any[] = [scout, juniper], status: Record<string, unknown> = {}) {
  snapshot = { bots, conversations: [{ id: "chat", kind: "direct", botIds: ["scout"], createdAt: 1, updatedAt: 1, messages }], settings: { sections: [] }, typing: {}, drafts: [], status };
  await act(async () => void (await switchWorkspace("srv")));
  await frames();
  useBots.setState({ activeId: "chat" });
  await act(async () => root.render(h(BotsView)));
  await frames();
}

beforeEach(() => {
  useStore.setState({ devices: [{ id: "srv", serverId: "srv", name: "Studio", local: true, mode: "lan", urls: [], online: true }], devicesLoaded: true, chats: [
    { id: "t1", title: "Fix the build", messages: [], createdAt: 1, updatedAt: 1, pullRequest: { number: 12, url: "https://github.com/o/r/pull/12", title: "Fix the build" } },
  ] } as any);
  useWorkspace.setState({ localId: "srv", localName: "Studio", problem: undefined, switching: undefined });
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  enterWorkspace("away");
});

test("a bot's prompt, stop, close and merge lines name it first, keeping their thread and pull request links", async () => {
  await show([
    event("e1", "scout", { kind: "thread", text: "Wrote a prompt in", detail: "Fix the build", threadId: "t1" }),
    event("e2", "scout", { kind: "thread", text: "Stopped a thread", detail: "Fix the build", threadId: "t1" }),
    event("e3", "scout", { kind: "thread", text: "Closed a thread", detail: "Fix the build", threadId: "t1" }),
    event("e4", "scout", { kind: "thread", text: "Merged a pull request", detail: "#12 Fix the build", threadId: "t1", pullUrl: "https://github.com/o/r/pull/12" }),
    event("e5", "scout", { kind: "thread", text: "Started a thread", detail: "Fix the build · Claude", threadId: "t1" }),
  ]);
  expect(lines().map((l) => lead(l.getAttribute("data-id")!).textContent)).toEqual(["Scout wrote a prompt in", "Scout stopped a thread", "Scout closed a thread", "Scout merged a pull request", "Scout started a thread"]);
  for (const id of ["e1", "e2", "e3", "e4", "e5"]) {
    // The name is a link to the bot, and the thread's title still links to the thread.
    expect(lead(id).querySelector(".link, a, button")?.textContent).toBe("Scout");
    expect(line(id).querySelector(".bm-event-detail")!.textContent).toContain("Fix the build");
    expect(line(id).querySelector(`.bm-event-detail a[href*="t1"]`)).not.toBeNull();
  }
  expect(line("e4").querySelector('a[href="https://github.com/o/r/pull/12"]')?.textContent).toBe("#12");
});

test("the name follows a rename, since it's looked up by the author's id", async () => {
  await show([event("e1", "scout", { kind: "thread", text: "Closed a thread", detail: "Fix the build", threadId: "t1" })], [{ ...scout, name: "Ranger" }, juniper]);
  expect(lead("e1").textContent).toBe("Ranger closed a thread");
  expect(document.body.textContent).not.toContain("Scout");
});

test("the user's own lines, and lines that already name a bot, keep their wording", async () => {
  await show([
    event("e1", "me", { kind: "created", text: "Created the group", detail: "Team" }),
    event("e2", "me", { kind: "joined", text: "Added", detail: "Juniper", bot: "juniper" }),
    event("e3", "juniper", { kind: "left", text: "Juniper left" }),
    event("e4", "scout", { kind: "message", text: "Sent a message", bot: "juniper", conversationId: "side" }),
    event("e5", "scout", { kind: "model", text: "Switched to fallback model Sonnet", detail: "anthropic", model: "anthropic/sonnet" }),
    event("e6", "scout", { kind: "poll", text: "Poll closed", detail: "Lunch?" }),
  ]);
  expect(lead("e1").textContent).toBe("Created the group");
  expect(lead("e2").textContent).toBe("Added");
  expect(line("e2").querySelector(".bm-event-detail")!.textContent).toBe("Juniper");
  expect(lead("e3").textContent).toBe("Juniper left");
  expect(lead("e4").textContent).toBe("Sent a message to Juniper");
  // An older switch keeps only the model's name: no place in the chain, no provider.
  expect(lead("e5").textContent).toBe("Scout switched to Sonnet");
  expect(line("e5").querySelector(".bm-event-detail")).toBeNull();
  expect(lead("e6").textContent).toBe("Poll closed");
});

test("routines, other bot events and older saved wording read naturally after the name", async () => {
  await show([
    event("e1", "scout", { kind: "routine", text: "Set a routine", detail: "Standup · Weekdays at 9:00" }),
    event("e11", "scout", { kind: "routine", text: "Ran a routine", detail: "Standup" }),
    event("e2", "scout", { kind: "routine", text: "Routine", detail: "Standup · Weekdays at 9:00" }),
    event("e3", "scout", { kind: "routine", text: "Routine", detail: "Standup" }),
    event("e4", "scout", { kind: "routine", text: "Follow-up set", detail: "Check CI · in 2 hours" }),
    event("e5", "scout", { kind: "routine", text: "Follow-up", detail: "Check CI" }),
    event("e6", "scout", { kind: "created", text: "New bot", detail: "Juniper", bot: "juniper" }),
    event("e7", "scout", { kind: "joined", text: "Added", detail: "Juniper", bot: "juniper" }),
    event("e8", "scout", { kind: "error", text: "Couldn't reply", detail: "rate limited" }),
    event("e9", "scout", { kind: "thread", text: "Wrote to a thread", detail: "Fix the build", threadId: "t1" }),
    event("e10", "scout", { kind: "thread", text: "Answered a thread's question", detail: "Which branch? → main", threadId: "t1" }),
  ]);
  expect(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11"].map((id) => lead(id).textContent)).toEqual([
    "Scout set a routine", "Scout set a routine", "Scout ran a routine", "Scout set a follow-up", "Scout followed up",
    "Scout made a new bot", "Scout added", "Scout couldn't reply", "Scout wrote a prompt in", "Scout answered a thread's question", "Scout ran a routine",
  ]);
  expect(line("e1").querySelector(".bm-event-detail")!.textContent).toContain("Standup · Weekdays at 9:00");
  expect(line("e6").querySelector(".bm-event-detail")!.textContent).toBe("Juniper");
});

test("a model switch links its bot and names the model, with the account only to tell two apart", async () => {
  await show([
    event("e1", "scout", { kind: "model", text: "Switched to GPT 6.1 Sol", detail: "openai-codex-2", model: "openai-codex-2/gpt-6.1-sol" }),
    event("e2", "scout", { kind: "model", text: "Switched to Grok 4.7", model: "xai/grok-4.7" }),
    event("e3", "scout", { kind: "model", text: "Switched to second priority model GPT 6.1 Sol", detail: "openai-codex", model: "openai-codex/gpt-6.1-sol" }),
  ], [{ ...scout, name: "Ranger" }, juniper]);
  expect(lead("e1").textContent).toBe("Ranger switched to GPT 6.1 Sol (Codex 2)");
  expect(lead("e2").textContent).toBe("Ranger switched to Grok 4.7");
  expect(lead("e3").textContent).toBe("Ranger switched to GPT 6.1 Sol");
  for (const id of ["e1", "e2", "e3"]) {
    expect(lead(id).querySelector("a, button")?.textContent).toBe("Ranger");
    expect(line(id).querySelector(".bm-event-detail")).toBeNull();
  }
});

test("a failed reply says so, without the provider's error, on old lines as on new", async () => {
  await show([
    // Saved before: every fallback's error, a provider's JSON, an HTTP status.
    event("e1", "scout", { kind: "error", text: "Couldn't reply", detail: "Every model failed.\nanthropic/opus: 429 rate_limit_error\nopenai-codex/gpt-6.1-sol: over its limit" }),
    event("e2", "scout", { kind: "error", text: "Couldn't reply", detail: '{"type":"error","error":{"type":"overloaded_error"}}' }),
    event("e3", "scout", { kind: "error", text: "Couldn't reply", detail: "Request failed with status 503" }),
    // New: no detail at all, or only a lapsed sign-in's fix.
    event("e4", "scout", { kind: "error", text: "Couldn't reply" }),
    event("e5", "scout", { kind: "error", text: "Couldn't reply", detail: "The sign-in for this model has expired. Sign in again in Settings → Providers.\ninvalid_grant: token expired" }),
    // OpenBuild's own reasons, which aren't the provider's, still show.
    event("e6", "scout", { kind: "error", text: "Couldn't reply", detail: "The reply took too long and was stopped." }),
  ]);
  for (const id of ["e1", "e2", "e3", "e4", "e5", "e6"]) expect(lead(id).textContent).toBe("Scout couldn't reply");
  for (const id of ["e1", "e2", "e3", "e4"]) expect(line(id).querySelector(".bm-event-detail")).toBeNull();
  expect(line("e5").querySelector(".bm-event-detail")!.textContent).toBe("The sign-in for this model has expired. Sign in again in Settings → Providers.");
  expect(line("e6").querySelector(".bm-event-detail")!.textContent).toBe("The reply took too long and was stopped.");
  expect(document.body.textContent).not.toMatch(/Every model failed|rate_limit|overloaded|503|invalid_grant/);
});

test("the bar over the chat gives a failed reply's gist, not the provider's error it keeps", async () => {
  const failed = { state: "error", conversationId: "chat", provider: true, error: "Every model failed.\nanthropic/opus: 429 rate_limit_error" };
  await show([], undefined, { scout: failed });
  expect(document.querySelector(".bots-sync-status")!.textContent).toBe("Bot could not complete the request.");
  const set = (status: Record<string, unknown>) => act(async () => void useBots.setState({ status } as any));
  await set({ scout: { ...failed, error: "The sign-in for this model has expired. Sign in again in Settings → Providers.\ninvalid_grant" } });
  expect(document.querySelector(".bots-sync-status")!.textContent).toBe("The sign-in for this model has expired. Sign in again in Settings → Providers.");
  await set({ scout: { state: "error", conversationId: "chat", error: "Pi isn't installed. Install it in Settings → Pi." } });
  expect(document.querySelector(".bots-sync-status")!.textContent).toBe("Pi isn't installed. Install it in Settings → Pi.");
});
