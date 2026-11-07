import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The runtime opens storage at import time. Each reproduction therefore gets its own process,
// database, fake executable, and Pi directory; none can read the user's sessions or credentials.
async function reproduce(mode: string, body: string) {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-pi-runtime-"));
  const bin = join(dir, "pi");
  await writeFile(bin, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "fixtures/pi-rpc.mjs")}' "$@"\n`);
  await chmod(bin, 0o700);
  const script = `
    import { strict as assert } from "node:assert";
    import { readFileSync } from "node:fs";
    const { runTurn, steer, answer, release } = await import("./server/pi/sessions.ts");
    const { readEvents } = await import("./shared/replies.ts");
    const req = { threadId: "test-thread-1234", cwd: process.cwd(), model: "test/model", effort: "off", prior: 0, message: "Work" };
    const log = () => { try { return readFileSync(process.env.PI_TEST_LOG, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
    const until = async (fn, ms = 2000) => {
      const end = Date.now() + ms;
      while (!fn()) { assert(Date.now() < end, "Timed out waiting for offline Pi"); await Bun.sleep(5); }
    };
    const collect = async (stream, events = []) => { for await (const e of readEvents(stream)) events.push(e); return events; };
    try { ${body} } finally { release(req.threadId); }
    process.exit(0);
  `;
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OPENCHAT_DATA_DIR: join(dir, "data"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"), PI_BIN: bin, PI_TEST_CASE: mode, PI_TEST_LOG: join(dir, "commands.jsonl") },
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    clearTimeout(timer);
    expect({ code, output: out + err }).toEqual({ code: 0, output: "" });
  } finally {
    // Failed assertions must not leave even an offline fake child behind.
    const records = await readFile(join(dir, "commands.jsonl"), "utf8").catch(() => "");
    for (const line of records.trim().split("\n").filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.type === "fixture_start") { try { process.kill(record.pid, "SIGKILL"); } catch {} }
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("Pi RPC keeps reading steering/abort responses when an event subscriber throws", () => reproduce("queue", `
  const { PiProcess, problems } = await import("./server/pi/rpc.ts");
  process.on("unhandledRejection", () => {}); // Baseline must fail by assertion, not crash the test host.
  const proc = new PiProcess(["--no-session"], req.cwd);
  let sawExit = false;
  proc.on((r) => { if (r.type === "message_update" || r.type === "process_exit") throw new Error("Consumer failed"); });
  proc.on((r) => { if (r.type === "process_exit") sawExit = true; });
  try {
    await proc.send({ type: "prompt", message: "Work" });
    await Bun.sleep(20);
    await proc.send({ type: "steer", message: "Change direction" }, 300);
    await proc.send({ type: "abort" }, 300);
    proc.close(0);
    await until(() => sawExit);
    assert(problems.some((p) => p.message.includes("Consumer failed")), "The failing subscriber was not reported");
  } finally { proc.close(0); }
`));

test("Pi source-stream cancellation cannot kill the shared RPC control reader or strand ownership", () => reproduce("cancel-stream", `
  const unhandled = [];
  process.on("unhandledRejection", (e) => unhandled.push(e));
  const ctrl = new AbortController();
  const source = runTurn(req, ctrl.signal);
  const reader = source.getReader();
  await reader.read();
  await reader.cancel();
  const owner = globalThis.openbuildPiLive.get(req.threadId);
  await steer(req.threadId, "steer-after-disconnect", "Continue");
  await Bun.sleep(30);
  await owner.proc.send({ type: "get_state" }, 300);
  ctrl.abort();
  await until(() => !owner.busy);
  assert.equal(unhandled.length, 0, "A cancelled stream threw into Pi's stdout reader");
`));

test("Pi Stop clears queued steering before abort, rather than continuing it", () => reproduce("queue", `
  const ctrl = new AbortController();
  const events = [];
  const done = collect(runTurn(req, ctrl.signal), events);
  await until(() => events.some((e) => e.t === "text"));
  await steer(req.threadId, "steer-1", "Continue with the next step");
  ctrl.abort();
  await done;
  const commands = log().map((c) => c.type);
  assert(commands.indexOf("clear_queue") >= 0 && commands.indexOf("clear_queue") < commands.indexOf("abort"), "Stop must clear the queue before aborting");
  assert(!commands.includes("continued_after_abort"), "Queued work resumed after Stop");
  assert(events.some((e) => e.t === "done" && e.finish === "aborted"));
`));

test("Pi re-aborts a prompt whose async preflight starts work after Stop was acknowledged", () => reproduce("late-prompt", `
  const ctrl = new AbortController();
  const events = [];
  let ended = false;
  const done = collect(runTurn(req, ctrl.signal), events).then(() => ended = true);
  await until(() => log().some((c) => c.type === "prompt"));
  ctrl.abort();
  await until(() => ended, 1000);
  await done;
  assert(log().filter((c) => c.type === "abort").length >= 2, "The prompt started after abort had already returned idle");
  assert(events.some((e) => e.t === "done" && e.finish === "aborted"));
`));

test("Pi Stop drains in-flight steering preflight before releasing the thread", () => reproduce("late-steer", `
  const ctrl = new AbortController();
  const events = [];
  const done = collect(runTurn(req, ctrl.signal), events);
  await until(() => events.some((e) => e.t === "text"));
  const steering = steer(req.threadId, "late-steer-1", "Do not leak this into the next reply").then(() => "accepted", () => "cancelled");
  await until(() => log().some((c) => c.type === "steer"));
  ctrl.abort();
  await done;
  assert.equal(await steering, "cancelled", "An in-flight steer was reported accepted after Stop");
  const commands = log().map((c) => c.type);
  assert(commands.lastIndexOf("clear_queue") > commands.indexOf("steer_accepted"), "A steer accepted after abort was left in Pi's queue");
`));

test("Pi drains steering that is accepted after the final agent_settled event", () => reproduce("late-steer-finish", `
  const events = [];
  const done = collect(runTurn(req, new AbortController().signal), events);
  await until(() => events.some((e) => e.t === "text"));
  const steering = steer(req.threadId, "late-steer-1", "Do not leak this into the next reply").then(() => "accepted", () => "cancelled");
  await done;
  assert.equal(await steering, "cancelled");
  const commands = log().map((c) => c.type);
  assert(commands.lastIndexOf("clear_queue") > commands.indexOf("steer_accepted"));
`));

test("Pi cancels a turn waiting for the previous owner without aborting that owner", () => reproduce("queue", `
  const first = new AbortController();
  const events = [];
  const active = collect(runTurn(req, first.signal), events);
  await until(() => events.some((e) => e.t === "text"));
  const next = new AbortController();
  let ended = false;
  const waiting = collect(runTurn(req, next.signal)).then(() => ended = true);
  next.abort();
  await until(() => ended, 1000);
  assert.equal(log().filter((c) => c.type === "prompt").length, 1);
  assert.equal(log().filter((c) => c.type === "abort").length, 0);
  first.abort();
  await Promise.all([active, waiting]);
`));

test("Pi does not start a process for a turn that was already stopped", () => reproduce("queue", `
  const ctrl = new AbortController();
  ctrl.abort();
  const events = await collect(runTurn(req, ctrl.signal));
  assert.equal(log().length, 0);
  assert(events.some((e) => e.t === "done" && e.finish === "aborted"));
`));

test("Pi rewind only counts the active branch, not abandoned user messages", () => reproduce("branch", `
  const events = await collect(runTurn({ ...req, prior: 1 }, new AbortController().signal));
  assert(!log().some((c) => c.type === "fork"), "A normal continuation forked to an abandoned branch");
  assert.equal(log().find((c) => c.type === "prompt_context").leafId, "active-a1");
  assert(events.some((e) => e.t === "done"));
`));

test("Pi rewind includes image-only user messages when locating an edited turn", () => reproduce("image", `
  await collect(runTurn({ ...req, prior: 1 }, new AbortController().signal));
  assert.equal(log().find((c) => c.type === "fork")?.entryId, "u2");
  assert.equal(log().find((c) => c.type === "prompt_context").leafId, "a1");
`));

for (const message of ["/handled", "/fail"]) {
  test(`Pi removes the abort listener after ${message}, so an old Stop cannot kill the next turn`, () => reproduce("listeners", `
    const old = new AbortController();
    await collect(runTurn({ ...req, message: ${JSON.stringify(message)} }, old.signal));
    const ctrl = new AbortController();
    const events = [];
    const done = collect(runTurn(req, ctrl.signal), events);
    await until(() => events.some((e) => e.t === "text"));
    old.abort();
    await Bun.sleep(50);
    assert.equal(log().filter((c) => c.type === "abort").length, 0, "A finished turn aborted a later turn");
    ctrl.abort();
    await done;
  `));
}

test("Pi dismisses stopped extension dialogs instead of replaying dead questions", () => reproduce("ask", `
  const ctrl = new AbortController();
  const events = [];
  const done = collect(runTurn(req, ctrl.signal), events);
  await until(() => events.some((e) => e.t === "ask"));
  ctrl.abort();
  await done;
  assert.equal(answer(req.threadId, "dialog-1", { value: "Yes" }), false, "A stopped question still accepts answers");
  const next = await collect(runTurn(req, new AbortController().signal));
  assert(!next.some((e) => e.t === "ask"), "A dead question reappeared in the next reply");
  assert(log().some((c) => c.type === "extension_ui_response" && c.cancelled === true));
`));

test("Pi Stop bounds shutdown even when a tool ignores abort and SIGTERM", () => reproduce("stuck", `
  const ctrl = new AbortController();
  const events = [];
  const done = collect(runTurn(req, ctrl.signal), events);
  await until(() => events.some((e) => e.t === "text"));
  ctrl.abort();
  let ended = false;
  done.then(() => ended = true);
  await until(() => ended, 8000);
  assert(events.some((e) => e.t === "done" && e.finish === "aborted"));
  const next = await collect(runTurn({ ...req, message: "/handled" }, new AbortController().signal));
  assert(next.some((e) => e.t === "done" && e.finish === "handled"));
  assert.equal(log().filter((c) => c.type === "fixture_start").length, 2, "The next turn reused the dead process");
`), 12_000);

test("Pi RPC waits out a compaction before timing out the command that set it off", () => reproduce("compaction", `
  const { PiProcess } = await import("./server/pi/rpc.ts");
  const proc = new PiProcess(["--no-session"], req.cwd);
  try {
    // The compaction takes longer than the answer's deadline; the prompt is still answered.
    const accepted = await proc.send({ type: "prompt", message: "Work" }, 150);
    assert.equal(accepted.disposition, "started");
    // Once the compaction is over the deadline runs again, so a Pi that never answers still fails.
    const started = Date.now();
    await assert.rejects(proc.send({ type: "prompt", message: "/compact-mute" }, 150), /didn't answer "prompt" in time/);
    assert(Date.now() - started >= 500, "The deadline didn't wait for the compaction to finish");
  } finally { proc.close(0); }
`));
