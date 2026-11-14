// Pages (html_render) as the room around them changes, for tests/htmlResize.test.ts to drive in Chrome:
// an OpenBots chat with its details panel, which can open a coding thread inside it, and the pages in
// both. `?page=` picks the page: "flow" wraps its text (taller as it narrows), "wide" is a fixed 700px.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { BotsView } from "../../../src/components/bots/BotsView";
import { useBots } from "../../../src/lib/bots/store";
import { useStore } from "../../../src/lib/store";
import type { Bot, BotMessage, Conversation } from "../../../src/lib/bots/types";
import type { Chat } from "../../../src/lib/types";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "dark";

const PAGES: Record<string, string> = {
  // Cards that reflow into fewer columns, and text that wraps onto more lines, as the frame narrows.
  flow: `<!doctype html><html><head><style>
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin-top: 10px; }
    .cell { height: 64px; border-radius: var(--radius); background: var(--card); padding: 8px; box-sizing: border-box; }
    .end { margin-top: 10px; height: 24px; border-radius: 6px; background: var(--chart-2); color: #000; padding: 0 8px; }
  </style></head><body>
    <p style="margin:0">${"Signups rose all week, most of them from the docs and the changelog. ".repeat(4)}</p>
    <div class="grid">${Array.from({ length: 8 }, (_, i) => `<div class="cell">Day ${i + 1}</div>`).join("")}</div>
    <div class="end" id="end">End of the page</div>
  </body></html>`,
  // Laid out for a desktop reply: a 580px chart that can't wrap, as wide as a page in a chat with nothing beside it.
  wide: `<!doctype html><html><head><style>
    .chart { width: 580px; height: 200px; display: flex; align-items: flex-end; gap: 6px; }
    .bar { flex: 1; border-radius: 4px 4px 0 0; background: var(--chart-1); }
    .end { width: 580px; margin-top: 10px; height: 24px; border-radius: 6px; background: var(--chart-2); color: #000; padding: 0 8px; box-sizing: border-box; display: flex; justify-content: space-between; }
  </style></head><body>
    <div class="chart">${Array.from({ length: 14 }, (_, i) => `<div class="bar" style="height:${40 + ((i * 37) % 150)}px"></div>`).join("")}</div>
    <div class="end" id="end"><span>Mon</span><span>Sun</span></div>
  </body></html>`,
};
// Asked, the page says how big its frame is and where its last line ends, as it sees them (its origin is
// opaque, so the app can't look inside it).
const REPORT = `<script>addEventListener("message", (e) => {
  if (e.data?.type !== "measure") return;
  const end = document.getElementById("end").getBoundingClientRect();
  parent.postMessage({ type: "measured", w: innerWidth, h: innerHeight, right: end.right, bottom: end.bottom }, "*");
});</script>`;
const html = PAGES[params.get("page") ?? "flow"]!.replace("</body>", `${REPORT}</body>`);
const at = Date.now() - 600_000;

const egg: Bot = { id: "egg", name: "Dr Eggbot", look: { shape: "puff", color: "white" }, instructions: "", memory: [], routines: [], createdAt: 1 };
const messages: BotMessage[] = [
  { id: "m0", author: "me", at, text: "Show me this week's signups" },
  { id: "m1", author: "egg", at: at + 1000, text: "", event: { kind: "thread", text: "Started a thread", detail: "Signups chart", threadId: "t1" } },
  { id: "m2", author: "egg", at: at + 2000, text: "", html: { title: "Signups", html, height: 240 } },
];
const conversations: Conversation[] = [{ id: "dm", kind: "direct", botIds: ["egg"], createdAt: at, updatedAt: at, messages }];
// The thread the bot started, still working, with the same page in its reply.
const thread: Chat = {
  id: "t1",
  title: "Signups chart",
  createdAt: at,
  updatedAt: at,
  startedBy: { bot: "egg", conversation: "dm" },
  workspace: { projectId: "site", projectName: "site", cwd: "/tmp/site" },
  messages: [
    { id: "t1-u", role: "user", content: "Chart this week's signups", createdAt: at, sentBy: "egg", sentByBot: "egg" },
    {
      id: "t1-a",
      role: "assistant",
      content: "Here it is.",
      createdAt: at + 1000,
      status: "streaming",
      parts: [{ type: "tool", id: "call-1", name: "html_render", status: "done", args: { title: "Signups", html, height: 240 } }, { type: "text", text: "Here it is." }],
    },
  ],
} as Chat;
useStore.setState({ botsOpen: true, botsSidebarOpen: false, chats: [thread] });
useBots.setState({ bots: [egg], conversations, activeId: "dm", detailsOpen: false, loaded: true, connected: true, ensureSeeded: () => {} });
/** Every page on screen, in the chat or in the thread inside the panel, as the page measures itself. */
const measure = () =>
  Promise.all(
    [...document.querySelectorAll<HTMLIFrameElement>("iframe.html-render-frame")].map(
      (frame) =>
        new Promise((resolve) => {
          const done = setTimeout(() => resolve(undefined), 1000);
          const on = (e: MessageEvent) => {
            if (e.source !== frame.contentWindow || e.data?.type !== "measured") return;
            removeEventListener("message", on);
            clearTimeout(done);
            const { w, h, right, bottom } = e.data;
            resolve({ where: frame.closest(".bots-details") ? "thread" : "chat", frame: { w, h }, end: { right: Math.round(right), bottom: Math.round(bottom) } });
          };
          addEventListener("message", on);
          frame.contentWindow?.postMessage({ type: "measure" }, "*");
        }),
    ),
  );
Object.assign(window, {
  measure,
  bots: useBots,
  store: useStore,
  openThread: () => useBots.getState().showDetailsThread("t1"),
});
createRoot(document.getElementById("root")!).render(
  <div className="bots-view" style={{ flex: 1, minWidth: 0, height: "100%" }}>
    <BotsView />
  </div>,
);
