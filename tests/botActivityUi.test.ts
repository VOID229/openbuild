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
const { clock: clockAt } = await import("../src/lib/clock");

let root: ReturnType<typeof createRoot>;
const frames = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
// The chat's clock, a moment after these fixtures' times: a bot's error shows for a minute after it
// happened (ERROR_SHOWN_MS), so the errors here are fresh. The test that lets one expire moves it on.
let clock = 10_000;
Date.now = () => clock;
const event = (id: string, author: string, e: Record<string, unknown>) => ({ id, author, at: Number(id.slice(1)), text: "", event: e });
const lines = () => [...document.querySelectorAll(".bm-event")];
const line = (id: string) => document.querySelector<HTMLElement>(`.bm-event[data-id="${id}"]`)!;
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
  clock = 10_000;
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
  // Setting one says when it was set, what it's called and when it runs, in its own words.
  expect(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11"].map((id) => lead(id).textContent)).toEqual([
    `At ${clockAt(1)}, Scout set routine “Standup” for weekdays at 9:00`, `At ${clockAt(2)}, Scout set routine “Standup” for weekdays at 9:00`, "Scout ran a routine",
    `At ${clockAt(4)}, Scout set a follow-up “Check CI” for in 2 hours`, "Scout followed up",
    "Scout made a new bot", "Scout added", "Scout couldn't reply", "Scout wrote a prompt in", "Scout answered a thread's question", "Scout ran a routine",
  ]);
  for (const id of ["e1", "e2", "e4"]) expect(line(id).querySelector(".bm-event-detail")).toBeNull();
  expect(line("e3").querySelector(".bm-event-detail")!.textContent).toBe("Standup");
  expect(line("e6").querySelector(".bm-event-detail")!.textContent).toBe("Juniper");
});

test("a routine line set at a quarter to one says so, with the time first", async () => {
  const at = new Date(2026, 10, 13, 12, 45).getTime();
  clock = at + 60_000;
  await show([{ id: "e1", author: "scout", at, text: "", event: { kind: "routine", text: "Set a follow-up", detail: "Check the deploy · in 5 minutes" } }]);
  expect(lead("e1").textContent).toBe(`At ${clockAt(at)}, Scout set a follow-up “Check the deploy” for in 5 minutes`);
  expect(lead("e1").textContent).toMatch(/^At 12:45/);
  // The bot's name links to it, and the words to its routines.
  expect([...lead("e1").querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Scout", "set a follow-up"]);
});

test("a routine line opens its bot's Routines in the details panel, from its own chat or a group", async () => {
  const routine = { id: "r1", title: "Standup", schedule: "Weekdays at 9:00", task: "Ask everyone what they did yesterday", enabled: true };
  await show([event("e1", "scout", { kind: "routine", text: "Set a routine", detail: "Standup · Weekdays at 9:00" })], [{ ...scout, routines: [routine] }, juniper]);
  const tab = () => document.querySelector(".bots-details [role='tab'][aria-selected='true']")?.textContent;
  const open = async (id: string) => {
    const link = [...lead(id).querySelectorAll("button")].find((b) => b.textContent === "set routine")!;
    await act(async () => link.click());
    await frames();
  };
  await open("e1");
  expect(useBots.getState().detailsOpen).toBe(true);
  expect(tab()).toBe("Routines");
  // Following it doesn't also toggle the row open.
  expect(line("e1").classList.contains("bm-event-open")).toBe(false);
  // A routine is a thin row: its title and when, with its task only once opened.
  const row = () => document.querySelector(".bots-details .bots-routine")!;
  expect(row().querySelector(".bots-routine-title")!.textContent).toBe("Standup");
  expect(row().querySelector(".bots-routine-when")!.textContent).toBe("Weekdays at 9:00");
  expect(row().querySelector(".bots-routine-task")).toBeNull();
  expect([...row().querySelectorAll(".bots-routine-action")].map((b) => b.textContent)).toEqual(["Open", "Delete"]);
  await act(async () => row().querySelector<HTMLElement>(".bots-routine-action")!.click());
  expect(row().querySelector(".bots-routine-task")!.textContent).toBe("Ask everyone what they did yesterday");
  await act(async () => row().querySelector<HTMLElement>(".bots-routine-action")!.click());
  expect(row().querySelector(".bots-routine-task")).toBeNull();

  // In a group, the line opens the group's own Routines, where the routine reports.
  await act(async () => useBots.setState((s) => ({
    detailsOpen: false,
    conversations: [...s.conversations, { id: "group", kind: "group" as const, botIds: ["scout", "juniper"], createdAt: 1, updatedAt: 1, messages: [event("e2", "scout", { kind: "routine", text: "Set a routine", detail: "Standup · Weekdays at 9:00" }) as any] }],
    activeId: "group",
  })));
  await frames();
  await open("e2");
  expect(useBots.getState().activeId).toBe("group");
  expect(useBots.getState().detailsOpen).toBe(true);
  expect(tab()).toBe("Routines");

  // A side chat's panel has none, so from there the line goes to the bot's own chat for them.
  await act(async () => useBots.setState((s) => ({
    detailsOpen: false,
    conversations: [...s.conversations, { id: "side", kind: "side" as const, botIds: ["scout", "juniper"], createdAt: 1, updatedAt: 1, messages: [event("e3", "scout", { kind: "routine", text: "Set a routine", detail: "Standup · Weekdays at 9:00" }) as any] }],
    activeId: "side",
  })));
  await frames();
  await open("e3");
  expect(useBots.getState().activeId).toBe("chat");
  expect(useBots.getState().detailsOpen).toBe(true);
  expect(tab()).toBe("Routines");
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

test("a change of settings links its bot by id, so a rename shows up, and keeps old and new values", async () => {
  await show([
    event("e1", "scout", { kind: "changed", text: "Scout's model: Grok 4.7 → GPT 6.1 Sol", bot: "scout" }),
    event("e2", "scout", { kind: "changed", text: "Scout's effort: default → high; OpenBuild: off → on", bot: "scout" }),
  ], [{ ...scout, name: "Ranger" }, juniper]);
  expect(lead("e1").textContent).toBe("Ranger's model: Grok 4.7 → GPT 6.1 Sol");
  expect(lead("e2").textContent).toBe("Ranger's effort: default → high; OpenBuild: off → on");
  for (const id of ["e1", "e2"]) {
    expect(lead(id).querySelector("a, button")?.textContent).toBe("Ranger");
    expect(line(id).querySelector(".bm-event-detail")).toBeNull();
  }
  expect(document.body.textContent).not.toContain("Scout");
});

test("failed replies show provider diagnostics on old and new lines", async () => {
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
  expect(line("e4").querySelector(".bm-event-detail")).toBeNull();
  for (const id of ["e1", "e2", "e3"]) expect(line(id).querySelector(".bm-event-detail")).not.toBeNull();
  expect(line("e5").querySelector(".bm-event-detail")!.textContent).toBe("The sign-in for this model has expired. Sign in again in Settings → Providers.");
  expect(line("e6").querySelector(".bm-event-detail")!.textContent).toBe("The reply took too long and was stopped.");
  expect(document.body.textContent).not.toMatch(/invalid_grant/);
});

test("the status bar shows redacted provider diagnostics", async () => {
  const failed = { state: "error", conversationId: "chat", provider: true, error: "Every model failed.\nanthropic/opus: 429 rate_limit_error" };
  await show([], undefined, { scout: failed });
  expect(document.querySelector(".bots-sync-status")!.textContent).toBe(failed.error);
  const set = (status: Record<string, unknown>) => act(async () => void useBots.setState({ status } as any));
  await set({ scout: { ...failed, error: "The sign-in for this model has expired. Sign in again in Settings → Providers.\ninvalid_grant" } });
  expect(document.querySelector(".bots-sync-status")!.textContent).toBe("The sign-in for this model has expired. Sign in again in Settings → Providers.");
  await set({ scout: { state: "error", conversationId: "chat", error: "Pi isn't installed. Install it in Settings → Pi." } });
  expect(document.querySelector(".bots-sync-status")!.textContent).toBe("Pi isn't installed. Install it in Settings → Pi.");
  // A status saved without the provider mark still shows a plain provider error only as the gist.
  for (const error of PLAIN_PROVIDER_ERRORS) {
    await set({ scout: { state: "error", conversationId: "chat", error } });
    expect(document.querySelector(".bots-sync-status")!.textContent).toBe((await import("../shared/bots")).shownReplyError(error)!);
  }
});

// Plain one-line provider errors, as older lines saved them: no JSON, no HTTP status, maybe a key.
const PLAIN_PROVIDER_ERRORS = ["rate limited", "insufficient credits", "Invalid API key: sk-live-abcdef1234567890", "a/one is over its limit", "Pi exited (code 1): No API key found for anthropic"];

test("legacy provider errors appear redacted in chat, preview and copy", async () => {
  const { messageText } = await import("../src/components/bots/common");
  const lines = PLAIN_PROVIDER_ERRORS.map((detail, i) => event(`e${i + 1}`, "scout", { kind: "error", text: "Couldn't reply", detail }));
  await show(lines);
  lines.forEach((m, i) => {
    expect(lead(m.id).textContent).toBe("Scout couldn't reply");
    expect(line(m.id).querySelector(".bm-event-detail")!.textContent).toBe(PLAIN_PROVIDER_ERRORS[i]!.replace("sk-live-abcdef1234567890", "[redacted]"));
    // The preview, a reply quote and a copy all read the line through messageText.
    expect(messageText(m as any)).toContain(PLAIN_PROVIDER_ERRORS[i]!.replace("sk-live-abcdef1234567890", "[redacted]"));
  });
  expect(document.body.textContent).not.toMatch(/sk-live/);
  // The sidebar preview of a chat whose last word is one of them.
  expect(document.body.textContent).not.toContain("sk-live");
  const { shownReplyError } = await import("../shared/bots");
  for (const safe of ["Pi isn't installed. Install it in Settings → Pi.", "The reply took too long and was stopped.", 'Pi didn\'t answer "prompt" in time', "Pi isn't running (exited with code 1)", "Pi exited (code 137)"]) expect(shownReplyError(safe)).toBe(safe);
  for (const unsafe of PLAIN_PROVIDER_ERRORS) expect(shownReplyError(unsafe)).toBe(unsafe.replace("sk-live-abcdef1234567890", "[redacted]"));
  expect(shownReplyError("Pi isn't installed. Install it in Settings → Pi.", true)).toBe("Pi isn't installed. Install it in Settings → Pi.");
  // A bot's model that's gone with its extension says so, even inside a provider error or a chain's failures.
  const { modelUnavailable } = await import("../shared/bots");
  const gone = modelUnavailable("bridge/claude-x");
  expect(shownReplyError(gone, true)).toBe(gone);
  expect(shownReplyError(`Every model failed.\nbridge/claude-x: ${gone}\nb/two: b/two is over its limit sk-live-1`, true)).toContain(gone);
});

test("models bots are set to that bots can't use are named with who uses them", async () => {
  const { unavailableModels } = await import("../shared/bots");
  const bots = [
    { name: "Alpha", model: "bridge/x", fallbackModels: ["bridge/x", "mock/m"] },
    { name: "Beta", fallbackModels: ["bridge/y"], noFallbacks: true },
    { name: "Gamma", model: "mock/m" },
  ];
  expect(unavailableModels(bots, { defaultModel: "bridge/y", defaultFallbackModels: ["bridge/x"] }, new Set(["mock/m"]))).toEqual([
    { model: "bridge/y", usedBy: ["default"] },
    { model: "bridge/x", usedBy: ["default fallbacks", "Alpha", "Alpha fallbacks"] },
  ]);
  expect(unavailableModels(bots, {}, new Set(["mock/m", "bridge/x", "bridge/y"]))).toEqual([]);
});

test("activity lines in a row fold into one quiet toggle, opened on a click; an error stands on its own", async () => {
  await show([
    { id: "m1", author: "scout", at: 1, text: "On it." },
    event("e2", "scout", { kind: "routine", text: "Set a follow-up", detail: "Check CI · in 10 minutes" }),
    event("e3", "scout", { kind: "routine", text: "Followed up", detail: "Check CI" }),
    event("e4", "juniper", { kind: "routine", text: "Ran a routine", detail: "Standup" }),
    event("e5", "scout", { kind: "error", text: "Couldn't reply", detail: "rate limited" }),
    { id: "m6", author: "scout", at: 6, text: "Back." },
    event("e7", "scout", { kind: "thread", text: "Closed a thread", detail: "Fix the build", threadId: "t1" }),
  ]);
  const runs = [...document.querySelectorAll(".bm-events")];
  expect(runs).toHaveLength(1);
  const toggle = runs[0]!.querySelector<HTMLButtonElement>(".bm-events-toggle")!;
  // Who did it (their mascots), and how much, but not the lines themselves until asked.
  expect(toggle.textContent).toBe("3 background actions");
  expect(toggle.querySelectorAll(".bot")).toHaveLength(2);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  for (const id of ["e2", "e3", "e4"]) expect(line(id).hidden).toBe(true);
  // Their words are still there, for finding a line by id or reading it.
  expect(lead("e2").textContent).toBe(`At ${clockAt(2)}, Scout set a follow-up “Check CI” for in 10 minutes`);
  // An error, and a line on its own between messages, show as they are.
  expect(line("e5").hidden).toBe(false);
  expect(line("e5").closest(".bm-events")).toBeNull();
  expect(line("e7").hidden).toBe(false);
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  for (const id of ["e2", "e3", "e4"]) expect(line(id).hidden).toBe(false);
  await act(async () => toggle.click());
  for (const id of ["e2", "e3", "e4"]) expect(line(id).hidden).toBe(true);
});

test("a mention followed by the rest of the bot's full name reads as the name alone, and copies whole", async () => {
  await show([{ id: "m1", author: "me", at: 1, text: "@Scout · Primary hey" }], [{ ...scout, name: "Scout · Primary" }, juniper]);
  const mention = document.querySelector(".bm-mention")!;
  expect(mention.textContent).toBe("@Scout · Primary");
  expect(mention.querySelector(".bm-mention-tail")!.textContent).toBe(" · Primary");
  // Outside the chip, only the message's own words.
  expect(document.querySelector(".bm-text")!.textContent).toBe("@Scout · Primary hey");
  expect(mention.nextSibling?.textContent).toBe(" hey");
});

test("a bot's error shows for a minute after it happened, then leaves the chat", async () => {
  // Opened a second before its minute is up.
  clock = 2 + 59_000;
  await show([
    { id: "m1", author: "scout", at: 1, text: "On it." },
    event("e2", "scout", { kind: "error", text: "Couldn't reply", detail: "Codex error: The usage limit has been reached" }),
    { id: "m3", author: "scout", at: 3, text: "Back." },
  ]);
  expect(line("e2")).not.toBeNull();
  // The minute passes: it goes on its own, and the messages around it stay.
  clock = 2 + 60_000;
  await act(async () => void (await new Promise((r) => setTimeout(r, 1_300))));
  await frames();
  expect(line("e2")).toBeNull();
  expect(document.querySelector('[data-id="m1"]')).not.toBeNull();
  expect(document.querySelector('[data-id="m3"]')).not.toBeNull();
}, 10_000);

test("opened, the same line again and again in a row shows once with how many times; one in between splits them", async () => {
  const ran = (id: string, author: string, detail: string) => event(id, author, { kind: "routine", text: "Ran a routine", detail });
  await show([
    { id: "m1", author: "scout", at: 1, text: "On it." },
    ran("e2", "scout", "Check bots aren't ghosting"),
    ran("e3", "juniper", "Check threads and PRs"),
    ran("e4", "scout", "Check bots aren't ghosting"),
    ran("e5", "scout", "Check bots aren't ghosting"),
    ran("e6", "scout", "Check bots aren't ghosting"),
    ran("e7", "scout", "Check bots aren't ghosting"),
    ran("e8", "juniper", "Check threads and PRs"),
  ]);
  const toggle = document.querySelector<HTMLButtonElement>(".bm-events-toggle")!;
  expect(toggle.textContent).toBe("7 background actions");
  await act(async () => toggle.click());
  const shown = [...document.querySelectorAll<HTMLElement>(".bm-events .bm-event")].filter((l) => !l.hidden);
  expect(shown.map((l) => [l.dataset.id, l.querySelector(".bm-event-times")?.textContent ?? null])).toEqual([
    ["e2", null],
    ["e3", null],
    ["e4", "×4"],
    ["e8", null],
  ]);
  // The repeats stay in the page, hidden, so a line can still be found by its id.
  for (const id of ["e5", "e6", "e7"]) expect(line(id).hidden).toBe(true);
});
