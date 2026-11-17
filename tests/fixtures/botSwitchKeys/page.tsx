// The real OpenBots sidebar for tests/botSwitchKeysUi.test.ts: three pinned chats (two tiles to a
// row, so the third starts a second row) over eight in the list, a composer-like field and an input
// beside it to type in, and with `?settings` Settings → Shortcuts, whose toggle leaves the pinned ones
// out of ⌥1–9. `?rail` starts closed to the rail; `?theme=dark` is dark.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { BotsSidebar } from "../../../src/components/bots/BotsSidebar";
import { ShortcutsSection } from "../../../src/components/ShortcutSettings";
import { useBots } from "../../../src/lib/bots/store";
import { useStore } from "../../../src/lib/store";
import { config } from "../../../src/lib/runtime";
import type { Bot, Conversation } from "../../../src/lib/bots/types";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
const looks = [["cloud", "white"], ["square", "blue"], ["sparkle", "teal"], ["tablet", "green"], ["house", "purple"]];
const names = ["Pip", "Manager", "Tracer", "Scout", "Worker", "Ada", "Bea", "Cy", "Dot", "Eli", "Fox"];
const bots: Bot[] = names.map((name, i) => ({ id: name.toLowerCase(), name, look: { shape: looks[i % 5]![0]!, color: looks[i % 5]![1]! }, instructions: "", memory: [], routines: [], createdAt: 1 }));
const at = Date.now() - 60 * 60_000;
const chat = (id: string, botIds: string[], updatedAt: number, pinnedAt?: number): Conversation => ({
  id, kind: botIds.length > 1 ? "group" : "direct", botIds, name: botIds.length > 1 ? "Crew" : undefined, createdAt: at, updatedAt, pinnedAt, messages: [{ id: `${id}-m`, author: "me", at: updatedAt, text: "hello" }],
});
const conversations = [
  chat("pin-pip", ["pip"], at, 1),
  chat("pin-crew", ["manager", "tracer"], at, 2),
  chat("pin-scout", ["scout"], at, 3),
  // The list is newest first: Worker, Ada, … Fox.
  ...names.slice(4).map((name, i) => chat(`row-${name.toLowerCase()}`, [name.toLowerCase()], at + (10 - i) * 60_000)),
];
useStore.setState({ botsOpen: true, botsSidebarOpen: !params.has("rail") });
useBots.setState({ bots, conversations, status: {}, activeId: "row-worker", loaded: true, connected: true, ensureSeeded: () => {} });
Object.assign(window, { bots: useBots, store: useStore });

function Page() {
  return (
    <>
      <BotsSidebar />
      <main style={{ flex: 1, padding: 24, display: "flex", flexDirection: "column", gap: 12, minWidth: 0, overflow: "auto" }}>
        <textarea id="composer" aria-label="Message" rows={3} />
        <input id="field" aria-label="Name" />
        {params.has("settings") && (
          <div className="settings-inner">
            <ShortcutsSection />
          </div>
        )}
      </main>
    </>
  );
}

void config.then(() => createRoot(document.getElementById("root")!).render(<Page />));
