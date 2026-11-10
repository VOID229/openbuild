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
      for (const { bot } of [first, second]) svc.updateBot(bot.id, { proactivity: 'off' }, { quiet: true });
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
      const memory = svc.addMemory(first.bot.id, 'Keep this', { by: 'me', id: memoryId }).item;
      a.equal(memory.id, memoryId);
      a.equal(svc.addMemory(first.bot.id, 'Keep this', { by: 'me', id: memoryId }).item.id, memoryId);
      a.equal(db.memories(first.bot.id).length, 1);
      a.throws(() => svc.addMemory(second.bot.id, 'Steal', { by: 'me', id: memoryId }), /already exists/);
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


test("untagged groups follow the last recipients for 20 minutes, else the primary, with no routing model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-follow-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      const spawn = Bun.spawn;
      let spawns = 0;
      Bun.spawn = (...args) => (spawns++, spawn(...args));
      const svc = await import('./server/bots/service.ts');
      const boss = svc.createBot({ name: 'Boss' }).bot.id;
      const helper = svc.createBot({ name: 'Helper' }).bot.id;
      const group = svc.createConversation({ kind: 'group', name: 'Group', botIds: [boss, helper] });
      const wakes = [];
      svc.setHooks({ wake: (id, w) => wakes.push({ id, ...w }), stop() {} });
      let now = Date.now();
      const post = text => svc.postMessage(group.id, { id: crypto.randomUUID(), author: 'me', text, at: now });
      // Woken before postMessage returns: nothing is decided in the background.
      const check = (text, expected) => {
        wakes.length = 0;
        const m = post(text);
        a.deepEqual(wakes.map(w => [w.id, w.messageIds]), expected.map(id => [id, [m.id]]), text);
        return m;
      };
      check('A new topic', [boss]);
      check('@Helper hello', [helper]);
      now += svc.GROUP_FOLLOW_MS - 1; check('Keep going', [helper]);
      // Each request restarts the clock, so the follow rolls on.
      now += svc.GROUP_FOLLOW_MS - 1; check('Still here', [helper]);
      now += svc.GROUP_FOLLOW_MS; check('Exactly 20 minutes later', [boss]);
      check('@Boss @Helper both', [boss, helper]);
      check('Continue both', [boss, helper]);
      // A duplicate post is the same message, and wakes nobody again.
      wakes.length = 0;
      const message = post('Once');
      svc.postMessage(group.id, message);
      a.equal(wakes.length, 2);
      a.equal(spawns, 0);
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe(""); expect(code).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("group replies wake the quoted bot instead of falling back to the primary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-replies-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      const svc = await import('./server/bots/service.ts');
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
      await new Promise(r => setTimeout(r, 10));
      const check = async (text, replyTo, expected) => {
        woken.length = 0;
        post(group.id, 'me', text, replyTo);
        await new Promise(r => setTimeout(r, 10));
        a.deepEqual(woken, expected);
      };
      await check('Tell me more', quoted.id, [second.bot.id]);
      await check('Generic', undefined, [primary.bot.id]);
      await check('Follow up', mine.id, [primary.bot.id]);
      await check('Missing quote', crypto.randomUUID(), [primary.bot.id]);
      await check('Foreign quote', foreign.id, [primary.bot.id]);
      await check('@Boss your thoughts?', quoted.id, [primary.bot.id, second.bot.id]);
      await check('@Helper tell me more', quoted.id, [second.bot.id]);
      svc.updateConversation(group.id, { botIds: [primary.bot.id] });
      await check('Removed bot', quoted.id, [primary.bot.id]);
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

test('group follow refreshes only on user requests and follows membership changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbuild-follow-'));
  try {
    const child = Bun.spawn([process.execPath, '-e', `
      import { strict as a } from 'node:assert';
      const svc = await import('./server/bots/service.ts');
      const boss = svc.createBot({ name: 'Boss' }).bot.id;
      const helper = svc.createBot({ name: 'Helper' }).bot.id;
      const third = svc.createBot({ name: 'Third' }).bot.id;
      const group = svc.createConversation({ kind: 'group', name: 'Follow', botIds: [boss, helper, third] });
      const wakes = [];
      svc.setHooks({ wake: (id, w) => wakes.push({ id, ...w }), stop() {} });
      let now = Date.now();
      const post = (text, author = 'me') => svc.postMessage(group.id, { id: crypto.randomUUID(), author, text, at: now });
      const last = n => wakes.slice(-n).map(w => w.id);
      post('@Helper @Third start'); a.deepEqual(last(2), [helper, third]);
      // Bot chatter and reactions don't keep the follow alive.
      now += 19 * 60_000;
      const chatter = post('Bot chatter', helper);
      svc.toggleReaction(group.id, chatter.id, '👍', 'me');
      now += 60_000; post('Expired'); a.deepEqual(last(1), [boss]);
      post('@Helper @Third again');
      // A removed member drops out of the follow; the rest keep it.
      svc.updateConversation(group.id, { botIds: [boss, helper] });
      wakes.length = 0; post('Without third'); a.deepEqual(last(9), [helper]);
      // With nobody left to follow, the primary takes it.
      svc.updateConversation(group.id, { botIds: [boss] });
      wakes.length = 0; post('Only boss'); a.deepEqual(last(9), [boss]);
      process.exit(0);
    `], { cwd: join(import.meta.dir, '..'), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: 'pipe', stderr: 'pipe' });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe(''); expect(code).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('group follow survives a restart mid-window, still expires, refreshes only on user requests and is cleaned up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbuild-follow-restart-'));
  // Each run is a fresh server process on the same data folder: a restart between them.
  const run = async (script: string) => {
    const child = Bun.spawn([process.execPath, '-e', `
      import { strict as a } from 'node:assert';
      import * as db from './server/bots/db.ts';
      const svc = await import('./server/bots/service.ts');
      const wakes = [];
      svc.setHooks({ wake: (id, w) => wakes.push({ id, ...w }), stop() {} });
      const post = (conversationId, text, at, author = 'me') => svc.postMessage(conversationId, { id: crypto.randomUUID(), author, text, at });
      const woken = (conversationId, text, at) => { wakes.length = 0; const m = post(conversationId, text, at); return wakes.map(w => [w.id, w.conversationId, w.messageIds]).concat([[m.id]]); };
      const rows = () => db.db.query('SELECT conversation_id AS id FROM group_follows ORDER BY conversation_id').all().map(r => r.id);
      ${script}
      process.exit(0);
    `], { cwd: join(import.meta.dir, '..'), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: 'pipe', stderr: 'pipe' });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(err).toBe(''); expect(code).toBe(0);
    return out.trim() ? JSON.parse(out) : undefined;
  };
  try {
    const T = Date.now();
    const ids = await run(`
      const boss = svc.createBot({ name: 'Boss' }).bot.id;
      const manager = svc.createBot({ name: 'Manager' }).bot.id;
      const one = svc.createConversation({ kind: 'group', name: 'One', botIds: [boss, manager] }).id;
      const two = svc.createConversation({ kind: 'group', name: 'Two', botIds: [boss, manager] }).id;
      const three = svc.createConversation({ kind: 'group', name: 'Three', botIds: [boss, manager] }).id;
      post(one, '@Manager take this', ${T});
      post(three, '@Manager and this', ${T});
      console.log(JSON.stringify({ boss, manager, one, two, three }));
    `);
    const { boss, manager, one, two, three } = ids;
    // After the restart, 19 minutes in, the follow still holds: exactly one wake, for that message, in that chat.
    await run(`
      const [w, [id]] = woken('${one}', 'Keep going', ${T} + 19 * 60_000);
      a.deepEqual(w, ['${manager}', '${one}', [id]]);
      // Another group has no follow of its own, so the primary takes it.
      const [o] = woken('${two}', 'Elsewhere', ${T} + 19 * 60_000);
      a.equal(o[0], '${boss}');
      // Bot chatter and reactions don't refresh the follow in "three".
      const chatter = post('${three}', 'Bot chatter', ${T} + 19 * 60_000, '${manager}');
      svc.toggleReaction('${three}', chatter.id, '👍', 'me');
    `);
    // Another restart: "one" was refreshed by the user at +19 min, "three" only by bots.
    await run(`
      a.equal(woken('${one}', 'Still here', ${T} + 38 * 60_000)[0][0], '${manager}');
      a.equal(woken('${three}', 'Expired', ${T} + 20 * 60_000)[0][0], '${boss}');
      // Exactly 20 minutes after the last request, it's over.
      a.equal(woken('${one}', 'Too late', ${T} + 58 * 60_000)[0][0], '${boss}');
      // A small step back of the clock still follows; a row stamped far ahead doesn't.
      post('${one}', '@Manager again', ${T} + 60 * 60_000);
      a.equal(woken('${one}', 'Clock stepped back', ${T} + 60 * 60_000 - 30_000)[0][0], '${manager}');
      db.setGroupFollow('${two}', { ids: ['${manager}'], at: ${T} + 10 * 60 * 60_000 });
      a.equal(woken('${two}', 'Future row', ${T} + 61 * 60_000)[0][0], '${boss}');
    `);
    // Cleanup: expired and future-stamped rows are swept on tick, deleted groups and emptied follows leave nothing, and a corrupt row is dropped.
    await run(`
      const now = Date.now();
      db.setGroupFollow('${one}', { ids: ['${manager}'], at: now - svc.GROUP_FOLLOW_MS });
      db.setGroupFollow('${two}', { ids: ['${manager}'], at: now + svc.GROUP_FOLLOW_MS });
      db.setGroupFollow('${three}', { ids: ['${manager}'], at: now });
      svc.tick(() => false);
      a.deepEqual(rows(), ['${three}']);
      svc.updateConversation('${three}', { botIds: ['${boss}'] });
      a.deepEqual(rows(), []);
      db.setGroupFollow('${two}', { ids: ['${manager}'], at: now });
      svc.deleteConversation('${two}');
      a.deepEqual(rows(), []);
      db.db.query("INSERT INTO group_follows (conversation_id, bot_ids, at) VALUES (?1, 'nope', ?2)").run('${one}', now);
      a.equal(db.groupFollow('${one}'), undefined);
      a.deepEqual(rows(), []);
    `);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("bots replying to each other never pause a chat, and an old bot-loop setting is ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-loop-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      // Settings saved before the pause was removed, with it switched on at its lowest limit.
      db.setValue('settings', { ...svc.getSettings(), botLoop: { enabled: true, limit: 1 } });
      a.equal('botLoop' in svc.getSettings(), false);
      const one = svc.createBot({ name: 'One' }).bot.id;
      const two = svc.createBot({ name: 'Two' }).bot.id;
      const group = svc.createConversation({ kind: 'group', name: 'Loop', botIds: [one, two] });
      const wakes = [];
      svc.setHooks({ wake(botId) { wakes.push(botId); }, stop() {} });
      const post = (author) => svc.postMessage(group.id, { id: crypto.randomUUID(), author, text: 'hi @' + (author === one ? 'Two' : 'One'), at: Date.now() });

      post('me');
      wakes.length = 0;
      for (let i = 0; i < 50; i++) post(i % 2 ? two : one);
      a.equal(wakes.length, 50);
      a.equal(svc.messagePage(group.id).messages.filter((m) => m.event?.text === 'Paused').length, 0);

      // A client still sending it changes nothing, and the next save drops the old value.
      a.equal('botLoop' in svc.updateSettings({ botLoop: { enabled: true, limit: 3 } }), false);
      a.equal('botLoop' in db.getValue('settings'), false);
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe(""); expect(code).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
