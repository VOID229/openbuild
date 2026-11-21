import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { awayLines, busyBots, DOTS_MAX, DOTS_SETTLE, elsewhere, plainPhase, plainPhaseEnds, shownLine, showWorking, trackShown, type Shown } from "../src/lib/bots/activity";
import { useBots } from "../src/lib/bots/store";
import { ConversationAvatar } from "../src/components/bots/common";
import type { BotStatus, Conversation } from "../src/lib/bots/types";

const solo = { id: "solo", kind: "direct", botIds: ["egg"] } as Conversation;
const group = { id: "group", kind: "group", botIds: ["egg", "other"] } as Conversation;

test("work in a group keeps the bot busy in its own chat, but never shows as thinking there", () => {
  const status: Record<string, BotStatus> = { egg: { state: "working", conversationId: "group", activity: "Reading a file" } };
  // The sidebar (and the header) animate a busy bot in its own chat and the group it's at work in: in the group, just that member.
  expect(busyBots(solo, status, {})).toEqual(["egg"]);
  expect(busyBots(group, status, {})).toEqual(["egg"]);
  // The solo chat says where it's busy, with no working line of its own.
  expect(showWorking("solo", status, [])).toEqual([]);
  expect(elsewhere(solo, status)).toEqual([{ botId: "egg", conversationId: "group" }]);
  // The group it's actually working in shows its working line.
  expect(showWorking("group", status, [])).toEqual(["egg"]);
  expect(elsewhere(group, status)).toEqual([]);
});

test("a group shows a member busy only with work of its own, never for work in a chat it has nothing to do with", () => {
  const other = { id: "other-group", kind: "group", botIds: ["egg", "other"] } as Conversation;
  const side = { id: "side", kind: "side", botIds: ["egg", "other"] } as Conversation;
  // At work in its own chat (or a group, or a side chat): its own chat is the bot, so it's busy there,
  // but every other group or side chat it's in shows it dozing, with nothing said of it.
  for (const where of ["solo", "group", "side"]) {
    const status: Record<string, BotStatus> = { egg: { state: "working", conversationId: where, activity: "Running the tests" } };
    expect(busyBots(solo, status, {})).toEqual(["egg"]);
    expect(busyBots(other, status, {})).toEqual([]);
    expect(elsewhere(other, status)).toEqual([]);
    if (where !== "side") expect(busyBots(side, status, {})).toEqual([]);
    if (where !== "group") expect(busyBots(group, status, {})).toEqual([]);
  }
  // Typing there, or holding on with a message there that names it next, it's busy there.
  const working: BotStatus = { state: "working", conversationId: "solo", activity: "Running the tests" };
  expect(busyBots(other, { egg: working }, { "other-group": ["egg"] })).toEqual(["egg"]);
  expect(busyBots(other, { egg: { ...working, waiting: ["other-group"] } }, {})).toEqual(["egg"]);
  expect(showWorking("other-group", { egg: { ...working, waiting: ["other-group"] } }, [])).toEqual(["egg"]);
  // A message to the whole group it hasn't decided on doesn't.
  expect(busyBots(other, { egg: { ...working, waiting: ["other-group"], undecided: ["other-group"] } }, {})).toEqual([]);
  // At work elsewhere on this group's account (a handoff from it, a side chat opened from it): away here.
  const forIt: Record<string, BotStatus> = { egg: { ...working, conversationId: "side", from: "other-group" } };
  expect(busyBots(other, forIt, {})).toEqual(["egg"]);
  expect(elsewhere(other, forIt)).toEqual([{ botId: "egg", conversationId: "side" }]);
  expect(busyBots(group, forIt, {})).toEqual([]);
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

// A bot at work in another chat, as the chat being looked at says it (awayLines): what it's doing
// there, where, by names the viewer can see, the most exact way first and shorter ones after, and of a
// chat the viewer can't see, neither.
const bots = [{ id: "scout", name: "Scout" }, { id: "pip", name: "Pip · Alice" }, { id: "tally", name: "Tally" }, { id: "rex", name: "Rex" }];
const chats = [
  { id: "dm", kind: "direct", botIds: ["scout"] },
  { id: "dev", kind: "group", name: "OpenBuild Dev", botIds: ["scout", "pip"] },
  { id: "release", kind: "group", name: "Release chat", botIds: ["scout", "pip"] },
  { id: "secret", kind: "group", name: "Surprise party", botIds: ["scout", "tally"], hidden: true },
  { id: "ask", kind: "side", botIds: ["scout", "pip"] },
  { id: "huddle", kind: "side", name: "Which test first", botIds: ["scout", "pip", "tally"], huddle: { by: "scout", from: "dev", topic: "Which test first", limit: 9 } },
  { id: "big", kind: "side", name: "Big one", botIds: ["scout", "pip", "tally", "rex"], huddle: { by: "scout", from: "release", topic: "Big", limit: 12 } },
] as Conversation[];
const known = { conversations: chats, bots };
const at = (conversationId: string, more: Partial<BotStatus> = {}): BotStatus => ({ state: "working", conversationId, ...more });

test("busy in a group: the step it's on there, in the group by its name, then in another group, then just busy", () => {
  expect(awayLines("dm", "scout", at("dev", { activity: "Running the test suite" }), known)).toEqual([
    "running the test suite in the OpenBuild Dev group",
    "running the test suite in another group",
    "doing something in the OpenBuild Dev group",
    "doing something in another group",
    "busy elsewhere",
  ]);
  // Plain work says nothing it isn't doing.
  expect(awayLines("dm", "scout", at("dev", { activity: "Working on it" }), known)[0]).toBe("doing something in the OpenBuild Dev group");
  // Writing a message there is posting there, typing too; a name that already says chat isn't "the Release chat group".
  expect(awayLines("dm", "scout", at("dev", { activity: "Writing a reply" }), known).slice(0, 2)).toEqual(["posting in the OpenBuild Dev group", "posting in another group"]);
  expect(awayLines("dm", "scout", at("release", { activity: "Working on it" }), { ...known, typing: { release: ["scout"] } })[0]).toBe("posting in the Release chat");
  // A line of its own that isn't a doing word, and acronyms, read as written.
  expect(awayLines("dm", "scout", at("dev", { activity: "PR review" }), known)[0]).toBe("working on PR review in the OpenBuild Dev group");
  expect(awayLines("dm", "scout", at("dev", { activity: "Checking CI…" }), known)[0]).toBe("checking CI in the OpenBuild Dev group");
  // Between plain words, the last line it named there.
  expect(awayLines("dm", "scout", at("dev", { activity: "Working on it" }), { ...known, shown: { line: "Reading the logs" } })[0]).toBe("reading the logs in the OpenBuild Dev group");
  // Nothing in it is ever cut: every line ends with a whole word.
  for (const line of awayLines("dm", "scout", at("dev", { activity: "Running the test suite" }), known)) expect(line).not.toMatch(/…$/);
});

test("work that came from the chat being looked at says so: posting about this, and the plain way where that's too long", () => {
  expect(awayLines("dm", "scout", at("dev", { activity: "Writing a reply", from: "dm" }), known)).toEqual([
    "posting about this in the OpenBuild Dev group",
    "posting about this in another group",
    "posting in the OpenBuild Dev group",
    "posting in another group",
    "busy elsewhere",
  ]);
  expect(awayLines("dm", "scout", at("dev", { activity: "Searching the web", from: "dm" }), known)[0]).toBe("searching the web for this in the OpenBuild Dev group");
  expect(awayLines("dm", "scout", at("dev", { activity: "Working on it", from: "dm" }), known)[0]).toBe("working on this in the OpenBuild Dev group");
  // From another chat than this one: not "about this" here.
  expect(awayLines("release", "scout", at("dev", { activity: "Writing a reply", from: "dm" }), known)[0]).toBe("posting in the OpenBuild Dev group");
});

test("between bots: messaging the one it's asking in a DM, talking with the several in a meeting, about this when it was opened from here", () => {
  expect(awayLines("dm", "scout", at("ask", { activity: "Writing a reply" }), known)).toEqual(["messaging Pip", "talking with Pip", "in a DM", "busy elsewhere"]);
  expect(awayLines("dev", "scout", at("ask", { activity: "Writing a reply", from: "dev" }), known).slice(0, 2)).toEqual(["messaging Pip about this", "talking with Pip about this"]);
  expect(awayLines("dm", "scout", at("ask", { activity: "Running a command" }), known)[0]).toBe("running a command in its chat with Pip");
  // A side chat opened from the group says so in the group, from the side chat's own record too.
  expect(awayLines("dev", "scout", at("huddle", { activity: "Working on it" }), known)[0]).toBe("talking with Pip and Tally about this");
  expect(awayLines("dev", "scout", at("huddle", { activity: "Searching the web" }), known).slice(0, 2)).toEqual(["searching the web for this in a meeting with Pip and Tally", "talking with Pip and Tally about this"]);
  expect(awayLines("dm", "scout", at("huddle", { activity: "Writing a reply" }), known)[0]).toBe("talking with Pip and Tally");
  expect(awayLines("dm", "scout", at("huddle", { activity: "Writing a reply" }), known).slice(-2)).toEqual(["in a meeting", "busy elsewhere"]);
  expect(awayLines("dm", "scout", at("big", { activity: "Writing a reply" }), known).slice(0, 2)).toEqual(["talking with Pip, Tally and Rex", "talking with 3 bots"]);
});

test("its own chat, and a routine", () => {
  expect(awayLines("dev", "scout", at("dm", { activity: "Writing a reply" }), known)[0]).toBe("messaging you");
  expect(awayLines("dev", "scout", at("dm", { activity: "Opening example.com" }), known)[0]).toBe("opening example.com in its chat with you");
  expect(awayLines("dm", "scout", at("dev", { activity: "Getting started on a routine", routine: "Morning digest" }), known).slice(0, 3)).toEqual([
    "running its “Morning digest” routine in the OpenBuild Dev group",
    "running its “Morning digest” routine in another group",
    "running a routine in the OpenBuild Dev group",
  ]);
  // A routine's own steps are said as they are.
  expect(awayLines("dm", "scout", at("dev", { activity: "Searching the web", routine: "Morning digest" }), known)[0]).toBe("searching the web in the OpenBuild Dev group");
  // Between turns, only waiting on a thread it started from the group, it's free: not busy elsewhere.
  expect(elsewhere(solo, { egg: at("dev", { activity: "Waiting on the release notes", threads: 1 }) })).toEqual([]);
});

test("a chat the viewer can't see shows neither its name nor what's going on there", () => {
  for (const st of [at("secret", { activity: "Ordering the cake" }), at("not-loaded", { activity: "Ordering the cake" }), at("secret", { activity: "Writing a reply", from: "dm" })]) {
    const lines = awayLines("dm", "scout", st, known);
    expect(lines).toEqual(["busy in another chat"]);
    expect(lines.join(" ")).not.toMatch(/Surprise|cake/i);
  }
});

test("busy elsewhere is said where it isn't typing, holding on or at work, and never for a group's undecided", () => {
  const status: Record<string, BotStatus> = { egg: at("group", { activity: "Reading a file" }) };
  expect(elsewhere(solo, status)).toEqual([{ botId: "egg", conversationId: "group" }]);
  // Typing in this chat is being here.
  expect(elsewhere(solo, status, { solo: ["egg"] })).toEqual([]);
  // Deciding in a group shows nothing anywhere.
  expect(elsewhere(solo, { egg: at("group", { deciding: true }) })).toEqual([]);
});

test("the busy-elsewhere mascot is calm: it rests, looks off a while and blinks, and never works, hops or goes round", async () => {
  const { nextAway } = await import("../src/lib/bots/routines");
  const all = Array.from({ length: 3000 }, nextAway);
  const what = all.flatMap((r) => r.map(([w]) => w));
  expect(what.filter((w) => typeof w === "string" && !w.startsWith("blink"))).toEqual([]);
  expect(what.filter((w) => w !== null && typeof w === "object" && "flash" in w)).toEqual([]);
  // Its eyes stay its small, resting ones: none of the work's big or round eyes.
  const poses = what.flatMap((w) => (w !== null && typeof w === "object" && "x" in w ? [w] : w !== null && typeof w === "object" && "sweep" in w ? [w.sweep] : []));
  expect(poses.length).toBeGreaterThan(0);
  for (const p of poses) {
    expect(p.eyes).toBe("open");
    expect(p.zoom ?? 0).toBe(0);
  }
  // Mostly at rest: the looks take less of its time than resting does.
  const ms = (pick: (w: (typeof what)[number]) => boolean) => all.flatMap((r) => r).filter(([w]) => pick(w)).reduce((n, [, t]) => n + t, 0);
  expect(ms((w) => w === null)).toBeGreaterThan(ms((w) => w !== null && typeof w === "object"));
});
