import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

// A thread's sidebar edit (PATCH) waits for its replies' runs before saving; a reply's message written
// meanwhile must still be there after the save. In a process of its own, on a data folder of its own.
test("a metadata edit saved while a reply writes keeps the reply's message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ob-chat-write-"));
  try {
    const { code, stderr: err } = await spawnScript(`
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
    `, { HOME: dir, OPENCHAT_DATA_DIR: join(dir, "data") });
    expect(err).not.toContain("Error");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A bot's queued message starts the next turn on the server as the turn before it ends; the tab that
// ran that turn saves it a moment later, from a copy without the bot's. The bot's turn must survive,
// and still be the bot's ("Sent by"), while a save that changes the thread's messages still stands.
test("a tab's save of the turn before keeps the turn a bot's queued message started", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ob-chat-write-bot-"));
  try {
    const { code, stderr: err } = await spawnScript(`
      import { strict as a } from "node:assert";
      const storage = await import("./server/storage.ts");
      const { writeChat } = await import("./server/chatWrite.ts");
      const user = (id, extra = {}) => ({ id, role: "user", content: id, createdAt: 1, ...extra });
      const reply = (id, status) => ({ id, role: "assistant", content: "", createdAt: 2, status, model: { plan: "claude", id: "claude/opus", name: "Opus" }, stream: { id: id + "-run" } });
      const bot = { sentBy: "Dr Eggbot", sentByBot: "bot-1" };
      const pending = (id) => [{ id: id + "-run", threadId: "t", kind: "run", status: "pending", events: [], startedAt: 2 }];
      const tab = { id: "t", title: "Thread", createdAt: 1, updatedAt: 1, runtime: "claude", messages: [user("u1"), reply("a1", "done")] };
      const withBotTurn = () => storage.putChat({ ...tab, messages: [...tab.messages, user("u2", bot), reply("a2", "streaming")] });

      withBotTurn();
      await writeChat(tab, async () => pending("a2"));
      a.deepEqual(storage.getChat("t").messages.map((m) => m.id), ["u1", "a1", "u2", "a2"]);
      a.deepEqual(storage.getChat("t").messages[2].sentBy, "Dr Eggbot");

      // A quick turn may be over before the tab's save arrives: kept while the worker knows its run.
      storage.putChat({ ...tab, messages: [...tab.messages, user("u2", bot), reply("a2", "done")] });
      await writeChat(tab, async () => [{ ...pending("a2")[0], status: "finished", endedAt: 3, events: [{ t: "done", finish: "stop" }] }]);
      a.deepEqual(storage.getChat("t").messages.map((m) => m.id), ["u1", "a1", "u2", "a2"]);
      // Not a run anything knows of: the tab's copy stands.
      storage.putChat({ ...tab, messages: [...tab.messages, user("u2", bot), reply("a2", "done")] });
      await writeChat(tab, async () => []);
      a.deepEqual(storage.getChat("t").messages.map((m) => m.id), ["u1", "a1"]);

      // A rewind or edit (different messages) stands, as does a turn that isn't a bot's.
      withBotTurn();
      await writeChat({ ...tab, messages: [user("u1-edited"), reply("a1b", "done")] }, async () => pending("a2"));
      a.deepEqual(storage.getChat("t").messages.map((m) => m.id), ["u1-edited", "a1b"]);
      storage.putChat({ ...tab, messages: [...tab.messages, user("u2"), reply("a2", "streaming")] });
      await writeChat(tab, async () => pending("a2"));
      a.deepEqual(storage.getChat("t").messages.map((m) => m.id), ["u1", "a1"]);
      process.exit(0);
    `, { HOME: dir, OPENCHAT_DATA_DIR: join(dir, "data") });
    expect(err).not.toContain("Error");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
