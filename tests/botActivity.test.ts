import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { atWork, showWorking } from "../src/lib/bots/activity";
import { useBots } from "../src/lib/bots/store";
import { ConversationAvatar } from "../src/components/bots/common";
import type { BotStatus, Conversation } from "../src/lib/bots/types";

const solo = { id: "solo", kind: "direct", botIds: ["egg"] } as Conversation;
const group = { id: "group", kind: "group", botIds: ["egg", "other"] } as Conversation;

test("work in another chat doesn't make the solo chat look busy, in the sidebar or in the chat", () => {
  const status: Record<string, BotStatus> = { egg: { state: "working", conversationId: "group", activity: "Reading a file" } };
  // The sidebar used to animate every chat with the bot in it, while the solo chat showed nothing.
  expect(atWork(solo, status, {})).toEqual([]);
  expect(showWorking("solo", status, [])).toEqual([]);
  // The group it's actually working in shows it, just that member.
  expect(atWork(group, status, {})).toEqual(["egg"]);
  expect(showWorking("group", status, [])).toEqual(["egg"]);
});

test("quiet work in the solo chat animates its mascot everywhere, with no working line", () => {
  const status: Record<string, BotStatus> = { egg: { state: "working", conversationId: "solo", activity: "Thinking", quiet: true } };
  expect(atWork(solo, status, {})).toEqual(["egg"]);
  expect(showWorking("solo", status, [])).toEqual([]);
});

test("loud work, typing and holding on all count as at work in the solo chat", () => {
  expect(atWork(solo, { egg: { state: "working", conversationId: "solo" } }, {})).toEqual(["egg"]);
  expect(showWorking("solo", { egg: { state: "working", conversationId: "solo" } }, [])).toEqual(["egg"]);
  // Typing: the dots show it, not a working line.
  expect(atWork(solo, {}, { solo: ["egg"] })).toEqual(["egg"]);
  expect(showWorking("solo", { egg: { state: "working", conversationId: "solo" } }, ["egg"])).toEqual([]);
  // Finishing in the group with the solo chat's message next in line.
  const held: Record<string, BotStatus> = { egg: { state: "working", conversationId: "group", waiting: ["solo"] } };
  expect(atWork(solo, held, {})).toEqual(["egg"]);
  expect(showWorking("solo", held, [])).toEqual(["egg"]);
  // Idle, or errored, isn't at work.
  expect(atWork(solo, { egg: { state: "idle", conversationId: "solo" } }, {})).toEqual([]);
  expect(atWork(solo, { egg: { state: "error", conversationId: "solo" } }, {})).toEqual([]);
});

test("the sidebar and the chat's header read the same busy state", async () => {
  const sidebar = await Bun.file("src/components/bots/BotsSidebar.tsx").text();
  const chat = await Bun.file("src/components/bots/BotChat.tsx").text();
  expect(sidebar).toContain("useShallow((s) => atWork(conversation, s.status, s.typing))");
  expect(chat).toContain("useShallow((s) => atWork(conversation, s.status, s.typing))");
  expect(chat).toContain("busy={busy} working={busy ? working : undefined}");
  expect(chat).toContain("showWorking(conversation.id, s.status, typing)");
});

test("a busy solo avatar fidgets, an idle one doesn't", () => {
  useBots.setState({ bots: [{ id: "egg", name: "Dr Eggbot", look: { shape: "orb", color: "blue" } } as never], pulses: {} });
  const render = (busy: boolean) => renderToStaticMarkup(createElement(ConversationAvatar, { conversation: solo, size: 26, busy, badge: false }));
  expect(render(true)).toContain("data-busy");
  expect(render(false)).not.toContain("data-busy");
});
