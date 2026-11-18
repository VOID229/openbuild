// The OpenBots sidebar's lists and the order of the chats in them: which list a chat is in (the pinned
// tiles, the rows, a section, the friends'), how each list sorts, and what dragging one chat to
// another changes. Pure, so the sidebar, its keyboard moves and the tests share one answer.
//
// The user's order is one list of conversation ids (BotsSettings.order). Each sidebar list sorts the
// chats it holds by where they are in it; chats not in it sit where they would without it: new pins
// after the others (in the order they were pinned), rows above the ones placed by hand, by their
// latest message. A move writes the whole of each list it touched into the order, so those keep
// their places from then on.
import type { Bot, Conversation } from "./types";

/** "pinned", "rest" (rows not filed anywhere), "friends" (chats shared with friends), or `section:<name>`. */
export type ListKey = "pinned" | "rest" | "friends" | `section:${string}`;

/** Where a dragged chat lands, against the chat it's dropped on. `swap`: the two change places. */
export type Place = "before" | "after" | "swap";

export type Target = { id: string; place: Place } | { list: ListKey };

export interface SidebarLists {
  pinned: Conversation[];
  rest: Conversation[];
  /** Shared with friends, and not filed under one of the user's sections. */
  shared: Conversation[];
  filed: (readonly [string, Conversation[]])[];
  side: Conversation[];
  hidden: Conversation[];
  retired: Conversation[];
}

export interface Arrangement {
  /** The new order to save. */
  order: string[];
  /** Conversations that changed list: pinned or not, and their section. */
  patches: [string, Partial<Pick<Conversation, "pinnedAt" | "section">>][];
}

const byRecent = (a: Conversation, b: Conversation) => b.updatedAt - a.updatedAt;
const byPinned = (a: Conversation, b: Conversation) => a.pinnedAt! - b.pinnedAt!;

/** `list` in the user's order, those not in it first (rows) or last (pins), in their usual order. */
export function sortList(list: Conversation[], rank: Map<string, number>, unranked: "first" | "last", usual: (a: Conversation, b: Conversation) => number): Conversation[] {
  const placed = list.filter((c) => rank.has(c.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const rest = list.filter((c) => !rank.has(c.id)).sort(usual);
  return unranked === "first" ? [...rest, ...placed] : [...placed, ...rest];
}

export const rankOf = (order: readonly string[]) => new Map(order.map((id, i) => [id, i]));

/** Every list in the sidebar, each in its order. */
export function sidebarLists(conversations: Conversation[], bots: Bot[], sections: string[], order: readonly string[]): SidebarLists {
  const rank = rankOf(order);
  // A retired bot's chat is under Retired and nowhere else, pinned, filed or hidden as it may be: it's back where it was when it's rehired.
  const away = new Set(bots.filter((b) => b.retiredAt).map((b) => b.id));
  const isRetired = (c: Conversation) => c.kind === "direct" && away.has(c.botIds[0]!);
  const current = conversations.filter((c) => !isRetired(c));
  const shown = current.filter((c) => !c.hidden);
  const listed = shown.filter((c) => !c.pinnedAt && c.kind !== "side");
  const rows = (list: Conversation[]) => sortList(list, rank, "first", byRecent);
  return {
    pinned: sortList(shown.filter((c) => c.pinnedAt), rank, "last", byPinned),
    // Chats shared with friends get a section of their own, unless the user filed one elsewhere.
    shared: rows(listed.filter((c) => c.friend && (!c.section || !sections.includes(c.section)))),
    rest: rows(listed.filter((c) => !c.friend && (!c.section || !sections.includes(c.section)))),
    filed: sections.map((name) => [name, rows(listed.filter((c) => c.section === name))] as const),
    side: shown.filter((c) => !c.pinnedAt && c.kind === "side").sort(byRecent),
    hidden: current.filter((c) => c.hidden).sort(byRecent),
    retired: conversations.filter(isRetired).sort(byRecent),
  };
}

/** The lists a chat can be dragged in and out of, by key, each in its order. */
export function movableLists(lists: SidebarLists): Map<ListKey, Conversation[]> {
  return new Map<ListKey, Conversation[]>([
    ["pinned", lists.pinned],
    ["rest", lists.rest],
    ...lists.filed.map(([name, list]) => [`section:${name}` as ListKey, list] as const),
    ["friends", lists.shared],
  ]);
}

/** Whether `c` can be in `list`: a side chat only pinned, a friend's chat not loose among the rows, and one of the user's own not with the friends'. */
export function accepts(list: ListKey, c: Conversation): boolean {
  if (list === "pinned") return true;
  if (c.kind === "side") return false;
  if (list === "friends") return !!c.friend;
  if (list === "rest") return !c.friend;
  return true;
}

/** What changes about `c` to put it in `list`. */
function joining(list: ListKey, c: Conversation): Arrangement["patches"][number][1] {
  if (list === "pinned") return c.pinnedAt ? {} : { pinnedAt: Date.now() };
  const section = list.startsWith("section:") ? list.slice("section:".length) : undefined;
  return { ...(c.pinnedAt ? { pinnedAt: undefined } : {}), ...(c.section !== section ? { section } : {}) };
}

const listOf = (lists: Map<ListKey, Conversation[]>, id: string) => [...lists].find(([, list]) => list.some((c) => c.id === id))?.[0];

/**
 * What dropping `dragId` on `target` changes: its place (and the target's, for a swap), the list it's
 * in, and the order to save. Undefined when it can't go there or nothing would change.
 */
export function planMove(lists: Map<ListKey, Conversation[]>, order: readonly string[], dragId: string, target: Target): Arrangement | undefined {
  const from = listOf(lists, dragId);
  if (!from) return;
  const drag = lists.get(from)!.find((c) => c.id === dragId)!;
  const ids = (key: ListKey) => lists.get(key)!.map((c) => c.id);
  const changed = new Map<ListKey, string[]>();
  const patches: Arrangement["patches"] = [];
  if ("list" in target) {
    // Onto a section's heading: first in it.
    if (!lists.has(target.list) || !accepts(target.list, drag)) return;
    if (target.list === from && ids(from)[0] === dragId) return;
    if (target.list !== from) changed.set(from, ids(from).filter((id) => id !== dragId));
    changed.set(target.list, [dragId, ...ids(target.list).filter((id) => id !== dragId)]);
    if (target.list !== from) patches.push([dragId, joining(target.list, drag)]);
  } else {
    if (target.id === dragId) return;
    const to = listOf(lists, target.id);
    if (!to) return;
    const other = lists.get(to)!.find((c) => c.id === target.id)!;
    if (target.place === "swap") {
      if (!accepts(to, drag) || !accepts(from, other)) return;
      if (from === to) {
        changed.set(from, ids(from).map((id) => (id === dragId ? target.id : id === target.id ? dragId : id)));
      } else {
        changed.set(from, ids(from).map((id) => (id === dragId ? target.id : id)));
        changed.set(to, ids(to).map((id) => (id === target.id ? dragId : id)));
        patches.push([dragId, joining(to, drag)], [target.id, joining(from, other)]);
      }
    } else {
      if (!accepts(to, drag)) return;
      const before = ids(to);
      const next = before.filter((id) => id !== dragId);
      next.splice(next.indexOf(target.id) + (target.place === "after" ? 1 : 0), 0, dragId);
      if (from === to && next.join() === before.join()) return;
      if (from !== to) {
        changed.set(from, ids(from).filter((id) => id !== dragId));
        patches.push([dragId, joining(to, drag)]);
      }
      changed.set(to, next);
    }
  }
  const touched = new Set([...changed.values()].flat());
  return { order: [...[...changed.values()].flat(), ...order.filter((id) => !touched.has(id))], patches: patches.filter(([, p]) => Object.keys(p).length > 0) };
}

/** Moving `id` one place up (-1) or down (1) in its own list, from the keyboard or its menu. */
export function planStep(lists: Map<ListKey, Conversation[]>, order: readonly string[], id: string, step: -1 | 1): Arrangement | undefined {
  const from = listOf(lists, id);
  if (!from) return;
  const list = lists.get(from)!;
  const neighbour = list[list.findIndex((c) => c.id === id) + step];
  return neighbour && planMove(lists, order, id, { id: neighbour.id, place: step < 0 ? "before" : "after" });
}

/** Whether `bot`'s own chat dropped on `group` could add the bot to it. */
export function canJoin(drag: Conversation | undefined, group: Conversation | undefined, bots: Bot[]): boolean {
  if (drag?.kind !== "direct" || group?.kind !== "group" || group.friend?.ended) return false;
  const botId = drag.botIds[0]!;
  return !group.botIds.includes(botId) && !bots.find((b) => b.id === botId)?.retiredAt;
}
