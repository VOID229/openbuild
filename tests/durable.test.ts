import { describe, test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableRuntime } from "../server/durable";
import type { PiChatRequest } from "../shared/types";
import { fakeModels } from "./durable-fake";

const request = (model: string): PiChatRequest => ({ threadId: "test-durable-thread", cwd: tmpdir(), model, effort: "off", message: "hi", prior: 0, stream: { id: "durable-test-request" } });
async function until(fn: () => boolean) {
  const end = Date.now() + 15000;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await Bun.sleep(10); }
}
describe("durable runtime (offline)", () => {
  test("HTML output publishes a page and replays identically after reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-html-"));
    const fake = fakeModels({ answer: '```openbuild-html\n<title>Demo</title><button onclick="this.textContent=42">Run</button>\n```' });
    const req = request(fake.model);
    let runtime = new DurableRuntime(directory, fake.models);
    try {
      const run = await runtime.startRun(req);
      await until(() => run.ended);
      const pages = run.events.filter(e => e.t === "tool" && e.name === "html_render");
      expect(pages).toHaveLength(1);
      expect(pages[0]).toMatchObject({ status: "done", args: { title: "Demo" } });
      expect(run.events.some(e => e.t === "text")).toBe(false);
      await runtime.close();
      runtime = new DurableRuntime(directory, fake.models);
      const replay = await runtime.findRun(run.id);
      expect(replay?.events.filter(e => e.t === "tool" && e.name === "html_render")).toEqual(pages);
      expect(fake.calls()).toBe(1);
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  test("manifest persisted before submit is admitted on startup; concurrent retry is deduplicated", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-admission-"));
    const fake = fakeModels();
    const req = request(fake.model);
    const id = req.stream!.id;
    // Fault injection: the exact persisted host state if the process dies immediately BEFORE submit.
    mkdirSync(join(directory, "runs"));
    writeFileSync(join(directory, "runs", createHash("sha256").update(id).digest("hex") + ".json"), JSON.stringify({ version: 1, id, request: req, baseline: [], seen: [], events: [], ended: false }));
    const runtime = new DurableRuntime(directory, fake.models);
    try {
      await runtime.recover();
      const [a, b] = await Promise.all([runtime.startRun(req), runtime.startRun(req)]);
      expect(a).toBe(b);
      await until(() => a.ended);
      expect(fake.calls()).toBe(1);
      expect(a.events.filter(e => e.t === "text")).toEqual([{ t: "text", v: "offline answer" }]);
      await expect(runtime.startRun({ ...req, stream: { id: "new-run" }, prior: 0 })).rejects.toThrow("rewinds/imports");
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  test("rejected UI turns do not permanently prevent the next Durable admission", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-ui-gaps-"));
    const fake = fakeModels({ hold: true });
    const runtime = new DurableRuntime(directory, fake.models);
    const req = request(fake.model);
    try {
      const first = await runtime.startRun(req);
      await until(() => fake.calls() > 0);
      await expect(runtime.startRun({ ...req, prior: 1, stream: { id: "busy-rejected" } })).rejects.toThrow("still working");
      await runtime.stopRun(first.id);
      await until(() => first.ended);
      // The UI now counts the rejected user message too, unlike the authoritative transcript.
      const next = await runtime.startRun({ ...req, prior: 2, stream: { id: "after-busy" } });
      await until(() => fake.calls() > 1);
      await runtime.stopRun(next.id);
      await until(() => next.ended);
      await expect(runtime.startRun({ ...req, prior: 1, stream: { id: "rewind" } })).rejects.toThrow("rewinds/imports");
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  test("an admission failure before submit does not wedge the thread forever", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-admission-failure-"));
    const fake = fakeModels();
    const req = request(fake.model);
    const runtime = new DurableRuntime(directory, fake.models);
    try {
      // Fault injection at configure, after the manifest was persisted. The thread is already open,
      // so this is the same root.configure() call driveImpl() makes.
      const thread = await (runtime as any).thread(req.threadId);
      const configure = thread.root.configure;
      thread.root.configure = async () => { throw new Error("bad workspace"); };
      await expect(runtime.startRun(req)).rejects.toThrow("bad workspace");
      const manifest = (runtime as any).manifests.get(req.stream!.id);
      expect(manifest.ended).toBe(true);
      expect(manifest.submitted).toBeUndefined();
      const failed = await runtime.findRun(req.stream!.id);
      expect(failed?.ended).toBe(true);
      expect(failed!.events).toMatchObject([{ t: "error", message: "bad workspace" }, { t: "done", finish: "error" }]);
      // The failed turn still counts as an admitted turn, so the next one uses prior: 1.
      thread.root.configure = configure;
      const next = await runtime.startRun({ ...req, prior: 1, stream: { id: "after-failure" } });
      await until(() => next.ended);
      expect(fake.calls()).toBe(1);
      const persisted = JSON.parse(readFileSync(join(directory, "runs", createHash("sha256").update("after-failure").digest("hex") + ".json"), "utf8"));
      expect(persisted.submitted).toBe(true);
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  test("stopRun ends a wedged run that has no live drive", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-wedged-stop-"));
    const fake = fakeModels();
    const req = request(fake.model);
    const runtime = new DurableRuntime(directory, fake.models);
    try {
      // A manifest persisted by an earlier process, whose thread cannot currently be driven.
      mkdirSync(join(directory, "runs"));
      writeFileSync(join(directory, "runs", createHash("sha256").update(req.stream!.id).digest("hex") + ".json"), JSON.stringify({ version: 1, id: req.stream!.id, request: req, baseline: [], seen: [], events: [], ended: false }));
      (runtime as any).recovering = Promise.resolve(); // recovery barrier already passed
      (runtime as any).load();
      expect(await runtime.stopRun(req.stream!.id)).toBe(true);
      const run = await runtime.findRun(req.stream!.id);
      expect(run?.ended).toBe(true);
      expect(run!.events.at(-1)).toMatchObject({ t: "done", finish: "aborted" });
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  test("one thread failing to open does not prevent other startup recovery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-isolation-"));
    const fake = fakeModels();
    const broken = request(fake.model);
    const healthy = { ...broken, threadId: "healthy-durable-thread", stream: { id: "healthy-run" } };
    const hash = (id: string) => createHash("sha256").update(id).digest("hex");
    mkdirSync(join(directory, "runs"));
    mkdirSync(join(directory, "threads"));
    writeFileSync(join(directory, "threads", hash(broken.threadId)), "not a storage directory");
    writeFileSync(join(directory, "runs", hash("corrupt-run") + ".json"), "{corrupt");
    for (const req of [broken, healthy]) writeFileSync(join(directory, "runs", hash(req.stream!.id) + ".json"), JSON.stringify({ version: 1, id: req.stream!.id, request: req, baseline: [], seen: [], events: [], ended: false }));
    const log = spyOn(console, "error").mockImplementation(() => {});
    const runtime = new DurableRuntime(directory, fake.models);
    try {
      await runtime.recover();
      const run = await runtime.findRun(healthy.stream.id);
      await until(() => !!run?.ended);
      expect(run!.events.some(e => e.t === "text")).toBe(true);
      await expect(runtime.findRun(broken.stream!.id)).rejects.toThrow();
      await expect(runtime.findRun("corrupt-run")).rejects.toThrow();
      expect(log).toHaveBeenCalled();
      rmSync(join(directory, "threads", hash(broken.threadId)));
      // Advance only this instance's retry deadline; do not patch the global clock/SDK.
      (runtime as any).retryAt.set(broken.stream!.id, 0);
      const repaired = await runtime.findRun(broken.stream!.id);
      await until(() => !!repaired?.ended);
      expect(repaired!.events.some(e => e.t === "text")).toBe(true);
    } finally { await runtime.close(); log.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
  });
  test("transient model initialization failure is not cached forever", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-model-init-"));
    const fake = fakeModels();
    const runtime = new DurableRuntime(directory);
    let attempts = 0;
    Object.defineProperty(runtime, "suppliedModels", { get() {
      if (++attempts === 1) throw new Error("temporary initialization failure");
      return fake.models;
    } });
    try {
      await expect(runtime.startRun(request(fake.model))).rejects.toThrow("temporary initialization failure");
      const run = await runtime.startRun(request(fake.model));
      await until(() => run.ended);
      expect(fake.calls()).toBe(1);
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  test("deleted threads cannot resume or admit new work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-deleted-"));
    const fake = fakeModels({ hold: true });
    const runtime = new DurableRuntime(directory, fake.models);
    const req = request(fake.model);
    try {
      const run = await runtime.startRun(req);
      await until(() => fake.calls() > 0);
      await runtime.stopThread(req.threadId);
      await until(() => run.ended);
      expect(run.events.filter(e => e.t === "done")).toMatchObject([{ t: "done", finish: "aborted" }]);
      await expect(runtime.startRun(req)).rejects.toThrow("deleted");
      await runtime.close();
      // Simulate death after tombstone commit but before cancellation/finalization persisted.
      const path = join(directory, "runs", readdirSync(join(directory, "runs"))[0]!);
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.ended = false;
      manifest.events = manifest.events.filter((e: { t: string }) => e.t !== "done");
      writeFileSync(path, JSON.stringify(manifest));
      const fresh = fakeModels();
      const reopened = new DurableRuntime(directory, fresh.models);
      await reopened.recover();
      expect((await reopened.findRun(req.stream!.id))?.ended).toBe(true);
      expect(fresh.calls()).toBe(0);
      await reopened.close();
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  test("stop intent aborts work without requiring a client stream", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-stop-"));
    const fake = fakeModels({ hold: true });
    const runtime = new DurableRuntime(directory, fake.models);
    try {
      const req = request(fake.model);
      const run = await runtime.startRun(req);
      await until(() => fake.calls() > 0);
      expect(await runtime.stopRun(req.stream!.id)).toBe(true);
      await until(() => run.ended);
      expect(run.events.at(-1)).toMatchObject({ t: "done", finish: "aborted" });
      expect(await runtime.stopRun("missing")).toBe(false);
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  test("committed text/tools replay after reopen and requestId admits only once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-test-"));
    const fake = fakeModels({ tool: true });
    const runtime = new DurableRuntime(directory, fake.models);
    const req = request(fake.model);
    try {
      await expect(runtime.startRun({ ...req, model: "missing/model" })).rejects.toThrow("not available");
      expect(existsSync(join(directory, "runs"))).toBe(false);
      const { effort: _effort, ...withoutEffort } = req;
      const run = await runtime.startRun({ ...withoutEffort, apiKey: "never-save-me" } as unknown as PiChatRequest);
      await until(() => run.ended);
      const persisted = readdirSync(join(directory, "runs")).map(name => readFileSync(join(directory, "runs", name), "utf8")).join("");
      expect(persisted).not.toContain("never-save-me");
      expect(run.events.filter(e => e.t === "text").map(e => e.v)).toEqual(["before tool", "offline answer"]);
      expect(run.events.filter(e => e.t === "tool").map(e => e.status)).toEqual(["running", "done"]);
      expect(await runtime.startRun(req)).toBe(run);
      expect(fake.calls()).toBe(2);
      expect(run.events.at(-1)).toMatchObject({ t: "done", usage: { input: 2, output: 2, cost: 0, contextTokens: 2 } });
      await runtime.close();
      const fresh = fakeModels();
      const reopened = new DurableRuntime(directory, fresh.models);
      await reopened.recover();
      const replay = await reopened.findRun(req.stream!.id);
      expect(replay?.events).toEqual(run.events);
      expect(replay?.ended).toBe(true);
      expect(await reopened.startRun(withoutEffort as PiChatRequest)).toBe(replay!);
      expect(fresh.calls()).toBe(0);
      expect(await new Response(replay!.stream()).text()).toContain('"t":"end"');
      await expect(reopened.startRun({ ...req, message: "different" })).rejects.toThrow("different request");
      await reopened.close();
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  test("a bash command without a timeout is bounded and the turn continues", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-bash-timeout-"));
    // Like the stranded diagnostic: prints a result, then keeps its event loop alive.
    const fake = fakeModels({ tool: true, command: `${JSON.stringify(process.execPath)} -e 'console.log("diagnostic ready"); setInterval(() => {}, 1000)'` });
    const runtime = new DurableRuntime(directory, fake.models, { bashTimeoutSeconds: 0.2 });
    try {
      const run = await runtime.startRun(request(fake.model));
      await until(() => run.ended);
      expect(run.events.filter(e => e.t === "tool")).toMatchObject([
        { status: "running" },
        { status: "error", output: expect.stringContaining("timed out after 0.2 seconds") },
      ]);
      expect(run.events.some(e => e.t === "text" && e.v === "offline answer")).toBe(true);
      expect(fake.calls()).toBe(2);
      const next = await runtime.startRun({ ...request(fake.model), prior: 1, stream: { id: "after-timeout" } });
      await until(() => next.ended);
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  test("SIGKILL during unsafe bash reports interruption instead of replaying side effects", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-tool-crash-"));
    const marker = join(directory, "tool-started");
    const counter = join(directory, "side-effects");
    const command = `printf x >> '${counter}'; printf ready > '${marker}'; sleep 1`;
    const code = `import { DurableRuntime } from './server/durable/index.ts';
      import { fakeModels } from './tests/durable-fake.ts';
      const f = fakeModels({tool:true,command:${JSON.stringify(command)}});
      const r = new DurableRuntime(${JSON.stringify(directory)}, f.models);
      await r.startRun({...${JSON.stringify(request("MODEL"))}, model:f.model});
      setInterval(()=>{},1000);`;
    const child = Bun.spawn([process.execPath, "-e", code], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    try {
      await until(() => existsSync(marker));
      child.kill("SIGKILL"); await child.exited;
      expect(readFileSync(counter, "utf8")).toBe("x");
      const fake = fakeModels({ tool: true, command });
      const reopened = new DurableRuntime(directory, fake.models);
      await reopened.recover();
      const run = await reopened.findRun("durable-test-request");
      await until(() => !!run?.ended);
      expect(readFileSync(counter, "utf8")).toBe("x"); // never replay the unsafe bash command
      expect(run!.events.filter(e => e.t === "tool")).toMatchObject([
        { id: "call1", status: "running" },
        { id: "call1", status: "error", output: expect.stringContaining("interrupted") },
      ]);
      expect(fake.calls()).toBe(1);
      await reopened.close();
    } finally { child.kill(); await child.exited; await Bun.sleep(1100); rmSync(directory, { recursive: true, force: true }); }
  }, 20000);
  test("SIGKILL during model work recovers on startup without a client; no duplicate admission/text", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-crash-"));
    const marker = join(directory, "entered");
    const code = `import { DurableRuntime } from './server/durable/index.ts';
      import { fakeModels } from './tests/durable-fake.ts';
      const f = fakeModels({tool:true,holdAfterTool:true,marker:${JSON.stringify(marker)}});
      const r = new DurableRuntime(${JSON.stringify(directory)}, f.models);
      await r.startRun({...${JSON.stringify(request("MODEL"))}, model:f.model});
      setInterval(()=>{},1000);`;
    const child = Bun.spawn([process.execPath, "-e", code], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    try {
      await until(() => existsSync(marker));
      child.kill("SIGKILL"); await child.exited;
      const fake = fakeModels();
      const reopened = new DurableRuntime(directory, fake.models);
      await reopened.recover(); // no startRun or reconnect needed to restart work
      const run = await reopened.findRun("durable-test-request");
      expect(run).toBeDefined();
      await until(() => !!run?.ended);
      expect(run!.events.filter(e => e.t === "text").map(e => e.v)).toEqual(["before tool", "offline answer"]);
      expect(run!.events.filter(e => e.t === "tool").map(e => e.status)).toEqual(["running", "done"]);
      expect(run!.events.at(-1)).toMatchObject({ t: "done", usage: { input: 2, output: 2, cost: 0, contextTokens: 2 } });
      expect(fake.calls()).toBe(1);
      expect(await reopened.startRun(request(fake.model))).toBe(run!);
      expect(fake.calls()).toBe(1);
      await reopened.close();
    } finally { child.kill(); await child.exited; rmSync(directory, { recursive: true, force: true }); }
  }, 20000);
});
