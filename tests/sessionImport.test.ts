import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each step runs in its own process (a server restart in between), against throwaway data and
// native session folders, so tests never read the user's real database or transcripts.
async function run(dir: string, script: string) {
  await mkdir(join(dir, "home"), { recursive: true });
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      OPENCHAT_DATA_DIR: join(dir, "data"),
      HOME: join(dir, "home"),
      XDG_DATA_HOME: join(dir, "xdg"),
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      CODEX_HOME: join(dir, "codex"),
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
  // Driven through the Agent SDK (OpenBuild's own threads look like this): not imported.
  await writeFile(join(dir, "22222222-2222-4222-8222-222222222222.jsonl"), jsonl([{ ...rec("s1", null, "user", "SDK prompt"), entrypoint: "sdk-ts" }, rec("s2", "s1", "assistant", [{ type: "text", text: "hi" }])]));
  // A thread OpenBuild just started, before its adapter mapped the session: not imported either.
  await writeFile(join(dir, "12121212-1212-4212-8212-121212121212.jsonl"), jsonl([{ ...rec("n1", null, "user", "Fresh OpenBuild prompt"), entrypoint: "openbuild" }]));
  // Already an OpenBuild thread's session: not imported.
  const owned = "33333333-3333-4333-8333-333333333333";
  await writeFile(join(dir, owned + ".jsonl"), jsonl([rec("o1", null, "user", "Mine"), rec("o2", "o1", "assistant", [{ type: "text", text: "yes" }])]));
  const storage = await import("./server/storage.ts");
  storage.setValue("claude-session:existing-thread", JSON.stringify({ id: owned, cwd, turns: 1, anchors: [null] }));
  const { createHash } = await import("node:crypto");
  const threadOf = (id) => "claude-" + createHash("sha256").update(id).digest("hex").slice(0, 32);
  // Claude Code's registry of running processes: one file per process, left behind when it exits.
  const registry = async (sessionId, status, pid = process.pid) => {
    await mkdir(join(process.env.CLAUDE_CONFIG_DIR, "sessions"), { recursive: true });
    await writeFile(join(process.env.CLAUDE_CONFIG_DIR, "sessions", pid + ".json"), JSON.stringify({ pid, sessionId, cwd, status, kind: "interactive" }));
  };
`;

test("discovers Claude Code sessions silently, ready to continue, with finished ones closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-session-import-"));
  await run(dir, `${claudeFixture}
    import { strict as assert } from "node:assert";
    const mod = await import("./server/sessionImport.ts");
    const { allowedCwd } = await import("./server/projects.ts");
    const { threadRuntime } = await import("./server/threadRuntime.ts");
    await mod.discover();
    const chats = storage.listChats();
    // The SDK-driven session and OpenBuild's own are left out.
    assert.equal(chats.length, 1);
    const chat = chats[0];
    assert.equal(chat.id, threadOf(native));
    assert.equal(chat.title, "Build fix");
    assert.equal(chat.archived, true);
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
    assert.equal(storage.listValues("claude-session:").length, 2);
  `);
});

test("the import dialog is gone: nothing asks, and discovery never runs inside test servers", async () => {
  const root = join(import.meta.dir, "..");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const server = await readFile(join(root, "server/index.ts"), "utf8");
  expect(app).not.toContain("SessionImport");
  expect(server).not.toContain("/api/session-import");
  expect(server).toContain("sessionImport.startDiscovery()");
  expect(await Bun.file(join(root, "src/components/SessionImport.tsx")).exists()).toBe(false);
  const dir = await mkdtemp(join(tmpdir(), "openbuild-session-import-test-env-"));
  await run(dir, `${claudeFixture}
    import { strict as assert } from "node:assert";
    process.env.NODE_ENV = "test";
    const mod = await import("./server/sessionImport.ts");
    mod.startDiscovery();
    await Bun.sleep(50);
    assert.equal(storage.listChats().length, 0);
  `);
});

test("classifies from live activity: a busy process shows working, stale registry files and idle ones don't", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-session-import-live-"));
  await run(dir, `${claudeFixture}
    import { strict as assert } from "node:assert";
    import { appendFile } from "node:fs/promises";
    const { EXTERNAL_VIA } = await import("./shared/replies.ts");
    const mod = await import("./server/sessionImport.ts");
    // Mid-turn on disk, and its process is busy on it.
    await appendFile(join(dir, native + ".jsonl"), jsonl([rec("u3", "a4", "user", "And the tests"), rec("a5", "u3", "assistant", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "make test" } }])]));
    await registry(native, "busy");
    // A process that exited long ago still says it was busy: it isn't running anything.
    const stale = "66666666-6666-4666-8666-666666666666";
    await writeFile(join(dir, stale + ".jsonl"), jsonl([rec("x1", null, "user", "Old work"), rec("x2", "x1", "assistant", [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "sleep 1" } }])]));
    await registry(stale, "busy", 2147483646);
    await mod.discover();
    const working = storage.getChat(threadOf(native));
    assert.equal(working.archived, false);
    const reply = working.messages.at(-1);
    assert.deepEqual([reply.role, reply.status, reply.stream.via], ["assistant", "streaming", EXTERNAL_VIA]);
    assert.equal(reply.parts.find((p) => p.type === "tool").status, "running");
    const old = storage.getChat(threadOf(stale));
    assert.equal(old.archived, true);
    assert.notEqual(old.messages.at(-1).status, "streaming");
    assert.equal(working.imported, true);
    // The turn ends: the thread stops working and is filed under Closed.
    await appendFile(join(dir, native + ".jsonl"), jsonl([rec("r2", "a5", "user", [{ type: "tool_result", tool_use_id: "t2", content: "ok" }]), rec("a6", "r2", "assistant", [{ type: "text", text: "Green." }])]));
    await registry(native, "idle");
    await mod.discover();
    const finished = storage.getChat(threadOf(native));
    assert.equal(finished.archived, true);
    assert.equal(finished.messages.at(-1).status, "done");
    assert.equal(finished.messages.at(-1).stream, undefined);
    assert.equal(finished.messages.at(-1).content, "Green.");
    // Back at work: it opens again by itself, as it was never touched by hand.
    await appendFile(join(dir, native + ".jsonl"), jsonl([rec("u4", "a6", "user", "Ship it")]));
    await registry(native, "busy");
    await mod.discover();
    assert.equal(storage.getChat(threadOf(native)).archived, false);
    assert.equal(storage.listChats().length, 2);
  `);
});

test("closing or reopening a discovered thread by hand sticks through later work and finishing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-session-import-user-"));
  await run(dir, `${claudeFixture}
    import { strict as assert } from "node:assert";
    import { appendFile } from "node:fs/promises";
    const mod = await import("./server/sessionImport.ts");
    const id = threadOf(native);
    const turn = async (u, a, parent, status) => {
      await appendFile(join(dir, native + ".jsonl"), jsonl([rec(u, parent, "user", "Prompt " + u), ...(status === "idle" ? [rec(a, u, "assistant", [{ type: "text", text: "Reply " + a }])] : [])]));
      await registry(native, status);
      await mod.discover();
      return storage.getChat(id);
    };
    await registry(native, "busy");
    await appendFile(join(dir, native + ".jsonl"), jsonl([rec("u3", "a4", "user", "Working")]));
    await mod.discover();
    assert.equal(storage.getChat(id).archived, false);
    // Closed by hand while it works (Sidebar's closePatch): it stays closed while working and after.
    storage.putChat({ ...storage.getChat(id), archived: true, done: false });
    assert.equal((await turn("u4", "a5", "u3", "busy")).archived, true);
    const done = await turn("u5", "a6", "u4", "idle");
    assert.equal(done.archived, true);
    assert.equal(done.messages.at(-1).status, "done");
    // Reopened by hand (archived: false, done: true): finishing again doesn't close it.
    storage.putChat({ ...storage.getChat(id), archived: false, done: true });
    assert.equal((await turn("u6", "a7", "a6", "busy")).archived, false);
    const after = await turn("u7", "a8", "u6", "idle");
    assert.deepEqual([after.archived, after.done, after.messages.at(-1).status], [false, true, "done"]);
  `);
});

test("without a process registry, a recent unfinished turn is working and an old one isn't", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-session-import-recent-"));
  await run(dir, `${claudeFixture}
    import { strict as assert } from "node:assert";
    import { utimes } from "node:fs/promises";
    const mod = await import("./server/sessionImport.ts");
    const fresh = "77777777-7777-4777-8777-777777777777", old = "88888888-8888-4888-8888-888888888888";
    await writeFile(join(dir, fresh + ".jsonl"), jsonl([rec("f1", null, "user", "Running now")]));
    await writeFile(join(dir, old + ".jsonl"), jsonl([rec("o1", null, "user", "Abandoned")]));
    await utimes(join(dir, old + ".jsonl"), new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    await mod.discover();
    const running = storage.getChat(threadOf(fresh));
    assert.equal(running.archived, false);
    assert.deepEqual(running.messages.map((m) => [m.role, m.status]), [["user", undefined], ["assistant", "streaming"]]);
    const stopped = storage.getChat(threadOf(old));
    assert.equal(stopped.archived, true);
    assert.deepEqual(stopped.messages.map((m) => m.role), ["user"]);
  `);
});

test("Codex and OpenCode report working sessions from their own status and unfinished turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-session-import-classify-"));
  await run(dir, `
    import { strict as assert } from "node:assert";
    const { projectCodex, projectOpencode } = await import("./server/sessionImport.ts");
    const now = Date.now();
    const th = (status, updatedAt) => ({ id: "c", cwd: "/w", createdAt: 1, updatedAt, turns: [{ id: "t", status, items: [{ type: "userMessage", id: "u", content: [{ type: "text", text: "go" }] }, { type: "agentMessage", id: "m", text: "Working" }] }] });
    assert.equal(projectCodex(th("inProgress", now), { modified: now }).working, true);
    assert.equal(projectCodex(th("inProgress", now - 3600_000), { modified: now - 3600_000 }).working, false);
    assert.equal(projectCodex(th("completed", now), { busy: true, modified: now }).working, true);
    assert.equal(projectCodex(th("inProgress", now), { busy: false, modified: now }).working, false);
    const stopped = projectCodex(th("inProgress", now - 3600_000), { modified: now - 3600_000 });
    assert.equal(stopped.chat.archived, true);
    const live = projectCodex(th("inProgress", now), { modified: now });
    assert.equal(live.chat.archived, false);
    assert.equal(live.chat.messages.at(-1).status, "streaming");
    const s = { id: "o", location: { directory: "/w" }, time: { created: now, updated: now } };
    const msgs = (finish) => [{ id: "u", type: "user", text: "go", time: { created: now } }, { id: "a", type: "assistant", content: [{ type: "text", text: "On it" }], ...(finish ? { finish } : {}), time: { created: now } }];
    assert.equal(projectOpencode(s, msgs(undefined), { modified: now }).working, true);
    assert.equal(projectOpencode(s, msgs("stop"), { modified: now }).working, false);
    assert.equal(projectOpencode(s, msgs(undefined), { modified: now - 3600_000 }).working, false);
  `);
});

test("repeated discovery is idempotent and incremental, and keeps what the user did with a thread", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-session-import-repeat-"));
  await run(dir, `${claudeFixture}
    import { strict as assert } from "node:assert";
    import { appendFile } from "node:fs/promises";
    const { mock } = await import("bun:test");
    const fs = await import("node:fs/promises");
    const originalRead = fs.readFile;
    let reads = 0;
    mock.module("node:fs/promises", () => ({ ...fs, readFile: async (file, ...args) => {
      if (String(file).endsWith(".jsonl")) reads++;
      return originalRead(file, ...args);
    } }));
    const mod = await import("./server/sessionImport.ts");
    const other = "99999999-9999-4999-8999-999999999999";
    await writeFile(join(dir, other + ".jsonl"), jsonl([rec("p1", null, "user", "Another"), rec("p2", "p1", "assistant", [{ type: "text", text: "Sure" }])]));
    // Concurrent callers share one pass.
    await Promise.all([mod.discover(), mod.discover()]);
    assert.equal(storage.listChats().length, 2);
    assert.equal(reads, 2);
    const versions = JSON.stringify(storage.chatIndex());
    await mod.discover();
    await mod.discover();
    // Unchanged sessions aren't read again, and nothing is written.
    assert.equal(reads, 2);
    assert.equal(JSON.stringify(storage.chatIndex()), versions);
    // The user renames, pins and reopens one thread, and deletes the other.
    const id = threadOf(native);
    storage.putChat({ ...storage.getChat(id), title: "Mine now", titleSource: "user", pinned: true, archived: false, done: true });
    storage.deleteChat(threadOf(other));
    await appendFile(join(dir, native + ".jsonl"), jsonl([rec("u3", "a4", "user", "One more"), rec("a5", "u3", "assistant", [{ type: "text", text: "Done too." }])]));
    await appendFile(join(dir, other + ".jsonl"), jsonl([rec("p3", "p2", "user", "Back again"), rec("p4", "p3", "assistant", [{ type: "text", text: "Hi" }])]));
    await mod.discover();
    const chat = storage.getChat(id);
    assert.deepEqual([chat.title, chat.titleSource, chat.pinned, chat.archived, chat.done], ["Mine now", "user", true, false, true]);
    assert.equal(chat.messages.at(-1).content, "Done too.");
    assert.equal(JSON.parse(storage.getValue("claude-session:" + id)).turns, 3);
    // Deleted stays deleted, and nothing else is removed.
    assert.equal(storage.getChat(threadOf(other)), undefined);
    assert.equal(storage.listChats().length, 1);
    assert.equal(storage.listValues("claude-session:").length, 3);
  `);
});

test("once OpenBuild runs a turn in an imported thread, discovery stops rewriting its history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-session-import-adopt-"));
  await run(dir, `${claudeFixture}
    import { strict as assert } from "node:assert";
    import { appendFile } from "node:fs/promises";
    const mod = await import("./server/sessionImport.ts");
    await mod.discover();
    const id = threadOf(native);
    const chat = storage.getChat(id);
    // A reply OpenBuild is streaming right now: discovery waits.
    storage.putChat({ ...chat, messages: [...chat.messages, { id: "ob-u", role: "user", content: "From OpenBuild", createdAt: Date.now() }, { id: "ob-a", role: "assistant", content: "", status: "streaming", stream: { id: "s", via: "server" }, createdAt: Date.now() }] });
    await appendFile(join(dir, native + ".jsonl"), jsonl([rec("u3", "a4", "user", "From OpenBuild")]));
    await mod.discover();
    assert.equal(storage.getChat(id).messages.at(-1).id, "ob-a");
    // Its adapter then records the turn in the mapping: the thread is OpenBuild's from here on.
    storage.setValue("claude-session:" + id, JSON.stringify({ id: native, cwd, turns: 3, anchors: ["a3", "a4", "x"] }));
    const ours = { ...storage.getChat(id), messages: storage.getChat(id).messages.map((m) => m.id === "ob-a" ? { ...m, status: "done", stream: undefined, content: "Answered here" } : m) };
    storage.putChat(ours);
    await appendFile(join(dir, native + ".jsonl"), jsonl([rec("a9", "u3", "assistant", [{ type: "text", text: "native write" }])]));
    await mod.discover();
    assert.equal(storage.getChat(id).messages.at(-1).content, "Answered here");
    assert.equal(JSON.parse(storage.getValue("claude-session:" + id)).turns, 3);
  `);
});

test("after a restart, a session whose process died stops working, without duplicates or rereads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-session-import-restart-"));
  await run(dir, `${claudeFixture}
    import { strict as assert } from "node:assert";
    import { appendFile } from "node:fs/promises";
    await appendFile(join(dir, native + ".jsonl"), jsonl([rec("u3", "a4", "user", "Long job")]));
    // This process is the Claude Code working on it; it exits with the "server".
    await registry(native, "busy");
    const mod = await import("./server/sessionImport.ts");
    await mod.discover();
    assert.equal(storage.getChat(threadOf(native)).messages.at(-1).status, "streaming");
    assert.equal(storage.getChat(threadOf(native)).archived, false);
  `);
  await run(dir, `
    import { strict as assert } from "node:assert";
    import { createHash } from "node:crypto";
    const { mock } = await import("bun:test");
    const fs = await import("node:fs/promises");
    const originalRead = fs.readFile;
    let reads = 0;
    mock.module("node:fs/promises", () => ({ ...fs, readFile: async (file, ...args) => {
      if (String(file).endsWith(".jsonl")) reads++;
      return originalRead(file, ...args);
    } }));
    const storage = await import("./server/storage.ts");
    const mod = await import("./server/sessionImport.ts");
    await mod.discover();
    const id = "claude-" + createHash("sha256").update("11111111-1111-4111-8111-111111111111").digest("hex").slice(0, 32);
    const chat = storage.getChat(id);
    assert.notEqual(chat.messages.at(-1).status, "streaming");
    // Only the session whose process went away is read again.
    assert.equal(reads, 1);
    await mod.discover();
    assert.equal(reads, 1);
    assert.equal(storage.listChats().length, 1);
  `);
});

test("the first discovery brings in the newest 100 sessions; later sessions follow, older ones never", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-import-recent-"));
  await run(dir, `${claudeFixture}
    const { utimes } = await import("node:fs/promises");
    const { strict: a } = await import("node:assert");
    const session = async (n, at) => {
      const id = 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0');
      const file = join(dir, id + '.jsonl');
      await writeFile(file, jsonl([rec('u', null, 'user', 'Session ' + n), rec('a', 'u', 'assistant', [{ type: 'text', text: 'Done' }])]));
      await utimes(file, at, at);
    };
    for (let n = 0; n < 105; n++) await session(n, 1000000000 + n);
    const { utimes: touch } = await import("node:fs/promises");
    await touch(join(dir, native + ".jsonl"), 900000000, 900000000);
    const mod = await import("./server/sessionImport.ts");
    await mod.discover();
    a.equal(storage.chatIndex().length, 100);
    a.ok(storage.listChats().some(c => c.title === 'Session 104'));
    a.ok(!storage.listChats().some(c => c.title === 'Session 4'));
    await session(200, 2000000000);
    await mod.discover();
    a.equal(storage.chatIndex().length, 101);
    a.ok(storage.listChats().some(c => c.title === 'Session 200'));
    a.ok(!storage.listChats().some(c => c.title === 'Session 4'));
  `);
});

test("failed imports roll back the chat and every resume binding, then retry successfully", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-import-atomic-"));
  await run(dir, `${claudeFixture}
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(process.env.OPENCHAT_DATA_DIR, "openchat.db"));
    db.run("CREATE TRIGGER fail_binding BEFORE INSERT ON kv WHEN NEW.key LIKE 'imported-session:%' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    const mod = await import("./server/sessionImport.ts");
    const { strict: a } = await import("node:assert");
    const warn = console.warn;
    console.warn = () => {};
    await mod.discover();
    console.warn = warn;
    a.equal(storage.chatIndex().length, 0);
    a.equal(storage.listValues("claude-session:").length, 1); // fixture's pre-existing own session only
    a.equal(storage.listValues("thread-runtime:").length, 0);
    db.run("DROP TRIGGER fail_binding");
    await mod.discover();
    a.equal(storage.chatIndex().length, 1);
  `);
});

test("discovers every signed-in account, and continues each thread on the account it came from", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-import-accounts-"));
  await run(dir, `${claudeFixture}
    import { strict as assert } from "node:assert";
    // A second Claude Code login beside the default one.
    const second = join(process.env.HOME, ".claude-2");
    await mkdir(join(second, "projects", "w"), { recursive: true });
    await writeFile(join(second, ".credentials.json"), "{}");
    const otherNative = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await writeFile(join(second, "projects", "w", otherNative + ".jsonl"), jsonl([rec("k1", null, "user", "On the second login"), rec("k2", "k1", "assistant", [{ type: "text", text: "Yes" }])]));
    const mod = await import("./server/sessionImport.ts");
    await mod.discover();
    const fromSecond = storage.getChat(threadOf(otherNative));
    assert.equal(fromSecond.runtimeAccount.configDir, second);
    assert.equal(fromSecond.runtimeAccount.runtime, "claude");
    assert.equal(storage.getChat(threadOf(native)).runtimeAccount, undefined);
    assert.equal(storage.listChats().length, 2);
    // Saved accounts count when they're this server's (no device, or this server's id), not a paired device's.
    const { serverId } = await import("./server/devices.ts");
    const account = (name, deviceId) => ({ id: name, name, runtime: "codex", configDir: join(process.env.HOME, "." + name), ...(deviceId ? { deviceId } : {}) });
    for (const name of ["work", "here", "elsewhere"]) await mkdir(join(process.env.HOME, "." + name), { recursive: true });
    storage.setValue("client-state", JSON.stringify({ state: { settings: { runtimeAccounts: [account("work"), account("here", serverId()), account("elsewhere", "another-device")] } } }));
    const keys = mod.sources().map((s) => s.key);
    assert.ok(keys.includes("codex:" + join(process.env.HOME, ".work")));
    assert.ok(keys.includes("codex:" + join(process.env.HOME, ".here")));
    assert.ok(!keys.some((k) => k.endsWith(".elsewhere")));
  `);
});

test("Codex is only asked again when its files change; its sessions follow each account's home", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ob-import-codex-"));
  await run(dir, `
    const { mock } = await import("bun:test");
    const { strict: a } = await import("node:assert");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const homes = [];
    let threads = ["native-codex", "kept-open"].map((id) => ({ id, cwd: "/tmp", updatedAt: Math.floor(Date.now() / 1000), status: { type: "active" } }));
    mock.module("./server/codex/install.ts", () => ({ codexBin: () => "/fake/codex", codexEnv: () => ({ CODEX_HOME: process.env.CODEX_HOME }) }));
    mock.module("./server/codex/rpc.ts", () => ({ CodexProcess: class {
      async initialize() { homes.push(process.env.CODEX_HOME); } close() {}
      async request(method, input) {
        if (method === "thread/list") return { data: input.archived ? [] : threads };
        if (method === "thread/read") return { thread: { id: input.threadId, cwd: "/tmp", turns: [{ id: "t", status: "inProgress", items: [{ id: "u", type: "userMessage", content: [{ type: "text", text: "hello" }] }] }] } };
        throw new Error(method);
      }
    } }));
    await mkdir(join(process.env.CODEX_HOME, "sessions"), { recursive: true });
    await writeFile(join(process.env.CODEX_HOME, "sessions", "rollout.jsonl"), "{}\\n");
    const storage = await import("./server/storage.ts");
    const mod = await import("./server/sessionImport.ts");
    await mod.discover();
    a.equal(homes.length, 1);
    const { threadId } = mod;
    const chat = storage.getChat(threadId("codex", "native-codex"));
    a.equal(chat.archived, false);
    a.equal(chat.messages.at(-1).status, "streaming");
    // The user closed and reopened this one by hand while it worked.
    const kept = threadId("codex", "kept-open");
    storage.putChat({ ...storage.getChat(kept), archived: false, done: true });
    await mod.discover();
    a.equal(homes.length, 1);
    // Codex writes to the rollout: listed again. The thread is gone from the listing: it isn't running anymore.
    threads = [];
    await writeFile(join(process.env.CODEX_HOME, "sessions", "rollout.jsonl"), "{}\\n{}\\n");
    await mod.discover();
    a.equal(homes.length, 2);
    const settled = storage.getChat(chat.id);
    a.equal(settled.messages.at(-1).status, "stopped");
    a.equal(settled.archived, true);
    const reopened = storage.getChat(kept);
    a.deepEqual([reopened.messages.at(-1).status, reopened.archived], ["stopped", false]);
    a.equal(storage.listChats().length, 2);
    // Settled once: later passes leave both alone.
    const versions = JSON.stringify(storage.chatIndex());
    await writeFile(join(process.env.CODEX_HOME, "sessions", "rollout.jsonl"), "{}\\n{}\\n{}\\n");
    await mod.discover();
    a.equal(JSON.stringify(storage.chatIndex()), versions);
  `);
});

test("Codex and OpenCode listings read histories only for sessions that need importing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ob-import-list-only-"));
  await run(dir, `
    const { mock } = await import("bun:test");
    const { strict: a } = await import("node:assert");
    const calls = [];
    mock.module("./server/codex/install.ts", () => ({ codexBin: () => "/fake/codex", codexEnv: () => ({}) }));
    mock.module("./server/codex/rpc.ts", () => ({ CodexProcess: class {
      async initialize() {} close() {}
      async request(method, input) {
        calls.push(method);
        if (method === "thread/list") return { data: input.archived ? [] : [{ id: "native-codex", cwd: "/tmp", updatedAt: 1 }, { id: "openbuild-own", cwd: "/tmp", updatedAt: 1, originator: "openbuild" }] };
        if (method === "thread/read") return { thread: { id: input.threadId, cwd: "/tmp", turns: [{ id: "t", status: "completed", items: [{ id: "u", type: "userMessage", content: [{ type: "text", text: "hello" }] }] }] } };
        throw new Error(method);
      }
    } }));
    mock.module("./server/opencode-agent/connection.ts", () => ({ opencodeBin: () => "/fake/opencode", connect: async () => ({
      async close() {},
      async request(path) {
        calls.push(path);
        if (path.startsWith("/api/session?")) return { data: [{ id: "native-opencode", location: { directory: "/tmp" }, time: { updated: 1 } }, { id: "child", parentID: "native-opencode", location: { directory: "/tmp" }, time: { updated: 1 } }] };
        if (path.startsWith("/api/session/native-opencode/message")) return { data: [{ id: "u", type: "user", text: "hi", time: { created: 1 } }, { id: "m", type: "assistant", finish: "stop", content: [{ type: "text", text: "hey" }], time: { created: 1 } }] };
        throw new Error("Unexpected OpenCode read: " + path);
      }
    }) }));
    const storage = await import("./server/storage.ts");
    const mod = await import("./server/sessionImport.ts");
    await mod.discover();
    a.equal(calls.filter(c => c === "thread/read").length, 1);
    a.equal(calls.filter(c => c.includes("/message")).length, 1);
    a.deepEqual(storage.listChats().map((c) => [c.runtime, c.archived]).sort(), [["codex", true], ["opencode", true]]);
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
    await mod.discover();
    const [chat] = storage.listChats();
    assert.equal(chat.archived, true);
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
