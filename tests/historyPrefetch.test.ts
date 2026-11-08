import { expect, test } from "bun:test";
import "fake-indexeddb/auto";
import { chatSummary } from "../shared/chatSummary";
import type { Chat } from "../src/lib/types";

// A thread's history fetched ahead of the click (its row was pointed at): opened from that, never
// from an older copy than the thread list says it is, and never fetched twice.
const listeners = () => {};
Object.assign(globalThis, { window: { addEventListener: listeners }, document: { addEventListener: listeners }, localStorage: { getItem: () => null, setItem: listeners, removeItem: listeners } });
const threads = new Map<string, { v: string; chat: Chat }>();
const put = (id: string, v: string, text: string) => threads.set(id, { v, chat: { id, title: id, createdAt: 1, updatedAt: 1, messages: [{ id: `${id}-m`, role: "user", content: text, createdAt: 1 }] } });
put("a", "a1", "first");
put("b", "b1", "before");
const fetches: string[] = [];
let hold: Promise<void> | undefined;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === "/api/config") return Response.json({ mode: "local", convexUrl: null });
  if (url.startsWith("/api/chats?summaries")) return Response.json({ summaryIndex: [...threads].map(([id, t]) => ({ id, v: t.v })) });
  if (url === "/api/chats/summaries") {
    const ids: string[] = JSON.parse(String(init?.body)).ids;
    return Response.json({ summaries: ids.map((id) => ({ v: threads.get(id)!.v, chat: chatSummary(threads.get(id)!.chat) })) });
  }
  if (url === "/api/chats/fetch") {
    const id = JSON.parse(String(init?.body)).ids[0];
    fetches.push(id);
    // The answer is what the server had when asked, however late it arrives.
    const t = threads.get(id)!;
    await hold;
    return Response.json({ chats: [{ v: t.v, chat: t.chat }] });
  }
  throw new Error(`Unexpected request ${url}`);
}) as typeof fetch;
const { historyAtHand, loadChats, loadChatHistory, prefetchHistory } = await import("../src/lib/db");
const until = async (ok: () => boolean) => { for (let n = 0; n < 200 && !ok(); n++) await Bun.sleep(5); expect(ok()).toBe(true); };
const byId = (chats: Chat[], id: string) => chats.find((c) => c.id === id)!;

test("a prefetched history opens without asking again, and stays like any opened thread", async () => {
  const a = byId(await loadChats(), "a");
  expect(a.historyDeferred).toBe(true);
  expect(historyAtHand(a)).toBeUndefined();
  prefetchHistory(a);
  prefetchHistory(a);
  await until(() => fetches.length === 1);
  await Bun.sleep(10);
  const opened = historyAtHand(a)!;
  expect(opened.historyDeferred).toBeUndefined();
  expect(opened.messages[0]!.content).toBe("first");
  expect(await loadChatHistory(a, true)).toMatchObject({ messages: [{ content: "first" }] });
  // Opened for good: the next poll keeps its history instead of fetching it again.
  const poll = byId(await loadChats(), "a");
  expect(poll.historyDeferred).toBeUndefined();
  expect(fetches).toEqual(["a"]);
});

test("rebuilding a history to save it always asks the server, never a prefetched copy", async () => {
  put("d", "d1", "on the server");
  const d = byId(await loadChats(), "d");
  prefetchHistory(d);
  await until(() => fetches.includes("d"));
  await Bun.sleep(10);
  // An agent writes to the thread on the server before the list next looks.
  put("d", "d1", "newer on the server");
  expect((await loadChatHistory({ ...d, pinned: true })).messages[0]!.content).toBe("newer on the server");
  expect(fetches.filter((id) => id === "d")).toEqual(["d", "d"]);
});

test("a prefetch of a thread that changed since isn't used", async () => {
  const b = byId(await loadChats(), "b");
  prefetchHistory(b);
  await until(() => fetches.includes("b"));
  await Bun.sleep(10);
  // A reply lands before the click: the list now says it's newer than what was prefetched.
  put("b", "b2", "after");
  const newer = byId(await loadChats(), "b");
  expect(historyAtHand(newer)).toBeUndefined();
  expect((await loadChatHistory(newer, true)).messages[0]!.content).toBe("after");
});

test("opening a thread whose prefetch is still on its way waits for it rather than asking twice", async () => {
  put("c", "c1", "slow");
  const c = byId(await loadChats(), "c");
  let release!: () => void;
  hold = new Promise((r) => (release = r));
  prefetchHistory(c);
  await until(() => fetches.includes("c"));
  const opening = loadChatHistory(c, true);
  release();
  expect((await opening).messages[0]!.content).toBe("slow");
  expect(fetches.filter((id) => id === "c")).toEqual(["c"]);
  hold = undefined;
});

test("a prefetch answered after a newer thread list is neither kept nor opened", async () => {
  put("e", "e1", "older");
  const e = byId(await loadChats(), "e");
  let release!: () => void;
  hold = new Promise((r) => (release = r));
  prefetchHistory(e);
  await until(() => fetches.includes("e"));
  // A reply lands, and the list says so, while the prefetch's answer (e1) is still on its way.
  put("e", "e2", "newer");
  hold = undefined;
  const newer = byId(await loadChats(), "e");
  release();
  await Bun.sleep(10);
  expect(historyAtHand(newer)).toBeUndefined();
  expect((await loadChatHistory(newer, true)).messages[0]!.content).toBe("newer");
  // The next poll still has e2: the late e1 didn't take its place.
  expect(byId(await loadChats(), "e").messages[0]!.content).toBe("newer");
});
