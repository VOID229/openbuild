// An OpenBots chat whose messages and activity lines name pull requests, for tests/botPullRefsChrome.test.ts.
// Its bots started threads in one repository, so a "#n" there links to that pull request; `?theme=`
// picks light or dark.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { BotChat } from "../../../src/components/bots/BotChat";
import { enterWorkspace, preloadBots, useBots } from "../../../src/lib/bots/store";
import { useWorkspace } from "../../../src/lib/bots/workspace";
import { useStore } from "../../../src/lib/store";
import type { Bot, BotMessage, Conversation } from "../../../src/lib/bots/types";
import type { Chat } from "../../../src/lib/types";

const bot = (id: string, name: string, color: string): Bot => ({ id, name, look: { shape: "ghost", color }, instructions: "", memory: [], routines: [], createdAt: 1 });
const bots = [bot("manager", "manager", "orange"), bot("tracer", "tracer", "blue")];
const start = Date.now() - 60_000;
const said = (author: string, text: string): Omit<BotMessage, "id" | "at"> => ({ author, text });
const follow: Omit<BotMessage, "id" | "at"> = { author: "manager", text: "", event: { kind: "routine", text: "Set a follow-up", detail: "Merge #213 and #210 when ready · in 6 minutes" } };
const messages: BotMessage[] = [
  said("manager", "@tracer #210 (header pill, thread f707f90a) was rebased onto main and is up with CI running. Can you re-review the new head?"),
  said("tracer", "#213 is docs-only: it removes the friends block from README.md. Model GPT 6.1 Sol #2 checked it."),
  follow,
  said("manager", "Not linked: `git log #213`, the colour: #333, https://example.com/page#12 and a heading's ##12.\n```\nfixes #210\n```"),
].map((m, i) => ({ ...m, id: `m${i}`, at: start + i * 1000 }));
const conversation: Conversation = { id: "crew", kind: "group", name: "Crew", botIds: ["manager", "tracer"], createdAt: start, updatedAt: start, messages };

const thread = (id: string, number: number): Chat => ({
  id, title: `Thread ${number}`, createdAt: start, updatedAt: start, messages: [],
  pullRequest: { number, url: `https://github.com/VOID229/openbuild/pull/${number}`, state: "open", checkedAt: start },
  startedBy: { bot: "manager", conversation: "crew" },
});
useStore.setState({ chats: [thread("f707f90a-0000-4000-8000-000000000000", 210)] });

const headers = { "x-openbuild-server": "srv" };
const real = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const path = new URL(String(input), location.href).pathname;
  if (path === "/api/config") return Response.json({ mode: "local", serverId: "srv", machine: "Studio" });
  const m = /^\/api\/workspace\/to\/srv(\/.*)$/.exec(path);
  if (!m) return path.startsWith("/api/") ? Response.json({}) : real(input, init);
  if (m[1] === "/api/bots") return Response.json({ bots, conversations: [conversation], settings: { sections: [] }, typing: {}, drafts: [], status: {} }, { headers });
  if (m[1] === "/api/bots/stream") return new Response(new ReadableStream(), { headers });
  return Response.json({ ok: true }, { headers });
}) as typeof fetch;

function Chat() {
  const c = useBots((s) => s.conversations.find((x) => x.id === "crew"));
  return c ? <BotChat conversation={c} /> : null;
}

useWorkspace.setState({ localId: "srv", localName: "Studio" });
enterWorkspace("srv");
await preloadBots();
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
createRoot(document.getElementById("root")!).render(
  <div className="bots-view" style={{ height: "100%" }}>
    <div className="bots-view-content">
      <Chat />
    </div>
  </div>,
);
