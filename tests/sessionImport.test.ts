import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each step runs in its own process (a server restart in between), against throwaway data and
// native session folders, so tests never read the user's real database or transcripts.
async function run(dir: string, script: string) {
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      OPENCHAT_DATA_DIR: join(dir, "data"),
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      CURSOR_CONFIG_DIR: join(dir, "cursor"),
      CODEX_BIN: join(dir, "no-codex"),
      OPENCODE_BIN: join(dir, "no-opencode"),
      OPENCODE_SERVER_URL: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, output: out + err }).toEqual({ code: 0, output: "" });
}

const claudeFixture = `
  import { mkdir, writeFile } from "node:fs/promises";
  import { join } from "node:path";
  const cwd = process.env.OPENCHAT_DATA_DIR + "-work";
  await mkdir(cwd, { recursive: true });
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(dir, { recursive: true });
  const at = (s) => "2026-01-01T00:00:0" + s + "Z";
  const rec = (uuid, parentUuid, type, content, extra = {}) => ({ type, uuid, parentUuid, sessionId: "x", timestamp: at(uuid.length % 10), isSidechain: false, cwd, entrypoint: "cli", message: { role: type, content, ...(type === "assistant" ? { model: "claude-test-1" } : {}) }, ...extra });
  const jsonl = (rs) => rs.map((r) => JSON.stringify(r)).join("\\n") + "\\n";
  const native = "11111111-1111-4111-8111-111111111111";
  await writeFile(join(dir, native + ".jsonl"), jsonl([
    rec("u1", null, "user", "Fix the build"),
    rec("a1", "u1", "assistant", [{ type: "thinking", thinking: "Look first" }, { type: "text", text: "Checking." }]),
    rec("a2", "a1", "assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } }]),
    rec("r1", "a2", "user", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }], { toolUseResult: { stdout: "built", stderr: "" } }),
    rec("a3", "r1", "assistant", [{ type: "text", text: "Fixed." }]),
    rec("c1", "a3", "user", "<command-name>/model</command-name>"),
    rec("u2", "c1", "user", "Thanks"),
    rec("a4", "u2", "assistant", [{ type: "text", text: "Any time." }]),
    { type: "ai-title", aiTitle: "Build fix", sessionId: native },
  ]));
  // Driven through the Agent SDK (OpenBuild's own threads look like this): not offered.
  await writeFile(join(dir, "22222222-2222-4222-8222-222222222222.jsonl"), jsonl([{ ...rec("s1", null, "user", "SDK prompt"), entrypoint: "sdk-ts" }, rec("s2", "s1", "assistant", [{ type: "text", text: "hi" }])]));
  // Already an OpenBuild thread's session: not offered.
  const owned = "33333333-3333-4333-8333-333333333333";
  await writeFile(join(dir, owned + ".jsonl"), jsonl([rec("o1", null, "user", "Mine"), rec("o2", "o1", "assistant", [{ type: "text", text: "yes" }])]));
  const storage = await import("./server/storage.ts");
  storage.setValue("claude-session:existing-thread", JSON.stringify({ id: owned, cwd, turns: 1, anchors: [null] }));
`;

test("imports Claude Code sessions once, ready to continue, and never offers again after a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-session-import-"));
  await run(dir, `${claudeFixture}
    import { strict as assert } from "node:assert";
    const mod = await import("./server/sessionImport.ts");
    const { allowedCwd } = await import("./server/projects.ts");
    const { threadRuntime } = await import("./server/threadRuntime.ts");
    assert.deepEqual(await mod.offer(), { pending: true, runtimes: { claude: 1 } });
    assert.deepEqual(await mod.answer(["claude"]), { imported: { claude: 1 }, errors: {} });
    const chats = storage.listChats().filter((c) => c.runtime === "claude");
    assert.equal(chats.length, 1);
    const chat = chats[0];
    assert.equal(chat.title, "Build fix");
    assert.equal(chat.workspace.cwd, cwd);
    assert.deepEqual(chat.messages.map((m) => [m.role, m.content]), [["user", "Fix the build"], ["assistant", "Checking.\\n\\nFixed."], ["user", "Thanks"], ["assistant", "Any time."]]);
    const parts = chat.messages[1].parts;
    assert.deepEqual(parts.map((p) => p.type), ["thought", "text", "tool", "text"]);
    assert.equal(parts[2].name, "bash");
    assert.equal(parts[2].status, "done");
    assert.equal(parts[2].output, "built");
    assert.equal(chat.messages[1].model.plan, "claude");
    // The mapping Claude Code's adapter resumes from: both prompts given, rewind anchors per prompt.
    assert.deepEqual(JSON.parse(storage.getValue("claude-session:" + chat.id)), { id: native, cwd, turns: 2, anchors: ["a3", "a4"] });
    assert.equal(threadRuntime(chat.id), "claude");
    assert.equal(allowedCwd(cwd), true);
    // Answered: no second offer, and a second answer imports nothing.
    assert.deepEqual(await mod.offer(), { pending: false, runtimes: {} });
    assert.deepEqual(await mod.answer(["claude"]), { imported: {}, errors: {} });
  `);
  // After a restart, with a brand-new native session on disk, it still isn't offered.
  await run(dir, `
    import { strict as assert } from "node:assert";
    import { writeFile, readdir } from "node:fs/promises";
    import { join } from "node:path";
    const root = join(process.env.CLAUDE_CONFIG_DIR, "projects");
    const [folder] = await readdir(root);
    await writeFile(join(root, folder, "44444444-4444-4444-8444-444444444444.jsonl"), JSON.stringify({ type: "user", uuid: "n1", parentUuid: null, cwd: "/tmp", entrypoint: "cli", message: { role: "user", content: "New" } }) + "\\n");
    const mod = await import("./server/sessionImport.ts");
    assert.deepEqual(await mod.offer(), { pending: false, runtimes: {} });
  `);
});

test("counts only sessions with a prompt, and keeps the history before a compaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-session-import-"));
  await run(dir, `
    import { strict as assert } from "node:assert";
    import { mkdir, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const cwd = process.env.OPENCHAT_DATA_DIR + "-work";
    await mkdir(cwd, { recursive: true });
    const projects = join(process.env.CLAUDE_CONFIG_DIR, "projects", "work");
    await mkdir(projects, { recursive: true });
    const base = { timestamp: "2026-01-01T00:00:00Z", isSidechain: false, cwd, entrypoint: "cli" };
    const user = (uuid, parentUuid, content, extra = {}) => ({ ...base, type: "user", uuid, parentUuid, message: { role: "user", content }, ...extra });
    const reply = (uuid, parentUuid, text) => ({ ...base, type: "assistant", uuid, parentUuid, message: { role: "assistant", model: "claude-test-1", content: [{ type: "text", text }] } });
    const session = (n, rs) => writeFile(join(projects, n.repeat(8) + "-1111-4111-8111-111111111111.jsonl"), rs.map((r) => JSON.stringify(r)).join("\\n") + "\\n");
    await session("1", [{ type: "file-history-snapshot", messageId: "m", snapshot: {} }]);
    await session("2", [{ type: "summary", summary: "Old", leafUuid: "gone" }]);
    await session("3", [user("c1", null, "<command-name>/clear</command-name>")]);
    const boundary = { ...base, type: "system", subtype: "compact_boundary", uuid: "b", parentUuid: null, logicalParentUuid: "a1" };
    await session("4", [user("u1", null, "Before"), reply("a1", "u1", "Earlier"), boundary, user("s", "b", "Summary", { isCompactSummary: true }), reply("a2", "s", "Continuing")]);
    const mod = await import("./server/sessionImport.ts");
    const storage = await import("./server/storage.ts");
    assert.deepEqual(await mod.offer(), { pending: true, runtimes: { claude: 1 } });
    assert.deepEqual(await mod.answer(["claude"]), { imported: { claude: 1 }, errors: {} });
    const [chat] = storage.listChats();
    assert.deepEqual(chat.messages.map((m) => [m.role, m.content]), [["user", "Before"], ["assistant", "Earlier\\n\\nContinuing"]]);
  `);
}, 30_000);

test("skipping is an answer too: nothing is imported and the offer never comes back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-session-import-skip-"));
  await run(dir, `${claudeFixture}
    import { strict as assert } from "node:assert";
    const mod = await import("./server/sessionImport.ts");
    assert.equal((await mod.offer()).pending, true);
    assert.deepEqual(await mod.answer([]), { imported: {}, errors: {} });
    assert.equal(storage.listChats().length, 0);
  `);
  await run(dir, `
    import { strict as assert } from "node:assert";
    const mod = await import("./server/sessionImport.ts");
    assert.deepEqual(await mod.offer(), { pending: false, runtimes: {} });
  `);
});

test("reads Cursor's content-addressed chat store in order and maps it for resuming", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-session-import-cursor-"));
  await run(dir, `
    import { strict as assert } from "node:assert";
    import { createHash } from "node:crypto";
    import { mkdir, writeFile, realpath } from "node:fs/promises";
    import { join } from "node:path";
    import { Database } from "bun:sqlite";
    const cwd = await realpath(await mkdir(process.env.OPENCHAT_DATA_DIR + "-work", { recursive: true }).then(() => process.env.OPENCHAT_DATA_DIR + "-work"));
    const id = "55555555-5555-4555-8555-555555555555";
    const chatDir = join(process.env.CURSOR_CONFIG_DIR, "chats", createHash("md5").update(cwd).digest("hex"), id);
    await mkdir(chatDir, { recursive: true });
    await writeFile(join(chatDir, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: 1000, updatedAtMs: 2000, hasConversation: true, title: "Cursor chat", cwd }));
    const db = new Database(join(chatDir, "store.db"));
    db.run("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
    db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    const put = (value) => { const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)); const hash = createHash("sha256").update(data).digest(); db.query("INSERT INTO blobs VALUES (?, ?)").run(hash.toString("hex"), data); return hash; };
    const refs = [
      { role: "system", content: "You are Cursor" },
      { role: "user", content: "<user_info>context</user_info>" },
      { role: "user", content: [{ type: "text", text: "<timestamp>now</timestamp>\\n<user_query>\\nList files\\n</user_query>" }] },
      { role: "assistant", content: [{ type: "text", text: "Listing." }, { type: "tool-call", toolCallId: "c1", toolName: "Shell", args: { command: "ls" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "Shell", result: "a\\nb" }] },
      { role: "assistant", content: [{ type: "text", text: "Two files." }] },
    ].map(put);
    // The root lists messages as protobuf field 1 (32-byte hashes); other fields are ignored.
    const root = Buffer.concat([...refs.map((h) => Buffer.concat([Buffer.from([0x0a, 32]), h])), Buffer.from([0x28, 0x05])]);
    const rootHash = put(root);
    db.query("INSERT INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify({ latestRootBlobId: rootHash.toString("hex"), createdAt: 1000 })).toString("hex"));
    db.close();
    const storage = await import("./server/storage.ts");
    const mod = await import("./server/sessionImport.ts");
    assert.deepEqual(await mod.offer(), { pending: true, runtimes: { cursor: 1 } });
    assert.deepEqual(await mod.answer(["cursor"]), { imported: { cursor: 1 }, errors: {} });
    const [chat] = storage.listChats();
    assert.equal(chat.title, "Cursor chat");
    assert.deepEqual(chat.messages.map((m) => [m.role, m.content]), [["user", "List files"], ["assistant", "Listing.\\n\\nTwo files."]]);
    const tool = chat.messages[1].parts.find((p) => p.type === "tool");
    assert.deepEqual([tool.name, tool.status, tool.output], ["bash", "done", "a\\nb"]);
    const mapping = JSON.parse(storage.getValue("cursor-session:" + chat.id));
    assert.deepEqual({ ...mapping, fingerprint: typeof mapping.fingerprint }, { id, cwd, turns: 1, pending: false, fingerprint: "string" });
  `);
});

test("projects a Codex thread's turns, counting native turns separately from prompts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-session-import-codex-"));
  await run(dir, `
    import { strict as assert } from "node:assert";
    const { projectCodex } = await import("./server/sessionImport.ts");
    const cwd = "/work";
    const projected = projectCodex({
      id: "codex-thread", cwd, name: "Codex task", model: "gpt-test", createdAt: 1700000000, updatedAt: 1700000100,
      turns: [
        { id: "t1", status: "completed", items: [
          { type: "userMessage", id: "u1", content: [{ type: "text", text: "# Files mentioned by the user:\\n\\n## a.png: /a.png\\n## My request for Codex:\\nFix it" }] },
          { type: "agentMessage", id: "m1", text: "On it." },
          { type: "commandExecution", id: "x1", command: "make", cwd, status: "completed", aggregatedOutput: "done", commandActions: [] },
          { type: "agentMessage", id: "m2", text: "Fixed." },
        ] },
        // A turn Codex ran on its own (no prompt), e.g. compacting: part of the previous reply.
        { id: "t2", status: "completed", items: [{ type: "agentMessage", id: "m3", text: "Compacted." }] },
        { id: "t3", status: "interrupted", items: [{ type: "userMessage", id: "u2", content: [{ type: "text", text: "Stop" }] }] },
      ],
    });
    assert.deepEqual(projected.chat.messages.map((m) => [m.role, m.content, m.status]), [["user", "Fix it", undefined], ["assistant", "On it.\\n\\nFixed.\\n\\nCompacted.", "done"], ["user", "Stop", undefined], ["assistant", "", "stopped"]]);
    assert.equal(projected.chat.messages[1].parts.find((p) => p.type === "tool").name, "bash");
    assert.deepEqual(projected.mapping, { id: "codex-thread", cwd, turns: 2, nativeTurns: 3 });
    assert.equal(projected.chat.createdAt, 1700000000000);
  `);
});
