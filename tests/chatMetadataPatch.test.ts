import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chatSummary } from "../shared/chatSummary";
import type { Chat } from "../src/lib/types";

// A thread's sidebar edits while the browser has only its summary (marked read, pinned, closed):
// the metadata alone, merged by the server into the history it has.

test("the server merges a thread's metadata into its stored history and answers with the summary", async () => {
  const data = mkdtempSync(join(tmpdir(), "ob-chat-patch-"));
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const base = `http://127.0.0.1:${probe.port}`;
  probe.stop(true);
  const server = Bun.spawn([process.execPath, resolve("server/index.ts")], {
    env: { ...process.env, NODE_ENV: "test", PORT: base.split(":").pop()!, HOST: "127.0.0.1", OPENCHAT_DATA_DIR: data },
    stdout: "ignore", stderr: "pipe",
  });
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    let up = false;
    for (let i = 0; i < 600 && !up; i++) {
      try { up = (await call("/api/auth/status")).ok; } catch {}
      if (!up) await Bun.sleep(25);
    }
    expect(up).toBe(true);
    const chat = {
      id: "t", title: "Thread", createdAt: 1, updatedAt: 2, runtime: "pi", unread: true,
      messages: [{ id: "u", role: "user", content: "keep this history", createdAt: 1 }, { id: "a", role: "assistant", content: "x".repeat(200_000), createdAt: 2, status: "done" }],
    };
    expect((await call("/api/chats/t", "PUT", chat)).status).toBe(200);

    const res = await call("/api/chats/t", "PATCH", { ...chatSummary(chat as Chat), messages: undefined, id: "t", unread: false, pinned: true, title: "Renamed" });
    // `messages: undefined` drops out of the JSON; anything else is the summary's metadata.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chat.historyDeferred).toBe(true);
    expect(JSON.stringify(body).length).toBeLessThan(5_000);
    const [row] = (await (await call("/api/chats/fetch", "POST", { ids: ["t"] })).json()).chats;
    expect(row.v).toBe(body.v);
    expect(row.chat).toMatchObject({ unread: false, pinned: true, title: "Renamed", updatedAt: 2 });
    expect(row.chat.historyDeferred).toBeUndefined();
    expect(row.chat.messages.map((m: { content: string }) => m.content.length)).toEqual(["keep this history".length, 200_000]);

    // Never messages, never another thread's id, never a runtime change.
    expect((await call("/api/chats/t", "PATCH", { id: "t", messages: [] })).status).toBe(400);
    expect((await call("/api/chats/t", "PATCH", { id: "other", pinned: false })).status).toBe(400);
    expect((await call("/api/chats/t", "PATCH", { id: "t", runtime: "codex" })).status).toBe(400);
    expect((await call("/api/chats/missing", "PATCH", { id: "missing", pinned: true })).status).toBe(404);
    // Deleted (a tombstone, as storage.deleteChat leaves; DELETE itself also asks a Pi worker,
    // which a machine without Pi doesn't have): it stays deleted.
    const db = new Database(join(data, "openchat.db"));
    db.run("UPDATE chats SET data = NULL, version = NULL, deleted_at = ?1 WHERE id = 't'", [Date.now()]);
    db.close();
    expect((await call("/api/chats/t", "PATCH", { id: "t", pinned: true })).status).toBe(410);
  } finally {
    server.kill();
    await server.exited;
    rmSync(data, { recursive: true, force: true });
  }
}, 30_000);

test("a server from before PATCH still gets the whole history, as it used to", async () => {
  const listeners = () => {};
  Object.assign(globalThis, { window: { addEventListener: listeners }, document: { addEventListener: listeners }, localStorage: { getItem: () => null, setItem: listeners, removeItem: listeners } });
  const full: Chat = { id: "old", title: "Old", createdAt: 1, updatedAt: 1, messages: [{ id: "m", role: "user", content: "all of it", createdAt: 1 }] };
  const calls: string[] = [];
  let put: Chat | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/config") return Response.json({ mode: "local", convexUrl: null });
    if (url === "/api/chats/fetch") return Response.json({ chats: [{ v: "v1", chat: full }] });
    if (init?.method === "PATCH") return Response.json({ error: "Not found" }, { status: 404 });
    if (init?.method === "PUT") { put = JSON.parse(String(init.body)); return Response.json({ ok: true, v: "v2", chat: put }); }
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
  const { saveChat } = await import("../src/lib/db");
  await saveChat({ ...chatSummary(full), unread: false });
  for (let n = 0; n < 100 && !put; n++) await Bun.sleep(5);
  expect(calls).toEqual(["GET /api/config", "PATCH /api/chats/old", "POST /api/chats/fetch", "PUT /api/chats/old"]);
  expect(put).toMatchObject({ unread: false, messages: [{ content: "all of it" }] });
});
