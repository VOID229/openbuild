import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A thread's sidebar edit (PATCH) waits for its replies' runs before saving; a reply's message written
// meanwhile must still be there after the save. In a process of its own, on a data folder of its own.
test("a metadata edit saved while a reply writes keeps the reply's message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ob-chat-write-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from "node:assert";
      const storage = await import("./server/storage.ts");
      const { writeChat } = await import("./server/chatWrite.ts");
      const message = (id, content) => ({ id, role: "assistant", content, createdAt: 1, status: "done", model: { plan: "pi", provider: "p", id: "m" } });
      storage.putChat({ id: "t", title: "Thread", createdAt: 1, updatedAt: 1, runtime: "pi", messages: [message("m1", "first")] });

      const fields = { pinned: true, unread: false };
      const onto = (latest) => ({ ...latest, ...fields, id: latest.id, messages: latest.messages });
      let release;
      const held = new Promise((r) => (release = r));
      const saving = writeChat(onto(storage.getChat("t")), async () => { await held; return []; }, onto);
      // While the save waits for the runs, a reply appends its message.
      const stored = storage.getChat("t");
      storage.putChat({ ...stored, updatedAt: 2, messages: [...stored.messages, message("m2", "second")] });
      release();
      const written = await saving;
      a.ok(!("error" in written), JSON.stringify(written));
      const after = storage.getChat("t");
      a.deepEqual(after.messages.map((m) => m.id), ["m1", "m2"]);
      a.equal(after.pinned, true);
      a.equal(after.unread, false);
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, HOME: dir, OPENCHAT_DATA_DIR: join(dir, "data") }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).not.toContain("Error");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
