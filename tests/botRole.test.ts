import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanRole, firstSentence, ROLE_MAX, roleLine } from "../shared/bots";
import { spawnScript } from "./spawnScript";

// A bot's role: one line teammates see in their roster, apart from its instructions. Each script runs
// against its own data directory, in a process of its own.
async function run(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bot-role-"));
  try {
    const { code, stdout: out, stderr: err } = await spawnScript(script, { OPENCHAT_DATA_DIR: dir, PI_BIN: join(dir, "no-pi"), PI_CODING_AGENT_DIR: join(dir, "pi"), OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json") });
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
  svc.setHooks({ wake() {}, stop() {} });
  svc.updateSettings({ onboarding: 'done', user: { name: 'Gal' } });
  // The app's routes, once the test's bots are made: with none yet, they'd start the usual primary.
  // The runner first: a bot made through manage imports it lazily to introduce itself (agent.ts), and
  // Bun 1.3.8 runs routes.ts (which starts the runner as it loads) before a runner that is still loading.
  const app = async () => (await import('./server/bots/runner.ts'), (await import('./server/bots/routes.ts')).botRoutes((h) => h));
  // The app's settings: the user's own edit.
  const patch = async (id, body) => {
    const req = new Request('http://x/api/bots/' + id, { method: 'PATCH', body: JSON.stringify(body) });
    req.params = { id };
    a.equal((await (await app())['/api/bots/:id'].PATCH(req)).status, 200);
  };
  const roster = (botId) => agent.contextSections(botId).openbots_team.split('\\n').filter((l) => l.startsWith('- '));
  const rosterLine = (viewer, bot) => roster(viewer).find((l) => l.startsWith('- ' + bot.name + ' ('));
  const changed = (bot) => db.messages(svc.directId(bot.id), 500).map((r) => r.message).filter((m) => m.event?.kind === 'changed').map((m) => m.event.text);
`;

test("a role is one line, capped; the fallback is the instructions' first sentence, not cut at e.g.", () => {
  expect(cleanRole("  Plans\n trips,\tbooks nothing  ")).toBe("Plans trips, books nothing");
  expect(cleanRole("x".repeat(300))).toHaveLength(ROLE_MAX);
  expect(cleanRole(42)).toBe("");
  expect(firstSentence("You plan trips, e.g. Lisbon or Porto, and book nothing. You also track receipts.")).toBe("You plan trips, e.g. Lisbon or Porto, and book nothing.");
  expect(firstSentence("You file things (i.e. receipts, bills, etc.) by month! Then tidy.")).toBe("You file things (i.e. receipts, bills, etc.) by month!");
  expect(firstSentence("Ask Dr. Eggbot first. Then go.")).toBe("Ask Dr. Eggbot first.");
  expect(firstSentence("Version 1.5 is out? Yes.")).toBe("Version 1.5 is out?");
  expect(firstSentence("\n  You plan trips\n- and more")).toBe("You plan trips");
  expect(firstSentence("")).toBe("");
  expect(roleLine({ role: "Books flights.", instructions: "You plan trips." })).toBe("Books flights.");
  expect(roleLine({ role: "  ", instructions: "You plan trips. More." })).toBe("You plan trips.");
  const long = roleLine({ instructions: `You ${"really ".repeat(30)}plan.` });
  expect(long).toHaveLength(ROLE_MAX);
  expect(long.endsWith("…")).toBe(true);
  expect(roleLine({ instructions: "" })).toBe("");
});

test("bots stored before roles load with an empty one, and the migration is safe to run again", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    import { Database } from 'bun:sqlite';
    import { mkdirSync } from 'node:fs';
    import { join } from 'node:path';
    const dir = join(process.env.OPENCHAT_DATA_DIR, 'bots');
    mkdirSync(dir, { recursive: true });
    const old = new Database(join(dir, 'bots.sqlite'), { create: true });
    old.exec('CREATE TABLE bots (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)');
    const legacy = (id, name, instructions, at) => old.query('INSERT INTO bots VALUES (?1, ?2, ?3)').run(id, JSON.stringify({ id, name, look: { shape: 'orb', color: 'green' }, primary: at === 1 || undefined, instructions, createdAt: at, proactivity: 'normal', by: 'me' }), at);
    legacy('boss-0001', 'Boss', '', 1);
    legacy('scout-0001', 'Scout', 'You research prices, e.g. flights and hotels, before anything is booked. Then report.', 2);
    old.close();

    const db = await import('./server/bots/db.ts');
    const agent = await import('./server/bots/agent.ts');
    a.deepEqual(db.listBots().map((b) => [b.name, b.role]), [['Boss', ''], ['Scout', '']]);
    // Running it again changes nothing, and doesn't touch a role that's set.
    db.putBot({ ...db.getBot('scout-0001'), role: 'Finds the best prices.' });
    db.db.exec("UPDATE bots SET data = json_set(data, '$.role', '') WHERE json_valid(data) AND json_type(data, '$.role') IS NULL;");
    a.equal(db.getBot('scout-0001').role, 'Finds the best prices.');
    db.putBot({ ...db.getBot('scout-0001'), role: '' });
    a.match(agent.contextSections('boss-0001').openbots_team, /- Scout \\(scout-00\\): You research prices, e\\.g\\. flights and hotels, before anything is booked\\.$/m);
    process.exit(0);
  `);
}, 30_000);

test("the roster shows a teammate's role, else its first sentence, and the user's edit wins", async () => {
  await run(`${SETUP}
    const boss = svc.createBot({ name: 'Boss' }).bot;
    const planner = svc.createBot({ name: 'Planner', instructions: 'You plan the user\\'s days, e.g. calls and trips, and book nothing alone. Then more.', role: 'Plans the week;\\nbooks nothing alone.' }).bot;
    const scout = svc.createBot({ name: 'Scout', instructions: 'You research prices, e.g. flights. Then report.' }).bot;
    const quiet = svc.createBot({ name: 'Quiet' }).bot;
    a.equal(db.getBot(planner.id).role, 'Plans the week; books nothing alone.', 'one line');
    a.equal(rosterLine(boss.id, planner), '- Planner (' + planner.id.slice(0, 8) + '): Plans the week; books nothing alone.');
    a.equal(rosterLine(boss.id, scout), '- Scout (' + scout.id.slice(0, 8) + '): You research prices, e.g. flights.');
    a.equal(rosterLine(boss.id, quiet), '- Quiet (' + quiet.id.slice(0, 8) + '): no instructions yet');
    a.equal(agent.manage(boss.id, { action: 'team', bot: 'Planner' })[0].role, 'Plans the week; books nothing alone.');
    a.equal(agent.manage(boss.id, { action: 'team', bot: 'Scout' })[0].role, undefined);
    // A bot hears its own role.
    a.match(agent.contextSections(planner.id).openbots_instructions, /Your role, as your teammates see it: Plans the week/);
    a.doesNotMatch(agent.contextSections(planner.id).openbots_instructions, /You have no role yet/);
    a.match(agent.contextSections(scout.id).openbots_instructions, /You have no role yet/);

    // The user sets one in the app, capped: a full-length role is in the roster whole.
    const full = 'Finds ' + 'x'.repeat(200);
    await patch(scout.id, { role: full });
    a.equal(db.getBot(scout.id).role, full.slice(0, agent.ROLE_MAX));
    a.equal(rosterLine(boss.id, scout), '- Scout (' + scout.id.slice(0, 8) + '): ' + full.slice(0, agent.ROLE_MAX));
    // And the primary hears what the user changed, as it does for instructions.
    const notes = svc.pendingChangeNotes(boss.id);
    a.deepEqual(notes.map((n) => [n.field, n.from]), [['role', 'none']]);
    a.match(svc.changeNoteText(boss.id, notes), /- Gal changed Scout's role from none to “Finds x+”\\./);
    // Cleared, the first sentence stands in again.
    await patch(scout.id, { role: '' });
    a.equal(rosterLine(boss.id, scout), '- Scout (' + scout.id.slice(0, 8) + '): You research prices, e.g. flights.');

    // Group lead-picking reads the explicit role first.
    const named = svc.createBot({ name: 'Flo', instructions: 'You help out.', role: 'Reviews invoices and receipts.' }).bot;
    const other = svc.createBot({ name: 'Rex', instructions: 'You review invoices and receipts all day.', role: 'Walks the dog.' }).bot;
    a.equal(svc.pickLead('can someone check these invoices?', [named.id, other.id]), named.id);
    process.exit(0);
  `);
}, 30_000);

test("a bot writes its own role once, visibly; after that it's the user's and the primary's", async () => {
  await run(`${SETUP}
    const boss = svc.createBot({ name: 'Boss' }).bot;
    const juniper = svc.createBot({ name: 'Juniper', instructions: 'You keep notes.' }).bot;
    const pip = svc.createBot({ name: 'Pip' }).bot;
    a.equal(changed(juniper).length, 0);

    // Its first role, with its instructions already set: written, and said in its own chat in full.
    const role = 'Keeps the user\\'s notes tidy, ' + 'y'.repeat(60);
    agent.manage(juniper.id, { action: 'update', role });
    a.equal(db.getBot(juniper.id).role, role);
    a.ok(role.length > 60 && role.length <= agent.ROLE_MAX);
    a.deepEqual(changed(juniper), ["Juniper's role: none → “" + role + "”"]);
    a.match(rosterLine(boss.id, juniper), new RegExp(': Keeps the user.s notes tidy, y{60}$'));

    // Set, it stays: alone, the call says why; with something else, the rest still goes through.
    a.throws(() => agent.manage(juniper.id, { action: 'update', role: 'Rewritten.' }), /Say what to change/);
    agent.manage(juniper.id, { action: 'update', role: 'Rewritten.', name: 'Juno' });
    a.deepEqual([db.getBot(juniper.id).role, db.getBot(juniper.id).name], [role, 'Juno']);
    // Not another bot's, empty or not.
    a.throws(() => agent.manage(juniper.id, { action: 'update', bot: 'Pip', role: 'Nope.' }), /only change yourself/);
    a.equal(db.getBot(pip.id).role, '');

    // The primary sets others' roles, on create and on update, as it does instructions.
    const coach = agent.manage(boss.id, { action: 'create', name: 'Coach', role: 'Tracks runs.' });
    a.equal(db.getBot(coach.id).role, 'Tracks runs.');
    agent.manage(boss.id, { action: 'update', bot: 'Juno', role: 'Files notes.' });
    a.equal(db.getBot(juniper.id).role, 'Files notes.');
    a.equal(changed(juniper).at(-1), "Juno's role: “" + role + "” → “Files notes.”");
    agent.manage(boss.id, { action: 'update', role: 'Runs the team.' });
    a.equal(db.getBot(boss.id).role, 'Runs the team.');

    // The user can always change it; cleared, the bot may write it again.
    await patch(juniper.id, { role: 'User says so.' });
    a.equal(db.getBot(juniper.id).role, 'User says so.');
    a.throws(() => agent.manage(juniper.id, { action: 'update', role: 'Mine.' }), /Say what to change/);
    await patch(juniper.id, { role: '' });
    agent.manage(juniper.id, { action: 'update', role: 'Mine again.' });
    a.equal(db.getBot(juniper.id).role, 'Mine again.');
    a.equal(changed(juniper).at(-1), "Juno's role: none → “Mine again.”");

    // Instructions keep their own rule, unannounced: a self-write of both shows only the role.
    agent.manage(pip.id, { action: 'update', instructions: 'You help.', role: 'Helps.' });
    a.deepEqual([db.getBot(pip.id).instructions, db.getBot(pip.id).role], ['You help.', 'Helps.']);
    a.deepEqual(changed(pip), ["Pip's role: none → “Helps.”"]);
    process.exit(0);
  `);
}, 30_000);

test("a new bot is told to write its instructions and its role together on its first turn, and only what's still empty", async () => {
  await run(`${SETUP}
    const guide = (bot) => agent.contextSections(bot.id).openbots_instructions;
    const both = /You don't have instructions yet\\. You have no role yet either\\. Write both yourself on your first turn, in one manage_bot update with instructions and role together/;
    const boss = svc.createBot({ name: 'Boss' }).bot;
    const fresh = svc.createBot({ name: 'Fresh' }).bot;

    // Nothing set: one nudge for both, in one call, and not the user's job. Primary or not.
    for (const bot of [boss, fresh]) {
      a.match(guide(bot), both);
      a.match(guide(bot), /Don't ask the user to write them or announce them/);
      a.doesNotMatch(guide(bot), /already set/);
    }
    // One update writes both.
    agent.manage(fresh.id, { action: 'update', instructions: 'You plan trips and book nothing without asking.', role: 'Plans trips; books nothing alone.' });
    a.deepEqual([db.getBot(fresh.id).instructions, db.getBot(fresh.id).role], ['You plan trips and book nothing without asking.', 'Plans trips; books nothing alone.']);
    agent.manage(boss.id, { action: 'update', instructions: 'You run the team.', role: 'Runs the team.' });
    a.deepEqual([db.getBot(boss.id).instructions, db.getBot(boss.id).role], ['You run the team.', 'Runs the team.']);
    // Done, the nudge is gone, and each field is closed to the bot on its own.
    a.doesNotMatch(guide(fresh), /You don't have instructions yet|You have no role yet/);
    a.doesNotMatch(guide(boss), /You don't have instructions yet|You have no role yet/);
    a.throws(() => agent.manage(fresh.id, { action: 'update', instructions: 'Rewritten.', role: 'Rewritten.' }), /Say what to change/);
    a.throws(() => agent.manage(fresh.id, { action: 'update', instructions: 'Rewritten.' }), /Say what to change/);
    a.throws(() => agent.manage(fresh.id, { action: 'update', role: 'Rewritten.' }), /Say what to change/);
    a.deepEqual([db.getBot(fresh.id).instructions, db.getBot(fresh.id).role], ['You plan trips and book nothing without asking.', 'Plans trips; books nothing alone.']);

    // The user wrote its instructions when making it: it's asked for its role only, and can't touch the instructions.
    const briefed = svc.createBot({ name: 'Briefed', instructions: 'You keep notes.' }).bot;
    a.match(guide(briefed), /You have no role yet; your instructions are already set, so leave them\\. Write it yourself this turn with manage_bot update role/);
    a.doesNotMatch(guide(briefed), /You don't have instructions yet|Write both/);
    agent.manage(briefed.id, { action: 'update', instructions: 'Mine now.', role: 'Keeps the notes.' });
    a.deepEqual([db.getBot(briefed.id).instructions, db.getBot(briefed.id).role], ['You keep notes.', 'Keeps the notes.']);
    a.doesNotMatch(guide(briefed), /You have no role yet/);

    // The primary gave it a role and no instructions: it's asked for those only, and its role stays.
    const named = db.getBot(agent.manage(boss.id, { action: 'create', name: 'Named', role: 'Tracks runs.' }).id);
    a.match(guide(named), /You don't have instructions yet; your role is already set, so leave it\\./);
    a.match(guide(named), /On your first turn, as soon as you know what they want from you and how, write them yourself with manage_bot update/);
    a.doesNotMatch(guide(named), /You have no role yet|Write both/);
    agent.manage(named.id, { action: 'update', instructions: 'You track runs.', role: 'Mine now.' });
    a.deepEqual([db.getBot(named.id).instructions, db.getBot(named.id).role], ['You track runs.', 'Tracks runs.']);
    a.doesNotMatch(guide(named), /You don't have instructions yet/);

    // The primary with instructions and no role is asked for its role, and isn't told its instructions are closed: they aren't.
    await patch(boss.id, { role: '' });
    a.match(guide(boss), /You have no role yet\\. Write it yourself this turn with manage_bot update role/);
    a.doesNotMatch(guide(boss), /so leave them/);
    a.match(guide(boss), /update your instructions with manage_bot/);

    // The user's own edit in the app closes a field the same way.
    const half = svc.createBot({ name: 'Half' }).bot;
    await patch(half.id, { role: 'Answers mail.' });
    a.match(guide(half), /You don't have instructions yet; your role is already set/);
    await patch(half.id, { role: '', instructions: 'You answer mail.' });
    a.match(guide(half), /You have no role yet; your instructions are already set/);
    process.exit(0);
  `);
}, 30_000);

test("the app's new bot carries its role through the API, as one line", async () => {
  await run(`${SETUP}
    svc.createBot({ name: 'Boss' });
    const req = new Request('http://x/api/bots', { method: 'POST', body: JSON.stringify({ name: 'Ada', role: '  Answers\\nmail. ', instructions: 'You answer mail.' }) });
    const res = await (await app())['/api/bots'].POST(req);
    a.equal(res.status, 200);
    const { bot } = await res.json();
    a.equal(db.getBot(bot.id).role, 'Answers mail.');
    process.exit(0);
  `);
}, 30_000);
