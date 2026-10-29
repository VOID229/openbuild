import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// All imports of remote/worker happen in a child with isolated data, before module evaluation.
const SCENARIO = String.raw`
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const { workerSocket, WORKER_FEATURES } = await import(process.env.WORKER);
const data = process.env.OPENCHAT_DATA_DIR;
const generation = "agent-worker-" + createHash("sha256").update(JSON.stringify([...WORKER_FEATURES].sort())).digest("hex").slice(0,16);
const request = (threadId, id, runtime = "cursor") => ({ threadId, runtime, cwd: data, model: runtime + "/test", effort: "off", prior: 0, message: "once", stream: { id } });
const record = (req, status = "pending") => ({ id: req.stream.id, threadId: req.threadId, kind: "run", request: req, status, startedAt: 1 });
const oldRequest = request("legacy-thread", "legacy-reply");
const oldFinished = request("legacy-idle", "legacy-finished");
const oldLive = request("legacy-live", "legacy-live-finished", "codex");
const lanes = [], signals = [], released = [];
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => signals.push(signal));
function lane(name, features, records = [], idle = []) {
  const directory = join(data, name); mkdirSync(directory, { recursive: true });
  const socket = workerSocket(directory), paths = [], starts = [], answers = [];
  const state = { name, socket, paths, starts, answers, records };
  const server = Bun.serve({ unix: socket, async fetch(req) {
    const url = new URL(req.url), path = url.pathname; paths.push(path);
    const body = req.method === "POST" ? await req.json() : {};
    if (path === "/health") return Response.json({ pid: process.pid, protocol: 1, features });
    if (path === "/runs") { const r = records.find(r => r.id === url.searchParams.get("id")); return r ? Response.json(r) : new Response(null, { status: 404 }); }
    if (path === "/events") return new Response(JSON.stringify({ t: "text", v: name }) + "\n" + JSON.stringify({ t: "end" }) + "\n");
    if (path === "/snapshots") return Response.json(records.map(r => ({ ...r, events: [], eventCount: 0 })));
    if (path === "/records") return Response.json(records);
    if (path === "/ownership") return Response.json({ live: [...records.filter(r => r.status === "pending").map(r => r.threadId), ...idle], owned: records.map(r => r.threadId) });
    if (path === "/start") { starts.push(body); const r = record(body); records.push(r); return Response.json(r); }
    if (path === "/answer") { answers.push(body); return Response.json(records.some(r => r.threadId === body.threadId)); }
    if (path === "/stop") { const r = records.find(r => r.id === body.id); if (r) r.status = "aborted"; return Response.json({ found: !!r }); }
    if (path === "/release") { released.push(body.threadId); idle.splice(0, idle.length, ...idle.filter(id => id !== body.threadId)); return Response.json({ ok: true }); }
    if (["/threads/stop", "/threads/delete", "/restartIdle", "/steer", "/compact"].includes(path)) return Response.json({ handled: true });
    throw new Error("Unexpected " + name + path);
  }});
  writeFileSync(join(directory, "worker.json"), JSON.stringify({ pid: process.pid, socket, protocol: 1 }));
  lanes.push({ ...state, server }); return state;
}
const main = lane("pi-worker", ["cursor", "codex", "idle-retire"], [record(oldRequest), record(oldFinished, "finished"), record(oldLive, "finished"), record(request("OTHER-thread", "OTHER-reply", "pi"))], ["legacy-live"]);
const historical = lane("agent-worker-0000000000000000", WORKER_FEATURES, [record(request("historical-thread", "historical-reply"))]);
const opencode = lane("opencode-worker", ["opencode", "idle-retire"], [record(request("opencode-old", "opencode-old-reply", "opencode"), "finished")]);
const current = lane(generation, WORKER_FEATURES);
try {
  const remote = await import(process.env.REMOTE);
  await remote.recover();
  assert.equal(remote.ownsSession("historical-thread"), true);
  assert.equal(remote.isSessionLive("OTHER-thread"), true);
  // Existing stable IDs replay on original owner without runtime-questions admission gate.
  const replay = await remote.startRun(oldRequest);
  assert.equal(replay.id, oldRequest.stream.id);
  assert.match(await new Response(replay.stream()).text(), /pi-worker/);
  await assert.rejects(remote.startRun({ ...oldRequest, message: "changed prompt" }), e => e.status === 409);
  await assert.rejects(remote.startRun(request("legacy-thread", "second-old")), e => e.code === "busy");
  // An idle thread on an outdated owner moves to the current lane instead of being stranded.
  const moved = await remote.startRun({ ...request("legacy-idle", "second-idle"), stream: { id: "second-idle" } });
  assert.match(await new Response(moved.stream()).text(), new RegExp(generation));
  assert.deepEqual(released, []); // no live native process to close
  await remote.startRun(request("legacy-idle", "third-idle")).then(() => assert.fail("pending turn must not be bypassed"), e => assert.equal(e.code, "busy"));
  current.records.find(r => r.id === "second-idle").status = "finished";
  await remote.startRun(request("legacy-idle", "third-idle")); // the latest run's lane now owns it
  // A live idle native process is released before its session resumes elsewhere.
  await remote.startRun(request("legacy-live", "legacy-live-next", "codex"));
  assert.deepEqual(released, ["legacy-live"]);
  assert.equal(main.starts.length, 0);
  assert.equal(current.starts.length, 3);
  // A new Cursor thread starts while OTHER-thread is pending in the incompatible main worker.
  const fresh = request("new-cursor", "new-cursor-reply");
  const simultaneous = await Promise.all([remote.startRun(fresh), remote.startRun(fresh)]);
  assert.equal(simultaneous[0].id, simultaneous[1].id);
  assert.equal(current.starts.length, 4);
  await assert.rejects(remote.startRun(request("new-cursor", "second-cursor")), e => e.code === "busy");
  for (const runtime of ["claude", "codex", "fx", "opencode"]) await remote.startRun(request("new-" + runtime, "new-" + runtime + "-reply", runtime));
  assert.equal(current.starts.length, 8); // incompatible OpenCode gets generation fallback
  await assert.rejects(remote.startRun(request("new-codex", "second-codex", "codex")), e => e.code === "busy");
  const codexReplay = await remote.startRun(request("new-codex", "new-codex-reply", "codex"));
  assert.equal(codexReplay.id, "new-codex-reply");
  assert.equal(current.starts.length, 8);
  assert.equal(opencode.starts.length, 0);
  await remote.recover(); // HTTP reattachment rediscovers pending lane ownership/approvals
  assert.equal(remote.isSessionLive("new-cursor"), true);
  assert.equal(await remote.answer("new-cursor", "ask-1", { value: "approved" }), true);
  assert.equal(current.answers.at(-1).reply.value, "approved");
  assert.equal((await remote.findRun(fresh.stream.id)).id, fresh.stream.id);
  assert.equal((await remote.findRun("historical-reply")).threadId, "historical-thread");
  assert.equal((await remote.snapshots()).length, 14);
  assert.equal((await remote.listRuns()).length, 14);
  await remote.steer("new-codex", "steer-1", "continue");
  assert.equal(current.paths.includes("/steer"), true);
  assert.equal(await remote.stopRun(fresh.stream.id), true);
  assert.equal(current.records.find(r => r.id === fresh.stream.id).status, "aborted");
  await remote.stopThread("historical-thread"); await remote.release("historical-thread"); await remote.deleteThread("historical-thread");
  assert.equal(historical.paths.includes("/threads/delete"), true);
  for (const l of lanes) assert.equal(l.paths.includes("/retire"), false);
  assert.deepEqual(signals, []);
  console.log("native lanes safe");
} finally { for (const l of lanes) l.server.stop(true); }
process.exit(0);
`;

test("native feature lanes isolate new admissions and preserve historical ownership/replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ob-native-upgrade-"));
  try {
    const child = Bun.spawn([process.execPath, "--eval", SCENARIO], {
      env: { ...process.env, OPENCHAT_DATA_DIR: directory, PI_CODING_AGENT_DIR: join(directory, "agent"), WORKER: resolve("server/pi/worker.ts"), REMOTE: resolve("server/pi/remote.ts") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr, stdout }).toEqual({ code: 0, stderr: "", stdout: "native lanes safe\n" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30_000);

const CLEANUP = String.raw`
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const directory = join(process.env.OPENCHAT_DATA_DIR, "agent-worker-0123456789abcdef"); mkdirSync(directory, { recursive: true });
// argv identifies a fixture process as this installation's worker, as required by CLI's PID fence.
const child = Bun.spawn([process.execPath, "--eval", "setInterval(() => {}, 1000)", process.env.WORKER], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
writeFileSync(join(directory, "worker.json"), JSON.stringify({ pid: child.pid }));
try {
  for (const args of [["stop"], ["stop", "--all"]]) {
    const cli = Bun.spawn([process.execPath, process.env.CLI, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const code = await cli.exited; assert.equal(code, 0, await new Response(cli.stderr).text());
    if (args.length === 1) { process.kill(child.pid, 0); assert.equal(child.exitCode, null); }
  }
  await Promise.race([child.exited, Bun.sleep(5000).then(() => { throw new Error("stop --all missed feature lane"); })]);
  console.log("cleanup safe");
} finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
`;

test("CLI normal stop preserves versioned workers; explicit stop --all cleans them up", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ob-native-cli-"));
  try {
    const child = Bun.spawn([process.execPath, "--eval", CLEANUP], {
      env: { ...process.env, OPENCHAT_DATA_DIR: directory, OPENBUILD_SYSTEMD: "0", WORKER: resolve("server/pi/worker.ts"), CLI: resolve("bin/openbuild.ts") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr, stdout }).toEqual({ code: 0, stderr: "", stdout: "cleanup safe\n" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 20_000);
