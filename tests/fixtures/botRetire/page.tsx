// The real OpenBots sidebar and chat over a fake workspace on the page, for tests/botRetireUi.test.ts:
// a primary, two bots at work and one already retired, each with a chat, and a group they share.
// `window.workspace.calls` lists what the app asked the workspace to do. `?theme=light` for a light page.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { BotsSidebar } from "../../../src/components/bots/BotsSidebar";
import { BotsView } from "../../../src/components/bots/BotsView";
import { enterWorkspace, preloadBots, useBots } from "../../../src/lib/bots/store";
import { useWorkspace } from "../../../src/lib/bots/workspace";
import { useStore } from "../../../src/lib/store";
import type { Bot, BotMessage, Conversation } from "../../../src/lib/bots/types";

const at = Date.now() - 3_600_000;
const bot = (id: string, name: string, shape: string, color: string, extra: Partial<Bot> = {}): Bot => ({ id, name, look: { shape, color }, instructions: `You are ${name}.`, role: "", memory: [], routines: [], createdAt: 1, ...extra });
const bots: Bot[] = [
  bot("egg", "Dr Eggbot", "cloud", "white", { primary: true, role: "Runs the team." }),
  bot("obsidian", "obsidian", "tablet", "purple", {
    role: "Keeps the notes in order.",
    routines: [{ id: "r1", title: "Tidy the vault", schedule: "Every day at 9:00", enabled: true, nextRunAt: Date.now() + 3_600_000 }],
  }),
  bot("tracer", "Tracer", "sparkle", "teal", { role: "Checks the work." }),
  // Retired already: out of the group it was in, its routine paused.
  bot("scout", "Scout", "blob", "green", { role: "Looks things up.", retiredAt: at, retiredFrom: ["team"], routines: [{ id: "r2", title: "Morning news", schedule: "Weekdays at 8:00", enabled: false }] }),
];
const say = (id: string, author: string, text: string, n: number, extra: Partial<BotMessage> = {}): BotMessage => ({ id, author, at: at + n * 60_000, text, ...extra });
const conversations: Conversation[] = [
  { id: "egg-chat", kind: "direct", botIds: ["egg"], pinnedAt: 1, createdAt: at, updatedAt: at + 1, messages: [say("e1", "egg", "Morning. What are we doing today?", 1)] },
  {
    id: "obsidian-chat", kind: "direct", botIds: ["obsidian"], createdAt: at, updatedAt: at + 4,
    messages: [
      say("o1", "me", "Can you file yesterday's meeting notes?", 1),
      say("o2", "obsidian", "Filed under Meetings, with the action items pulled out at the top.", 2),
      say("o3", "obsidian", "", 3, { question: { title: "Archive last month's daily notes too?", options: [{ key: "A", label: "Yes" }, { key: "B", label: "Not yet" }] } }),
    ],
  },
  { id: "tracer-chat", kind: "direct", botIds: ["tracer"], createdAt: at, updatedAt: at + 3, messages: [say("t1", "tracer", "The login fix looks right. One test is missing.", 1)] },
  {
    id: "scout-chat", kind: "direct", botIds: ["scout"], createdAt: at, updatedAt: at + 2,
    messages: [say("s1", "scout", "Three sources agree on the release date.", 1), say("s2", "me", "", 2, { event: { kind: "left", text: "Scout was retired" } })],
  },
  { id: "team", kind: "group", name: "Team", botIds: ["egg", "obsidian", "tracer"], createdAt: at, updatedAt: at + 5, messages: [say("g1", "me", "Morning, team.", 1), say("g2", "tracer", "Morning.", 2)] },
];

const workspace = {
  /** What the app asked for beyond reading: "POST /api/bots/obsidian/retire". */
  calls: [] as string[],
};
Object.assign(window, { workspace, bots: useBots, store: useStore });

const headers = { "x-openbuild-server": "srv" };
const real = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const path = new URL(String(input), location.href).pathname;
  const method = init.method ?? "GET";
  if (path === "/api/config") return Response.json({ mode: "local", serverId: "srv", machine: "Studio" });
  const m = /^\/api\/workspace\/to\/srv(\/.*)$/.exec(path);
  if (!m) return path.startsWith("/api/") ? Response.json({}) : real(input, init);
  const rest = m[1]!;
  if (rest === "/api/bots" && method === "GET") return Response.json({ bots, conversations, settings: { sections: [] }, typing: {}, drafts: [], status: {} }, { headers });
  if (rest === "/api/bots/stream") return new Response(new ReadableStream(), { headers });
  // What the app does to a bot or a chat: not read markers, nor the settings it syncs as it connects.
  if (method !== "GET" && !rest.endsWith("/read") && rest !== "/api/bots/settings") workspace.calls.push(`${method} ${rest}`);
  return Response.json({ ok: true }, { headers });
}) as typeof fetch;

useWorkspace.setState({ localId: "srv", localName: "Studio" });
useStore.setState({ botsOpen: true, botsSidebarOpen: true });
enterWorkspace("srv");
await preloadBots();
useBots.setState({ activeId: "obsidian-chat" });
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
createRoot(document.getElementById("root")!).render(
  <>
    <BotsSidebar />
    <main style={{ flex: 1, minWidth: 0, display: "flex" }}>
      <BotsView />
    </main>
  </>,
);
