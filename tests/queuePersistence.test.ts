import { expect, test } from "bun:test";

// Keep the browser storage shim out of other tests' module caches.
test("queues survive fresh module loads with attachments, edits, order and deletions", async () => {
  const script = `
    import "fake-indexeddb/auto";
    import { expect } from "bun:test";
    const load = (n) => import("./src/lib/queue.ts?queue-persistence=" + n);
    const first = await load(1);
    await first.queuesReady;
    const file = { id: "f", name: "note.txt", mime: "text/plain", text: "hello", dataUrl: "data:text/plain;base64,aGVsbG8=" };
    first.enqueue("chat", { id: "a", text: "first", files: [file] });
    first.enqueue("chat", { id: "b", text: "second", files: [] });
    first.enqueue("other", { id: "c", text: "other chat", files: [] });
    first.updateQueued("chat", "a", { text: "edited", files: [file] });
    first.moveQueued("chat", "b", 0);
    first.setEditingQueued("chat", "a");
    first.setSteering("chat", [{ id: "steer", text: "already sent", files: [] }]);
    // A readonly transaction opened by hydration follows all preceding writes.
    const second = await load(2);
    await second.queuesReady;
    expect(second.queueOf("chat")).toEqual([
      { id: "b", text: "second", files: [] },
      { id: "a", text: "edited", files: [file] },
    ]);
    expect(second.queueOf("other")).toHaveLength(1);
    expect(second.useQueue.getState().editing).toEqual({});
    expect(second.useQueue.getState().steering).toEqual({});
    second.removeQueued("chat", "a");
    expect(second.shiftQueue("chat").id).toBe("b");
    const third = await load(3);
    await third.queuesReady;
    expect(third.queueOf("chat")).toEqual([]);
    expect(third.queueOf("other")).toHaveLength(1);
    // A local change made during hydration must win over an older saved queue.
    const fourth = await load(4);
    fourth.removeQueued("other", "c");
    await fourth.queuesReady;
    expect(fourth.queueOf("other")).toEqual([]);
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${out}\n${err}`);
  expect(code).toBe(0);
});
