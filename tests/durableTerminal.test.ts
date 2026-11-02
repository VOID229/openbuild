import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableRuntime } from "../server/durable";
import { fakeModels } from "./durable-fake";

test("Durable terminal manifest failure remains retryable instead of ending only in memory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "durable-terminal-write-"));
  const fake = fakeModels();
  const runtime = new DurableRuntime(directory, fake.models);
  const log = spyOn(console, "error").mockImplementation(() => {});
  const req = { threadId: "terminal-thread", cwd: tmpdir(), model: fake.model, effort: "off" as const, message: "hi", prior: 0, stream: { id: "terminal-run" } };
  try {
    const persist = (runtime as any).persist.bind(runtime);
    let failed = false;
    (runtime as any).persist = (manifest: { ended: boolean }) => {
      if (manifest.ended && !failed) { failed = true; throw new Error("terminal write failed"); }
      return persist(manifest);
    };
    const run = await runtime.startRun(req);
    const deadline = Date.now() + 2000;
    while (!failed || !(runtime as any).recoveryErrors.has(run.id)) { if (Date.now() > deadline) throw new Error("timed out waiting for fault"); await Bun.sleep(5); }
    expect((runtime as any).manifests.get(run.id).ended).toBe(false);
    expect(run.ended).toBe(false);
    expect(await runtime.startRun(req)).toBe(run);
    while (!run.ended) { if (Date.now() > deadline) throw new Error("timed out after retry"); await Bun.sleep(5); }
    expect(run.events.filter(e => e.t === "done")).toHaveLength(1);
    expect(fake.calls()).toBe(1);
  } finally { await runtime.close(); log.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
});
