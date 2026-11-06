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


test("a group keeps sending untagged messages to the non-primary bot the user is talking with for 5 minutes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-follow-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      import * as svc from './server/bots/service.ts';
      const boss = svc.createBot({ name: 'Boss' }).bot.id;
      const helper = svc.createBot({ name: 'Helper' }).bot.id;
      const tracer = svc.createBot({ name: 'Tracer' }).bot.id;
      const group = svc.createConversation({ kind: 'group', name: 'Group', botIds: [boss, helper, tracer] });
      const woken = [];
      svc.setHooks({ wake: id => woken.push(id), stop() {} });
      let at = Date.now();
      const post = (author, text, after = 1000) => svc.postMessage(group.id, { id: crypto.randomUUID(), author, text, at: at += after });
      const check = (text, expected, after) => {
        woken.length = 0;
        post('me', text, after);
        a.deepEqual(woken, expected, text);
      };
      const minute = 60_000;
      check('Hi', [boss]);
      check('@Helper can you look?', [helper]);
      check('Thanks, and the other one?', [helper], 4 * minute);
      check('Still there?', [helper], 5 * minute);
      check('Back after a break', [boss], 5 * minute + 1);
      check('Hi again', [boss]);

      check('@Helper one more', [helper]);
      post(helper, 'On it', 4 * minute);
      check('Great', [helper], 4 * minute);

      check('@Helper @Tracer both of you', [helper, tracer]);
      check('Go ahead', [helper, tracer]);
      check('@Boss your call', [boss]);
      check('And now?', [boss]);

      check('@Tracer check it', [tracer]);
      check('@everyone status?', [boss, helper, tracer]);
      check('Ok', [boss]);

      check('@Tracer once more', [tracer]);
      svc.updateConversation(group.id, { botIds: [boss, helper] });
      check('Tracer left', [boss]);
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
      // Each message is an hour apart, so no follow carries over from the one before.
      let at = Date.now();
      const post = (conversationId, author, text, replyTo) => svc.postMessage(conversationId, { id: crypto.randomUUID(), author, text, replyTo, at: at += 3_600_000 });
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

test("a message between bots shows as a linked activity line in each bot's own chat, without its text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-side-activity-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      import * as db from './server/bots/db.ts';
      import * as svc from './server/bots/service.ts';
      svc.setHooks({ wake() {}, stop() {} });
      const asker = svc.createBot({ name: 'Asker' });
      const helper = svc.createBot({ name: 'Helper' });
      const side = svc.createConversation({ kind: 'side', botIds: [asker.bot.id, helper.bot.id] });
      const events = (id) => db.messages(id).map((m) => m.message.event).filter((e) => e?.kind === 'message');
      const post = (author, text) => svc.postMessage(side.id, { id: crypto.randomUUID(), author, at: Date.now(), text });

      post(asker.bot.id, 'The secret plan');
      a.deepEqual(events(asker.conversationId), [{ kind: 'message', text: 'Sent a message to Helper', bot: helper.bot.id, conversationId: side.id }]);
      a.deepEqual(events(helper.conversationId), [{ kind: 'message', text: 'Received a message from Asker', bot: asker.bot.id, conversationId: side.id }]);
      a.ok(!JSON.stringify(db.messages(helper.conversationId)).includes('secret'));

      // A back-and-forth stays one line per chat until something else happens there.
      post(helper.bot.id, 'Reply');
      post(asker.bot.id, 'Thanks');
      a.equal(events(asker.conversationId).length, 1);
      a.equal(events(helper.conversationId).length, 1);
      svc.postMessage(helper.conversationId, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: 'Hi' });
      post(asker.bot.id, 'One more');
      a.equal(events(asker.conversationId).length, 1);
      a.equal(events(helper.conversationId).length, 2);
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
