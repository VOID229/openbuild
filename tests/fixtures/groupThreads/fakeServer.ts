// A fake OpenBuild server for the group Threads tab's page: imported before the app, so its config,
// thread list and OpenBots stream answer from here. `window.serverChats` is the thread list the app's
// poll reads; the test changes it to start and finish threads.
import { DEFAULT_THREAD_ACCESS } from "../../../shared/bots";
import { EXTERNAL_VIA } from "../../../shared/replies";
import type { Bot, BotMessage, Conversation } from "../../../src/lib/bots/types";
import type { Chat } from "../../../src/lib/types";

const ID = "fixture";
const start = Date.now() - 3_600_000;
const bot = (id: string, name: string, shape: Bot["look"]["shape"], color: string): Bot => ({ id, name, look: { shape, color } as Bot["look"], instructions: "", memory: [], routines: [], createdAt: 1 });
// manager may spawn minions, tracer not: their Minions tabs say different things while empty. obsidian
// has two minions, one open and one closed, each with its chat.
const minion = (id: string, name: string, task: string, closedAt?: number): Bot => ({ ...bot(id, name, "pill", "green"), createdAt: closedAt ? 2 : 3, minion: { owner: "outsider", task, chat: `chat-${id}`, ...(closedAt ? { closedAt } : {}) } });
const bots = [
  { ...bot("manager", "manager", "ghost", "orange"), threads: DEFAULT_THREAD_ACCESS },
  { ...bot("tracer", "tracer", "pill", "blue"), spawnMinions: false },
  bot("outsider", "obsidian", "pill", "purple"),
  minion("mn-log", "Log reader", "Read the last day of server logs and list each error once.", start),
  minion("mn-notes", "Changelog writer", "Write the 2.4 changelog from the merged pull requests."),
];
const conversation = (id: string, kind: "direct" | "group", botIds: string[], messages: BotMessage[] = []): Conversation => ({
  id, kind, botIds, createdAt: start, updatedAt: start, messages, ...(kind === "group" ? { name: "OpenBuild Dev" } : {}),
});
/** The line a bot's chat shows when it starts a thread, linking to it. */
const started = (id: string, by: string, threadId: string, title: string, at: number): BotMessage => ({ id, author: by, at, text: "", event: { kind: "thread", text: "Started a thread", detail: title, threadId } });
const conversations = [
  conversation("dev", "group", ["manager", "tracer"], [
    { id: "m1", author: "me", at: start, text: "Can you two look into the flaky sidebar test?" },
    // Each line between messages, so none fold away into a run of background actions.
    started("e1", "manager", "t-flaky", "Fix the flaky sidebar test", start + 500),
    { id: "m2", author: "manager", at: start + 1000, text: "On it. I've started a thread for it." },
    started("e2", "tracer", "t-done", "Bump dependencies", start + 1500),
    { id: "m3", author: "tracer", at: start + 2000, text: "And the dependencies are bumped." },
  ]),
  conversation("dm-manager", "direct", ["manager"], [started("e3", "manager", "t-direct", "Rename the config loader", start + 4000)]),
  conversation("dm-tracer", "direct", ["tracer"]),
  conversation("dm-outsider", "direct", ["outsider"]),
  // Each minion's chat with its owner: a side chat of the two, with the task and its report.
  ...["mn-log", "mn-notes"].map((id) => ({
    ...conversation(`chat-${id}`, "direct", ["outsider", id], [
      { id: `${id}-0`, author: "outsider", at: start + 5000, text: bots.find((b) => b.id === id)!.minion!.task },
      { id: `${id}-1`, author: id, at: start + 6000, text: "Done: the list is in ~/notes." },
      ...(id === "mn-log" ? [{ id: `${id}-2`, author: "outsider", at: start + 7000, text: "", event: { kind: "changed" as const, text: "Closed Log reader" } }] : []),
    ]),
    kind: "side" as const,
    minion: id,
  })),
];

const SETTINGS = { quietHours: { from: 0, to: 0 }, sections: [], onboarding: "done" };

/** A thread a bot started from `conversation`, its reply still coming unless `done`. */
export const thread = (id: string, title: string, by: string, from: string, project: string, done = false): Chat => ({
  id, title, createdAt: start, updatedAt: Date.now(), startedBy: { bot: by, conversation: from },
  workspace: { projectId: project, projectName: project, cwd: `/tmp/${project}` } as Chat["workspace"],
  messages: [
    { id: `${id}-u`, role: "user", content: `${title}, please.`, createdAt: start, sentBy: by, sentByBot: by },
    { id: `${id}-a`, role: "assistant", content: done ? "All done." : "Looking into it…", status: done ? "done" : "streaming", createdAt: start, ...(done ? {} : { stream: { id: `${id}-s`, via: EXTERNAL_VIA } }) },
  ],
});

const w = window as any;
w.thread = thread;
// The store lists chats newest first, so each starts a second after the one before it: threads built in
// the same millisecond would otherwise come out in either order.
const now = Date.now();
w.serverChats = [
  thread("t-flaky", "Fix the flaky sidebar test", "manager", "dev", "openbuild"),
  thread("t-trace", "Trace the slow startup", "tracer", "dev", "openbuild-site"),
  // Not this group's: started from a one-to-one chat, by a bot outside it, or finished.
  { ...thread("t-direct", "Rename the config loader", "manager", "dm-manager", "openbuild"), pullRequest: { number: 42, url: "https://github.com/acme/openbuild/pull/42", state: "open", checks: "pending", checkedAt: start } },
  thread("t-outside", "Tidy the vault", "outsider", "dm-outsider", "notes"),
  thread("t-done", "Bump dependencies", "tracer", "dev", "openbuild", true),
].map((chat, i) => ({ ...chat, updatedAt: now - i * 1000 }));

/** The OpenBots stream: who it is, everything, then pings so it never seems to have gone quiet. */
function stream(): Response {
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval>;
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const send = (event: object) => ctrl.enqueue(enc.encode(JSON.stringify(event) + "\n"));
      send({ t: "hello", workspace: ID });
      send({ t: "snapshot", bots, conversations, settings: SETTINGS, status: {}, typing: {}, drafts: [] });
      timer = setInterval(() => send({ t: "ping" }), 2000);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson", "x-openbuild-server": ID } });
}

// Pull requests opened on GitHub, rather than in the app.
w.opened = [] as string[];
window.open = ((url?: string | URL) => (w.opened.push(String(url)), null)) as typeof window.open;

// Threads' streams would go over /api/stream's socket; this page has none, so they fall back to fetch.
w.WebSocket = undefined;
// What the page asked the server to change, for a test to read: the path as OpenBots' own (no workspace prefix).
w.sent = [] as { method: string; path: string; body: unknown }[];
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input instanceof Request ? input.url : input), location.href).pathname;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET") {
    let body: unknown;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    } catch {}
    w.sent.push({ method, path: path.replace(`/api/workspace/to/${ID}`, ""), body });
  }
  if (path === "/api/config") return Response.json({ mode: "local", convexUrl: null, serverId: ID, machine: "imac" });
  if (path === `/api/workspace/to/${ID}/api/bots`) return Response.json({ bots, conversations, settings: SETTINGS, status: {}, typing: {}, drafts: [] }, { headers: { "x-openbuild-server": ID } });
  if (path === `/api/workspace/to/${ID}/api/bots/stream`) return stream();
  if (path === "/api/devices") return Response.json({ devices: [] });
  // No models: Settings → Bots and a bot's page read the listing, which has none here.
  if (path.endsWith("/api/bots/models") || path === "/api/pi/models") return Response.json({ models: [], checkedAt: Date.now() });
  if (path === "/api/projects") return Response.json({ projects: [] });
  if (path === "/api/plugins") return Response.json({ plugins: [] });
  if (path === "/api/chats") return Response.json({ chats: w.serverChats });
  // Usage, with nothing used yet.
  if (path === "/api/usage/limits") return Response.json({ providers: [], checkedAt: Date.now() });
  if (path === "/api/usage") {
    const zero = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    const now = Date.now();
    return Response.json({ range: "30d", bucket: "day", start: now - 30 * 86_400_000, end: now, providers: [], series: [], totals: { ...zero, cost: 0, sessions: 0, requests: 0, cacheSavings: 0 }, costByType: { ...zero, other: 0 }, models: [], days: [], unpriced: [], problems: [], generatedAt: now });
  }
  // The side panel's pull requests tab: there's no GitHub here, which it says rather than showing one.
  if (path.startsWith("/api/workspaces/pulls")) return Response.json({ error: "No GitHub here" }, { status: 500 });
  const one = /^\/api\/chats\/([^/]+)$/.exec(path);
  if (one) {
    const chat = (w.serverChats as Chat[]).find((c) => c.id === one[1]);
    return chat ? Response.json(chat) : Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json({});
}) as typeof fetch;
