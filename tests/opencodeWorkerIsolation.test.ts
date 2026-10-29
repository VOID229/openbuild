import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FAKE_OPENCODE } from "./opencodeFixture";

// Run the module wrappers in a fresh process: their data directory and storage imports
// must never inherit another test's singleton clients or touch developer-owned workers.
const ISOLATION = String.raw`
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const { workerSocket, secureSocketPath } = await import(process.env.FIXTURE_WORKER_MODULE);
const data = process.env.OPENCHAT_DATA_DIR;
const directory = join(data, "pi-worker");
mkdirSync(directory, { recursive: true });
const socket = workerSocket(directory);
secureSocketPath(socket);
const paths = [], signals = [];
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => signals.push(signal));
const ordinary = {
  id: "reply-ordinary-0123456789abcdef", threadId: "ordinary-thread", kind: "run",
  request: { runtime: "pi", threadId: "ordinary-thread", cwd: data, model: "test/model", message: "still working", effort: "off", prior: 0 },
  status: "pending", startedAt: Date.now(),
};
let starts = 0;
const main = Bun.serve({ unix: socket, async fetch(req) {
  const url = new URL(req.url), path = url.pathname;
  paths.push(path);
  if (path === "/health") return Response.json({ pid: process.pid, protocol: 1, features: ["idle-retire"] });
  if (path === "/records") return Response.json([ordinary]);
  if (path === "/ownership") return Response.json({ live: [ordinary.threadId], owned: [ordinary.threadId] });
  if (path === "/snapshots") return Response.json([{ ...ordinary, events: [{ t: "text", v: "ordinary work remains live" }], eventCount: 1 }]);
  if (path === "/runs") return url.searchParams.get("id") === ordinary.id ? Response.json(ordinary) : new Response(null, { status: 404 });
  if (path === "/retire") return Response.json({ error: "Existing ordinary turn is still pending", code: "busy" }, { status: 409 });
  if (path === "/start") { starts++; return Response.json({ error: "Legacy worker does not support OpenCode" }, { status: 400 }); }
  return new Response(null, { status: 404 });
}});
// Real metadata makes this a discoverable, live main lane, not a mocked fetch.
writeFileSync(join(directory, "worker.json"), JSON.stringify({ pid: process.pid, socket, protocol: 1 }));
try {
  const remote = await import(process.env.FIXTURE_REMOTE_MODULE);
  await remote.recover();
  assert.equal(remote.isSessionLive(ordinary.threadId), true);
  const run = await remote.startRun({
    threadId: "isolated-opencode-thread", runtime: "opencode", cwd: data,
    model: "opencode/test/fake-1", effort: "off", prior: 0, message: "isolated work",
    stream: { id: "reply-isolated-opencode-0123456789abcdef" },
  });
  const response = await new Response(run.stream()).text();
  const events = response.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.at(-1).t, "end");
  assert.equal(events.some(event => event.t === "error"), false, response);
  assert.equal(events.filter(event => event.t === "text").map(event => event.v).join(""), "Started-\n\nfinished offline");
  const snapshots = await remote.snapshots();
  assert.equal(snapshots.find(r => r.id === ordinary.id)?.status, "pending");
  assert.equal(snapshots.find(r => r.id === run.id)?.status, "finished");
  await remote.refreshOwnership();
  assert.equal(remote.isSessionLive(ordinary.threadId), true);
  const health = await fetch("http://pi/health", { unix: socket });
  assert.equal((await health.json()).pid, process.pid);
  const worker = JSON.parse(readFileSync(join(data, "opencode-worker", "worker.json"), "utf8"));
  assert.notEqual(worker.pid, process.pid);
  assert.notEqual(worker.socket, socket);
  assert.equal(starts, 0);
  assert.equal(paths.includes("/retire"), false, JSON.stringify(paths));
  assert.deepEqual(signals, []);
  assert.equal(readFileSync(process.env.FAKE_EFFECTS, "utf8"), "isolated work\n");
  assert.equal(readFileSync(process.env.FAKE_TOOL_EFFECTS, "utf8"), "once\n");
  console.log("OpenCode completed independently; ordinary work remains pending; no retirement or signals");
} finally {
  main.stop(true);
}
process.exit(0);
`;

test("OpenCode completes in its own lane while an older main worker has live ordinary work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ob-opencode-isolation-"));
  const data = join(directory, "data");
  const fake = join(directory, "fake-opencode");
  const release = join(directory, "release");
  mkdirSync(data);
  writeFileSync(fake, `#!${process.execPath}\n` + FAKE_OPENCODE);
  chmodSync(fake, 0o700);
  writeFileSync(release, "complete immediately");
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    child = Bun.spawn([process.execPath, "--eval", ISOLATION], {
      env: {
        ...process.env, OPENCHAT_DATA_DIR: data, PI_CODING_AGENT_DIR: join(directory, "agent"),
        OPENCODE_BIN: fake, OPENCODE_SERVER_URL: "", OPENCODE_SERVER_PASSWORD: "",
        FAKE_RELEASE: release, FAKE_EFFECTS: join(directory, "effects"),
        FAKE_TOOL_EFFECTS: join(directory, "tools"), FAKE_PROTOCOL: join(directory, "protocol"),
        FAKE_HISTORY: join(directory, "history.json"),
        FIXTURE_WORKER_MODULE: resolve("server/pi/worker.ts"),
        FIXTURE_REMOTE_MODULE: resolve("server/pi/remote.ts"),
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("OpenCode completed independently");
  } finally {
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    // Only the real detached fixture lane is signalled. The main mock exits itself.
    try {
      const metadata = JSON.parse(readFileSync(join(data, "opencode-worker", "worker.json"), "utf8"));
      const group = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(metadata.pid)]);
      if (Number.isSafeInteger(metadata.pid) && metadata.pid > 1 && metadata.pid !== process.pid) {
        const leader = Number(group.stdout.toString().trim()) === metadata.pid;
        try { process.kill(leader ? -metadata.pid : metadata.pid, "SIGKILL"); } catch {}
      }
      rmSync(metadata.socket, { force: true });
    } catch {}
    // workerSocket is deterministic; the mock's socket may remain after a failed child.
    const { workerSocket } = await import("../server/pi/worker");
    rmSync(workerSocket(join(data, "pi-worker")), { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}, 40_000);
