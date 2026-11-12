// The real OpenBots sidebar and pane side by side, for tests/botMascots.test.ts to watch in Chrome:
// pinned groups of two, three, four and six bots, one of them with a member at work, and that
// group's chat open with its details beside it.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { BotsSidebar } from "../../../src/components/bots/BotsSidebar";
import { BotsView } from "../../../src/components/bots/BotsView";
import { useBots } from "../../../src/lib/bots/store";
import { usePlugins } from "../../../src/lib/plugins";
import { useStore } from "../../../src/lib/store";
import type { Bot, BotMessage, Conversation } from "../../../src/lib/bots/types";

const bot = (id: string, name: string, shape: string, color: string): Bot => ({ id, name, look: { shape, color }, instructions: "", memory: [], routines: [], createdAt: 1 });
const bots = [
  bot("egg", "Dr Eggbot", "cloud", "white"),
  bot("moss", "Moss", "blob", "green"),
  bot("boo", "Boo", "house", "amber"),
  bot("pill", "Pill", "tablet", "blue"),
  bot("tile", "Tile", "square", "purple"),
  bot("spark", "Spark", "sparkle", "teal"),
];
const at = Date.now() - 60_000;
const said = (id: string, author: string, text: string, i: number): BotMessage => ({ id, author, at: at + i * 1000, text });
const chat = (id: string, name: string | undefined, kind: "direct" | "group", botIds: string[], pinnedAt?: number, messages?: BotMessage[]): Conversation => ({
  id, kind, botIds, name, createdAt: at, updatedAt: at, pinnedAt, messages: messages ?? [said(`${id}-m`, "me", "hello", 0)],
});
const params = new URLSearchParams(location.search);
if (params.get("theme")) document.documentElement.dataset.theme = params.get("theme")!;
useStore.setState({ botsOpen: true, botsSidebarOpen: true });
useBots.setState({
  bots,
  conversations: [
    chat("dm", undefined, "direct", ["egg"], 1),
    chat("dev", "OpenBuild Dev", "group", ["egg", "moss", "boo", "pill"], 2, [
      said("dev-1", "me", "Can someone look at the flaky test?", 0),
      said("dev-2", "moss", "On it.", 1),
      said("dev-3", "pill", "I'll review once it's up.", 2),
    ]),
    chat("pair", "Pair", "group", ["moss", "pill"], 3),
    chat("trio", "Trio", "group", ["boo", "tile", "spark"], 4),
    chat("crowd", "Everyone", "group", ["egg", "moss", "boo", "pill", "tile", "spark"], 5),
    chat("row", "Row group", "group", ["tile", "spark"]),
  ],
  // Moss is at work in OpenBuild Dev: wherever a group shows it, it's awake, and the rest sleep.
  status: { moss: { state: "working", conversationId: "dev", activity: "Reading the test" } },
  activeId: "dev",
  detailsOpen: true,
  loaded: true,
  connected: true,
  ensureSeeded: () => {},
});
// Provider marks (beside a thread in the details) wait for the plugins' icons; there are none here.
await usePlugins.getState().refresh();
Object.assign(window, { bots: useBots, store: useStore });
createRoot(document.getElementById("root")!).render(
  <>
    <BotsSidebar />
    <div className="bots-view" style={{ flex: 1, minWidth: 0, height: "100%" }}>
      <BotsView />
    </div>
  </>,
);
