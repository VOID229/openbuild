import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { busyBots, elsewhere, showWorking } from "../src/lib/bots/activity";
import { useBots } from "../src/lib/bots/store";
import { ConversationAvatar } from "../src/components/bots/common";
import type { BotStatus, Conversation } from "../src/lib/bots/types";

const solo = { id: "solo", kind: "direct", botIds: ["egg"] } as Conversation;
const group = { id: "group", kind: "group", botIds: ["egg", "other"] } as Conversation;

test("work in another chat keeps the bot busy everywhere, but never shows as thinking in the solo chat", () => {
  const status: Record<string, BotStatus> = { egg: { state: "working", conversationId: "group", activity: "Reading a file" } };
  // The sidebar (and the header) animate a busy bot in every chat it's in: in groups, just that member.
  expect(busyBots(solo, status, {})).toEqual(["egg"]);
  expect(busyBots(group, status, {})).toEqual(["egg"]);
  // The solo chat says where it's busy, with no working line of its own.
  expect(showWorking("solo", status, [])).toEqual([]);
  expect(elsewhere(solo, status)).toEqual([{ botId: "egg", conversationId: "group" }]);
  // The group it's actually working in shows its working line.
  expect(showWorking("group", status, [])).toEqual(["egg"]);
  expect(elsewhere(group, status)).toEqual([]);
});

test("quiet work in the solo chat animates its mascot everywhere, with no working line", () => {
  const status: Record<string, BotStatus> = { egg: { state: "working", conversationId: "solo", activity: "Thinking", quiet: true } };
  expect(busyBots(solo, status, {})).toEqual(["egg"]);
  expect(showWorking("solo", status, [])).toEqual([]);
  expect(elsewhere(solo, status)).toEqual([]);
});

test("loud work, typing and holding on count as busy, and only holding says so from elsewhere", () => {
  expect(busyBots(solo, { egg: { state: "working", conversationId: "solo" } }, {})).toEqual(["egg"]);
  expect(showWorking("solo", { egg: { state: "working", conversationId: "solo" } }, [])).toEqual(["egg"]);
  // Typing: the dots show it, not a working line.
  expect(busyBots(solo, {}, { solo: ["egg"] })).toEqual(["egg"]);
  expect(showWorking("solo", { egg: { state: "working", conversationId: "solo" } }, ["egg"])).toEqual([]);
  // Finishing in the group with the solo chat's message next in line: the holding line, not "busy in".
  const held: Record<string, BotStatus> = { egg: { state: "working", conversationId: "group", waiting: ["solo"] } };
  expect(busyBots(solo, held, {})).toEqual(["egg"]);
  expect(showWorking("solo", held, [])).toEqual(["egg"]);
  expect(elsewhere(solo, held)).toEqual([]);
  // Idle, or errored, isn't busy.
  expect(busyBots(solo, { egg: { state: "idle", conversationId: "solo" } }, {})).toEqual([]);
  expect(busyBots(solo, { egg: { state: "error", conversationId: "solo" } }, {})).toEqual([]);
});

test("the sidebar and the chat's header read the same busy state, and the header says where", async () => {
  const sidebar = await Bun.file("src/components/bots/BotsSidebar.tsx").text();
  const chat = await Bun.file("src/components/bots/BotChat.tsx").text();
  const common = await Bun.file("src/components/bots/common.tsx").text();
  // Both through the one hook, so a group's huddle wakes and dozes the same members in each.
  expect(common).toContain("useShallow((s) => (conversation ? busyBots(conversation, s.status, s.typing) : NONE))");
  expect(sidebar).toContain("const working = useBusyBots(conversation);");
  expect(chat).toContain("const working = useBusyBots(conversation);");
  expect(chat).toContain("busy={busy} working={working}");
  expect(chat).toContain("showWorking(conversation.id, s.status, typing)");
  expect(chat).toContain("`Busy in ${conversationName(there, s.bots)}`");
  expect(chat).toContain('activity ?? away ?? members');
  expect(chat).toContain('<span className="bots-head-away">{away}</span>');
});

test("a busy solo avatar fidgets, an idle one doesn't", () => {
  useBots.setState({ bots: [{ id: "egg", name: "Dr Eggbot", look: { shape: "orb", color: "blue" } } as never], pulses: {} });
  const render = (busy: boolean) => renderToStaticMarkup(createElement(ConversationAvatar, { conversation: solo, size: 26, busy, badge: false }));
  expect(render(true)).toContain("data-busy");
  expect(render(false)).not.toContain("data-busy");
});
