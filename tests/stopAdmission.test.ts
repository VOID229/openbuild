import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestRunStop } from "../server/runStops";
import { localRun } from "../server/runs";
import { DurableRuntime } from "../server/durable";
import { fakeModels } from "./durable-fake";

test("Stop before local admission never invokes its producer, including POST retries", () => {
  const id = crypto.randomUUID();
  requestRunStop(id);
  const start = () => { throw new Error("stopped work must not start"); };
  const run = localRun(id, start);
  expect(run.ended).toBe(true);
  expect(run.signal.aborted).toBe(true);
  expect(run.events).toEqual([{ t: "done", finish: "aborted" }]);
  expect(localRun(id, start)).toBe(run);
});

for (const duringAdmission of [false, true]) {
  test(`Durable honors Stop ${duringAdmission ? "while admission awaits its baseline" : "before its manifest exists"}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-early-stop-"));
    const fake = fakeModels();
    const runtime = new DurableRuntime(directory, fake.models);
    const req = { threadId: crypto.randomUUID(), cwd: tmpdir(), model: fake.model, effort: "off" as const, prior: 0, message: "must not run", stream: { id: crypto.randomUUID() } };
    try {
      if (duringAdmission) {
        const { root } = await (runtime as any).thread(req.threadId);
        const watch = root.watch.bind(root);
        root.watch = async (...args: unknown[]) => { requestRunStop(req.stream.id); return watch(...args); };
      } else requestRunStop(req.stream.id);
      const run = await runtime.startRun(req);
      expect(run.ended).toBe(true);
      expect(run.events.at(-1)).toMatchObject({ t: "done", finish: "aborted" });
      expect(fake.calls()).toBe(0);
      expect(await runtime.startRun(req)).toBe(run);
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
