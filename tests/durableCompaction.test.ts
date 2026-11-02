import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DurableRuntime } from "../server/durable";
import { fakeModels } from "./durable-fake";

async function until(fn: () => boolean) {
  const end = Date.now() + 3000;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await Bun.sleep(5); }
}

test("real SDK compaction preserves archived actions across a host projection crash gap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "durable-sdk-compaction-"));
  const fake = fakeModels({ tool: true });
  const summarizer = fakeModels();
  fake.models.completeSimple = (model, input, options) => summarizer.models.completeSimple(model, input, options);
  const runtime = new DurableRuntime(directory, fake.models);
  let reopened: DurableRuntime | undefined;
  try {
    const req = { threadId: "compaction-thread", cwd: tmpdir(), model: fake.model, effort: "off" as const, message: "original action request", prior: 0, stream: { id: "compaction-run" } };
    const run = await runtime.startRun(req);
    await until(() => run.ended);
    const { root, harness } = await (runtime as any).thread(req.threadId);
    // Keep a large recent message, so real selectCut() summarizes the older tool-bearing prefix.
    await root.commit((tx: any) => tx.appendEntry(root.id, {
      kind: "audit.retained-context",
      model: [{ role: "user", content: "recent context ".repeat(7000), timestamp: Date.now() }],
    }), context);
    const taskId = await runtime.compact(req.threadId);
    const settled = await harness.waitForTask(taskId, context);
    expect(settled.state.outcome.status).toBe("completed");
    const submissionId = settled.state.outcome.result.submissionId;
    expect(submissionId).toBeDefined();
    expect((await (await harness.submission(submissionId, context)).wait(context)).status).toBe("done");
    const active = await root.watch(context);
    expect(active.value.entries.some((e: any) => e.kind === "pi.compaction")).toBe(true);
    expect(active.value.entries.some((e: any) => e.model?.some((m: any) => m.role === "toolResult"))).toBe(false);
    await active.stop();
    expect(summarizer.calls()).toBe(1);
    await runtime.close();

    const file = join(directory, "runs", createHash("sha256").update(req.stream.id).digest("hex") + ".json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(manifest, { events: [], seen: [], usage: {}, ended: false });
    writeFileSync(file, JSON.stringify(manifest));
    const fresh = fakeModels();
    reopened = new DurableRuntime(directory, fresh.models);
    await reopened.recover();
    const replay = await reopened.findRun(req.stream.id);
    await until(() => !!replay?.ended);
    expect(replay!.events.filter(e => e.t === "text").map(e => e.v)).toEqual(["before tool", "offline answer"]);
    expect(replay!.events.filter(e => e.t === "tool").map(e => e.status)).toEqual(["running", "done"]);
    expect(fresh.calls()).toBe(0);
  } finally { await reopened?.close(); await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});
