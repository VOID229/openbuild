// A real OpenBots chat on a page of its own, for tests/botComposerScroll.test.ts to drive in Chrome.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { BotChat } from "../../../src/components/bots/BotChat";
import { useBots } from "../../../src/lib/bots/store";
import type { Bot, Conversation } from "../../../src/lib/bots/types";

const kind = new URLSearchParams(location.search).get("kind") === "group" ? "group" : "direct";
const bot = (id: string, name: string, color: string): Bot => ({ id, name, look: { shape: "ghost", color }, instructions: "", memory: [], routines: [], createdAt: 1 });
const bots = [bot("manager", "manager", "orange"), bot("helper", "helper", "blue")];
const start = Date.now() - 60_000;
const long = "That adds some latency, though we haven't measured how much on your setup. ".repeat(3);
const conversation: Conversation = {
  id: "chat",
  kind,
  name: kind === "group" ? "Crew" : undefined,
  botIds: kind === "group" ? ["manager", "helper"] : ["manager"],
  createdAt: start,
  updatedAt: start,
  messages: Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, author: i % 2 ? "manager" : "me", at: start + i * 1000, text: `${i}. ${long}` })),
};
useBots.setState({ bots, conversations: [conversation], loaded: true, connected: true, ensureSeeded: () => {} });
document.documentElement.dataset.theme = "dark";
const root = document.getElementById("root")!;
createRoot(root).render(
  <div className="bots-view" style={{ height: "100%" }}>
    <div className="bots-view-content">
      <BotChat conversation={conversation} />
    </div>
  </div>,
);
