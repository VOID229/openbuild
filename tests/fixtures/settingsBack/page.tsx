// The real Settings dialog with a few bots, a group and a Pi skill in it, for
// tests/settingsBack.test.ts to open the pages inside its sections in Chrome.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { SettingsModal } from "../../../src/components/Settings";
import { useBots } from "../../../src/lib/bots/store";
import type { Bot, Conversation } from "../../../src/lib/bots/types";
import { useStore } from "../../../src/lib/store";

const colors = ["orange", "blue", "green", "purple", "pink", "yellow"];
// Long instructions, so every page inside Bots is taller than the dialog and scrolls.
const bot = (i: number): Bot => ({ id: `b${i}`, name: `Bot ${i}`, look: { shape: "ghost", color: colors[i % colors.length]! }, instructions: "Keep the build green and say what changed. ".repeat(40), memory: [], routines: [], createdAt: i });
const bots = Array.from({ length: 6 }, (_, i) => bot(i));
const conversation = (id: string, botIds: string[], kind: "direct" | "group", name?: string): Conversation => ({ id, kind, name, botIds, createdAt: 1, updatedAt: 1, messages: [] });
useBots.setState({
  bots,
  conversations: [...bots.map((b) => conversation(`d-${b.id}`, [b.id], "direct")), conversation("crew", bots.map((b) => b.id), "group", "Crew")],
  loaded: true,
  connected: true,
  ensureSeeded: () => {},
});

Object.assign(window, { store: useStore, bots: useBots });
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<SettingsModal />);
