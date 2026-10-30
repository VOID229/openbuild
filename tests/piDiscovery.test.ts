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
    // Recovery after a restart reads model-facing prompts from disk.
    const { withProfileContext } = await import("./src/lib/profile.ts");
    const { HTML_DELIVERY_NOTE } = await import("./server/htmlDelivery.ts");
    const injected = HTML_DELIVERY_NOTE + withProfileContext("Actual message", { name: "gal", bio: "private preferences", location: "", language: "" });
    for (const content of [injected, [{ type: "text", text: injected }]]) {
      const recovered = projectSession(jsonl([header, entry("recovered", null, "user", content)]), file, Date.now());
      assert.equal(recovered.messages[0].content, "Actual message");
      assert.equal(recovered.title, "Actual message");
    }
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

    // A generated title survives later turns too.
    storage.putChat({ ...chats[0], title: "Generated Name", titleSource: "auto" });
    await appendFile(file, jsonl([entry("user3", "user2", "user", "And again")]));
    await discoverSessions();
    assert.equal(storage.listChats()[0].title, "Generated Name");

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

    // Pi writes one assistant message per round, with tools in between: the paragraph break that
    // follows a round extends the text, and never becomes a whitespace-only part that would split
    // the run of tools after it into a second "Ran N commands" row.
    const round = entry("answer2", "result1", "assistant", [{ type: "text", text: "Now checking" }, { type: "toolCall", id: "tool2", name: "bash", arguments: { command: "ls" } }], { stopReason: "toolUse" });
    const next2 = projectSession(jsonl([...lines, round]), file, 10).messages[1];
    assert.deepEqual(next2.parts.map((p) => p.type), ["thought", "text", "tool", "text", "tool"]);
    assert.equal(next2.parts[3].text, "Now checking");
    assert.equal(next2.content, "Old answer\\n\\nNow checking");

    // Subagents name their session first thing; the prefix becomes a flag rather than part of the title.
    const info = { type: "session_info", id: "info1", parentId: null, timestamp: header.timestamp, name: "subagent: runtime-ui" };
    const child = projectSession(jsonl([header, info, { ...user, parentId: "info1" }]), file, 10);
    assert.equal(child.subagent, true);
    assert.equal(child.title, "runtime-ui");
    assert.equal(projectSession(jsonl(lines), file, 10).subagent, undefined);
    // Worker-owned UI history stays intact, but later terminal continuations are still imported.
    const { projectStoredChats } = await import('./server/pi/projection.ts');
    const managedId = 'managed-thread-1234';
    const managedFile = join(root, 'managed.jsonl');
    const cutoff = Date.now();
    storage.setValue('pi-session:' + managedId, JSON.stringify({file:managedFile,cwd:root}));
    globalThis.openbuildPiClient.owned.add(managedId);
    const ownedStream = {id:'owned-reply-0123456789',via:'server-test'};
    storage.putChat({id:managedId,title:'Keep',createdAt:1,updatedAt:cutoff,messages:[
      {id:'ob-user',role:'user',content:'Original',createdAt:cutoff + 999999},
      {id:'ob-assistant',role:'assistant',content:'Rich output',createdAt:cutoff,stream:ownedStream,status:'done'}
    ]});
    projectStoredChats([{id:ownedStream.id,threadId:managedId,kind:'run',status:'finished',startedAt:cutoff-100,endedAt:cutoff,events:[{t:'text',v:'Rich output'},{t:'done',finish:'stop'}]}]);
    const terminalUser = entry('terminal-user', 'answer1', 'user', 'Continue in terminal', {timestamp:cutoff+1000});
    const terminalReply = entry('terminal-reply', 'terminal-user', 'assistant', [{type:'text',text:'Terminal answer'}], {timestamp:cutoff+1001,stopReason:'stop'});
    await writeFile(managedFile,jsonl([{...header,id:managedId},user,assistant,terminalUser,terminalReply]));
    await utimes(managedFile,(cutoff+1002)/1000,(cutoff+1002)/1000);
    await discoverSessions();
    const continued=storage.getChat(managedId);
    assert.deepEqual(continued.messages.map(m=>m.id),['ob-user','ob-assistant','terminal-user','terminal-reply']);
    assert.deepEqual(continued.messages[1].stream,ownedStream);
    assert.equal(continued.messages[3].content,'Terminal answer');
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
