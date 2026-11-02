// Offline evidence for Stop arriving before /api/pi/chat has registered its run. The route and
// cancellation branch are real; only Pi is a fake executable and all files are temporary.
import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Stop acknowledged before run admission prevents the late Pi prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-transport-admission-"));
  const bin = join(dir, "pi");
  await writeFile(bin, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "fixtures/pi-rpc.mjs")}' "$@"\n`);
  await chmod(bin, 0o700);
  const script = `
    import { strict as assert } from "node:assert";
    import { mkdirSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    const { piRoutes } = await import("./server/pi/routes.ts");
    const { findRun } = await import("./server/runs.ts");
    const { requestRunStop } = await import("./server/runStops.ts");
    const { isStreamId } = await import("./shared/replies.ts");
    const durable = await import("./server/durable/index.ts");
    const { release } = await import("./server/pi/sessions.ts");
    const cwd = join(process.env.OPENCHAT_DATA_DIR, "scratch", "offline");
    mkdirSync(cwd, { recursive: true });
    const id = "stop-before-admission-0123456789";
    const body = { threadId: "test-thread-admission", cwd, model: "test/model", effort: "off", prior: 0, message: "Must not start after Stop", stream: { id } };
    const routes = piRoutes(handler => handler);
    let admit;
    const request = { json: () => new Promise(resolve => { admit = resolve; }) };
    const pending = routes["/api/pi/chat"].POST(request, { timeout() {} });
    assert.equal(findRun(id), undefined);
    // Exact server/index.ts Stop branch, with no listening server or network request.
    if (isStreamId(id)) {
      requestRunStop(id);
      const run = findRun(id);
      if (run) run.stop();
      else await durable.stopRun(id);
    }
    const acknowledged = Response.json({ ok: true });
    assert.deepEqual(await acknowledged.json(), { ok: true });
    admit(body);
    const response = await pending;
    assert.equal(response.status, 200);
    const until = async fn => { for (let n = 0; n < 400 && !fn(); n++) await Bun.sleep(5); assert(fn(), "offline Pi did not receive late prompt"); };
    const records = () => { try { return readFileSync(process.env.PI_TEST_LOG, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
    try {
      await until(() => findRun(id)?.ended);
      await Bun.sleep(30);
      assert(!records().some(r => r.type === "prompt"), "A late prompt started after Stop");
      assert.equal(findRun(id).signal.aborted, true);
      console.log(JSON.stringify({ stopAcknowledged: true, latePromptStarted: false, runAborted: true }));
    } finally {
      findRun(id)?.stop();
      await response.body?.cancel();
      release(body.threadId);
    }
    process.exit(0);
  `;
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, OPENCHAT_DATA_DIR: join(dir, "data"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"), PI_BIN: bin, PI_TEST_CASE: "queue", PI_TEST_LOG: join(dir, "commands.jsonl") },
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      expect(JSON.parse(out)).toEqual({ stopAcknowledged: true, latePromptStarted: false, runAborted: true });
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  } finally {
    const log = await readFile(join(dir, "commands.jsonl"), "utf8").catch(() => "");
    for (const line of log.trim().split("\n").filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.type === "fixture_start") { try { process.kill(record.pid, "SIGKILL"); } catch {} }
    }
    await rm(dir, { recursive: true, force: true });
  }
});
