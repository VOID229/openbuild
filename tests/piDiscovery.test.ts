import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run discovery in its own process so tests never open the user's real database or Pi archive.
test("discovers past and future Pi sessions, refreshes history, resumes originals and respects deletions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-pi-discovery-"));
  const script = `
    import { mkdir, writeFile, appendFile, utimes } from "node:fs/promises";
    import { join } from "node:path";
    import { strict as assert } from "node:assert";
    const storage = await import("./server/storage.ts");
    const { discoverSessions, projectSession } = await import("./server/pi/discovery.ts");
    const root = join(process.env.PI_CODING_AGENT_DIR, "sessions", "--old-project--");
    await mkdir(root, { recursive: true });
    const file = join(root, "old.jsonl");
    const id = "old-session-1234";
    const header = { type: "session", version: 3, id, cwd: root, timestamp: "2025-01-01T00:00:00Z" };
    const entry = (id, parentId, role, content, extra = {}) => ({ type: "message", id, parentId, timestamp: "2025-01-01T00:01:00Z", message: { role, content, timestamp: 1735689660000, ...extra } });
    const user = entry("user1", null, "user", "Old terminal task");
    const assistant = entry("answer1", "user1", "assistant", [{ type: "thinking", thinking: "Plan" }, { type: "text", text: "Old answer" }, { type: "toolCall", id: "tool1", name: "bash", arguments: { command: "pwd" } }], { provider: "test", model: "model", stopReason: "toolUse", usage: { input: 3, output: 4, cost: { total: 0.01 } } });
    const result = entry("result1", "answer1", "toolResult", [{ type: "text", text: "/old/project" }], { toolCallId: "tool1" });
    const lines = [header, user, assistant, result];
    const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join("\\n") + "\\n";
    await writeFile(file, jsonl(lines));
    await discoverSessions();
    let chats = storage.listChats();
    assert.equal(chats.length, 1);
    assert.equal(chats[0].id, id);
    assert.equal(chats[0].title, "Old terminal task");
    assert.equal(chats[0].workspace.cwd, root);
    const { allowedCwd } = await import("./server/projects.ts");
    assert(allowedCwd(root)); // Resumable without adding the folder as an OpenBuild project.
    const unrelated = join(root, "unrelated");
    await mkdir(unrelated);
    assert(!allowedCwd(unrelated)); // A binding authorizes the exact cwd, not arbitrary descendants.
    assert.equal(chats[0].messages[1].parts[2].output, "/old/project");
    assert.equal(chats[0].messages[1].parts[2].status, "done");
    assert.equal(chats[0].messages[1].model.id, "test/model");
    assert.equal(JSON.parse(storage.getValue("pi-session:" + id)).file, file);
    const originalBytes = await Bun.file(file).text();
    assert.equal(originalBytes, jsonl(lines)); // Discovery never writes to a Pi file.

    // Preserve OpenBuild metadata while picking up messages from a terminal later on.
    storage.putChat({ ...chats[0], pinned: true, title: "My title", titleSource: "user" });
    const next = entry("user2", "result1", "user", "Continued elsewhere");
    await appendFile(file, jsonl([next]));
    await discoverSessions();
    chats = storage.listChats();
    assert.equal(chats[0].messages.length, 3);
    assert.equal(chats[0].pinned, true);
    assert.equal(chats[0].title, "My title");

    // A session born after startup appears automatically; no project registration required.
    await writeFile(join(root, "new.jsonl"), jsonl([{ ...header, id: "future-session-1234" }, user]));
    await discoverSessions();
    assert.equal(storage.listChats().length, 2);

    // Existing OpenBuild bindings must not be imported a second time under Pi's header ID.
    const boundFile = join(root, "bound.jsonl");
    await writeFile(boundFile, jsonl([{ ...header, id: "forked-pi-session" }, user]));
    storage.setValue("pi-session:openbuild-thread", JSON.stringify({ file: boundFile, cwd: header.cwd }));
    storage.putChat({ id: "openbuild-thread", updatedAt: 1, createdAt: 1, messages: [] });
    await discoverSessions();
    assert.equal(storage.listChats().length, 3);
    assert(!storage.listChats().some((c) => c.id === "forked-pi-session"));

    // Hiding a thread doesn't delete its Pi transcript or let a later scan resurrect it.
    storage.deleteChat(id);
    await appendFile(file, jsonl([entry("answer2", "user2", "assistant", [{ type: "text", text: "Later" }])]));
    await discoverSessions();
    assert(!storage.listChats().some((c) => c.id === id));
    assert(await Bun.file(file).exists());

    // Follow the active branch, not abandoned alternatives; tolerate a partial final write.
    const alternative = entry("alternate", "user1", "assistant", [{ type: "text", text: "Alternative answer" }]);
    const projected = projectSession(jsonl([...lines, alternative]) + '{"type":', file, 10);
    assert.equal(projected.messages.length, 2);
    assert.equal(projected.messages[1].content, "Alternative answer");
    assert.equal(projectSession("not a session", file, 10), undefined);
    const empty = projectSession(jsonl([header]), file, 10);
    assert.equal(empty.messages.length, 0);

    // A turn mid-tool-call is running while its transcript is fresh, and stopped once it's gone quiet.
    const live = projectSession(jsonl(lines), file, Date.now());
    assert.equal(live.messages[1].status, "streaming");
    assert.equal(live.messages[1].stream.via, "external");
    const pending = projectSession(jsonl([header, user, assistant]), file, Date.now());
    assert.equal(pending.messages[1].parts[2].status, "running");
    assert.equal(projectSession(jsonl(lines), file, Date.now() - 60 * 60 * 1000).messages[1].status, "stopped");
    const finished = entry("answer2", "result1", "assistant", [{ type: "text", text: "Done" }], { stopReason: "stop" });
    assert.equal(projectSession(jsonl([...lines, finished]), file, Date.now()).messages[1].status, "done");

    // Subagents name their session first thing; the prefix becomes a flag rather than part of the title.
    const info = { type: "session_info", id: "info1", parentId: null, timestamp: header.timestamp, name: "subagent: runtime-ui" };
    const child = projectSession(jsonl([header, info, { ...user, parentId: "info1" }]), file, 10);
    assert.equal(child.subagent, true);
    assert.equal(child.title, "runtime-ui");
    assert.equal(projectSession(jsonl(lines), file, 10).subagent, undefined);
    process.exit(0);
  `;
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OPENCHAT_DATA_DIR: join(dir, "data"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_CODING_AGENT_SESSION_DIR: join(dir, "custom") },
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: out + err }).toEqual({ code: 0, output: "" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
