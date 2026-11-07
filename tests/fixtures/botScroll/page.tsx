// The real OpenBots pane with a few chats in it, for tests/botChatScroll.test.ts to switch between in Chrome.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { Activity, useState } from "react";
import { createRoot } from "react-dom/client";
import { BotsView } from "../../../src/components/bots/BotsView";
import { useBots } from "../../../src/lib/bots/store";
import type { Bot, BotMessage, Conversation } from "../../../src/lib/bots/types";

const bot = (id: string, name: string, color: string): Bot => ({ id, name, look: { shape: "ghost", color }, instructions: "", memory: [], routines: [], createdAt: 1 });
const bots = [bot("manager", "manager", "orange"), bot("helper", "helper", "blue")];
const start = Date.now() - 3_600_000;
const long = "That adds some latency, though we haven't measured how much on your setup. ";
/** Messages of different lengths, so no two chats line up the same. */
const messages = (chat: string, n: number, from = 0): BotMessage[] =>
  Array.from({ length: n }, (_, j) => {
    const i = from + j;
    return { id: `${chat}-${i}`, author: i % 2 ? "manager" : "me", at: start + i * 1000, text: `${chat} ${i}. ${long.repeat(1 + (((i * 7) % 4) + 4) % 4)}` };
  });
const chat = (id: string, kind: "direct" | "group", n: number): Conversation => ({
  id,
  kind,
  name: kind === "group" ? `Crew ${id}` : undefined,
  botIds: kind === "group" ? ["manager", "helper"] : ["manager"],
  createdAt: start,
  updatedAt: start,
  messages: messages(id, n),
});
useBots.setState({
  bots,
  conversations: [chat("a", "direct", 40), chat("b", "group", 60), chat("c", "direct", 25)],
  activeId: "a",
  loaded: true,
  connected: true,
  ensureSeeded: () => {},
  // The store fetches older messages from the workspace the tab is visiting, and there's none here:
  // the same page from the test's server instead, put in front as the store does.
  loadOlder: async (id) => {
    const page = (await (await fetch(`/older/${id}`)).json()) as { messages: BotMessage[]; more: boolean };
    useBots.setState((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, messages: [...page.messages.filter((m) => !c.messages.some((x) => x.id === m.id)), ...c.messages], more: page.more } : c)),
    }));
  },
});

let setShown: (shown: boolean) => void = () => {};
function Host() {
  const [shown, show] = useState(true);
  setShown = show;
  // As App does: OpenBots stays mounted, hidden, while a thread or another view is in front of it.
  return <Activity mode={shown ? "visible" : "hidden"}><BotsView /></Activity>;
}

Object.assign(window, {
  bots: useBots,
  messages,
  show: (shown: boolean) => setShown(shown),
});
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(
  <div className="bots-view" style={{ height: "100%", width: "100%" }}>
    <Host />
  </div>,
);
