// A bot's message steered into a running reply is labeled "Sent by" as the open tab streams the
// reply, not only after a reload: the tab keeps its own copy of a working thread, so the label has to
// come with the steer event itself.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Bot } from "../src/lib/bots/types";
import type { Chat } from "../src/lib/types";

const g = globalThis as any;
g.window ??= globalThis;
g.innerWidth = 1280;
g.document ??= { addEventListener() {}, visibilityState: "visible" };
g.addEventListener ??= () => {};
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
g.requestAnimationFrame ??= (fn: () => void) => setTimeout(fn, 0);
g.cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
const saved = new Map<string, string>();
g.localStorage ??= { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };

const ndjson = (...events: unknown[]) => new Response(events.map((ev) => JSON.stringify(ev)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson", "x-openchat-run": "1" } });
let run: Response | undefined;
globalThis.fetch = (async (url: any) => {
  const path = String(url);
  if (path === "/api/config") return Response.json({ mode: "local", serverId: "steer-live" });
  if (path.includes("/api/chat/runs/")) return run ?? ndjson({ t: "end" });
  return Response.json({});
}) as typeof fetch;

const { config } = await import("../src/lib/runtime");
await config;
const { useStore } = await import("../src/lib/store");
const { useBots } = await import("../src/lib/bots/store");
const { resumeReplies } = await import("../src/lib/chat");
const { MessageItem } = await import("../src/components/MessageItem");

const eggbot = { id: "bot-egg", name: "Dr Eggbot", look: { shape: "puff", color: "white" } } as Bot;

/** A Claude thread whose reply is running on this server, as a bot's send finds it. */
function working(id: string): Chat {
  const now = Date.now();
  return {
    id, title: "Mascots", runtime: "claude", createdAt: now, updatedAt: now,
    messages: [
      { id: `${id}-u`, role: "user", content: "Gentler eyes", createdAt: now, sentBy: "Dr Eggbot", sentByBot: eggbot.id },
      { id: `${id}-a`, role: "assistant", content: "", status: "streaming", model: { plan: "claude", id: "claude/opus", name: "Opus" }, stream: { id: `${id}-run`, via: "steer-live" }, createdAt: now, startedAt: now },
    ],
  };
}

async function stream(chat: Chat, ...events: unknown[]) {
  run = ndjson(...events);
  useStore.setState({ chats: [chat], activeChatId: chat.id });
  resumeReplies(chat.id);
  for (let i = 0; i < 200; i++) {
    const reply = useStore.getState().chats.find((c) => c.id === chat.id)?.messages.at(-1);
    if (reply?.status !== "streaming") return reply!;
    await Bun.sleep(10);
  }
  throw new Error("The reply didn't settle");
}

test("a bot's steer is labeled as the open tab streams it", async () => {
  useBots.getInitialState().bots = [eggbot];
  const reply = await stream(working("live"),
    { t: "text", v: "Looking at the shapes." },
    { t: "steer", id: "s1", text: "Also the Look picker", sentBy: "Dr Eggbot", sentByBot: eggbot.id },
    { t: "text", v: "On it." },
    { t: "done", finish: "stop" },
    { t: "end" },
  );
  expect(reply.status).toBe("done");
  const steer = reply.parts?.find((p) => p.type === "steer");
  expect(steer).toMatchObject({ type: "steer", id: "s1", text: "Also the Look picker", sentBy: "Dr Eggbot", sentByBot: eggbot.id });
  const html = renderToStaticMarkup(createElement(MessageItem, { message: reply, chatId: "live", isLast: true }));
  expect(html).toContain("msg-steer");
  expect(html.split("msg-steer")[1]).toContain("Sent by");
  expect(html.split("msg-steer")[1]).toContain("<span>Dr Eggbot</span>");
});

test("the user's own steer stays unlabeled", async () => {
  const reply = await stream(working("own"),
    { t: "steer", id: "s2", text: "Mine" },
    { t: "done", finish: "stop" },
    { t: "end" },
  );
  expect(reply.status).toBe("done");
  const steer = reply.parts?.find((p) => p.type === "steer");
  expect(steer).toEqual({ type: "steer", id: "s2", text: "Mine" });
});
