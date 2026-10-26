// A terminal in the browser: the drawer's shell runs on a PTY on the device that holds the project
// (server/terminals.ts), and its events come back as NDJSON (shared/terminal.ts).
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editingSequence, terminalSize, terminalTail } from "../shared/terminal";

describe("terminalSize", () => {
  test("takes what the browser measured", () => {
    expect(terminalSize(120, 40)).toEqual({ cols: 120, rows: 40 });
    expect(terminalSize(120.4, 39.6)).toEqual({ cols: 120, rows: 40 });
  });
  test("falls back to 80x24, and stays within what a PTY can be given", () => {
    expect(terminalSize(undefined, undefined)).toEqual({ cols: 80, rows: 24 });
    expect(terminalSize("wide", null)).toEqual({ cols: 80, rows: 24 });
    expect(terminalSize(Number.NaN, Infinity)).toEqual({ cols: 80, rows: 24 });
    expect(terminalSize(0, 0)).toEqual({ cols: 20, rows: 5 });
    expect(terminalSize(10_000, 10_000)).toEqual({ cols: 400, rows: 300 });
  });
});

describe("terminalTail", () => {
  test("keeps short output as is, escapes and all", () => {
    expect(terminalTail("\x1b[32m$ ls\x1b[0m\n", 100)).toBe("\x1b[32m$ ls\x1b[0m\n");
  });
  test("keeps the end, from a whole line, with the colours reset", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i} \x1b[32mgreen\x1b[0m`).join("\n");
    const tail = terminalTail(lines, 200);
    expect(tail.startsWith("\x1b[0m")).toBe(true);
    expect(tail).not.toContain("\nline 0 ");
    expect(tail.endsWith("line 499 \x1b[32mgreen\x1b[0m")).toBe(true);
    // It starts on a line of its own, never halfway through a line or an escape sequence.
    expect(tail.slice(4, 9)).toBe("line ");
  });
  test("a single long line is cut anyway", () => {
    expect(terminalTail("x".repeat(500), 200)).toBe("\x1b[0m" + "x".repeat(200));
  });
});

const k = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) => ({ key, metaKey: !!mods.metaKey, ctrlKey: !!mods.ctrlKey, altKey: !!mods.altKey });

describe("editingSequence", () => {
  test("on a Mac, Option works in words and Command on the line, as in Terminal.app", () => {
    expect(editingSequence(true, k("ArrowLeft", { altKey: true }))).toBe("\x1bb");
    expect(editingSequence(true, k("ArrowRight", { altKey: true }))).toBe("\x1bf");
    expect(editingSequence(true, k("Backspace", { altKey: true }))).toBe("\x1b\x7f");
    expect(editingSequence(true, k("Delete", { altKey: true }))).toBe("\x1bd");
    expect(editingSequence(true, k("ArrowLeft", { metaKey: true }))).toBe("\x01");
    expect(editingSequence(true, k("ArrowRight", { metaKey: true }))).toBe("\x05");
    expect(editingSequence(true, k("Backspace", { metaKey: true }))).toBe("\x15");
  });
  test("elsewhere, Ctrl with the arrows and Delete does the same job", () => {
    expect(editingSequence(false, k("ArrowLeft", { ctrlKey: true }))).toBe("\x1bb");
    expect(editingSequence(false, k("ArrowRight", { ctrlKey: true }))).toBe("\x1bf");
    expect(editingSequence(false, k("Backspace", { ctrlKey: true }))).toBe("\x17");
    expect(editingSequence(false, k("Home", { ctrlKey: true }))).toBe("\x01");
    expect(editingSequence(false, k("End", { ctrlKey: true }))).toBe("\x05");
    // Command is a Mac thing: Cmd on its own isn't an editing key elsewhere, and neither is Ctrl+Alt.
    expect(editingSequence(false, k("ArrowLeft", { metaKey: true }))).toBeUndefined();
    expect(editingSequence(false, k("ArrowLeft", { ctrlKey: true, altKey: true }))).toBeUndefined();
  });
  test("plain keys, and keys the terminal should handle itself, are left alone", () => {
    for (const mac of [true, false]) {
      expect(editingSequence(mac, k("ArrowLeft"))).toBeUndefined();
      expect(editingSequence(mac, k("Enter"))).toBeUndefined();
      expect(editingSequence(mac, k("c", { ctrlKey: true }))).toBeUndefined();
      expect(editingSequence(mac, k("ArrowUp", { ctrlKey: true, metaKey: true, altKey: true }))).toBeUndefined();
    }
  });
});

// In its own process, so it never opens the user's real database.
test("a shell runs on a PTY in the folder asked for: it answers, resizes, and reports how it ended", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-terminal-"));
  // The child script is plain JavaScript in a string, so it builds its own control characters
  // instead of escaping them through this file.
  const script = `
    import { strict as assert } from "node:assert";
    import { mkdirSync, realpathSync } from "node:fs";
    import { join } from "node:path";
    const { openTerminal, findSession, killTerminal, terminalRoutes } = await import("./server/terminals.ts");
    const { readEvents } = await import("./shared/replies.ts");
    const { scratchDir } = await import("./server/projects.ts");

    const CR = String.fromCharCode(13);
    // A folder OpenBuild knows about (a thread's scratch folder): the routes only open terminals in one.
    const scratch = join(scratchDir(), "2026-01-01-terminal");
    mkdirSync(scratch, { recursive: true });
    const cwd = realpathSync(scratch);
    const id = "t".repeat(20);

    // The routes: what the app asks for, and what they refuse. Bun hands handlers the id as
    // req.params; these are the same calls without the server around them.
    const api = (handler) => (req) => handler(req);
    const routes = terminalRoutes(api);
    const withParams = (req, params) => Object.assign(req, { params });
    const call = (path, body, method = "POST") =>
      routes[path][method](withParams(new Request("http://localhost" + path, { method, body: JSON.stringify(body) }), { id }), { timeout() {} });
    const open = (body) => routes["/api/terminals"].POST(new Request("http://localhost/api/terminals", { method: "POST", body: JSON.stringify(body) }));
    assert.equal((await open({ cwd })).status, 400);
    assert.equal((await open({ id: "short", cwd })).status, 400);
    assert.equal((await open({ id, cwd: "/etc" })).status, 403, "a folder that isn't a project");
    assert.equal((await open({ id, cwd: join(cwd, "gone") })).status, 410);
    const opened = await open({ id, cwd, cols: 100, rows: 30 });
    assert.equal(opened.status, 200);
    assert.equal((await opened.json()).cwd, cwd);

    // Asking again attaches to the same shell instead of starting a second one, and the window
    // resize that comes with it is passed on.
    const session = findSession(id);
    const startedAt = session.startedAt;
    assert.equal((await open({ id, cwd, cols: 100, rows: 30 })).status, 200);
    assert.equal(findSession(id), session);
    assert.equal(session.startedAt, startedAt);

    // A login shell takes a moment to put up its prompt: wait for what we asked for.
    const until = async (what, ok) => {
      for (let i = 0; i < 150; i++) {
        if (ok()) return;
        await Bun.sleep(100);
      }
      assert.fail("timed out waiting for " + what + ": " + JSON.stringify(session.output.slice(-300)));
    };
    await until("the prompt", () => /[$%#] $/.test(session.output));

    // A watcher that comes late gets what the shell printed so far, then the rest.
    const collect = async (stream) => { const out = []; for await (const e of readEvents(stream)) out.push(e); return out; };
    const first = collect(session.stream());
    const type = (data) => call("/api/terminals/:id/input", { data });
    assert.equal((await type("echo OUT:$((6*7))" + CR)).status, 200);
    assert.equal((await type("")).status, 400);
    await until("the command's answer", () => session.output.includes("OUT:42"));

    // A real tty: the shell says so itself.
    await type("tty" + CR);
    await until("the tty's name", () => /\\/dev\\/pts\\/\\d+/.test(session.output));

    // Resizing reaches the PTY.
    await call("/api/terminals/:id/resize", { cols: 132, rows: 43 });
    await type("stty size" + CR);
    await until("the new size", () => session.output.includes("43 132"));

    // Closing it ends the shell, and every watcher hears how it went.
    assert.equal((await call("/api/terminals/:id", undefined, "DELETE")).status, 200);
    const events = await first;
    assert.equal(events[0].t, "snap");
    assert.equal(events[0].running, true);
    assert.match(events[0].output, /[$%#]/, "the snapshot holds the prompt and what came after it");
    assert.ok(events.some((e) => e.t === "out" && e.v.includes("OUT:42")), "the new output reaches the watcher");
    assert.equal(events.at(-1).t, "end");
    assert.ok(events.some((e) => e.t === "exit"));
    assert.equal(session.running, false);

    // A shell that ended reports that to whoever asks where it went.
    const after = await collect(session.stream());
    assert.deepEqual(after.map((e) => e.t), ["snap", "exit", "end"]);
    assert.equal(after[0].running, false);
    assert.ok(after[0].output.includes("OUT:42"), "the whole session is there for whoever asks after it ended");
    assert.equal(killTerminal(id), undefined);

    // Opening the terminal again after the shell ended is a new shell, not the dead one.
    const again = await open({ id, cwd, cols: 100, rows: 30 });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).running, true);
    assert.notEqual(findSession(id), session);
    assert.equal(session.running, false);
    killTerminal(id);
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
}, 60_000);
