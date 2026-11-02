import { expect, test, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DurableRuntime } from "../server/durable";
import type { PiChatRequest } from "../shared/types";
import { fakeModels } from "./durable-fake";

const request = (model: string): PiChatRequest => ({ threadId: "lifecycle-thread", cwd: tmpdir(), model, effort: "off", message: "hi", prior: 0, stream: { id: "lifecycle-run" } });
async function until(fn: () => boolean) {
  const end = Date.now() + 3000;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await Bun.sleep(5); }
}
const manifestFile = (directory: string, id = "lifecycle-run") => join(directory, "runs", createHash("sha256").update(id).digest("hex") + ".json");

test("Durable recovers a committed submit whose acknowledgement was lost", async () => {
  const directory = mkdtempSync(join(tmpdir(), "durable-submit-ack-"));
  const fake = fakeModels({ hold: true });
  const runtime = new DurableRuntime(directory, fake.models);
  let reopened: DurableRuntime | undefined;
  try {
    const req = request(fake.model);
    const { root } = await (runtime as any).thread(req.threadId);
    const submit = root.submit.bind(root);
    root.submit = async (...args: unknown[]) => { await submit(...args); throw new Error("lost submit acknowledgement"); };
    await expect(runtime.startRun(req)).rejects.toThrow("lost submit acknowledgement");
    const manifest = JSON.parse(readFileSync(manifestFile(directory), "utf8"));
    expect(manifest.ended).toBe(false);
    expect(manifest.submitted).toBe(true);
    expect((runtime as any).watches.size).toBe(0);
    await until(() => fake.calls() === 1);
    await runtime.close();
    const fresh = fakeModels();
    reopened = new DurableRuntime(directory, fresh.models);
    await reopened.recover();
    const replay = await reopened.findRun(req.stream!.id);
    await until(() => !!replay?.ended);
    expect(replay!.events.filter(e => e.t === "text")).toEqual([{ t: "text", v: "offline answer" }]);
    expect(fresh.requests[0]!.input.messages.filter(m => m.role === "user")).toHaveLength(1);
  } finally { await reopened?.close(); await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Durable recovery honors persisted Stop without resubmitting the cancelled input", async () => {
  const directory = mkdtempSync(join(tmpdir(), "durable-cancelled-replay-"));
  const fake = fakeModels();
  const runtime = new DurableRuntime(directory, fake.models);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const req = request(fake.model);
    mkdirSync(join(directory, "runs"));
    writeFileSync(manifestFile(directory), JSON.stringify({ version: 1, id: req.stream!.id, request: req, baseline: [], seen: [], events: [], ended: false, stopping: true }));
    const { root } = await (runtime as any).thread(req.threadId);
    let submissions = 0;
    root.submit = async () => { submissions++; throw new Error("cancelled input must not be submitted"); };
    await runtime.recover();
    expect(submissions).toBe(0);
    const run = await runtime.findRun(req.stream!.id);
    expect(run?.ended).toBe(true);
    expect(run?.events.at(-1)).toMatchObject({ t: "done", finish: "aborted" });
    expect(fake.calls()).toBe(0);
  } finally { await runtime.close(); log.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
});

test("Durable persists Stop intent while an admission acknowledgement is stalled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "durable-stalled-admission-"));
  const fake = fakeModels();
  const runtime = new DurableRuntime(directory, fake.models);
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let admission: ReturnType<DurableRuntime["startRun"]> | undefined;
  let stopping: Promise<boolean> | undefined;
  try {
    const req = request(fake.model);
    const { root } = await (runtime as any).thread(req.threadId);
    const configure = root.configure.bind(root);
    root.configure = async (...args: unknown[]) => { entered.resolve(); await released.promise; return configure(...args); };
    admission = runtime.startRun(req);
    await entered.promise;
    stopping = runtime.stopRun(req.stream!.id);
    // Stop cannot safely cross an unsettled admission. Its acknowledgement can remain blocked,
    // but cancellation intent must already be durable and prevent submission when it unblocks.
    const status = await Promise.race([stopping.then(() => "stopped"), Bun.sleep(30).then(() => "admission-blocked")]);
    expect(status).toBe("admission-blocked");
    expect(JSON.parse(readFileSync(manifestFile(directory), "utf8")).stopping).toBe(true);
    released.resolve();
    const run = await admission;
    expect(await stopping).toBe(true);
    expect(run.ended).toBe(true);
    expect(run.events.at(-1)).toMatchObject({ t: "done", finish: "aborted" });
    expect(fake.calls()).toBe(0);
  } finally { released.resolve(); await admission; await stopping; await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Durable Stop cancels orphaned work after submit acknowledgement failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "durable-orphan-stop-"));
  const fake = fakeModels({ hold: true });
  const runtime = new DurableRuntime(directory, fake.models);
  try {
    const req = request(fake.model);
    const { root } = await (runtime as any).thread(req.threadId);
    const submit = root.submit.bind(root);
    root.submit = async (...args: unknown[]) => { await submit(...args); throw new Error("lost acknowledgement"); };
    await expect(runtime.startRun(req)).rejects.toThrow("lost acknowledgement");
    await until(() => fake.calls() === 1);
    expect(await runtime.stopRun(req.stream!.id)).toBe(true);
    expect(fake.requests[0]!.signal!.aborted).toBe(true);
    expect((await runtime.findRun(req.stream!.id))?.events.at(-1)).toMatchObject({ t: "done", finish: "aborted" });
  } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Durable Stop cannot cross from the finishing run into the next admission", async () => {
  const directory = mkdtempSync(join(tmpdir(), "durable-stop-owner-"));
  const fake = fakeModels({ hold: true });
  const runtime = new DurableRuntime(directory, fake.models);
  const abortEntered = Promise.withResolvers<void>();
  const releaseAbort = Promise.withResolvers<void>();
  let stopping: Promise<boolean> | undefined;
  try {
    const req = request(fake.model);
    const first = await runtime.startRun(req);
    await until(() => fake.calls() === 1);
    const { root } = await (runtime as any).thread(req.threadId);
    const abort = root.abort.bind(root);
    root.abort = async (...args: unknown[]) => { abortEntered.resolve(); await releaseAbort.promise; return abort(...args); };
    stopping = runtime.stopRun(first.id);
    await abortEntered.promise;
    fake.release(); // the old provider finishes while cancellation is in flight
    await until(() => first.ended);
    const admitting = runtime.startRun({ ...req, prior: 1, stream: { id: "next-run" } });
    await Bun.sleep(30);
    const callsBeforeAbort = fake.calls();
    releaseAbort.resolve();
    await stopping;
    const next = await admitting;
    await until(() => fake.calls() === 2);
    expect(callsBeforeAbort).toBe(1);
    expect(next.ended).toBe(false);
    expect(fake.requests[1]!.signal!.aborted).toBe(false);
    root.abort = abort;
    await runtime.stopRun(next.id);
  } finally { releaseAbort.resolve(); await stopping; await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Durable recovers committed actions hidden by a compaction before host projection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "durable-compacted-replay-"));
  const fake = fakeModels({ tool: true });
  const runtime = new DurableRuntime(directory, fake.models);
  let reopened: DurableRuntime | undefined;
  try {
    const req = request(fake.model);
    const run = await runtime.startRun(req);
    await until(() => run.ended);
    const { root } = await (runtime as any).thread(req.threadId);
    // A compaction's head hides an older committed prefix from watch.value.entries, not storage.
    await root.commit((tx: any) => tx.appendEntry(root.id, { kind: "pi.compaction", head: "self", model: [{ role: "user", content: "summary", timestamp: Date.now() }] }), context);
    await runtime.close();
    // Crash after SDK commits, before the host has projected the completed entries/final state.
    const file = manifestFile(directory);
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(manifest, { events: [], seen: [], usage: {}, ended: false });
    writeFileSync(file, JSON.stringify(manifest));
    const fresh = fakeModels();
    reopened = new DurableRuntime(directory, fresh.models);
    await reopened.recover();
    const replay = await reopened.findRun(req.stream!.id);
    await until(() => !!replay?.ended);
    expect(replay!.events.filter(e => e.t === "text").map(e => e.v)).toEqual(["before tool", "offline answer"]);
    expect(replay!.events.filter(e => e.t === "tool").map(e => e.status)).toEqual(["running", "done"]);
    expect(fresh.calls()).toBe(0);
    const next = await reopened.startRun({ ...req, prior: 1, stream: { id: "after-compaction" } });
    await until(() => next.ended);
    expect(next.events.filter(e => e.t === "text").map(e => e.v)).toEqual(["offline answer"]);
    expect(fresh.requests[0]!.input.messages.some(m => m.role === "user" && m.content === "summary")).toBe(true);
  } finally { await reopened?.close(); await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Durable reattaches after its asynchronous completion watcher fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "durable-waiter-retry-"));
  const fake = fakeModels();
  const runtime = new DurableRuntime(directory, fake.models);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const req = request(fake.model);
    const { root } = await (runtime as any).thread(req.threadId);
    const watch = root.watch.bind(root);
    let watches = 0;
    root.watch = (...args: unknown[]) => ++watches === 3 ? Promise.reject(new Error("snapshot temporarily unavailable")) : watch(...args);
    const run = await runtime.startRun(req);
    await until(() => log.mock.calls.length > 0);
    expect(run.ended).toBe(false);
    root.watch = watch;
    expect(await runtime.startRun(req)).toBe(run);
    await until(() => run.ended);
    expect(fake.calls()).toBe(1);
    expect(run.events.filter(e => e.t === "text")).toHaveLength(1);
  } finally { await runtime.close(); log.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
});
