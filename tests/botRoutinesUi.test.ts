import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// The Routines in the details panel, rendered in a DOM: a group's own, each with its bot's mascot and
// name; a bot's, under where each reports; and every one counting down to its next run.
// Each test file runs in its own process (scripts/test.ts), so the globals stay here.
const win = new Window({ url: "http://localhost/" });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(win)) if (!(key in g)) g[key] = (win as any)[key];
Object.assign(g, { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, sessionStorage: win.sessionStorage, location: win.location, history: win.history, getComputedStyle: win.getComputedStyle.bind(win) });
g.window.matchMedia = (q: string) => ({ matches: q.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} });
g.matchMedia = g.window.matchMedia;
g.IS_REACT_ACT_ENVIRONMENT = true;

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
let clock = new Date(2026, 10, 13, 12, 0).getTime();
const start = clock;
Date.now = () => clock;
const MIN = 60_000;

const routine = (id: string, title: string, schedule: string, more: Record<string, unknown> = {}) => ({ id, title, schedule, task: `Do ${title}`, enabled: true, createdAt: start, nextRunAt: start + 5 * MIN, ...more });
const bot = (id: string, name: string, color: string, routines: any[]) => ({ id, name, look: { shape: "blob", color }, instructions: "", memory: [], routines, createdAt: 1 });
const direct = (id: string, botId: string) => ({ id, kind: "direct", botIds: [botId], createdAt: 1, updatedAt: 1, messages: [] });

const scout = bot("scout", "Scout", "orange", [
  routine("r1", "Morning summary", "Weekdays at 8:00", { conversationId: "chat-scout", nextRunAt: start + 2 * 24 * 60 * MIN + 3 * 60 * MIN }),
  routine("r2", "Check the deploy", "in 5 minutes", { conversationId: "launch", followUp: true, nextRunAt: start + 4 * MIN + 5_000 }),
  routine("r3", "Rotate logs", "Daily at 23:00", { conversationId: "ops", nextRunAt: start + 11 * 60 * MIN }),
  // Unset, it reports to the bot's own chat.
  routine("r4", "Inbox zero", "Daily at 17:00", { nextRunAt: start + 5 * 60 * MIN + 2 * MIN + 7_000 }),
]);
const tracer = bot("tracer", "Tracer", "teal", [routine("r5", "Watch CI", "every 2 hours", { conversationId: "launch", createdAt: start + 1, nextRunAt: start + 2 * 60 * MIN })]);
const manager = bot("manager", "Manager", "purple", [routine("r6", "Standup", "Weekdays at 9:30", { conversationId: "launch", createdAt: start + 2, enabled: false })]);

async function show(activeId: string) {
  snapshot = {
    bots: [scout, tracer, manager],
    conversations: [
      direct("chat-scout", "scout"), direct("chat-tracer", "tracer"), direct("chat-manager", "manager"),
      { id: "launch", kind: "group", name: "Launch crew", botIds: ["scout", "tracer", "manager"], createdAt: 1, updatedAt: 1, messages: [] },
      { id: "ops", kind: "group", name: "Ops room", botIds: ["scout", "manager"], createdAt: 1, updatedAt: 1, messages: [] },
    ],
    settings: { sections: [] }, typing: {}, drafts: [], status: {},
  };
  await act(async () => void (await switchWorkspace("srv")));
  await frames();
  useBots.setState({ activeId, detailsOpen: true });
  await act(async () => root.render(h(BotsView)));
  await frames();
}
const tabs = () => [...document.querySelectorAll(".bots-details [role='tab']")].map((t) => t.textContent);
async function openTab(name: string) {
  const tab = [...document.querySelectorAll<HTMLElement>(".bots-details [role='tab']")].find((t) => t.textContent === name)!;
  await act(async () => tab.click());
  await frames();
}
const rows = (within?: HTMLElement) => [...(within ?? document.querySelector(".bots-details")!).querySelectorAll<HTMLElement>(".bots-routine")];
const text = (row: HTMLElement, part: string) => row.querySelector(`.bots-routine-${part}`)?.textContent;

beforeEach(() => {
  useStore.setState({ devices: [{ id: "srv", serverId: "srv", name: "Studio", local: true, mode: "lan", urls: [], online: true }], devicesLoaded: true, chats: [] } as any);
  useWorkspace.setState({ localId: "srv", localName: "Studio", problem: undefined, switching: undefined });
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => {
  clock = start;
  act(() => root.unmount());
  document.body.innerHTML = "";
  enterWorkspace("away");
});

test("a group's details have Routines: those reporting there, each with its bot's mascot and name", async () => {
  await show("launch");
  expect(tabs()).toEqual(["Members 3", "Goal", "Routines", "Threads"]);
  await openTab("Routines");
  const list = rows();
  // Only the ones reporting to this group, oldest first, whoever's they are.
  expect(list.map((r) => text(r, "title"))).toEqual(["Check the deploy", "Watch CI", "Standup"]);
  expect(list.map((r) => r.dataset.bot)).toEqual(["scout", "tracer", "manager"]);
  expect(list.map((r) => text(r, "when"))).toEqual(["Scout · in 5 minutes", "Tracer · every 2 hours", "Manager · Weekdays at 9:30"]);
  // Each one's mascot, in its bot's colour.
  for (const r of list) expect(r.querySelector(".bots-routine-owner .bot")).not.toBeNull();
  expect(list.map((r) => r.querySelector(".bots-routine-owner [aria-label]")?.getAttribute("aria-label"))).toEqual(["Scout", "Tracer", "Manager"]);
  // Paused, it says so in place of a countdown.
  expect(text(list[2]!, "next")).toBe("Paused");

  // Pausing one from here pauses that bot's routine.
  const calls: { path: string; body: any }[] = [];
  const fetched = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push({ path: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return fetched(input);
  }) as unknown as typeof fetch;
  try {
    await act(async () => list[1]!.querySelector<HTMLElement>("[role='switch']")!.click());
    await frames();
  } finally {
    globalThis.fetch = fetched;
  }
  expect(calls.find((c) => c.path.includes("/routines/"))).toMatchObject({ path: expect.stringContaining("/api/bots/tracer/routines/r5"), body: { enabled: false } });
});

test("a group with no routines says how to get one", async () => {
  await show("ops");
  await openTab("Routines");
  // Ops room's routine is Scout's, reporting there: it shows. Taken away, the hint does.
  expect(rows().map((r) => text(r, "title"))).toEqual(["Rotate logs"]);
  await act(async () => useBots.setState((s) => ({ bots: s.bots.map((b) => ({ ...b, routines: b.routines.filter((r) => r.conversationId !== "ops") })) })));
  await frames();
  expect(rows()).toHaveLength(0);
  expect(document.querySelector(".bots-details .bots-pane .bots-hint")!.textContent).toContain("No routines here yet");
});

test("every routine counts down to its next run, ticking each second", async () => {
  await show("launch");
  await openTab("Routines");
  const deploy = () => rows()[0]!;
  expect(text(deploy(), "next")).toBe("Runs in 4m 05s");
  expect(text(rows()[1]!, "next")).toBe("Runs in 2h 00m 00s");
  clock += 2_000;
  await frames(1_100);
  expect(text(deploy(), "next")).toBe("Runs in 4m 03s");
  // Once it's due, until the server has run it and said when it's next.
  clock = start + 10 * MIN;
  await frames(1_100);
  expect(text(deploy(), "next")).toBe("Due now");
});

test("a bot's routines are grouped by where they report: its chat with you first, then each group with its mascots", async () => {
  await show("chat-scout");
  await openTab("Routines");
  const sections = [...document.querySelectorAll<HTMLElement>(".bots-details .bots-routine-group")];
  expect(sections.map((s) => s.querySelector(".bots-routine-group-name")!.textContent)).toEqual(["Chat with you", "Launch crew", "Ops room"]);
  expect(sections.map((s) => rows(s).map((r) => text(r, "title")))).toEqual([["Morning summary", "Inbox zero"], ["Check the deploy"], ["Rotate logs"]]);
  expect(sections.map((s) => s.querySelector(".bots-routine-group-count")!.textContent)).toEqual(["2", "1", "1"]);
  // Each group's members, each its own mascot.
  expect(sections.map((s) => s.querySelectorAll(".bots-routine-group-head .bot").length)).toEqual([1, 3, 2]);
  // A bot's own routines don't repeat its name; they count down too.
  expect(rows().map((r) => text(r, "when"))).toEqual(["Weekdays at 8:00", "Daily at 17:00", "in 5 minutes", "Daily at 23:00"]);
  expect(rows().map((r) => text(r, "next"))).toEqual(["Runs in 2d 3h 0m", "Runs in 5h 02m 07s", "Runs in 4m 05s", "Runs in 11h 00m 00s"]);
});

test("a bot whose routines all report to its own chat keeps one list", async () => {
  await show("chat-tracer");
  await openTab("Routines");
  // Tracer's one routine reports to the group; moved to its chat, there are no sections.
  expect(document.querySelectorAll(".bots-details .bots-routine-group")).toHaveLength(1);
  await act(async () => useBots.setState((s) => ({ bots: s.bots.map((b) => (b.id === "tracer" ? { ...b, routines: b.routines.map((r) => ({ ...r, conversationId: undefined })) } : b)) })));
  await frames();
  expect(document.querySelectorAll(".bots-details .bots-routine-group")).toHaveLength(0);
  expect(rows().map((r) => text(r, "title"))).toEqual(["Watch CI"]);
});
