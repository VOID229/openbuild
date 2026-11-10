import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The one look a bot gets through the memory it had before the profile/journal split: on its next
// turn of its own, once, and only if it had any. Turns run on fake Pis that record their prompts.
// Each script runs against its own data directory, in a process of its own.
async function run(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bot-memory-review-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, OPENCHAT_DATA_DIR: dir, PI_BIN: join(dir, "no-pi"), PI_CODING_AGENT_DIR: join(dir, "pi"), OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) console.error(out, err);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a bot with memory from before the split is asked once to promote what lasts; one without never is, and migrating again doesn't re-arm it", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    const minds = globalThis.openbotsMinds = new Map();
    const db = await import('./server/bots/db.ts');
    const svc = await import('./server/bots/service.ts');
    const runner = await import('./server/bots/runner.ts');
    const store = await import('./server/friends/store.ts');
    const chats = await import('./server/friends/chats.ts');
    const { newKeyPair, keyId } = await import('./server/friends/protocol.ts');
    const { piFlags, friendFlags } = await import('./server/bots/extensions.ts');
    const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
    svc.updateSettings({ onboarding: 'done', user: { name: 'Gal' } });
    const boss = svc.createBot({ name: 'Boss' });
    const scout = svc.createBot({ name: 'Scout' });
    const fresh = svc.createBot({ name: 'Fresh' });
    for (let i = 0; i < 80; i++) svc.addMemory(scout.bot.id, 'Old note ' + i + ' about wombat' + i + '.', { by: scout.bot.id });
    svc.addMemory(boss.bot.id, 'Gal likes oolong tea.', { by: boss.bot.id });

    // Back to the shape the version before the split wrote, then migrated as a load would.
    db.db.exec('DROP INDEX memories_kind; ALTER TABLE memories DROP COLUMN kind');
    db.migrateMemories(db.db);
    const armed = () => db.db.query("SELECT key FROM kv WHERE key LIKE 'memory-review:%' ORDER BY key").all().map((r) => r.key.slice('memory-review:'.length));
    // Scout's newest notes filled its profile and the rest went to its journal; Boss's one fact fit in its profile, so it has nothing to sort.
    const older = db.memories(scout.bot.id).filter((m) => m.kind === 'journal');
    a.ok(older.length > 40 && older.length < 80);
    a.equal(db.memories(boss.bot.id)[0].kind, 'profile');
    a.deepEqual(armed(), [scout.bot.id], 'only bots left with old memory in their journal');
    // A note written after the split isn't one from before.
    svc.addMemory(scout.bot.id, 'Gal asked about the platypus exhibit today.', { by: 'me' });

    // A shared chat with a friend, Scout in it.
    svc.setFriendHooks({ relay: chats.relay, members: chats.members, left: chats.left, list: () => [] });
    const key = newKeyPair();
    const FID = keyId(key.publicKey);
    store.putFriend({ id: FID, name: 'Alice', publicKey: key.publicKey, role: 'guest', mode: 'lan', listen: '127.0.0.1', addedAt: Date.now() });
    const friend = store.friend(FID);
    const BOLT = crypto.randomUUID(), CHAT = crypto.randomUUID();
    chats.apply(friend, 'chat.open', { chat: CHAT, name: 'Picnic', members: [{ id: BOLT, name: 'Bolt', look: { shape: 'pill', color: 'blue' } }], owner: 'Alice' });
    const shared = db.listConversations().find((c) => c.friend?.chat === CHAT);
    svc.updateConversation(shared.id, { botIds: [scout.bot.id] });

    // Fake Pis, one per bot's own lane and one for Scout's lane with Alice.
    const prompts = [];
    const fake = (bot, lane = 'main') => {
      const mind = { token: 'test', loaded: JSON.stringify(lane === 'main' ? piFlags() : friendFlags(store.allowsTools(FID))), busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), close() {}, async send(cmd) {
        if (cmd.type === 'prompt') prompts.push({ ...cmd, bot: bot.id, lane, armed: armed(), finish(text) { mind.draft = text; mind.onSettled?.(); } });
        return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
      } } };
      Object.defineProperty(mind, 'sessionPath', { get: () => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', bot.id, globalThis.openbotsFocus?.get(bot.id) ?? svc.directId(bot.id), lane)) });
      minds.set(lane === 'main' ? bot.id : bot.id + '~' + lane, mind);
    };
    for (const b of [boss, scout, fresh]) fake(b.bot);
    fake(scout.bot, 'friend:' + FID);
    svc.setHooks({ wake: runner.wake, stop: runner.stop });
    const until = async (check) => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); a.ok(check()); };
    const end = async (prompt) => { prompt.finish('[silent]'); await until(() => !runner.busy(prompt.bot)); };
    const turn = async (bot, text = 'hi') => {
      const n = prompts.length;
      svc.postMessage(bot.conversationId, { id: crypto.randomUUID(), author: 'me', text, at: Date.now() });
      await until(() => prompts.length === n + 1);
      await end(prompts[n]);
      return prompts[n];
    };
    const REVIEW = /Just this once: make your profile hold only lasting facts/;

    // Scout's turn in the friend's chat neither shows nor spends it.
    const n = prompts.length;
    chats.apply(friend, 'chat.message', { chat: CHAT, message: { id: crypto.randomUUID(), member: BOLT, text: '@Scout what do you remember?' } });
    await until(() => prompts.length === n + 1);
    a.equal(prompts[n].lane, 'friend:' + FID);
    a.doesNotMatch(prompts[n].message, REVIEW);
    a.doesNotMatch(prompts[n].message, /wombat/);
    await end(prompts[n]);
    a.ok(armed().includes(scout.bot.id));

    // Scout's own next turn: the instruction and its newest 40 entries from before, and it's done before the turn even ends.
    const first = await turn(scout);
    a.match(first.message, REVIEW);
    a.match(first.message, /who Gal is, their standing preferences, and your own role and way of working/);
    a.match(first.message, /capped at 1500 bytes/);
    const newestOld = older[0].text.replace('.', '\\\\.');
    a.match(first.message, new RegExp('Your older entries from before, newest first \\\\(' + (older.length - 40) + ' more: search finds them\\\\):\\\\n- \\\\[[0-9a-f]{8}\\\\] \\\\d{4}-\\\\d\\\\d-\\\\d\\\\d ' + newestOld + '\\\\n'));
    a.equal(first.message.match(/^- \\[[0-9a-f]{8}\\] \\d{4}-\\d\\d-\\d\\d Old note \\d+ /gm).length, 40);
    a.doesNotMatch(first.message, new RegExp(older.at(-1).text.replace('.', '\\\\.')), 'the oldest are left to search');
    a.doesNotMatch(first.message, /platypus/);
    a.ok(first.message.indexOf('Just this once') < first.message.indexOf('The time is'));
    a.deepEqual(first.armed, [], 'taken as the turn starts');

    // It promotes one with the memory tool it already has, and never hears of this again.
    const agent = await import('./server/bots/agent.ts');
    a.equal(agent.memory(scout.bot.id, { action: 'write', kind: 'journal', text: db.memories(scout.bot.id).find((m) => m.kind === 'profile').text }).kind, 'journal');
    a.equal(agent.memory(scout.bot.id, { action: 'write', kind: 'profile', text: older.at(-1).text }).kind, 'profile');
    db.migrateMemories(db.db);
    a.deepEqual(armed(), [], 'migrating again re-arms nothing');
    const second = await turn(scout, 'again');
    a.doesNotMatch(second.message, REVIEW);
    a.doesNotMatch(second.message, /entries from before/);
    a.doesNotMatch(second.message, /wombat/);

    // Boss, whose old memory all fit in its profile: nothing to sort, so never asked.
    a.doesNotMatch((await turn(boss)).message, REVIEW);

    // A bot with nothing from before: not on its first turn, and not once it writes journal entries of its own.
    a.doesNotMatch((await turn(fresh)).message, REVIEW);
    for (let i = 0; i < 8; i++) agent.memory(fresh.bot.id, { action: 'write', text: 'Fresh note ' + i + ' on the garden.' });
    db.migrateMemories(db.db);
    a.deepEqual(armed(), []);
    a.doesNotMatch((await turn(fresh, 'again')).message, REVIEW);
    // Nor in what it carries every turn: the instruction leaves nothing behind in any bot's context.
    for (const b of [boss, scout, fresh]) a.doesNotMatch(agent.contextFor(b.bot.id), /Just this once|entries from before/);
    process.exit(0);
  `);
}, 60_000);

test("the migration arms the look only for bots left with old memory in their journal, and a bot deleted first leaves nothing armed", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    import { Database } from 'bun:sqlite';
    import { mkdirSync } from 'node:fs';
    import { join } from 'node:path';
    const dir = join(process.env.OPENCHAT_DATA_DIR, 'bots');
    mkdirSync(dir, { recursive: true });
    // The database as the version before the split wrote it.
    const old = new Database(join(dir, 'bots.sqlite'), { create: true });
    old.exec('CREATE TABLE bots (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)');
    old.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, by TEXT)');
    old.exec('CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, bot_id UNINDEXED, text)');
    const bot = (id, name, at) => old.query('INSERT INTO bots VALUES (?1, ?2, ?3)').run(id, JSON.stringify({ id, name, look: { shape: 'orb', color: 'green' }, primary: at === 1 || undefined, instructions: '', createdAt: at, proactivity: 'normal' }), at);
    const mem = (id, botId, text, at) => old.query('INSERT INTO memories VALUES (?1, ?2, ?3, ?4, ?5)').run(id, botId, text, at, 'me');
    bot('boss-0001', 'Boss', 1);
    bot('quiet-0001', 'Quiet', 2);
    bot('gone-0001', 'Gone', 3);
    bot('fits-0001', 'Fits', 4);
    // Boss: two facts that fit its profile, and one too long to be a fact, which stays in its journal.
    mem('mem-1', 'boss-0001', 'Gal likes tea.', 1000);
    mem('mem-long', 'boss-0001', 'L'.repeat(600), 1500);
    mem('mem-2', 'boss-0001', 'Gal works weekends.', 2000);
    mem('mem-3', 'gone-0001', 'G'.repeat(600), 3000);
    mem('mem-4', 'fits-0001', 'Fits knew this.', 3500);
    mem('mem-5', 'nobody-0001', 'O'.repeat(600), 4000);
    old.close();

    const db = await import('./server/bots/db.ts');
    const svc = await import('./server/bots/service.ts');
    svc.setHooks({ wake() {}, stop() {} });
    const armed = () => db.db.query("SELECT key, value FROM kv WHERE key LIKE 'memory-review:%' ORDER BY key").all();
    // Marked with each one's newest date then. Not a bot with no memory, nor one whose memory all fit its profile, nor rows with no bot.
    a.deepEqual(armed(), [{ key: 'memory-review:boss-0001', value: '2000' }, { key: 'memory-review:gone-0001', value: '3000' }]);
    a.deepEqual(db.memories('boss-0001').map((m) => [m.id, m.kind]), [['mem-2', 'profile'], ['mem-long', 'journal'], ['mem-1', 'profile']]);
    a.equal(svc.memoryReviewNote('quiet-0001'), '');
    a.equal(svc.memoryReviewNote('fits-0001'), '');
    await svc.deleteBot('gone-0001');
    a.deepEqual(armed().map((r) => r.key), ['memory-review:boss-0001']);
    db.migrateMemories(db.db);
    a.equal(armed().length, 1);
    // Taken once: the note with only the old journal entries, then never again.
    const note = svc.memoryReviewNote('boss-0001');
    a.match(note, /Your older entries from before, newest first:\\n- \\[mem-long\\] \\d{4}-\\d\\d-\\d\\d L+…$/);
    a.doesNotMatch(note, /Gal likes tea|Gal works weekends/);
    a.equal(svc.memoryReviewNote('boss-0001'), '');
    a.equal(db.takeMemoryReview('boss-0001'), undefined);
    db.migrateMemories(db.db);
    a.deepEqual(armed(), []);
    process.exit(0);
  `);
}, 30_000);
