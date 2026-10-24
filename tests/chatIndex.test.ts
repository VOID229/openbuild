import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    storage.deleteChat("b");
    assert.equal(storage.putChat({ id: "b", updatedAt: 3, createdAt: 3, messages: [] }), false);
    assert.deepEqual(storage.chatIndex().map((e) => e.id), ["a", "legacy"]);
    assert.deepEqual(storage.chatsById(["b"]), []);
    process.exit(0);
  `;
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, OPENCHAT_DATA_DIR: join(dir, "data") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
