import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bot writes preserve ownership, history and one-shot scheduling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-integrity-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      import * as db from './server/bots/db.ts';
      import * as svc from './server/bots/service.ts';
      const first = svc.createBot({ name: 'First' });
      const second = svc.createBot({ name: 'Second' });
      for (const { bot } of [first, second]) svc.updateBot(bot.id, { proactivity: 'off' });
      const collisionId = crypto.randomUUID();
      a.throws(() => svc.createBot({ id: collisionId, name: 'Collision', conversationId: first.conversationId }), /conversation already exists/);
      a.equal(db.getBot(collisionId), undefined);
      a.deepEqual(db.getConversation(first.conversationId).botIds, [first.bot.id]);

      svc.updateConversation(first.conversationId, { unread: true, pinnedAt: Date.now(), section: 'Work' });
      a.equal(db.getConversation(first.conversationId).unread, true);
      svc.updateConversation(first.conversationId, { unread: false, pinnedAt: null, section: null });
      a.equal(db.getConversation(first.conversationId).unread, undefined);
      a.equal(db.getConversation(first.conversationId).pinnedAt, undefined);
      a.equal(db.getConversation(first.conversationId).section, undefined);

      const memoryId = crypto.randomUUID();
      const memory = svc.addMemory(first.bot.id, 'Keep this', 'me', memoryId);
      a.equal(memory.id, memoryId);
      a.equal(svc.addMemory(first.bot.id, 'Keep this', 'me', memoryId).id, memoryId);
      a.equal(db.memories(first.bot.id).length, 1);
      a.throws(() => svc.addMemory(second.bot.id, 'Steal', 'me', memoryId), /already exists/);
      svc.removeMemory(first.bot.id, memoryId);
      a.equal(db.memories(first.bot.id).length, 0);

      const ids = [];
      for (let i = 0; i < 241; i++) {
        const id = crypto.randomUUID(); ids.push(id);
        svc.postMessage(first.conversationId, { id, author: 'me', at: Date.now(), text: 'Message ' + i });
      }
      const latest = svc.messagePage(first.conversationId);
      a.equal(latest.messages.length, 200);
      a.equal(latest.more, true);
      a.equal(latest.messages[0].id, ids[41]);
      const older = svc.messagePage(first.conversationId, latest.messages[0].id);
      a.equal(older.messages.length, 41);
      a.equal(older.more, false);
      a.equal(older.messages[0].id, ids[0]);
      a.throws(() => svc.messagePage(second.conversationId, ids[0]), /history cursor/);
      a.throws(() => svc.postMessage(second.conversationId, { id: ids[0], author: 'me', at: Date.now(), text: 'Duplicate' }), /already exists/);
      a.equal(svc.postMessage(first.conversationId, { id: ids[0], author: 'me', at: Date.now(), text: 'Retry' }).text, 'Message 0');

      const routine = svc.saveRoutine(first.bot.id, { id: crypto.randomUUID(), title: 'Weekly', schedule: 'Sundays at 10:00', enabled: true });
      a.throws(() => svc.saveRoutine(second.bot.id, { ...routine, title: 'Stolen' }), /another bot/);
      a.throws(() => svc.saveRoutine(second.bot.id, { ...routine, id: crypto.randomUUID(), conversationId: first.conversationId }), /isn't in/);
      a.throws(() => svc.updateRoutine(second.bot.id, routine.id, { title: 'Stolen' }), /No such routine/);
      a.throws(() => svc.removeRoutine(second.bot.id, routine.id), /No such routine/);
      svc.removeRoutine(first.bot.id, routine.id);

      // Reparse a one-shot at its creation time, not after its absolute date passed.
      const realNow = Date.now;
      const created = new Date(2030, 0, 1, 8).getTime();
      Date.now = () => created;
      const once = svc.saveRoutine(first.bot.id, { id: crypto.randomUUID(), title: 'Once', schedule: '2030-01-01 at 09:00', enabled: true });
      const wakes = [];
      svc.setHooks({ wake: (id, item) => wakes.push(item), stop() {} });
      Date.now = () => new Date(2030, 0, 1, 9, 1).getTime();
      svc.tick(() => false);
      svc.tick(() => false);
      a.equal(wakes.filter(w => w.kind === 'routine').length, 1);
      a.equal(db.routineOwner(once.id), undefined);
      Date.now = realNow;

      // Membership can change after a routine was validated at creation.
      const group = svc.createConversation({ kind: 'group', name: 'Group', botIds: [first.bot.id, second.bot.id] });
      const stale = svc.saveRoutine(first.bot.id, { id: crypto.randomUUID(), title: 'Stale', schedule: 'every hour', enabled: true, conversationId: group.id });
      svc.updateConversation(group.id, { botIds: [second.bot.id] });
      db.putRoutine(first.bot.id, { ...stale, nextRunAt: Date.now() - 1000 });
      const beforeStale = wakes.length;
      a.doesNotThrow(() => svc.tick(() => false));
      a.equal(db.routines(first.bot.id).find(r => r.id === stale.id).enabled, false);
      a.equal(wakes.length, beforeStale);
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("group replies wake the quoted bot instead of falling back to the primary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-replies-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      import * as svc from './server/bots/service.ts';
      const primary = svc.createBot({ name: 'Boss' });
      const second = svc.createBot({ name: 'Helper' });
      const group = svc.createConversation({ kind: 'group', name: 'Group', botIds: [primary.bot.id, second.bot.id] });
      const woken = [];
      svc.setHooks({ wake: id => woken.push(id), stop() {} });
      const post = (conversationId, author, text, replyTo) => svc.postMessage(conversationId, { id: crypto.randomUUID(), author, text, replyTo, at: Date.now() });
      const quoted = post(group.id, second.bot.id, 'Hello');
      const mine = post(group.id, 'me', 'Generic');
      const foreign = post(second.conversationId, second.bot.id, 'Private');
      const check = (text, replyTo, expected) => {
        woken.length = 0;
        post(group.id, 'me', text, replyTo);
        a.deepEqual(woken, expected);
      };
      check('Tell me more', quoted.id, [second.bot.id]);
      check('Generic', undefined, [primary.bot.id]);
      check('Follow up', mine.id, [primary.bot.id]);
      check('Missing quote', crypto.randomUUID(), [primary.bot.id]);
      check('Foreign quote', foreign.id, [primary.bot.id]);
      check('@Boss your thoughts?', quoted.id, [primary.bot.id, second.bot.id]);
      check('@Helper tell me more', quoted.id, [second.bot.id]);
      svc.updateConversation(group.id, { botIds: [primary.bot.id] });
      check('Removed bot', quoted.id, [primary.bot.id]);
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
