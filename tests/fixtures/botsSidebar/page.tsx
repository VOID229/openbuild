// The real OpenBots sidebar, for tests/botsSidebarMascots.test.ts to point at in Chrome: bots' own
// chats and groups, pinned (tiles) and not (rows), one group with a member at work and one bot at
// work in its own chat. `?only=<chat id>` shows just that chat, and `?seed=<n>` makes Math.random
// repeat, so with one bot on the page two loads live the same life.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { BotsSidebar } from "../../../src/components/bots/BotsSidebar";
import { useBots } from "../../../src/lib/bots/store";
import { useStore } from "../../../src/lib/store";
import { config } from "../../../src/lib/runtime";
import type { Bot, Conversation } from "../../../src/lib/bots/types";

const bot = (id: string, name: string, shape: string, color: string): Bot => ({ id, name, look: { shape, color }, instructions: "", memory: [], routines: [], createdAt: 1 });
const bots = [bot("pip", "Pip", "cloud", "white"), bot("manager", "Manager", "square", "blue"), bot("tracer", "Tracer", "sparkle", "teal"), bot("scout", "Scout", "tablet", "green"), bot("worker", "Worker", "house", "purple")];
const at = Date.now() - 60_000;
const chat = (id: string, kind: "direct" | "group", botIds: string[], pinnedAt?: number): Conversation => ({
  id, kind, botIds, name: kind === "group" ? `Crew ${id}` : undefined, createdAt: at, updatedAt: at, pinnedAt, messages: [{ id: `${id}-m`, author: "me", at, text: "hello" }],
});
const params = new URLSearchParams(location.search);
const seed = params.get("seed");
if (seed) {
  // mulberry32
  let a = Number(seed) >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const conversations = [
  chat("pinned-bot", "direct", ["pip"], 1),
  chat("pinned-group", "group", ["manager", "tracer"], 2),
  chat("row-bot", "direct", ["manager"]),
  chat("row-group", "group", ["tracer", "scout"]),
  chat("busy-group", "group", ["pip", "scout"]),
  chat("row-worker", "direct", ["worker"]),
].filter((c) => !params.get("only") || c.id === params.get("only"));
useStore.setState({ botsOpen: true, botsSidebarOpen: true });
useBots.setState({
  bots,
  conversations,
  // Scout is at work: in the groups it's in, only it fidgets. Worker is at work in its own chat.
  status: { scout: { state: "working", conversationId: "busy-group" }, worker: { state: "working", conversationId: "row-worker" } },
  activeId: "row-bot",
  loaded: true,
  connected: true,
  ensureSeeded: () => {},
});
Object.assign(window, { bots: useBots, store: useStore });
// As the app does, render once /api/config has said which release this is (the footer shows it).
void config.then(() => createRoot(document.getElementById("root")!).render(<BotsSidebar />));
