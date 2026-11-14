// The stash shortcuts in a real Chrome, for tests/stashShortcut.test.ts: a thread's composer, or with
// ?side=bots an OpenBots chat, behind the same key handling App uses (takeShortcut). The server and
// the bots' workspace are faked. `window.lastKey` is the last keydown as the page left it.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { Composer } from "../../../src/components/Composer";
import { BotChat } from "../../../src/components/bots/BotChat";
import { enterWorkspace, preloadBots, useBots } from "../../../src/lib/bots/store";
import { useWorkspace } from "../../../src/lib/bots/workspace";
import type { Bot, Conversation } from "../../../src/lib/bots/types";
import { dispatchShortcut, takeShortcut } from "../../../src/lib/shortcutKeys";
import { botStash, threadStash } from "../../../src/lib/stash";
import { useStore } from "../../../src/lib/store";

(window as any).WebSocket = undefined;
const onBots = new URLSearchParams(location.search).get("side") === "bots";

const bot: Bot = { id: "helper", name: "helper", look: { shape: "ghost", color: "blue" }, instructions: "", memory: [], routines: [], createdAt: 1 };
const conversation: Conversation = { id: "chat", kind: "direct", botIds: ["helper"], createdAt: 1, updatedAt: 1, messages: [{ id: "m0", author: "helper", at: Date.now() - 60_000, text: "Hi." }] };
const headers = { "x-openbuild-server": "srv" };
window.fetch = (async (input: RequestInfo | URL) => {
  const path = new URL(String(input), location.href).pathname;
  if (path === "/api/config") return Response.json({ mode: "local", serverId: "srv", machine: "Studio" });
  if (path === "/api/workspace/to/srv/api/bots") return Response.json({ bots: [bot], conversations: [conversation], settings: { sections: [] }, typing: {}, drafts: [], status: {} }, { headers });
  if (path === "/api/workspace/to/srv/api/bots/stream") return new Response(new ReadableStream(), { headers });
  return Response.json({}, { headers });
}) as typeof fetch;

useStore.setState({
  botsOpen: onBots,
  chats: [{ id: "t", title: "Thread", runtime: "claude", createdAt: 0, updatedAt: 0, messages: [] }],
});
// What App does with a key: a shortcut is taken from the page and the browser, and the stash ones go to the composer.
window.addEventListener("keydown", (e) => void takeShortcut(e, useStore.getState().settings, dispatchShortcut), true);
// Added after, so it sees what the shortcut handling left of the key.
window.addEventListener("keydown", (e) => ((window as any).lastKey = { code: e.code, prevented: e.defaultPrevented }), true);
Object.assign(window, { threadStash, botStash, store: useStore });

/** Adds stashes oldest first, each a moment after the last. */
(window as any).stashAll = async (texts: string[]) => {
  const stash = onBots ? botStash : threadStash;
  await stash.ready;
  for (const text of texts) {
    stash.add(text, []);
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
};

function Chat() {
  const c = useBots((s) => s.conversations.find((x) => x.id === "chat"));
  return c ? <BotChat conversation={c} /> : null;
}

document.documentElement.dataset.theme = "dark";
if (onBots) {
  useWorkspace.setState({ localId: "srv", localName: "Studio" });
  enterWorkspace("srv");
  await preloadBots();
}
createRoot(document.getElementById("root")!).render(
  onBots ? (
    <div className="bots-view" style={{ height: "100%" }}>
      <div className="bots-view-content">
        <Chat />
      </div>
    </div>
  ) : (
    <div className="chat-view" style={{ width: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: 16 }}>
      <Composer variant="dock" chatId="t" streaming={false} />
    </div>
  ),
);
