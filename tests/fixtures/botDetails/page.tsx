// The real OpenBots pane with a chat's details open, for tests/botDetailsOverflow.test.ts to measure in
// Chrome: a primary bot (Dr Eggbot, the white puff) with words too long to wrap in its role,
// instructions, routines (one reporting to the group), tasks and model, and a group of two with a long
// name, goal and routine. The server is faked: the models bots run on, and nothing else.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { BotsView } from "../../../src/components/bots/BotsView";
import { useBots } from "../../../src/lib/bots/store";
import type { Bot, Conversation, TodoItem } from "../../../src/lib/bots/types";
import { openBotsDetails } from "../../../src/lib/gestures";
import { useStore } from "../../../src/lib/store";

const at = Date.now() - 60_000;
const long = "a-very-long-unbroken-word-that-would-push-the-panel-out-sideways-if-anything-let-it";
const reasoning = { efforts: ["low", "medium", "high", "xhigh"], mode: "effort", toggle: false };
const model = (id: string, name: string, provider: string) => ({ id, name, provider, protocol: "openai", reasoning, input: ["text"] });
const models = [
  model("anthropic/claude-opus-5-5", "Claude Opus 5.5", "anthropic"),
  model("opencode-go/glm-5.3-long-context-preview", "GLM 5.3 Long Context Preview, with a name longer than the panel", "opencode-go"),
];
window.fetch = (async (input: string) => {
  if (String(input).replace(location.origin, "").startsWith("/api/bots/models")) return Response.json({ models, defaultModel: models[0]!.id, checkedAt: 1 });
  return Response.json({});
}) as typeof fetch;

const bot = (id: string, name: string, shape: string, color: string, extra: Partial<Bot> = {}): Bot => ({ id, name, look: { shape, color }, instructions: "", memory: [], routines: [], createdAt: 1, ...extra });
const bots = [
  bot("egg", "Dr Eggbot", "puff", "white", {
    primary: true,
    role: `Keeps the ${long} tidy`,
    instructions: `Watch the build and say when it breaks. ${long}`,
    model: models[1]!.id,
    fallbackModels: [models[0]!.id],
    routines: [
      { id: "r1", title: `Morning check on ${long}`, schedule: "every weekday at 9am", enabled: true, task: `Read ${long} and report`, nextRunAt: at + 3 * 86_400_000 },
      // Reporting to the group: under it in the bot's Routines, and in the group's own with its mascot.
      { id: "r3", title: `Evening check on ${long}`, schedule: `every weekday at 6pm, ${long}`, enabled: true, conversationId: "crew", nextRunAt: at + 3_600_000 },
      { id: "r2", title: "Weekly review", schedule: "every Friday", enabled: false },
    ],
  }),
  bot("moss", "Moss", "orb", "green"),
];
const todo = (id: string, text: string, status: TodoItem["status"], botId?: string): TodoItem => ({ id, text, status, by: "egg", at, ...(botId ? { bot: botId } : {}) });
const conversations: Conversation[] = [
  { id: "dm", kind: "direct", botIds: ["egg"], createdAt: at, updatedAt: at, messages: [], todos: [todo("t1", `Fix ${long}`, "doing", "egg"), todo("t2", "Ship it", "todo")] },
  { id: "crew", kind: "group", name: `Crew ${long}`, botIds: ["egg", "moss"], instructions: long, createdAt: at, updatedAt: at, messages: [], todos: [todo("t3", long, "todo")] },
];
useStore.setState({ botsOpen: true, botsSidebarOpen: false });
useBots.setState({ bots, conversations, activeId: new URLSearchParams(location.search).get("chat") ?? "dm", loaded: true, connected: true, ensureSeeded: () => {} });
Object.assign(window, { bots: useBots, openBotsDetails });
createRoot(document.getElementById("root")!).render(
  <div className="bots-view" style={{ flex: 1, minWidth: 0, height: "100vh" }}>
    <BotsView />
  </div>,
);
