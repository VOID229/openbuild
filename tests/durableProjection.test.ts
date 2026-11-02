import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { DurableRuntime } from "../server/durable";
import type { StreamEvent } from "../shared/types";

function entry(id: number, text: string): EntryRecord {
  return {
    id: id as EntryRecord["id"], conversationId: 1 as EntryRecord["conversationId"], kind: "pi.assistant",
    model: [{ role: "assistant", api: "openai-completions", provider: "offline", model: "offline", timestamp: 0,
      content: [{ type: "text", text }], stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }],
  };
}

test("Durable overlapping archive scans recheck seen IDs after each page await", async () => {
  const directory = mkdtempSync(join(tmpdir(), "durable-projection-overlap-"));
  const runtime = new DurableRuntime(directory);
  type Page = { items: EntryRecord[]; next?: string };
  const firstPages = [Promise.withResolvers<Page>(), Promise.withResolvers<Page>()];
  const secondPages = [Promise.withResolvers<Page>(), Promise.withResolvers<Page>()];
  let firstReads = 0, secondReads = 0;
  const root = { entries(_query: unknown, _limit: number, cursor?: string) {
    return cursor ? secondPages[secondReads++]!.promise : firstPages[firstReads++]!.promise;
  } };
  const manifest = { version: 1, id: "overlap-run", request: { threadId: "overlap-thread", cwd: tmpdir(), model: "offline/model", effort: "off", message: "hi", prior: 0, stream: { id: "overlap-run" } }, baseline: [], seen: [] as number[], events: [] as StreamEvent[], ended: false };
  const scans: Promise<void>[] = [];
  try {
    scans.push((runtime as any).projectHistory(manifest, root), (runtime as any).projectHistory(manifest, root));
    firstPages[0]!.resolve({ items: [entry(1, "first")], next: "page-2" });
    while (secondReads < 1) await Bun.sleep(1);
    firstPages[1]!.resolve({ items: [entry(1, "first")], next: "page-2" });
    while (secondReads < 2) await Bun.sleep(1);
    secondPages[1]!.resolve({ items: [entry(2, "second")] });
    await scans[1];
    secondPages[0]!.resolve({ items: [entry(2, "second")] });
    await scans[0];
    expect(manifest.seen).toEqual([1, 2]);
    expect(manifest.events.filter((e: any) => e.t === "text")).toEqual([{ t: "text", v: "first" }, { t: "text", v: "second" }]);
    expect((manifest as any).usage).toMatchObject({ input: 2, output: 2 });

    // Watch.stop() does not join a running callback. Its delayed storage read must not publish
    // another turn's entries after a final snapshot/abort has terminalized this manifest.
    const delayed = Promise.withResolvers<Page>();
    const trailing = (runtime as any).projectHistory(manifest, { entries: () => delayed.promise });
    (runtime as any).finish(manifest, [{ t: "done", finish: "stop" }]);
    delayed.resolve({ items: [entry(3, "must not leak after done")] });
    await trailing;
    expect(manifest.seen).toEqual([1, 2]);
    expect(manifest.events.at(-1)).toMatchObject({ t: "done" });
  } finally {
    for (const gate of [...firstPages, ...secondPages]) gate.resolve({ items: [] });
    await Promise.all(scans);
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
