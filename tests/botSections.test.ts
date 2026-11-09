import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = async (script: string, env: Record<string, string> = {}) => {
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: join(import.meta.dir, ".."), env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  return stdout.trim();
};

test("a sidebar section goes, saved, when its last chat moves out or is deleted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bot-sections-"));
  try {
    const env = { OPENCHAT_DATA_DIR: dir };
    await run(`
      import { strict as a } from 'node:assert';
      import * as svc from './server/bots/service.ts';
      const events = [];
      svc.subscribe((e) => e.t === 'settings' && events.push(e.settings.sections));
      const first = svc.createBot({ name: 'First' });
      const second = svc.createBot({ name: 'Second' });
      const third = svc.createBot({ name: 'Third' });
      const group = svc.createConversation({ kind: 'group', name: 'Group', botIds: [first.bot.id, second.bot.id] });
      const sections = () => svc.getSettings().sections;

      // The sidebar's "New section…": the section is saved first, then the chat moves in, so the
      // move keeps it though nothing was filed there a moment ago.
      const file = (id, section) => {
        svc.updateSettings({ sections: [...sections(), section] });
        svc.updateConversation(id, { section });
      };
      file(first.conversationId, 'Work');
      svc.updateConversation(second.conversationId, { section: 'Work' });
      file(group.id, 'Home');
      file(third.conversationId, 'Fresh');
      a.deepEqual(sections(), ['Work', 'Home', 'Fresh']);

      // One chat of two leaving keeps the section; the last one out takes it along.
      svc.updateConversation(first.conversationId, { section: null });
      a.deepEqual(sections(), ['Work', 'Home', 'Fresh']);
      svc.updateConversation(second.conversationId, { section: 'Home' });
      a.deepEqual(sections(), ['Home', 'Fresh']);
      a.deepEqual(events.at(-1), ['Home', 'Fresh']);

      // A section whose only chat is hidden still holds it.
      svc.updateConversation(second.conversationId, { section: 'Fresh' });
      svc.updateConversation(group.id, { hidden: true });
      a.deepEqual(sections(), ['Home', 'Fresh']);

      // Deleting the last chat, or the bot whose chat it was, removes the section too.
      svc.deleteConversation(group.id);
      a.deepEqual(sections(), ['Fresh']);
      await svc.deleteBot(second.bot.id);
      a.deepEqual(sections(), ['Fresh']);
      await svc.deleteBot(third.bot.id);
      a.deepEqual(sections(), []);

      // Saved with no chat in them, as before this fix: swept once the server starts.
      svc.updateSettings({ sections: ['Stale'] });
      process.exit(0);
    `, env);
    const out = await run(`
      import * as svc from './server/bots/service.ts';
      console.log(JSON.stringify(svc.getSettings().sections));
      svc.ensureStarted();
      console.log(JSON.stringify(svc.getSettings().sections));
      process.exit(0);
    `, env);
    expect(out.split("\n")).toEqual(['["Stale"]', "[]"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the sidebar drops an emptied section at once, with its folded state, and follows the server's list", async () => {
  const out = await run(`
    import { mock } from "bun:test";
    import { resolve } from "node:path";
    import assert from "node:assert/strict";
    mock.module(resolve("src/lib/store.ts"), () => ({ useStore: { getState: () => ({ settings: { profile: {} } }) } }));
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.fetch = async () => Response.json({ ok: true });
    const { useBots } = await import(resolve("src/lib/bots/store.ts"));
    const chat = (id, section, kind = "group") => ({ id, kind, name: id, botIds: [id], section, createdAt: 1, updatedAt: 1, messages: [] });
    useBots.setState({
      bots: [{ id: "b" }, { id: "c" }],
      conversations: [chat("a", "Work"), chat("b", "Work", "direct"), chat("c", "Home", "direct")],
      sections: ["Work", "Home", "Fresh"],
      folded: ["hidden", "Work"],
    });
    const st = () => useBots.getState();
    // Into a section just made: kept.
    st().updateConversation("a", { section: "Fresh" });
    assert.deepEqual(st().sections, ["Work", "Home", "Fresh"]);
    st().updateConversation("b", { section: undefined });
    assert.deepEqual(st().sections, ["Home", "Fresh"]);
    assert.deepEqual(st().folded, ["hidden"]);
    // Other changes leave sections alone.
    st().updateConversation("a", { unread: true });
    assert.deepEqual(st().sections, ["Home", "Fresh"]);
    st().deleteConversation("a");
    assert.deepEqual(st().sections, ["Home"]);
    st().deleteBot("c");
    assert.deepEqual(st().sections, []);
    console.log("ok");
    process.exit(0);
  `);
  expect(out).toBe("ok");
});
