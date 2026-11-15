// The real OpenBots sidebar and chat, for tests/botAway.test.ts to measure in Chrome: Scout's own chat
// open while Scout is at work in another one, which the test picks through `window.bots`.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { BotsSidebar } from "../../../src/components/bots/BotsSidebar";
import { BotsView } from "../../../src/components/bots/BotsView";
import { useBots } from "../../../src/lib/bots/store";
import { usePlugins } from "../../../src/lib/plugins";
import { useStore } from "../../../src/lib/store";
import type { Bot, Conversation } from "../../../src/lib/bots/types";

const bot = (id: string, name: string, shape: string, color: string): Bot => ({ id, name, look: { shape, color }, instructions: "", memory: [], routines: [], createdAt: 1 });
const at = Date.now() - 60_000;
const chat = (id: string, kind: Conversation["kind"], botIds: string[], name?: string): Conversation => ({
  id, kind, botIds, name, createdAt: at, updatedAt: at, messages: [{ id: `${id}-m`, author: "me", at, text: "Can you check why CI is red?" }],
});
useStore.setState({ botsOpen: true, botsSidebarOpen: true });
useBots.setState({
  bots: [bot("scout", "Scout", "blob", "blue"), bot("pip", "Pip", "cloud", "orange")],
  conversations: [
    chat("dm", "direct", ["scout"]),
    chat("pipdm", "direct", ["pip"]),
    chat("dev", "group", ["scout", "pip"], "OpenBuild Dev"),
    chat("long", "group", ["scout", "pip"], "Quarterly planning for the onboarding and billing migration"),
  ],
  status: {},
  activeId: "dm",
  loaded: true,
  connected: true,
  ensureSeeded: () => {},
});
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
