// The OpenBots sidebar's order (src/lib/bots/sidebarOrder.ts): how each list sorts with and without
// the user's own order, and what a drag or a keyboard move changes: places, pins and sections.
import { describe, expect, test } from "bun:test";
import { botChatsLabel, canJoin, leavesSidebar, movableLists, planMove, planStep, railLists, sidebarLists } from "../src/lib/bots/sidebarOrder";
import type { Bot, Conversation } from "../src/lib/bots/types";

const bot = (id: string, retiredAt?: number): Bot => ({ id, name: id, look: { shape: "cloud", color: "white" }, instructions: "", memory: [], routines: [], createdAt: 1, retiredAt });
const bots = [bot("a"), bot("b"), bot("c"), bot("d"), bot("old", 5)];
const chat = (id: string, more: Partial<Conversation> = {}): Conversation => ({ id, kind: "direct", botIds: [id], createdAt: 1, updatedAt: 1, messages: [], ...more });
const group = (id: string, botIds: string[], more: Partial<Conversation> = {}) => chat(id, { kind: "group", botIds, name: id, ...more });

// Pinned: a (pinned first), crew (second). Rows: b (newest), c, d (oldest). Section "Work": w1, w2. A friend's chat, a side chat.
const conversations = [
  chat("a", { pinnedAt: 10 }),
  group("crew", ["a", "b"], { pinnedAt: 20 }),
  chat("b", { updatedAt: 300 }),
  chat("c", { updatedAt: 200 }),
  chat("d", { updatedAt: 100 }),
  group("w1", ["a", "c"], { section: "Work", updatedAt: 50 }),
  group("w2", ["b", "c"], { section: "Work", updatedAt: 40 }),
  group("pals", ["a"], { friend: { friendId: "f", friendName: "Sam", remoteId: "r", bots: [] } as unknown as Conversation["friend"], updatedAt: 30 }),
  chat("side", { kind: "side", botIds: ["a", "b"], updatedAt: 20 }),
  chat("old", { updatedAt: 999 }),
];
const sections = ["Work"];
const ids = (list: Conversation[]) => list.map((c) => c.id);
const layout = (order: string[] = [], list = conversations) => {
  const lists = sidebarLists(list, bots, sections, order);
  return { lists, movable: movableLists(lists) };
};
/** The lists after an arrangement is applied, as the store applies it. */
const after = (order: string[], patches: [string, Partial<Conversation>][]) => {
  const next = conversations.map((c) => {
    const p = patches.find(([id]) => id === c.id)?.[1];
    return p ? { ...c, ...p } : c;
  });
  return sidebarLists(next, bots, sections, order);
};

describe("sorting", () => {
  test("without an order, pins go as they were pinned and rows by their latest message", () => {
    const { lists } = layout();
    expect(ids(lists.pinned)).toEqual(["a", "crew"]);
    expect(ids(lists.rest)).toEqual(["b", "c", "d"]);
    expect(ids(lists.filed[0]![1])).toEqual(["w1", "w2"]);
    expect(ids(lists.shared)).toEqual(["pals"]);
    expect(ids(lists.side)).toEqual(["side"]);
    // A retired bot's chat is under Retired only.
    expect(ids(lists.retired)).toEqual(["old"]);
  });

  test("placed chats keep their places; ones not placed sit above them in rows, after them in pins", () => {
    const { lists } = layout(["crew", "a", "d", "c"]);
    expect(ids(lists.pinned)).toEqual(["crew", "a"]);
    // b isn't placed: newest first, above the ones put in place.
    expect(ids(lists.rest)).toEqual(["b", "d", "c"]);
    const pins = sidebarLists([...conversations, chat("e", { pinnedAt: 5 })], [...bots, bot("e")], sections, ["crew", "a"]).pinned;
    expect(ids(pins)).toEqual(["crew", "a", "e"]);
  });
});

describe("chats between bots", () => {
  const side = (id: string, botIds: string[], more: Partial<Conversation> = {}) => chat(id, { kind: "side", botIds, ...more });
  const closed = { by: "a", from: "crew", topic: "Port?", limit: 6, closedAt: 5 } as Conversation["huddle"];

  test("a closed one is in no list, pinned or hidden as it may be; an open one and a plain DM stay", () => {
    const list = [
      ...conversations,
      side("shut", ["a", "b"], { huddle: closed, updatedAt: 500 }),
      side("shut-pin", ["a", "c"], { huddle: closed, pinnedAt: 30 }),
      side("shut-hidden", ["b", "c"], { huddle: closed, hidden: true }),
      side("open", ["a", "b", "c"], { huddle: { ...closed, closedAt: undefined } as Conversation["huddle"], updatedAt: 400 }),
    ];
    expect(list.filter(leavesSidebar).map((c) => c.id)).toEqual(["shut", "shut-pin", "shut-hidden"]);
    const lists = sidebarLists(list, bots, sections, []);
    expect(ids(lists.side)).toEqual(["open", "side"]);
    expect(ids(lists.pinned)).toEqual(["a", "crew"]);
    expect(ids(lists.hidden)).toEqual([]);
    const every = [...lists.pinned, ...lists.rest, ...lists.shared, ...lists.filed.flatMap(([, l]) => l), ...lists.side, ...lists.hidden, ...lists.retired];
    expect(every.some((c) => c.id.startsWith("shut"))).toBe(false);
    // A group or a bot's own chat never leaves this way.
    expect(conversations.some(leavesSidebar)).toBe(false);
  });

  test("their heading says what they are: DMs, Meetings, or both", () => {
    expect(botChatsLabel([side("x", ["a", "b"])])).toBe("DMs");
    expect(botChatsLabel([side("x", ["a", "b", "c"])])).toBe("Meetings");
    expect(botChatsLabel([side("x", ["a", "b"]), side("y", ["a", "b", "c", "d"])])).toBe("DMs and meetings");
  });
});

describe("the rail", () => {
  const rail = (folded: string[], order: string[] = []) => {
    const r = railLists(sidebarLists(conversations, bots, sections, order), folded, order.length > 0);
    return { pinned: ids(r.pinned), rest: ids(r.rest), side: ids(r.side) };
  };

  test("leaves out every section folded shut in the list, and keeps the rest", () => {
    // All open: the rows, Work's chats and the friends' run together by their latest message.
    expect(rail([])).toEqual({ pinned: ["a", "crew"], rest: ["b", "c", "d", "w1", "w2", "pals"], side: ["side"] });
    // Work, With friends and the chats between bots folded: none of theirs. Pins and the unfiled rows have no fold.
    expect(rail(["Work"]).rest).toEqual(["b", "c", "d", "pals"]);
    expect(rail(["friends"]).rest).toEqual(["b", "c", "d", "w1", "w2"]);
    expect(rail(["Work", "friends", "side"])).toEqual({ pinned: ["a", "crew"], rest: ["b", "c", "d"], side: [] });
    // Hidden is folded by default and never on the rail, like Retired; a name that's no section changes nothing.
    expect(rail(["hidden", "retired:open", "Nope"])).toEqual(rail([]));
  });

  test("placed by hand, it keeps the list's order, still without a folded section", () => {
    expect(rail([], ["d", "b"]).rest).toEqual(["c", "d", "b", "w1", "w2", "pals"]);
    expect(rail(["Work"], ["d", "b"]).rest).toEqual(["c", "d", "b", "pals"]);
  });
});

describe("moving", () => {
  test("above or below another row in the same list", () => {
    const { movable } = layout();
    const plan = planMove(movable, [], "d", { id: "b", place: "before" })!;
    expect(plan.patches).toEqual([]);
    expect(ids(after(plan.order, plan.patches).rest)).toEqual(["d", "b", "c"]);
    const down = planMove(movable, [], "b", { id: "c", place: "after" })!;
    expect(ids(after(down.order, down.patches).rest)).toEqual(["c", "b", "d"]);
  });

  test("a drop that changes nothing is no move", () => {
    const { movable } = layout();
    expect(planMove(movable, [], "b", { id: "c", place: "before" })).toBeUndefined();
    expect(planMove(movable, [], "c", { id: "b", place: "after" })).toBeUndefined();
    expect(planMove(movable, [], "b", { id: "b", place: "after" })).toBeUndefined();
  });

  test("other lists keep their places in the order", () => {
    const { movable } = layout(["w2", "w1"]);
    const plan = planMove(movable, ["w2", "w1"], "d", { id: "b", place: "before" })!;
    const lists = after(plan.order, plan.patches);
    expect(ids(lists.filed[0]![1])).toEqual(["w2", "w1"]);
    expect(ids(lists.rest)).toEqual(["d", "b", "c"]);
  });

  test("a pinned bot dropped onto a pinned group swaps the two", () => {
    const { movable } = layout();
    const plan = planMove(movable, [], "a", { id: "crew", place: "swap" })!;
    expect(plan.patches).toEqual([]);
    expect(ids(after(plan.order, plan.patches).pinned)).toEqual(["crew", "a"]);
  });

  test("a row dropped among the tiles is pinned there, and a tile among the rows unpinned there", () => {
    const { movable } = layout();
    const pin = planMove(movable, [], "c", { id: "a", place: "after" })!;
    expect(pin.patches).toHaveLength(1);
    expect(pin.patches[0]![0]).toBe("c");
    expect(pin.patches[0]![1].pinnedAt).toBeNumber();
    const pinned = after(pin.order, pin.patches);
    expect(ids(pinned.pinned)).toEqual(["a", "c", "crew"]);
    expect(ids(pinned.rest)).toEqual(["b", "d"]);

    const unpin = planMove(movable, [], "a", { id: "c", place: "before" })!;
    expect(unpin.patches).toEqual([["a", { pinnedAt: undefined }]]);
    const unpinned = after(unpin.order, unpin.patches);
    expect(ids(unpinned.pinned)).toEqual(["crew"]);
    expect(ids(unpinned.rest)).toEqual(["b", "a", "c", "d"]);
  });

  test("into another section: filed there, where it was dropped", () => {
    const { movable } = layout();
    const plan = planMove(movable, [], "b", { id: "w2", place: "before" })!;
    expect(plan.patches).toEqual([["b", { section: "Work" }]]);
    expect(ids(after(plan.order, plan.patches).filed[0]![1])).toEqual(["w1", "b", "w2"]);
    // And on a section's heading: first in it.
    const top = planMove(movable, [], "d", { list: "section:Work" })!;
    expect(top.patches).toEqual([["d", { section: "Work" }]]);
    expect(ids(after(top.order, top.patches).filed[0]![1])).toEqual(["d", "w1", "w2"]);
    // Out of a section into the rows: no section.
    const out = planMove(movable, [], "w1", { id: "d", place: "after" })!;
    expect(out.patches).toEqual([["w1", { section: undefined }]]);
  });

  test("swapping across lists swaps pins and sections too", () => {
    const { movable } = layout();
    // An unpinned bot onto a pinned group: the bot takes the group's tile, the group the bot's row.
    const plan = planMove(movable, [], "c", { id: "crew", place: "swap" })!;
    expect(plan.patches.map(([id, p]) => [id, Object.keys(p)])).toEqual([["c", ["pinnedAt"]], ["crew", ["pinnedAt"]]]);
    expect(plan.patches[1]![1].pinnedAt).toBeUndefined();
    const lists = after(plan.order, plan.patches);
    expect(ids(lists.pinned)).toEqual(["a", "c"]);
    expect(ids(lists.rest)).toEqual(["b", "crew", "d"]);
  });

  test("a friend's chat stays out of the loose rows, the user's own out of the friends', a side chat out of both", () => {
    const { movable } = layout();
    expect(planMove(movable, [], "pals", { id: "b", place: "before" })).toBeUndefined();
    expect(planMove(movable, [], "b", { list: "friends" })).toBeUndefined();
    expect(planMove(movable, [], "b", { id: "pals", place: "swap" })).toBeUndefined();
    // A friend's chat can be pinned or filed.
    expect(planMove(movable, [], "pals", { id: "w1", place: "before" })!.patches).toEqual([["pals", { section: "Work" }]]);
    expect(planMove(movable, [], "pals", { id: "a", place: "before" })!.patches[0]![1].pinnedAt).toBeNumber();
    // A pinned side chat moves among the tiles, not to the rows.
    const pinnedSide = conversations.map((c) => (c.id === "side" ? { ...c, pinnedAt: 30 } : c));
    const side = layout([], pinnedSide).movable;
    expect(planMove(side, [], "side", { id: "a", place: "before" })).toBeDefined();
    expect(planMove(side, [], "side", { id: "b", place: "before" })).toBeUndefined();
    // Chats outside the movable lists (side chats, hidden, retired) aren't moved.
    expect(planMove(movable, [], "side", { id: "b", place: "before" })).toBeUndefined();
    expect(planMove(movable, [], "old", { id: "b", place: "before" })).toBeUndefined();
  });

  test("one step up or down its own list, and not past its ends", () => {
    const { movable } = layout();
    const up = planStep(movable, [], "c", -1)!;
    expect(ids(after(up.order, up.patches).rest)).toEqual(["c", "b", "d"]);
    const right = planStep(movable, [], "a", 1)!;
    expect(ids(after(right.order, right.patches).pinned)).toEqual(["crew", "a"]);
    expect(planStep(movable, [], "b", -1)).toBeUndefined();
    expect(planStep(movable, [], "d", 1)).toBeUndefined();
  });
});

test("a bot can join a group it isn't in, unless it's retired or the shared chat ended", () => {
  const find = (id: string) => conversations.find((c) => c.id === id);
  expect(canJoin(find("c"), find("crew"), bots)).toBe(true);
  expect(canJoin(find("a"), find("crew"), bots)).toBe(false);
  expect(canJoin(find("old"), find("crew"), bots)).toBe(false);
  expect(canJoin(find("w1"), find("crew"), bots)).toBe(false);
  expect(canJoin(find("c"), find("d"), bots)).toBe(false);
  expect(canJoin(find("c"), group("gone", ["a"], { friend: { ended: true } as unknown as Conversation["friend"] }), bots)).toBe(false);
});
