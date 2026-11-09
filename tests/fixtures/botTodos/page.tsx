// The real OpenBots pane for tests/botTodos.test.ts to drive in Chrome: a group with a to-do list
// (its details open on the Goal tab) and a bot's own chat holding a page the bot showed.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { BotsView } from "../../../src/components/bots/BotsView";
import { useBots } from "../../../src/lib/bots/store";
import { useStore } from "../../../src/lib/store";
import type { Bot, BotMessage, Conversation, TodoItem } from "../../../src/lib/bots/types";

const bot = (id: string, name: string, shape: string, color: string): Bot => ({ id, name, look: { shape, color }, instructions: "", memory: [], routines: [], createdAt: 1 });
const bots = [bot("moss", "Moss", "orb", "green"), bot("pill", "Pill", "pill", "blue"), bot("egg", "Dr Eggbot", "puff", "white")];
const at = Date.now() - 60_000;
const said = (id: string, author: string, text: string, i: number, extra: Partial<BotMessage> = {}): BotMessage => ({ id, author, at: at + i * 1000, text, ...extra });
const todo = (id: string, text: string, status: TodoItem["status"], botId?: string): TodoItem => ({ id, text, status, by: "moss", at, ...(botId ? { bot: botId } : {}) });
// A page that says how it was framed, so the test can read it back through postMessage.
const PAGE = `<!doctype html><html><head><style>.box{height:180px;border-radius:var(--radius);background:var(--muted)}</style></head><body>
<div class="box" id="box">Signups</div>
<script>
let storage = "blocked"; try { localStorage.setItem("x", "1"); storage = "open"; } catch (e) {}
let parentDom = "blocked"; try { void parent.document.body; parentDom = "open"; } catch (e) {}
parent.postMessage({ type: "probe", origin: location.origin, storage, parentDom, background: getComputedStyle(document.documentElement).getPropertyValue("--background").trim() }, "*");
</script></body></html>`;
const params = new URLSearchParams(location.search);
if (params.get("theme")) document.documentElement.dataset.theme = params.get("theme")!;
const conversations: Conversation[] = [
  {
    id: "crew", kind: "group", name: "Launch crew", botIds: ["moss", "pill"], instructions: "Ship the landing page by Friday.", createdAt: at, updatedAt: at,
    messages: [said("c-1", "me", "Where are we on the launch?", 0), said("c-2", "moss", "Copy is done, I'm on the hero image.", 1)],
    todos: [
      todo("t-copy", "Write the landing page copy", "done", "moss"),
      todo("t-hero", "Draw the hero image", "doing", "moss"),
      todo("t-pricing", "Check the pricing table", "doing", "pill"),
      todo("t-deploy", "Deploy to staging", "todo"),
      todo("t-announce", "Draft the announcement", "todo"),
    ],
  },
  {
    id: "dm", kind: "direct", botIds: ["egg"], createdAt: at, updatedAt: at,
    messages: [
      said("d-1", "me", "Show me last week's signups", 0),
      said("d-2", "egg", "", 1, { html: { title: "Weekly signups", html: PAGE, height: 180 } }),
    ],
  },
];
useStore.setState({ botsOpen: true, botsSidebarOpen: false });
useBots.setState({ bots, conversations, activeId: params.get("chat") ?? "crew", detailsOpen: params.get("details") !== "closed", loaded: true, connected: true, ensureSeeded: () => {} });
Object.assign(window, { bots: useBots, store: useStore, probes: [] as unknown[] });
window.addEventListener("message", (e) => {
  if (e.data?.type === "probe") (window as unknown as { probes: unknown[] }).probes.push(e.data);
});
createRoot(document.getElementById("root")!).render(
  <div className="bots-view" style={{ flex: 1, minWidth: 0, height: "100%" }}>
    <BotsView />
  </div>,
);
