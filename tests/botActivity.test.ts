import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { busyBots, DOTS_MAX, DOTS_SETTLE, elsewhere, plainPhase, plainPhaseEnds, shownLine, showWorking, trackShown, type Shown } from "../src/lib/bots/activity";
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
  // Typing: "Typing…" shows it, not a working line.
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

test("plain words are three dots only with nothing else to name, briefly, and the same for every place that asks", () => {
  const now = 1_000_000;
  const plain: BotStatus = { state: "working", conversationId: "solo", activity: "Working on it", since: now };
  let shown = trackShown({}, { egg: plain }, now);
  // Just turned plain: a moment to settle, then dots, then the mascot back with the words.
  expect(plainPhase(plain, shown.egg, false, now)).toBe("settling");
  expect(plainPhaseEnds(plain, shown.egg, false, now)).toBe(now + DOTS_SETTLE);
  expect(plainPhase(plain, shown.egg, false, now + DOTS_SETTLE)).toBe("dots");
  expect(plainPhaseEnds(plain, shown.egg, false, now + DOTS_SETTLE)).toBe(now + DOTS_SETTLE + DOTS_MAX);
  expect(plainPhase(plain, shown.egg, false, now + DOTS_SETTLE + DOTS_MAX)).toBe("words");
  expect(plainPhaseEnds(plain, shown.egg, false, now + DOTS_SETTLE + DOTS_MAX)).toBeUndefined();
  // Another plain phrase is the same spell of plain words: the clock doesn't start over.
  shown = trackShown(shown, { egg: { ...plain, activity: "Getting it done", since: now + 900 } }, now + 900);
  expect(shown.egg!.plainSince).toBe(now);
  // A line of its own ends it, and is kept: plain words after it say that line, never dots.
  shown = trackShown(shown, { egg: { ...plain, activity: "Checking the build logs" } }, now + 1000);
  expect(shown.egg).toEqual({ line: "Checking the build logs" });
  const after: BotStatus = { ...plain, activity: "Making progress", since: now + 2000 };
  shown = trackShown(shown, { egg: after }, now + 2000);
  expect(plainPhase(after, shown.egg, false, now + 2000 + DOTS_SETTLE)).toBeUndefined();
  expect(shownLine(after, shown.egg)).toBe("Checking the build logs");
  // "Writing a reply" is over once the message is out: it's never kept.
  const fresh: Record<string, Shown> = {};
  const writing = trackShown(fresh, { egg: { ...plain, activity: "Writing a reply" } }, now);
  expect(writing.egg?.line).toBeUndefined();
  // Typing, quiet work, a group bot still deciding, and no work at all are never dots.
  const at = now + DOTS_SETTLE;
  const own = trackShown({}, { egg: plain }, now).egg;
  expect(plainPhase(plain, own, true, at)).toBeUndefined();
  expect(plainPhase({ ...plain, quiet: true }, trackShown({}, { egg: { ...plain, quiet: true } }, now).egg, false, at)).toBeUndefined();
  expect(plainPhase({ ...plain, deciding: true }, own, false, at)).toBeUndefined();
  expect(plainPhase({ state: "idle" }, own, false, at)).toBeUndefined();
  expect(plainPhase(undefined, undefined, false, at)).toBeUndefined();
  // Going idle forgets it all, and nothing changing hands back the same record.
  expect(trackShown(shown, { egg: { state: "idle" } }, now)).toEqual({});
  const same = trackShown({}, { egg: plain }, now);
  expect(trackShown(same, { egg: plain }, now + 50)).toBe(same);
  // Loaded in the middle of a long plain spell (a reload): the server's since says it's been long enough already.
  const loaded = trackShown({}, { egg: { ...plain, since: now - 60_000 } }, now);
  expect(plainPhase(plain, loaded.egg, false, now)).toBe("words");
  // This device's clock behind the server's: a spell that looks ahead of now starts now.
  expect(trackShown({}, { egg: { ...plain, since: now + 900 } }, now).egg!.plainSince).toBe(now);
});
