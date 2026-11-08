// A fake OpenBuild server for the group Threads tab's page: imported before the app, so its config,
// thread list and OpenBots stream answer from here. `window.serverChats` is the thread list the app's
// poll reads; the test changes it to start and finish threads.
import { EXTERNAL_VIA } from "../../../shared/replies";
import type { Bot, BotMessage, Conversation } from "../../../src/lib/bots/types";
import type { Chat } from "../../../src/lib/types";

const ID = "fixture";
const start = Date.now() - 3_600_000;
const bot = (id: string, name: string, shape: Bot["look"]["shape"], color: string): Bot => ({ id, name, look: { shape, color } as Bot["look"], instructions: "", memory: [], routines: [], createdAt: 1 });
const bots = [bot("manager", "manager", "ghost", "orange"), bot("tracer", "tracer", "pill", "blue"), bot("outsider", "obsidian", "pill", "purple")];
const conversation = (id: string, kind: "direct" | "group", botIds: string[], messages: BotMessage[] = []): Conversation => ({
  id, kind, botIds, createdAt: start, updatedAt: start, messages, ...(kind === "group" ? { name: "OpenBuild Dev" } : {}),
});
const conversations = [
  conversation("dev", "group", ["manager", "tracer"], [
    { id: "m1", author: "me", at: start, text: "Can you two look into the flaky sidebar test?" },
    { id: "m2", author: "manager", at: start + 1000, text: "On it. I've started a thread for it." },
  ]),
  conversation("dm-manager", "direct", ["manager"]),
  conversation("dm-tracer", "direct", ["tracer"]),
  conversation("dm-outsider", "direct", ["outsider"]),
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
w.serverChats = [
  thread("t-flaky", "Fix the flaky sidebar test", "manager", "dev", "openbuild"),
  thread("t-trace", "Trace the slow startup", "tracer", "dev", "openbuild-site"),
  // Not this group's: started from a one-to-one chat, by a bot outside it, or finished.
  thread("t-direct", "Rename the config loader", "manager", "dm-manager", "openbuild"),
  thread("t-outside", "Tidy the vault", "outsider", "dm-outsider", "notes"),
  thread("t-done", "Bump dependencies", "tracer", "dev", "openbuild", true),
];

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

// Threads' streams would go over /api/stream's socket; this page has none, so they fall back to fetch.
w.WebSocket = undefined;
window.fetch = (async (input: RequestInfo | URL) => {
  const path = new URL(String(input instanceof Request ? input.url : input), location.href).pathname;
  if (path === "/api/config") return Response.json({ mode: "local", convexUrl: null, serverId: ID, machine: "imac" });
  if (path === `/api/workspace/to/${ID}/api/bots`) return Response.json({ bots, conversations, settings: SETTINGS, status: {}, typing: {}, drafts: [] }, { headers: { "x-openbuild-server": ID } });
  if (path === `/api/workspace/to/${ID}/api/bots/stream`) return stream();
  if (path === "/api/devices") return Response.json({ devices: [] });
  if (path === "/api/projects") return Response.json({ projects: [] });
  if (path === "/api/plugins") return Response.json({ plugins: [] });
  if (path === "/api/chats") return Response.json({ chats: w.serverChats });
  const one = /^\/api\/chats\/([^/]+)$/.exec(path);
  if (one) {
    const chat = (w.serverChats as Chat[]).find((c) => c.id === one[1]);
    return chat ? Response.json(chat) : Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json({});
}) as typeof fetch;
