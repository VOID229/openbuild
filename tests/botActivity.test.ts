import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { busyBots, elsewhere, showWorking, starting, STARTING_MS } from "../src/lib/bots/activity";
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

test("a busy solo avatar fidgets, an idle one doesn't", () => {
  useBots.setState({ bots: [{ id: "egg", name: "Dr Eggbot", look: { shape: "orb", color: "blue" } } as never], pulses: {} });
  const render = (busy: boolean) => renderToStaticMarkup(createElement(ConversationAvatar, { conversation: solo, size: 26, busy, badge: false }));
  expect(render(true)).toContain("data-busy");
  expect(render(false)).not.toContain("data-busy");
});

test("a bot has just started for a moment: working, in the open, with no step to name yet", () => {
  const now = 1_000_000;
  const fresh: BotStatus = { state: "working", conversationId: "solo", activity: "Working on it", since: now - 200 };
  expect(starting(fresh, now)).toBe(true);
  expect(starting({ ...fresh, activity: undefined }, now)).toBe(true);
  // A step to show, and the moment is over; so it is after a while with none.
  expect(starting({ ...fresh, activity: "Reading a file" }, now)).toBe(false);
  expect(starting(fresh, now + STARTING_MS)).toBe(false);
  // Plain working words between later steps aren't a start.
  expect(starting({ ...fresh, activity: "Making progress", since: now - 60_000 }, now)).toBe(false);
  // Quiet work, deciding whether a message is its to answer, and no work at all never are.
  expect(starting({ ...fresh, quiet: true }, now)).toBe(false);
  expect(starting({ ...fresh, deciding: true }, now)).toBe(false);
  expect(starting({ state: "idle" }, now)).toBe(false);
  expect(starting(undefined, now)).toBe(false);
  // This device's clock behind the server's: a start that looks ahead of now is still a start.
  expect(starting({ ...fresh, since: now + 900 }, now)).toBe(true);
});
