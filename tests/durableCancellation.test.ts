import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableRuntime } from "../server/durable";
import { fakeModels } from "./durable-fake";

test("Durable Stop unblocks even when a provider stream ignores its abort signal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "durable-provider-abort-"));
  const sideEffect = join(directory, "must-not-execute");
  const fake = fakeModels({ hold: true, ignoreAbort: true, tool: true, command: `touch '${sideEffect}'` });
  const runtime = new DurableRuntime(directory, fake.models);
  let stopping: Promise<boolean> | undefined;
  try {
    const req = { threadId: "abort-thread", cwd: tmpdir(), model: fake.model, effort: "off" as const, message: "hi", prior: 0, stream: { id: "abort-run" } };
    const run = await runtime.startRun(req);
    while (fake.calls() === 0) await Bun.sleep(5);
    stopping = runtime.stopRun(run.id);
    const result = await Promise.race([stopping.then(() => "stopped"), Bun.sleep(3000).then(() => "hung")]);
    expect(result).toBe("stopped");
    expect(run.ended).toBe(true);
    expect(run.events.at(-1)).toMatchObject({ t: "done", finish: "aborted" });
    fake.release(); // a late provider reply must not schedule its tool calls after Stop
    await Bun.sleep(30);
    expect(existsSync(sideEffect)).toBe(false);
    expect(fake.calls()).toBe(1);
  } finally { fake.release(); await stopping; await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});
