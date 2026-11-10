import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOURNAL_RECENT, PROFILE_MAX_BYTES, type MemoryItem } from "../shared/bots";
import { findMemory, JOURNAL_LINE_MAX, memoryDate, memoryKey, memorySection, similarMemories } from "../server/bots/sessionPolicy";

// A bot's memory: a capped profile that's always in its prompt, a journal of which only the latest
// entries are, and search over all of it. Each script runs against its own data directory, in a
// process of its own.
async function run(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bot-memory-"));
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

const SETUP = `
  import { strict as a } from 'node:assert';
  const db = await import('./server/bots/db.ts');
  const svc = await import('./server/bots/service.ts');
  const agent = await import('./server/bots/agent.ts');
  const shared = await import('./shared/bots.ts');
  svc.setHooks({ wake() {}, stop() {} });
  svc.updateSettings({ onboarding: 'done', user: { name: 'Gal' } });
  const boss = svc.createBot({ name: 'Boss' }).bot;
  const scout = svc.createBot({ name: 'Scout' }).bot;
  const section = (id = boss.id) => agent.contextSections(id).openbots_memory;
  const texts = (id = boss.id) => db.memories(id).map((m) => m.text);
`;

const DAY = 24 * 60 * 60 * 1000;
const item = (n: number, kind: MemoryItem["kind"], text: string): MemoryItem => ({ id: `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`, kind, text, at: Date.UTC(2026, 0, 1, 12) + n * DAY });

test("the always-on memory is the whole profile and only the latest few journal entries", () => {
  expect(memorySection([])).toBe("You haven't written any memories yet.");

  // Newest first, as storage returns them: 60 journal entries and 4 profile facts.
  const journal = Array.from({ length: 60 }, (_, i) => item(i, "journal", `Journal entry number ${i}.`)).reverse();
  const profile = [item(100, "profile", "Prefers short answers."), item(101, "profile", "Works Tuesday to Saturday."), item(102, "profile", "Is vegetarian."), item(103, "profile", "Lives in Lisbon.")].reverse();
  const text = memorySection([...profile, ...journal]);
  for (const fact of profile) expect(text).toContain(`- [${fact.id.slice(0, 8)}] ${memoryDate(fact.at)} ${fact.text}`);
  const shown = text.split("\n").filter((l) => /Journal entry number/.test(l));
  expect(shown).toHaveLength(JOURNAL_RECENT);
  expect(shown.map((l) => Number(/number (\d+)/.exec(l)![1]))).toEqual([59, 58, 57, 56, 55]);
  expect(text).toContain(`(${60 - JOURNAL_RECENT} older entries: search finds them)`);
  // Dated, with the short id that forget and replaces take.
  expect(shown[0]).toBe(`- [${journal[0]!.id.slice(0, 8)}] ${memoryDate(journal[0]!.at)} Journal entry number 59.`);

  // It doesn't grow with the journal: ten times the entries, the same size but for the count.
  const many = Array.from({ length: 600 }, (_, i) => item(i, "journal", `Journal entry number ${i % 10}.`)).reverse();
  expect(memorySection([...profile, ...many]).length).toBeLessThanOrEqual(text.length + 2);

  // A long entry (from before the split, say) is cut in the prompt, not in storage.
  const long = item(700, "journal", "x".repeat(2000));
  const cut = memorySection([long]);
  expect(cut).toContain("Your profile is empty");
  expect(cut.split("\n").at(-1)!.length).toBeLessThanOrEqual(JOURNAL_LINE_MAX + 24);
  expect(cut.endsWith("…")).toBe(true);
  expect(long.text).toHaveLength(2000);

  // Whatever is stored, the profile never takes more than its cap.
  const huge = Array.from({ length: 80 }, (_, i) => item(i, "profile", `Lasting fact ${i}: ${"y".repeat(60)}`));
  const capped = memorySection(huge);
  expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(PROFILE_MAX_BYTES + "Your profile:\n".length);
});

test("the same fact is recognised whatever its case, spacing or punctuation, and near ones are pointed out", () => {
  expect(memoryKey("  Likes TEA. ")).toBe(memoryKey("likes tea"));
  expect(memoryKey("Likes tea")).not.toBe(memoryKey("Likes coffee"));
  const items = [item(1, "profile", "Gal's favourite drink is green tea."), item(2, "journal", "Booked the dentist for Friday."), item(3, "journal", "Gal moved to Porto.")];
  expect(similarMemories("Gal's favourite drink is black coffee now.", items).map((m) => m.id)).toEqual([items[0]!.id]);
  expect(similarMemories("Bought a new bike.", items)).toEqual([]);

  // By whole id, exact text (however it's cased or punctuated), or the short id the prompt shows.
  expect(findMemory(items, items[1]!.id)).toBe(items[1]);
  expect(findMemory(items, "booked the dentist for friday")).toBe(items[1]);
  expect(findMemory(items, "[00000003]")).toBe(items[2]);
  expect(findMemory(items, "00000003")).toBe(items[2]);
  // Not by part of the text, and not by a short id that fits several.
  expect(findMemory(items, "dentist")).toBeUndefined();
  expect(findMemory(items, "0000")).toBeUndefined();
  expect(findMemory(items, "")).toBeUndefined();
});

test("writes are deduped, kinds can change, and the profile's cap is hard", async () => {
  await run(`${SETUP}
    // A journal entry by default; the tool gives back the short id and kind.
    const first = agent.memory(boss.id, { action: 'write', text: 'Shipped the invoice export.' });
    a.deepEqual(Object.keys(first), ['id', 'kind']);
    a.equal(first.kind, 'journal');
    a.equal(db.memories(boss.id)[0].id.slice(0, 8), first.id);
    a.equal(db.memories(boss.id)[0].by, boss.id);
    const fact = agent.memory(boss.id, { text: 'Prefers short answers.', kind: 'profile' });
    a.equal(fact.kind, 'profile');
    a.match(section(), /Your profile:\\n- \\[[0-9a-f]{8}\\] \\d{4}-\\d\\d-\\d\\d Prefers short answers\\.\\nYour journal, newest first:\\n- \\[[0-9a-f]{8}\\] \\d{4}-\\d\\d-\\d\\d Shipped the invoice export\\./);

    // The same fact again, however it's typed: still one copy, and it's now the newest.
    const before = db.memories(boss.id).find((m) => m.kind === 'journal');
    const again = agent.memory(boss.id, { action: 'write', text: '  shipped the INVOICE export ' });
    a.equal(again.id, first.id);
    a.match(again.note, /already had this/);
    a.equal(db.memories(boss.id).length, 2);
    a.deepEqual(texts(), ['Shipped the invoice export.', 'Prefers short answers.']);
    a.ok(db.memories(boss.id)[0].at > before.at, 'confirmed again: its date moves up');
    a.equal(db.searchMemory(boss.id, 'invoice').length, 1, 'one row in the index too');

    // Written again as the other kind, it moves rather than doubling: how a bot promotes a journal entry.
    a.equal(agent.memory(boss.id, { action: 'write', text: 'Shipped the invoice export.', kind: 'profile' }).kind, 'profile');
    a.deepEqual(db.memories(boss.id).map((m) => m.kind), ['profile', 'profile']);
    a.doesNotMatch(section(), /Your journal/);

    // Confirming a profile fact without a kind keeps it in the profile: only an explicit kind moves it.
    const kept = agent.memory(boss.id, { action: 'write', text: 'prefers SHORT answers' });
    a.equal(kept.kind, 'profile');
    a.match(kept.note, /already had this/);
    a.deepEqual(db.memories(boss.id).map((m) => [m.text, m.kind]), [['Prefers short answers.', 'profile'], ['Shipped the invoice export.', 'profile']]);
    a.doesNotMatch(section(), /Your journal/);
    // And a journal entry confirmed without a kind stays in the journal.
    agent.memory(boss.id, { action: 'write', text: 'Deployed on Friday.' });
    a.equal(agent.memory(boss.id, { action: 'write', text: 'deployed on friday' }).kind, 'journal');
    // An explicit kind still moves it, both ways.
    a.equal(agent.memory(boss.id, { action: 'write', text: 'Prefers short answers.', kind: 'journal' }).kind, 'journal');
    a.equal(agent.memory(boss.id, { action: 'write', text: 'Prefers short answers.', kind: 'profile' }).kind, 'profile');
    agent.memory(boss.id, { action: 'forget', text: 'Deployed on Friday.' });

    // Another bot's memory is its own.
    a.deepEqual(texts(scout.id), []);
    a.equal(section(scout.id), "You haven't written any memories yet.");
    a.deepEqual(db.searchMemory(scout.id, 'invoice'), []);

    // One fact is a sentence: an essay is refused whole, not cut.
    a.throws(() => agent.memory(boss.id, { action: 'write', text: 'x'.repeat(shared.MEMORY_TEXT_MAX + 1) }), /keep each fact to a sentence[\\s\\S]*Nothing was saved/);
    a.throws(() => agent.memory(boss.id, { action: 'write', text: '   ' }), /Write what to remember/);
    a.throws(() => agent.memory(boss.id, { action: 'write', text: 'Fine.', kind: 'shared' }), /kind is profile or journal/);
    a.throws(() => agent.memory(boss.id, { action: 'recall', text: 'Fine.' }), /action is write or forget/);
    a.equal(db.memories(boss.id).length, 2);

    // The profile fills up to its cap and no further; the journal still takes the fact.
    let wrote = 0;
    const fill = (i) => agent.memory(scout.id, { action: 'write', kind: 'profile', text: 'Lasting fact ' + i + ': ' + 'y'.repeat(120) });
    a.throws(() => { for (let i = 0; i < 100; i++) { fill(i); wrote++; } }, /Your profile is full[\\s\\S]*Forget or merge[\\s\\S]*Nothing was saved/);
    a.ok(wrote >= 5 && wrote < 20, 'wrote ' + wrote);
    a.equal(db.memories(scout.id).length, wrote);
    a.ok(Buffer.byteLength(section(scout.id)) <= shared.PROFILE_MAX_BYTES + 'Your profile:\\n'.length);
    a.equal(section(scout.id).split('\\n').length, wrote + 1, 'all of it is in the prompt');
    // Promoting a journal entry into a full profile is refused the same way, and the entry stays where it was.
    agent.memory(scout.id, { action: 'write', text: 'Lasting fact 500: ' + 'y'.repeat(120) });
    a.throws(() => agent.memory(scout.id, { action: 'write', kind: 'profile', text: 'Lasting fact 500: ' + 'y'.repeat(120) }), /Your profile is full/);
    a.equal(db.memories(scout.id).filter((m) => m.kind === 'journal').length, 1);
    // Confirming a fact that's already in a full profile is fine: it adds nothing.
    a.match(fill(0).note, /already had this/);
    // Making room works.
    agent.memory(scout.id, { action: 'forget', text: 'Lasting fact 1: ' + 'y'.repeat(120) });
    fill(600);
    a.equal(db.memories(scout.id).filter((m) => m.kind === 'profile').length, wrote);
    process.exit(0);
  `);
}, 30_000);

test("forgetting takes the exact text or an id, and a newer fact replaces the one it outdates", async () => {
  await run(`${SETUP}
    const tea = agent.memory(boss.id, { action: 'write', kind: 'profile', text: "Gal's favourite drink is green tea." });
    agent.memory(boss.id, { action: 'write', text: 'Booked the dentist for Friday.' });
    agent.memory(boss.id, { action: 'write', text: 'Gal moved to Porto.' });

    // A fact that contradicts an old one isn't saved in silence: the old one comes back to be dealt with.
    const coffee = agent.memory(boss.id, { action: 'write', kind: 'profile', text: "Gal's favourite drink is black coffee now." });
    a.deepEqual(coffee.similar.map((m) => [m.id, m.kind, m.text]), [[tea.id, 'profile', "Gal's favourite drink is green tea."]]);
    a.match(coffee.similar[0].date, /^\\d{4}-\\d\\d-\\d\\d$/);
    a.match(coffee.check, /Newer wins: forget any that this makes wrong/);
    // An unrelated fact comes back plain.
    a.equal(agent.memory(boss.id, { action: 'write', text: 'Bought a new bike.' }).similar, undefined);

    // Forget by exact text, however it's cased: only that one goes, from the index too.
    const gone = agent.memory(boss.id, { action: 'forget', text: "gal's favourite drink is green tea" });
    a.equal(gone.forgot.id, tea.id);
    a.ok(!texts().includes("Gal's favourite drink is green tea."));
    a.equal(texts().length, 4);
    a.deepEqual(db.searchMemory(boss.id, 'green'), []);
    // Part of a text names nothing, so nothing goes by accident.
    a.throws(() => agent.memory(boss.id, { action: 'forget', text: 'dentist' }), /No such memory/);
    a.throws(() => agent.memory(boss.id, { action: 'forget' }), /Say which memory/);
    a.equal(texts().length, 4);
    // By the short id the prompt shows.
    const bike = db.memories(boss.id).find((m) => m.text === 'Bought a new bike.');
    a.match(section(), new RegExp('- \\\\[' + bike.id.slice(0, 8) + '\\\\] \\\\d{4}-\\\\d\\\\d-\\\\d\\\\d Bought a new bike\\\\.'));
    agent.memory(boss.id, { action: 'forget', id: bike.id.slice(0, 8) });
    a.ok(!texts().includes('Bought a new bike.'));

    // replaces: the old fact goes and the new one lands, in one step, by text or by id.
    const moved = agent.memory(boss.id, { action: 'write', text: 'Gal moved to Lisbon.', replaces: 'Gal moved to Porto.' });
    a.equal(moved.replaced.text, 'Gal moved to Porto.');
    a.equal(moved.similar, undefined, 'the replaced fact is not also reported as a near one');
    a.ok(texts().includes('Gal moved to Lisbon.') && !texts().includes('Gal moved to Porto.'));
    a.deepEqual(db.searchMemory(boss.id, 'Porto'), []);
    const dentist = db.memories(boss.id).find((m) => m.text.startsWith('Booked'));
    agent.memory(boss.id, { action: 'write', text: 'The dentist moved to Monday.', replaces: dentist.id.slice(0, 8) });
    a.deepEqual(texts().sort(), ["Gal's favourite drink is black coffee now.", 'Gal moved to Lisbon.', 'The dentist moved to Monday.'].sort());
    // Naming a fact that isn't there saves nothing, rather than adding a second version.
    a.throws(() => agent.memory(boss.id, { action: 'write', text: 'Gal moved to Faro.', replaces: 'Gal moved to Madrid.' }), /No such memory to replace/);
    a.equal(texts().length, 3);
    // The newest is on top.
    a.equal(texts()[0], 'The dentist moved to Monday.');
    // Rewording a profile fact with replaces and no kind keeps it in the profile.
    const tea2 = agent.memory(boss.id, { action: 'write', text: "Gal's favourite drink is oat flat whites.", replaces: "Gal's favourite drink is black coffee now." });
    a.equal(tea2.kind, 'profile');
    a.equal(tea2.replaced.kind, 'profile');
    process.exit(0);
  `);
}, 30_000);

test("search recalls either kind with its date and kind: best match first, then what only contains the query", async () => {
  await run(`${SETUP}
    const { memoryDate } = await import('./server/bots/sessionPolicy.ts');
    const search = (query, extra = {}) => agent.search(boss.id, { query, ...extra });
    svc.addMemory(boss.id, 'Prefers the window seat on trains.', { kind: 'profile' });
    for (let i = 0; i < 30; i++) svc.addMemory(boss.id, 'Day ' + i + ': walked the dog and tidied the notes.');
    svc.addMemory(boss.id, 'Merged pull request #1230 for the billing page.');
    svc.addMemory(boss.id, 'Train to Porto was late, so the meeting moved.');
    svc.addMemory(boss.id, 'Trains, trains, trains: Gal wants a train trip by train next spring.');
    const stored = db.memories(boss.id);
    const byText = (t) => stored.find((m) => m.text.startsWith(t));

    // Old entries aren't in the prompt any more; search is how they come back.
    a.doesNotMatch(section(), /Day 3:/);
    a.match(section(), /\\(28 older entries: search finds them\\)/);
    const day3 = await search('"Day 3" dog');
    a.ok(day3.some((r) => r.text.startsWith('Day 3:')));

    // Shape: short id, kind, date, whole text.
    const trains = await search('train');
    a.deepEqual(Object.keys(trains[0]), ['id', 'kind', 'date', 'text']);
    a.equal(trains[0].date, memoryDate(byText('Trains, trains').at));
    // Ranked: the entry that's most about trains leads, and both kinds are found.
    a.equal(trains[0].text, byText('Trains, trains').text);
    a.deepEqual(trains.map((r) => r.kind).sort(), ['journal', 'journal', 'profile']);
    a.ok(trains.some((r) => r.kind === 'profile' && r.text === 'Prefers the window seat on trains.'));
    // Equal matches: the newer first.
    const days = await search('tidied');
    a.equal(days.length, 12);
    a.equal(days[0].text, byText('Day 29:').text);

    // The index only knows whole words and their starts. Part of a number or word still finds it.
    a.deepEqual(db.searchMemory(boss.id, '1230').map((m) => m.text), [byText('Merged').text]);
    a.deepEqual((await search('230')).map((r) => r.text), [byText('Merged').text]);
    a.deepEqual((await search('#123')).map((r) => r.text), [byText('Merged').text]);
    a.deepEqual((await search('indow sea')).map((r) => r.kind), ['profile']);
    // And a short id from the prompt finds its entry.
    const porto = byText('Train to Porto');
    a.deepEqual((await search(porto.id.slice(0, 8))).map((r) => r.id), [porto.id.slice(0, 8)]);
    a.deepEqual(await search('zzzz-nothing'), []);
    // Ranked matches come before ones that only contain the query.
    svc.addMemory(boss.id, 'Retrained the spam filter.');
    const mixed = await search('train');
    a.equal(mixed.at(-1).text, 'Retrained the spam filter.');
    a.equal(mixed.length, 4);
    // No query: the newest, for "what do you remember?".
    const newest = await search('');
    a.equal(newest.length, 12);
    a.equal(newest[0].text, 'Retrained the spam filter.');
    // A LIKE wildcard is just a character.
    a.deepEqual(await search('%'), []);
    // Messages are still the other half of search, and no memory comes back from it.
    svc.postMessage(svc.directId(boss.id), { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: 'which train do we take' });
    const said = await search('train', { what: 'messages' });
    a.deepEqual(said.map((r) => r.text), ['which train do we take']);
    process.exit(0);
  `);
}, 30_000);

test("memory from before the split fills the profile newest first up to its cap, the rest becomes journal: nothing lost, and migrating again changes nothing", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    import { Database } from 'bun:sqlite';
    import { mkdirSync } from 'node:fs';
    import { join } from 'node:path';
    const dir = join(process.env.OPENCHAT_DATA_DIR, 'bots');
    mkdirSync(dir, { recursive: true });
    // The database as the version before wrote it: no kind, and an index that has drifted both ways.
    const old = new Database(join(dir, 'bots.sqlite'), { create: true });
    old.exec('CREATE TABLE bots (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)');
    old.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, by TEXT)');
    old.exec('CREATE INDEX memories_bot ON memories(bot_id, at)');
    old.exec('CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, bot_id UNINDEXED, text)');
    const bot = (id, name, at) => old.query('INSERT INTO bots VALUES (?1, ?2, ?3)').run(id, JSON.stringify({ id, name, look: { shape: 'orb', color: 'green' }, primary: at === 1 || undefined, instructions: '', createdAt: at, proactivity: 'normal' }), at);
    bot('boss-0001', 'Boss', 1);
    bot('scout-0001', 'Scout', 2);
    const rows = [];
    const legacy = (id, botId, text, at, by, indexed = true) => {
      old.query('INSERT INTO memories VALUES (?1, ?2, ?3, ?4, ?5)').run(id, botId, text, at, by);
      if (indexed) old.query('INSERT INTO memories_fts (id, bot_id, text) VALUES (?1, ?2, ?3)').run(id, botId, text);
      rows.push({ id, botId, text, at, by });
    };
    for (let i = 0; i < 50; i++) legacy('mem-' + String(i).padStart(4, '0'), 'boss-0001', 'Old note ' + i + ' about zebra' + i, 1000 + i, i % 2 ? 'me' : 'boss-0001');
    legacy('mem-long', 'boss-0001', 'L'.repeat(2000), 5000, null);
    legacy('mem-unindexed', 'boss-0001', 'Never reached the index: quokka', 6000, 'boss-0001', false);
    legacy('mem-scout', 'scout-0001', 'Scout knows about zebra7', 7000, 'scout-0001');
    old.query('INSERT INTO memories_fts (id, bot_id, text) VALUES (?1, ?2, ?3)').run('mem-ghost', 'boss-0001', 'Deleted long ago: okapi');
    old.query('INSERT INTO memories_fts (id, bot_id, text) VALUES (?1, ?2, ?3)').run('mem-0003', 'boss-0001', 'Old note 3 about zebra3');
    old.close();

    const db = await import('./server/bots/db.ts');
    const agent = await import('./server/bots/agent.ts');
    const { profileBytes } = await import('./server/bots/sessionPolicy.ts');
    const { PROFILE_MAX_BYTES, MEMORY_TEXT_MAX } = await import('./shared/bots.ts');
    // What the profile should hold: newest first, every fact that still fits under the cap; one too
    // long to be a fact stays out. Everything else is journal.
    const expectedProfile = (botId) => {
      const picked = [];
      for (const r of [...rows].filter((r) => r.botId === botId).sort((x, y) => y.at - x.at)) {
        if (r.text.length > MEMORY_TEXT_MAX) continue;
        if (profileBytes([...picked, r]) <= PROFILE_MAX_BYTES) picked.push(r);
      }
      return picked.map((r) => r.id);
    };
    const bossProfile = expectedProfile('boss-0001');
    const kindOf = (id) => db.db.query('SELECT kind FROM memories WHERE id = ?').get(id).kind;
    const dump = () => JSON.stringify([
      db.db.query('SELECT id, bot_id, text, at, by, kind FROM memories ORDER BY id').all(),
      db.db.query('SELECT id, bot_id, text FROM memories_fts ORDER BY id').all(),
    ]);
    const check = () => {
      const all = db.db.query('SELECT id, bot_id AS botId, text, at, by FROM memories ORDER BY rowid').all();
      // Every row, with its id, owner, whole text, date and author as they were.
      a.deepEqual(all, rows);
      // The newest facts are in the profile, as many as fit; the overflow is journal.
      a.ok(bossProfile.length >= 10 && bossProfile.length < 50, 'profile holds ' + bossProfile.length);
      a.equal(bossProfile[0], 'mem-unindexed');
      a.ok(!bossProfile.includes('mem-long'));
      a.deepEqual(db.memories('boss-0001').filter((m) => m.kind === 'profile').map((m) => m.id), bossProfile);
      a.ok(profileBytes(db.memories('boss-0001').filter((m) => m.kind === 'profile')) <= PROFILE_MAX_BYTES);
      a.equal(kindOf('mem-long'), 'journal');
      a.equal(kindOf('mem-0000'), 'journal');
      a.equal(kindOf('mem-0049'), 'profile');
      a.equal(kindOf('mem-scout'), 'profile', 'each bot fills its own profile');
      // The index has each row exactly once, and nothing else.
      a.equal(db.db.query('SELECT COUNT(*) AS n FROM memories_fts').get().n, rows.length);
      a.equal(db.db.query('SELECT COUNT(DISTINCT id) AS n FROM memories_fts').get().n, rows.length);
      a.equal(db.memories('boss-0001').length, 52);
      a.equal(db.memories('boss-0001')[0].text, 'Never reached the index: quokka');
      a.equal(db.memories('boss-0001')[0].kind, 'profile');
      a.equal(db.memories('boss-0001').find((m) => m.id === 'mem-long').text.length, 2000);
      a.deepEqual(db.searchMemory('boss-0001', 'quokka').map((m) => m.id), ['mem-unindexed']);
      a.deepEqual(db.searchMemory('boss-0001', 'okapi'), []);
      a.equal(db.searchMemory('boss-0001', 'zebra3')[0].id, 'mem-0003', 'the whole word before words that start with it');
      a.deepEqual(db.searchMemory('boss-0001', 'zebra42').map((m) => m.id), ['mem-0042']);
      a.deepEqual(db.searchMemory('boss-0001', 'zebra7').map((m) => m.id), ['mem-0007'], "another bot's memory stays its own");
      a.deepEqual(db.searchMemory('scout-0001', 'zebra7').map((m) => m.id), ['mem-scout']);
    };
    check();
    const once = dump();
    // Again, and again on a database that's already in the new shape.
    db.migrateMemories(db.db);
    db.migrateMemories(db.db);
    a.equal(dump(), once);
    check();

    // What the bot sees: its standing facts in the profile, the latest overflow, and a way to the rest.
    const section = agent.contextSections('boss-0001').openbots_memory;
    const older = 52 - bossProfile.length - 5;
    a.ok(section.startsWith('Your profile:\\n- [mem-unin] '));
    a.ok(section.split('\\n')[1].endsWith(' Never reached the index: quokka'));
    a.ok(section.includes('Your journal, newest first (' + older + ' older entries: search finds them):'));
    a.equal(section.split('\\n').length, 2 + bossProfile.length + 5);
    a.ok(section.includes('Old note 49 about zebra49'), 'the newest standing rules are in the prompt');
    a.doesNotMatch(section, /Old note 3 /);
    // It promotes an old note by writing it to the profile once there's room: moved, not copied, and migrating leaves that alone.
    const svc = await import('./server/bots/service.ts');
    svc.setHooks({ wake() {}, stop() {} });
    a.throws(() => agent.memory('boss-0001', { action: 'write', kind: 'profile', text: 'Old note 3 about zebra3' }), /Your profile is full/);
    agent.memory('boss-0001', { action: 'write', kind: 'journal', text: 'Old note 49 about zebra49' });
    agent.memory('boss-0001', { action: 'write', kind: 'journal', text: 'Old note 48 about zebra48' });
    const promoted = agent.memory('boss-0001', { action: 'write', kind: 'profile', text: 'Old note 3 about zebra3' });
    a.equal(promoted.id, 'mem-0003');
    a.equal(db.memories('boss-0001').length, 52);
    db.migrateMemories(db.db);
    a.equal(db.memories('boss-0001').find((m) => m.id === 'mem-0003').kind, 'profile');
    a.match(agent.contextSections('boss-0001').openbots_memory, /^Your profile:\\n- \\[mem-0003\\] \\d{4}-\\d\\d-\\d\\d Old note 3 about zebra3\\n/);
    a.equal(kindOf('mem-0049'), 'journal', 'demoting is explicit, and migrating leaves it alone');
    // New writes land in the migrated table and index.
    agent.memory('boss-0001', { action: 'write', text: 'Fresh after migrating: wombat.' });
    a.equal(db.searchMemory('boss-0001', 'wombat').length, 1);
    a.equal(db.db.query('SELECT COUNT(*) AS n FROM memories_fts').get().n, rows.length + 1);
    process.exit(0);
  `);
}, 30_000);

test("memory outlives the process: a new one reads back the same profile, journal and index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bot-memory-restart-"));
  const env = { ...process.env, OPENCHAT_DATA_DIR: dir, PI_BIN: join(dir, "no-pi"), PI_CODING_AGENT_DIR: join(dir, "pi"), OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json") };
  const spawn = async (script: string) => {
    const child = Bun.spawn([process.execPath, "-e", script], { cwd: join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) console.error(out, err);
    expect(err).toBe("");
    expect(code).toBe(0);
    return out;
  };
  try {
    const first = await spawn(`
      const svc = await import('./server/bots/service.ts');
      const agent = await import('./server/bots/agent.ts');
      svc.setHooks({ wake() {}, stop() {} });
      const boss = svc.createBot({ name: 'Boss' }).bot;
      agent.memory(boss.id, { action: 'write', kind: 'profile', text: 'Prefers short answers.' });
      for (let i = 0; i < 9; i++) agent.memory(boss.id, { action: 'write', text: 'Entry ' + i + ' of the week.' });
      console.log(JSON.stringify({ id: boss.id, section: agent.contextSections(boss.id).openbots_memory }));
      process.exit(0);
    `);
    const { id, section } = JSON.parse(first) as { id: string; section: string };
    expect(section).toContain("(4 older entries: search finds them)");
    // No Pi session exists anywhere in this: the database alone carries it.
    const second = await spawn(`
      const db = await import('./server/bots/db.ts');
      const agent = await import('./server/bots/agent.ts');
      console.log(JSON.stringify({ section: agent.contextSections(${JSON.stringify(id)}).openbots_memory, found: db.searchMemory(${JSON.stringify(id)}, 'Entry 0').map((m) => m.text) }));
      process.exit(0);
    `);
    const again = JSON.parse(second) as { section: string; found: string[] };
    expect(again.section).toBe(section);
    expect(again.found[0]).toBe("Entry 0 of the week.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
