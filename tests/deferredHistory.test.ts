import { expect, test } from "bun:test";
import "fake-indexeddb/auto";
import { chatSummary } from "../shared/chatSummary";
import type { Chat } from "../src/lib/types";

const listeners = () => {};
Object.assign(globalThis, { window: { addEventListener: listeners }, document: { addEventListener: listeners }, localStorage: { getItem: () => null, setItem: listeners, removeItem: listeners } });
let version = "v1";
let full: Chat = { id: "a", title: "History", createdAt: 1, updatedAt: 1, messages: [{ id: "m", role: "user", content: "preserve me", createdAt: 1 }] };
const calls: string[] = [];
let written: Chat | undefined;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push(`${init?.method ?? "GET"} ${url}`);
  if (url === "/api/config") return Response.json({ mode: "local", convexUrl: null });
  if (url.startsWith("/api/chats?summaries")) return Response.json({ summaryIndex: [{ id: "a", v: version }] });
  if (url === "/api/chats/summaries") return Response.json({ summaries: [{ v: version, chat: chatSummary(full) }] });
  if (url === "/api/chats/fetch") {
    const id = JSON.parse(String(init?.body)).ids[0];
    return Response.json({ chats: [{ v: version, chat: { ...full, id } }] });
  }
  if (url === "/api/chats/a" && init?.method === "PUT") {
    written = JSON.parse(String(init.body));
    full = written!;
    version = "v2";
    return Response.json({ ok: true, v: version, chat: full });
  }
  throw new Error(`Unexpected request ${url}`);
}) as typeof fetch;
const { loadChats, loadChatHistory, saveChat } = await import("../src/lib/db");

test("startup and unchanged polls avoid full transcripts; metadata saves and opened threads retain history", async () => {
  const [summary] = await loadChats();
  expect(summary?.historyDeferred).toBe(true);
  expect(calls.some(c => c.includes("/api/chats/fetch"))).toBe(false);
  const count = calls.length;
  await loadChats();
  expect(calls.slice(count)).toEqual(["GET /api/chats?summaries"]);
  await saveChat({ ...summary!, pinned: true });
  // The durable outbox sends in the background.
  for (let n = 0; n < 100 && !written; n++) await Bun.sleep(5);
  expect(written?.messages[0]?.content).toBe("preserve me");
  expect(written?.pinned).toBe(true);
  expect(written?.historyDeferred).toBeUndefined();
  const [next] = await loadChats();
  expect(next?.historyDeferred).toBe(true);
  const opened = await loadChatHistory(next!, true);
  expect(opened.messages[0]?.content).toBe("preserve me");
  expect(opened.historyDeferred).toBeUndefined();
  const [poll] = await loadChats();
  expect(poll?.historyDeferred).toBeUndefined();
  expect(poll?.messages[0]?.content).toBe("preserve me");
});

test("visiting many threads evicts older full histories rather than retaining the archive", async () => {
  for (let i = 0; i < 9; i++) await loadChatHistory(chatSummary({ ...full, id: `visited-${i}` }), true);
  const [older] = await loadChats();
  expect(older?.id).toBe("a");
  expect(older?.historyDeferred).toBe(true);
  expect(older?.messages[0]?.content).toBe("");
});
