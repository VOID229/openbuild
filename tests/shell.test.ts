// Commands the user runs from the composer: "!cmd" (the agent reads it) and "!!cmd" (it doesn't).
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputTail, shellCommand } from "../shared/shell";

describe("shellCommand", () => {
  test("! shares the command with the agent, !! keeps it from the agent", () => {
    expect(shellCommand("!ls -la")).toEqual({ command: "ls -la", hidden: false });
    expect(shellCommand("  ! git status ")).toEqual({ command: "git status", hidden: false });
    expect(shellCommand("!!cat .env")).toEqual({ command: "cat .env", hidden: true });
    expect(shellCommand("!! echo a\necho b")).toEqual({ command: "echo a\necho b", hidden: true });
  });
  test("a bare ! or !! isn't a command, and neither is text that doesn't start with one", () => {
    expect(shellCommand("!")).toBeUndefined();
    expect(shellCommand("!!  ")).toBeUndefined();
    expect(shellCommand("run ls!")).toBeUndefined();
  });
});

describe("outputTail", () => {
  test("keeps short output as is", () => {
    expect(outputTail("a\nb\n", 100)).toBe("a\nb\n");
  });
  test("keeps the end of long output, from a whole line, and says some was cut", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const tail = outputTail(lines, 200);
    expect(tail.startsWith("… earlier output not shown …\n")).toBe(true);
    expect(tail.endsWith("line 999")).toBe(true);
    expect(tail.split("\n")[1]).toMatch(/^line \d+$/);
    // Cutting again doesn't stack the note.
    expect(outputTail(tail + "\nmore", 200).match(/earlier output/g)?.length).toBe(1);
  });
});

// In their own process, so they never open the user's real database.
test("Pi's record of a command shows as a shell message, and a running command streams to every watcher", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-shell-"));
  const script = `
    import { strict as assert } from "node:assert";
    import { mkdirSync, realpathSync } from "node:fs";
    import { join } from "node:path";
    const { projectSession } = await import("./server/pi/discovery.ts");
    const { Shell } = await import("./server/pi/shell.ts");
    const { scratchDir } = await import("./server/projects.ts");
    const { readEvents } = await import("./shared/replies.ts");

    // From a session file: "!" and "!!" commands between the replies.
    const scratch = join(scratchDir(), "2026-01-01-abc123");
    mkdirSync(scratch, { recursive: true });
    const header = { type: "session", version: 3, id: "shell-session-1234", cwd: realpathSync(scratch), timestamp: "2026-01-01T00:00:00Z" };
    const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:01:00Z", message: { timestamp: 1767225660000, ...message } });
    const lines = [
      header,
      entry("u1", null, { role: "user", content: "hi" }),
      entry("a1", "u1", { role: "assistant", content: [{ type: "text", text: "hello" }], provider: "p", model: "m", stopReason: "stop" }),
      entry("b1", "a1", { role: "bashExecution", command: "cd ~ && ls", output: "Desktop\\n", exitCode: 0, cancelled: false, truncated: false }),
      entry("b2", "b1", { role: "bashExecution", command: "cat .env", output: "SECRET=1\\n", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true }),
      entry("b3", "b2", { role: "bashExecution", command: "npm run dev", output: "ready\\n", cancelled: true, truncated: true, fullOutputPath: "/tmp/pi-bash-1.log" }),
      entry("u2", "b3", { role: "user", content: "what did ls show?" }),
    ];
    const chat = projectSession(lines.map((l) => JSON.stringify(l)).join("\\n"), "/x.jsonl", Date.now() - 3600_000);
    assert.deepEqual(chat.messages.map((m) => m.role), ["user", "assistant", "shell", "shell", "shell", "user"]);
    const [ls, env, dev] = chat.messages.slice(2, 5);
    // A scratch thread's commands ran from the home folder; they show as typed.
    assert.equal(ls.content, "ls");
    assert.deepEqual(ls.shell, { command: "ls", hidden: undefined, status: "done", output: "Desktop\\n", exitCode: 0, fullOutputPath: undefined });
    assert.equal(env.shell.hidden, true);
    assert.equal(dev.shell.status, "stopped");
    assert.equal(dev.shell.fullOutputPath, "/tmp/pi-bash-1.log");

    // A running command: a watcher that comes late gets the output so far, then the rest.
    const shell = new Shell("s".repeat(20), "thread-1234");
    const collect = async (stream) => { const out = []; for await (const e of readEvents(stream)) out.push(e); return out; };
    const early = collect(shell.stream());
    shell.write("one\\n");
    await Bun.sleep(150);
    const late = collect(shell.stream());
    shell.write("two\\n");
    // Output still waiting for its batch reaches a watcher that just came, once.
    const mid = collect(shell.stream());
    await Bun.sleep(150);
    shell.finish({ t: "exit", status: "done", exitCode: 0, ms: 5 });
    const [a, b, c] = await Promise.all([early, late, mid]);
    assert.deepEqual(c, b);
    assert.deepEqual(a, [{ t: "snap", output: "", status: "running" }, { t: "out", v: "one\\n" }, { t: "out", v: "two\\n" }, { t: "exit", status: "done", exitCode: 0, ms: 5 }, { t: "end" }]);
    assert.deepEqual(b, [{ t: "snap", output: "one\\n", status: "running" }, { t: "out", v: "two\\n" }, { t: "exit", status: "done", exitCode: 0, ms: 5 }, { t: "end" }]);
    // And once it's over, the whole of it at once.
    assert.deepEqual(await collect(shell.stream()), [{ t: "snap", output: "one\\ntwo\\n", status: "done" }, { t: "exit", status: "done", exitCode: 0, ms: 5 }, { t: "end" }]);
    process.exit(0);
  `;
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, OPENCHAT_DATA_DIR: join(dir, "data"), PI_CODING_AGENT_DIR: join(dir, "agent") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
