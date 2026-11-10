// Pages (html_render) closing to a chip and opening again, for tests/htmlPreviews.test.ts to drive in
// Chrome: `?surface=thread` draws an OpenBuild thread (ChatView), `?surface=bots` an OpenBots chat.
// Each has a page six of the user's turns back and one in the latest reply.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { ChatView } from "../../../src/components/ChatView";
import { BotsView } from "../../../src/components/bots/BotsView";
import { useBots } from "../../../src/lib/bots/store";
import { useStore } from "../../../src/lib/store";
import type { Bot, BotMessage, Conversation } from "../../../src/lib/bots/types";
import type { Chat, Message } from "../../../src/lib/types";

const params = new URLSearchParams(location.search);
if (params.get("theme")) document.documentElement.dataset.theme = params.get("theme")!;

// A page that says each time it's loaded, so the test can tell a fresh frame from the old one.
const page = (name: string) => `<!doctype html><html><body><div style="height:180px">${name}</div>
<script>parent.postMessage({ type: "loaded", name: ${JSON.stringify(name)} }, "*");</script></body></html>`;
Object.assign(window, { loads: [] as string[] });
window.addEventListener("message", (e) => {
  if (e.data?.type === "loaded") (window as unknown as { loads: string[] }).loads.push(e.data.name);
});

const at = Date.now() - 600_000;
const filler = "Here's what changed, and what's left to do. ".repeat(6);

if (params.get("surface") === "bots") {
  const egg: Bot = { id: "egg", name: "Dr Eggbot", look: { shape: "puff", color: "white" }, instructions: "", memory: [], routines: [], createdAt: 1 };
  let i = 0;
  const said = (author: string, text: string, extra: Partial<BotMessage> = {}): BotMessage => ({ id: `d-${i}`, author, at: at + i++ * 1000, text, ...extra });
  const messages: BotMessage[] = [said("me", "Show me last week's signups"), said("egg", "", { html: { title: "Old signups", html: page("old"), height: 180 } })];
  for (let t = 0; t < 5; t++) messages.push(said("me", `Question ${t}`), said("egg", filler));
  messages.push(said("me", "And this week?"), said("egg", "", { html: { title: "New signups", html: page("new"), height: 180 } }));
  const conversations: Conversation[] = [{ id: "dm", kind: "direct", botIds: ["egg"], createdAt: at, updatedAt: at, messages }];
  useStore.setState({ botsOpen: true, botsSidebarOpen: false });
  useBots.setState({ bots: [egg], conversations, activeId: "dm", detailsOpen: false, loaded: true, connected: true, ensureSeeded: () => {} });
  Object.assign(window, { bots: useBots });
  createRoot(document.getElementById("root")!).render(
    <div className="bots-view" style={{ flex: 1, minWidth: 0, height: "100%" }}>
      <BotsView />
    </div>,
  );
} else {
  let i = 0;
  const user = (content: string): Message => ({ id: `m-${i++}`, role: "user", content, createdAt: at + i * 1000 });
  const reply = (content: string, page?: { id: string; title: string; html: string }): Message => ({
    id: `m-${i++}`,
    role: "assistant",
    content,
    createdAt: at + i * 1000,
    status: "done",
    parts: [...(page ? [{ type: "tool" as const, id: page.id, name: "html_render", status: "done" as const, args: { title: page.title, html: page.html, height: 180 } }] : []), { type: "text" as const, text: content }],
  });
  const messages: Message[] = [user("Chart last week's signups"), reply("There it is.", { id: "call-old", title: "Old signups", html: page("old") })];
  for (let t = 0; t < 5; t++) messages.push(user(`Question ${t}`), reply(filler));
  messages.push(user("And this week?"), reply("Here's this week.", { id: "call-new", title: "New signups", html: page("new") }));
  const chat: Chat = { id: "thread", title: "Signups", createdAt: at, updatedAt: at, messages } as Chat;
  useStore.setState({ chats: [chat], activeChatId: chat.id });
  Object.assign(window, { store: useStore });
  function Thread() {
    const c = useStore((s) => s.chats.find((x) => x.id === "thread"));
    return c ? <ChatView chat={c} /> : null;
  }
  createRoot(document.getElementById("root")!).render(
    <div className="main" style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column" }}>
      <Thread />
    </div>,
  );
}
