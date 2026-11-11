import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

// Its own process, so the test never opens the user's real database.
test("chat versions change with content and match what PUT reports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-chat-index-"));
  const script = `
    import { strict as assert } from "node:assert";
    import { mkdirSync } from "node:fs";
    import { join } from "node:path";
    import { Database } from "bun:sqlite";
    // A database from before the stored version column: opening it must migrate and backfill.
    mkdirSync(process.env.OPENCHAT_DATA_DIR, { recursive: true, mode: 0o700 });
    const legacy = new Database(join(process.env.OPENCHAT_DATA_DIR, "openchat.db"), { create: true });
    legacy.run("CREATE TABLE chats (id TEXT PRIMARY KEY, data TEXT, updated_at INTEGER NOT NULL, deleted_at INTEGER)");
    legacy.run("INSERT INTO chats (id, data, updated_at) VALUES (?1, ?2, ?3)", ["legacy", JSON.stringify({ id: "legacy", updatedAt: 0, messages: [] }), 0]);
    legacy.close();
    const storage = await import("./server/storage.ts");
    assert.equal(storage.chatIndex().find((e) => e.id === "legacy").v, storage.versionOf(JSON.stringify({ id: "legacy", updatedAt: 0, messages: [] })));
    const a = { id: "a", updatedAt: 1, createdAt: 1, messages: [] };
    const v1 = storage.putChat(a);
    storage.putChat({ id: "b", updatedAt: 2, createdAt: 2, messages: [] });
    assert.deepEqual(storage.chatIndex().map((e) => e.id), ["b", "a", "legacy"]);
    assert.equal(storage.chatIndex()[1].v, v1);
    const v2 = storage.putChat({ ...a, pinned: true });
    assert.notEqual(v2, v1);
    const [row] = storage.chatsById(["a", "missing"]);
    assert.equal(row.v, v2);
    assert.equal(JSON.parse(row.data).pinned, true);
    const huge = { id: "large", updatedAt: 3, messages: [{ id: "m", role: "assistant", content: "x".repeat(5000000), createdAt: 1, status: "done" }] };
    storage.putChat(huge);
    const summaries = await storage.chatSummaries(["large"]);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].chat.historyDeferred, true);
    assert.ok(JSON.stringify(summaries).length < 1000);
    assert.throws(() => storage.putChat(summaries[0].chat), /deferred/);
    assert.equal(storage.getChat("large").messages[0].content.length, 5000000);
    storage.deleteChat("large");
    storage.deleteChat("b");
    assert.equal(storage.putChat({ id: "b", updatedAt: 3, createdAt: 3, messages: [] }), false);
    assert.deepEqual(storage.chatIndex().map((e) => e.id), ["a", "legacy"]);
    assert.deepEqual(storage.chatsById(["b"]), []);
    process.exit(0);
  `;
  try {
    const { code, stderr: err } = await spawnScript(script, { OPENCHAT_DATA_DIR: join(dir, "data") });
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The listing must never read chat rows: their listing columns sit after the transcript, so each
// read walks the transcript's pages (hundreds of ms on a long-used install, every poll).
test("the thread listing reads an index, and Durable threads are found without parsing transcripts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-chat-listing-"));
  const script = `
    import { strict as assert } from "node:assert";
    import { join } from "node:path";
    import { Database } from "bun:sqlite";
    const storage = await import("./server/storage.ts");
    storage.putChat({ id: "pi", updatedAt: 1, createdAt: 1, messages: [] });
    storage.putChat({ id: "durable", runtime: "durable", updatedAt: 2, createdAt: 2, messages: [] });
    storage.putChat({ id: "gone", runtime: "durable", updatedAt: 3, createdAt: 3, messages: [] });
    storage.deleteChat("gone");
    // A Durable chat from before summaries were kept: found from its own data.
    storage.putChat({ id: "old", runtime: "durable", updatedAt: 4, createdAt: 4, messages: [] });
    const db = new Database(join(process.env.OPENCHAT_DATA_DIR, "openchat.db"));
    db.run("DELETE FROM chat_summaries WHERE id = 'old'");
    // A summary left behind by an older version of a chat doesn't count.
    storage.putChat({ id: "was-durable", runtime: "durable", updatedAt: 5, createdAt: 5, messages: [] });
    db.run("UPDATE chats SET data = ?1, version = 'changed' WHERE id = 'was-durable'", [JSON.stringify({ id: "was-durable", updatedAt: 5, createdAt: 5, messages: [] })]);
    assert.deepEqual(storage.durableChatIndex().map((e) => e.id).sort(), ["durable", "old"]);
    const plan = (sql) => db.query("EXPLAIN QUERY PLAN " + sql).all().map((r) => r.detail).join("; ");
    assert.match(plan("SELECT id, version FROM chats WHERE deleted_at IS NULL ORDER BY updated_at DESC"), /COVERING INDEX chats_listing/);
    const rows = await storage.chatSummaryRows(["pi", "durable"]);
    assert.deepEqual(rows.map((r) => JSON.parse(r.data).id), ["durable", "pi"]);
    assert.equal(rows[0].v, storage.chatIndex().find((e) => e.id === "durable").v);
    process.exit(0);
  `;
  try {
    const { code, stderr: err } = await spawnScript(script, { OPENCHAT_DATA_DIR: join(dir, "data") });
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
