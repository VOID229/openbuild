// The real OpenBots sidebar, for tests/botsSidebarMascots.test.ts to point at in Chrome: bots' own
// chats and groups, pinned (tiles) and not (rows), one group with a member at work.
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
const bots = [bot("pip", "Pip", "puff", "white"), bot("manager", "Manager", "tile", "blue"), bot("tracer", "Tracer", "spark", "teal"), bot("scout", "Scout", "bean", "green")];
const at = Date.now() - 60_000;
const chat = (id: string, kind: "direct" | "group", botIds: string[], pinnedAt?: number): Conversation => ({
  id, kind, botIds, name: kind === "group" ? `Crew ${id}` : undefined, createdAt: at, updatedAt: at, pinnedAt, messages: [{ id: `${id}-m`, author: "me", at, text: "hello" }],
});
useStore.setState({ botsOpen: true, botsSidebarOpen: true });
useBots.setState({
  bots,
  conversations: [
    chat("pinned-bot", "direct", ["pip"], 1),
    chat("pinned-group", "group", ["manager", "tracer"], 2),
    chat("row-bot", "direct", ["manager"]),
    chat("row-group", "group", ["tracer", "scout"]),
    chat("busy-group", "group", ["pip", "scout"]),
  ],
  // Scout is at work: in the groups it's in, only it fidgets.
  status: { scout: { state: "working", conversationId: "busy-group" } },
  activeId: "row-bot",
  loaded: true,
  connected: true,
  ensureSeeded: () => {},
});
Object.assign(window, { bots: useBots, store: useStore });
// As the app does, render once /api/config has said which release this is (the footer shows it).
void config.then(() => createRoot(document.getElementById("root")!).render(<BotsSidebar />));
