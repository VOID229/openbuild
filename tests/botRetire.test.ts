// Retiring a bot: a pause between active and deleted, undone by rehiring it. What it keeps, what
// stops reaching it, what goes back to whoever sent it, what the other bots hear, and that its chat
// is there to read and nothing more. Each script runs against its own data directory, in a process
// of its own.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unexpectedStderr } from "./botStderr";
import { spawnScript } from "./spawnScript";

async function run(name: string, script: string) {
  const dir = await mkdtemp(join(tmpdir(), `openbuild-bot-retire-${name}-`));
  try {
    const { code, stderr: err } = await spawnScript(script, { OPENCHAT_DATA_DIR: dir, PI_CODING_AGENT_DIR: join(dir, "pi") });
    expect(unexpectedStderr(err)).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A team to retire from, with the runner's hooks replaced by ones that record what they're asked. */
const TEAM = `
  import { strict as a } from 'node:assert';
  import { mock } from 'bun:test';
  mock.module('./server/computers/api.ts', () => ({ computerApi: () => ({ call: async () => ({}) }), computerTargets: async () => [] }));
  const db = await import('./server/bots/db.ts');
  const svc = await import('./server/bots/service.ts');
  const wakes = [];
  const stopped = [];
  let assigned = [];
  let waiting = [];
  const hooks = { wake: (id, w) => wakes.push({ id, ...w }), stop: (id) => stopped.push(id), halt: () => true, pendingAssignments: () => assigned, pendingChats: () => waiting };
  svc.setHooks(hooks);
  // Never quiet hours, so the clock's check-ins don't depend on when the test runs.
  svc.updateSettings({ user: { name: 'Outis' }, onboarding: 'done', quietHours: { from: 0, to: 0 } });
  const boss = svc.createBot({ name: 'Boss' });
  const tracer = svc.createBot({ name: 'Tracer', role: 'Checks the work.', instructions: 'Review pull requests.', look: { shape: 'tablet', color: 'blue' } });
  const scout = svc.createBot({ name: 'Scout', role: 'Looks things up.' });
  const team = svc.createConversation({ kind: 'group', name: 'Team', botIds: [boss.bot.id, tracer.bot.id, scout.bot.id] });
  const short = (id) => id.slice(0, 8);
  const say = (conversationId, author, text, extra) => svc.postMessage(conversationId, { id: crypto.randomUUID(), author, at: Date.now(), text, ...extra });
  const lines = (conversationId) => db.messages(conversationId, 50).map((r) => r.message).filter((m) => m.event).map((m) => [m.author === 'me' ? 'me' : 'bot', m.event.text, m.event.detail].filter(Boolean).join(' | '));
  const wokeFor = (id) => wakes.filter((w) => w.id === id);
`;

test("a retired bot keeps everything, leaves its groups and pauses; rehiring brings it back with its routines still paused", () => run("state", `${TEAM}
  svc.updateBot(tracer.bot.id, { model: 'openai/gpt-6', effort: 'high', fallbackModels: ['xai/grok-4'] }, { quiet: true });
  svc.addMemory(tracer.bot.id, 'Outis likes short reviews.', { kind: 'profile' });
  svc.addMemory(tracer.bot.id, 'Reviewed the login fix.');
  const duo = svc.createConversation({ kind: 'group', name: 'Duo', botIds: [tracer.bot.id, scout.bot.id] });
  const nightly = svc.saveRoutine(tracer.bot.id, { id: crypto.randomUUID(), title: 'Nightly checks', schedule: 'every day at 2', enabled: true });
  const inTeam = svc.saveRoutine(tracer.bot.id, { id: crypto.randomUUID(), title: 'Standup', schedule: 'weekdays at 9', conversationId: team.id, enabled: true });
  const off = svc.saveRoutine(tracer.bot.id, { id: crypto.randomUUID(), title: 'Paused thing', schedule: 'every day at 3', enabled: false });
  say(tracer.conversationId, 'me', 'hello there');
  say(tracer.conversationId, tracer.bot.id, 'Hi!');
  svc.updateConversation(tracer.conversationId, { pinnedAt: 1, section: 'Work' });

  // The primary is never retired, as it's never deleted; and deleting takes a bot that's retired.
  a.throws(() => svc.retireBot(boss.bot.id), /The primary bot can't be retired\\. Make another one primary first\\./);
  a.throws(() => svc.retireBot('nobody-here'), /No such bot/);
  await a.rejects(svc.deleteBot(tracer.bot.id, { by: 'me' }), /Tracer isn't retired\\. Retire it first/);
  a.ok(db.getBot(tracer.bot.id));

  const events = [];
  svc.subscribe((e) => events.push(e));
  const before = svc.fullBot(tracer.bot.id);
  const chatBefore = svc.conversationView(tracer.conversationId);
  const retired = svc.retireBot(tracer.bot.id);
  a.ok(retired.retiredAt >= before.createdAt);
  a.equal(svc.retired(tracer.bot.id), true);
  a.equal(svc.retired(scout.bot.id), false);
  // Its turn, queue and jobs stop.
  a.deepEqual(stopped, [tracer.bot.id]);
  // Memory, instructions, look, role and model settings are as they were.
  for (const key of ['name', 'look', 'instructions', 'role', 'model', 'effort', 'fallbackModels', 'proactivity', 'createdAt']) a.deepEqual(retired[key], before[key], key);
  a.deepEqual(retired.memory, before.memory);
  a.equal(retired.memory.length, 2);
  // Its own chat is still there, with what was said, where the user had put it.
  const chat = svc.conversationView(tracer.conversationId);
  a.deepEqual(chat.messages.filter((m) => !m.event).map((m) => m.text), ['hello there', 'Hi!']);
  a.equal(chat.pinnedAt, chatBefore.pinnedAt);
  a.equal(chat.section, 'Work');
  a.deepEqual(chat.botIds, [tracer.bot.id]);
  // It left its groups, which carry on, and remembers which they were.
  a.deepEqual(db.getConversation(team.id).botIds, [boss.bot.id, scout.bot.id]);
  a.deepEqual(db.getConversation(duo.id).botIds, [scout.bot.id]);
  a.deepEqual([...retired.retiredFrom].sort(), [team.id, duo.id].sort());
  // Said in each of its chats, as the user's own line.
  a.deepEqual(lines(tracer.conversationId).at(-1), 'me | Tracer was retired');
  a.deepEqual(lines(team.id).at(-1), 'me | Tracer was retired');
  a.deepEqual(lines(duo.id).at(-1), 'me | Tracer was retired');
  // Every routine is paused, and none is due, however late it gets.
  a.deepEqual(retired.routines.map((r) => [r.title, r.enabled]), [['Nightly checks', false], ['Standup', false], ['Paused thing', false]]);
  a.deepEqual(retired.retiredRoutines, [nightly.id, inTeam.id]);
  a.deepEqual(db.dueRoutines(Date.now() + 10 * 365 * 86400000).filter((d) => d.botId === tracer.bot.id), []);
  // The app hears: the bot with its mark, and each group without it.
  a.ok(events.some((e) => e.t === 'bot' && e.bot.id === tracer.bot.id && e.bot.retiredAt));
  a.ok(events.some((e) => e.t === 'conversation' && e.conversation.id === team.id && !e.conversation.botIds.includes(tracer.bot.id)));
  a.ok(events.some((e) => e.t === 'status' && e.botId === tracer.bot.id && e.status.state === 'idle'));
  a.equal(svc.snapshot().bots.find((b) => b.id === tracer.bot.id).retiredAt, retired.retiredAt);
  // Retiring it again changes nothing.
  const linesNow = lines(team.id).length;
  a.equal(svc.retireBot(tracer.bot.id).retiredAt, retired.retiredAt);
  a.equal(lines(team.id).length, linesNow);
  a.deepEqual(stopped, [tracer.bot.id]);
  // A retired bot isn't made primary.
  a.throws(() => svc.updateBot(tracer.bot.id, { primary: true }), /Tracer is retired\\. Rehire it before making it primary/);
  // It can still be edited while it's away.
  a.equal(svc.updateBot(tracer.bot.id, { instructions: 'Review pull requests, bugs first.' }, { by: 'me' }).instructions, 'Review pull requests, bugs first.');

  // Its routines stay paused: one can't be turned on, though it can be renamed or removed.
  a.throws(() => svc.updateRoutine(tracer.bot.id, nightly.id, { enabled: true }), /Tracer is retired, so its routines stay paused\\. Rehire it to turn one on\\./);
  a.throws(() => svc.saveRoutine(tracer.bot.id, { id: crypto.randomUUID(), title: 'New', schedule: 'every day at 4', enabled: true }), /routines stay paused/);
  a.equal(svc.updateRoutine(tracer.bot.id, nightly.id, { title: 'Nightly test run' }).enabled, false);
  // One left due by an older build doesn't run either: the clock turns it off, and no check-in wakes it.
  db.putRoutine(tracer.bot.id, { ...svc.fullBot(tracer.bot.id).routines[0], enabled: true, nextRunAt: Date.now() - 1000 });
  wakes.length = 0;
  svc.tick(() => false);
  a.deepEqual(wokeFor(tracer.bot.id), []);
  a.deepEqual(wakes.map((w) => [w.id, w.kind]).sort(), [[boss.bot.id, 'heartbeat'], [scout.bot.id, 'heartbeat']].sort());
  a.deepEqual(svc.fullBot(tracer.bot.id).routines.map((r) => r.enabled), [false, false, false]);

  // Rehired: back as it was, in the groups it left.
  const back = svc.rehireBot(tracer.bot.id);
  a.equal(back.retiredAt, undefined);
  a.equal(back.retiredFrom, undefined);
  a.equal(back.retiredRoutines, undefined);
  a.equal(svc.retired(tracer.bot.id), false);
  a.deepEqual(db.getConversation(team.id).botIds, [boss.bot.id, scout.bot.id, tracer.bot.id]);
  a.deepEqual(db.getConversation(duo.id).botIds, [scout.bot.id, tracer.bot.id]);
  a.deepEqual(back.memory, before.memory);
  a.equal(back.model, 'openai/gpt-6');
  a.equal(back.instructions, 'Review pull requests, bugs first.');
  a.deepEqual(lines(tracer.conversationId).at(-1), 'me | Tracer was rehired');
  a.deepEqual(lines(team.id).at(-1), 'me | Tracer was rehired');
  // Its routines stay paused until the user turns them on.
  a.deepEqual(back.routines.map((r) => [r.title, r.enabled]), [['Nightly test run', false], ['Standup', false], ['Paused thing', false]]);
  wakes.length = 0;
  svc.tick(() => false);
  a.deepEqual(wokeFor(tracer.bot.id).filter((w) => w.kind === 'routine'), []);
  a.deepEqual(db.dueRoutines(Date.now() + 10 * 365 * 86400000).filter((d) => d.botId === tracer.bot.id), []);
  const on = svc.updateRoutine(tracer.bot.id, nightly.id, { enabled: true });
  a.equal(on.enabled, true);
  a.ok(on.nextRunAt > Date.now());
  a.deepEqual(db.dueRoutines(Date.now() + 10 * 365 * 86400000).filter((d) => d.botId === tracer.bot.id).map((d) => d.routine.title), ['Nightly test run']);
  // Rehiring a bot that isn't retired changes nothing.
  a.equal(svc.rehireBot(tracer.bot.id).retiredAt, undefined);
  a.equal(lines(team.id).filter((l) => l.includes('rehired')).length, 1);

  // A group that's gone by the time it's rehired isn't brought back.
  svc.retireBot(tracer.bot.id);
  svc.deleteConversation(duo.id);
  svc.rehireBot(tracer.bot.id);
  a.equal(db.getConversation(duo.id), undefined);
  a.ok(db.getConversation(team.id).botIds.includes(tracer.bot.id));

  // Deleting takes a retired bot, and then it's gone with its chat.
  svc.retireBot(tracer.bot.id);
  await svc.deleteBot(tracer.bot.id, { by: 'me' });
  a.equal(db.getBot(tracer.bot.id), undefined);
  a.equal(db.getConversation(tracer.conversationId), undefined);
  process.exit(0);
`), 30_000);

test("nothing routes to a retired bot: no message, mention, group, side chat, reaction or wake reaches it", () => run("routing", `${TEAM}
  const agent = await import('./server/bots/agent.ts');
  const runner = await import('./server/bots/runner.ts');
  const { findTags, matchMentionBots } = await import('./shared/bots.ts');
  const group = () => db.getConversation(team.id).botIds.map((id) => db.getBot(id));
  const mine = say(tracer.conversationId, tracer.bot.id, 'Reviewed.');
  const inTeam = say(team.id, tracer.bot.id, 'Looks fine to me.');

  // While it's active, a mention reaches it.
  wakes.length = 0;
  say(team.id, 'me', '@Tracer check the deploy');
  a.deepEqual(wokeFor(tracer.bot.id).map((w) => w.kind), ['messages']);
  a.deepEqual(matchMentionBots(group(), 'tr').map((b) => b.name), ['Tracer']);

  svc.retireBot(tracer.bot.id);
  wakes.length = 0;

  // Its own chat takes no message from the user: it's there to read.
  a.throws(() => say(tracer.conversationId, 'me', 'still there?'), /Tracer is retired, so its chat is read-only\\. Rehire it to message it\\./);
  // A group skips it: named, it isn't a mention any more, and the message goes to the bots still there.
  const named = say(team.id, 'me', '@Tracer check the deploy again');
  a.deepEqual(wakes.map((w) => w.id).sort(), [boss.bot.id, scout.bot.id].sort());
  a.deepEqual(findTags(named.text, group()), []);
  wakes.length = 0;
  say(team.id, 'me', '@all status?');
  a.deepEqual(wakes.map((w) => w.id).sort(), [boss.bot.id, scout.bot.id].sort());
  // The mention picker lists a group's members: it isn't one.
  a.deepEqual(matchMentionBots(group(), 'tr'), []);
  a.deepEqual(matchMentionBots(group(), '').map((b) => b.name), ['Boss', 'Scout']);
  // Who leads an untagged message is picked from the ones there.
  a.notEqual(svc.pickLead('check the work', db.getConversation(team.id).botIds), tracer.bot.id);

  // Another bot naming it reaches nobody, makes no handoff, and is told why.
  wakes.length = 0;
  say(team.id, scout.bot.id, '@Tracer can you review this?');
  a.deepEqual(wokeFor(tracer.bot.id), []);
  a.deepEqual(svc.openHandoffs(), []);
  const exact = agent.exactMentions(scout.bot.id, team.id, '@Tracer can you review this?');
  a.deepEqual(exact.missed, [{ tag: 'Tracer', retired: 'Tracer' }]);
  a.match(agent.missedNote(exact.missed, ['Boss']), /^Tracer is retired, so @Tracer reached nobody: it can't be mentioned or asked until it's rehired\\. Bots here: Boss\\./);
  // It can't be asked, brought into a side chat, or put in a group, by a bot or by the user.
  await a.rejects(agent.askBot(scout.bot.id, { bot: 'Tracer', text: 'Which port?' }), /Tracer is retired: it can't be asked, messaged or added to a chat until it's rehired\\./);
  a.throws(() => agent.sideChat(boss.bot.id, { bots: ['Tracer'], topic: 'Port?', report_to: short(team.id) }), /Tracer is retired/);
  a.throws(() => svc.openHuddle(boss.bot.id, team.id, [tracer.bot.id], 'Port?'), /Tracer is retired, so it can't join a side chat|answering the user/);
  a.throws(() => agent.manage(boss.bot.id, { action: 'create_group', name: 'New', bots: ['Tracer', 'Scout'] }), /Tracer is retired/);
  a.throws(() => agent.manage(boss.bot.id, { action: 'add_to_group', bot: 'Tracer', conversation: short(team.id) }), /Tracer is retired/);
  a.throws(() => svc.createConversation({ kind: 'group', name: 'New', botIds: [boss.bot.id, tracer.bot.id] }), /Tracer is retired\\. Rehire it to add it to a chat\\./);
  svc.updateConversation(team.id, { botIds: [boss.bot.id, scout.bot.id, tracer.bot.id] });
  a.deepEqual(db.getConversation(team.id).botIds, [boss.bot.id, scout.bot.id]);
  // A side chat it was in takes nothing new either.
  const side = svc.createConversation({ kind: 'side', botIds: [scout.bot.id, boss.bot.id] });
  db.putConversation({ ...db.getConversation(side.id), botIds: [scout.bot.id, tracer.bot.id] });
  a.throws(() => say(side.id, scout.bot.id, 'Hello?'), /Tracer is retired, so this side chat is read-only until it's rehired\\./);
  // Nothing wakes it: a wake from a job or a thread, a reaction to something it wrote, the clock.
  wakes.length = 0;
  svc.wakeBot(tracer.bot.id, { kind: 'note', conversationId: tracer.conversationId, text: 'A job finished.' });
  svc.toggleReaction(team.id, inTeam.id, '👍', 'me');
  a.throws(() => svc.toggleReaction(tracer.conversationId, mine.id, '👍', 'me'), /read-only/);
  svc.tick(() => false);
  a.deepEqual(wokeFor(tracer.bot.id), []);
  // The runner itself drops a wake for it, whoever asks.
  runner.wake(tracer.bot.id, { kind: 'note', conversationId: tracer.conversationId, text: 'direct' });
  a.equal(runner.busy(tracer.bot.id), false);

  // The team roster leaves it out. Only the primary, which can rehire it, is told who's retired.
  const roster = (id) => agent.contextSections(id).openbots_team;
  a.ok(roster(scout.bot.id).includes('- Boss ('));
  a.ok(!roster(scout.bot.id).includes('Tracer'));
  a.ok(!roster(boss.bot.id).split('\\n').some((l) => l.startsWith('- Tracer')));
  a.ok(roster(boss.bot.id).includes('Retired, off the team until rehired (manage_bot rehire): Tracer (' + short(tracer.bot.id) + ')'));
  a.deepEqual(agent.manage(scout.bot.id, { action: 'team' }).map((b) => b.name), ['Boss']);
  a.deepEqual(agent.manage(boss.bot.id, { action: 'team' }).map((b) => [b.name, !!b.retired]), [['Tracer', true], ['Scout', false]]);
  a.deepEqual(svc.botWorkStatus(boss.bot.id).bots.map((b) => b.name), ['Boss', 'Scout']);
  const transcript = runner.transcript(team.id, db.listBots(), 'Outis', scout.bot.id);
  a.match(transcript, /Bots here: Boss \\(.*\\); you \\(Looks things up\\.\\)\\.\\n/);
  a.ok(!/Bots here:[^\\n]*Tracer/.test(transcript));
  // What it wrote before still reads under its name.
  a.ok(transcript.includes('Tracer: Looks fine to me.'), transcript);

  // Rehired, it's reached again, by name and in its own chat.
  svc.rehireBot(tracer.bot.id);
  wakes.length = 0;
  const again = say(team.id, 'me', '@Tracer check the deploy once more');
  a.deepEqual(wokeFor(tracer.bot.id).map((w) => [w.kind, w.messageIds]), [['messages', [again.id]]]);
  wakes.length = 0;
  say(tracer.conversationId, 'me', 'welcome back');
  a.deepEqual(wokeFor(tracer.bot.id).map((w) => w.kind), ['messages']);
  a.ok(roster(scout.bot.id).includes('- Tracer ('));
  a.ok(!roster(boss.bot.id).includes('Retired, off the team'));
  a.deepEqual(agent.exactMentions(scout.bot.id, team.id, '@Tracer look').missed, []);
  process.exit(0);
`), 30_000);

test("what waited on a retired bot goes back to whoever sent it, and the other bots get a note that it's retired, then that it's back", () => run("notes", `${TEAM}
  const agent = await import('./server/bots/agent.ts');
  const manager = svc.createBot({ name: 'Manager' });
  svc.updateConversation(team.id, { botIds: [boss.bot.id, tracer.bot.id, scout.bot.id, manager.bot.id] });

  // A bot's mention in the group, which Tracer hasn't read: an open handoff.
  const asked = say(team.id, scout.bot.id, '@Tracer review pull request 12');
  a.deepEqual(svc.openHandoffs().map((h) => [h.from, h.to]), [[scout.bot.id, tracer.bot.id]]);
  // The user's messages still waiting on it: one in its own chat, one handed to it in the group.
  const own = say(tracer.conversationId, 'me', 'are you   there?');
  const request = say(team.id, 'me', '@Tracer check the deploy before lunch');
  waiting = [tracer.conversationId, team.id];
  assigned = [{ conversationId: team.id, messageIds: [request.id] }];
  // Manager's question in a side chat with it, and Scout still waiting on an answer to its own (ask_bot).
  const side = svc.createConversation({ kind: 'side', botIds: [manager.bot.id, tracer.bot.id] });
  say(side.id, manager.bot.id, 'Which port does staging use?');
  const held = svc.createConversation({ kind: 'side', botIds: [scout.bot.id, tracer.bot.id] });
  const answer = svc.waitForReply(scout.bot.id, held.id, db.latestSeq(held.id), 60000).then(() => 'answered', (err) => err);
  say(held.id, scout.bot.id, 'Is the build green?');
  // A side chat several bots are working something out in.
  const huddle = svc.createConversation({ kind: 'side', name: 'Port?', botIds: [boss.bot.id, tracer.bot.id, scout.bot.id], huddle: { by: boss.bot.id, from: team.id, topic: 'Port?', limit: 9 } });

  wakes.length = 0;
  svc.retireBot(tracer.bot.id, { by: 'me' });
  assigned = [];
  waiting = [];

  // Whoever asked it something hears now that no answer is coming, where they asked.
  const note = (id, conversationId) => wakes.filter((w) => w.id === id && w.conversationId === conversationId && w.kind === 'note').map((w) => w.text);
  a.deepEqual(note(scout.bot.id, team.id), ['Tracer was retired before it answered what you asked in [' + short(asked.id) + '] (“@Tracer review pull request 12”), so no answer is coming. It can\\'t be asked until it\\'s rehired: do it yourself, hand it to another bot, or tell the user if they\\'re waiting on it. If it no longer matters, stay [silent].']);
  a.deepEqual(svc.openHandoffs(), []);
  a.deepEqual(note(manager.bot.id, side.id).map((t) => t.split(', so no answer')[0]), ['Tracer was retired before it answered what you asked here (“Which port does staging use?”)']);
  // The one still waiting on its answer is told through that wait, not twice.
  const gave = await answer;
  a.ok(gave instanceof svc.BotRetiredError, String(gave));
  a.equal(gave.bot, 'Tracer');
  a.deepEqual(note(scout.bot.id, held.id), []);
  // The side chat closed, and whoever opened it reports back with what there is.
  a.ok(db.getConversation(huddle.id).huddle.closedAt);
  a.equal(note(boss.bot.id, team.id).length, 1);
  a.match(note(boss.bot.id, team.id)[0], /Your side chat .* closed\\. Tracer was retired\\./);
  // Nothing was sent to the retired bot itself.
  a.deepEqual(wokeFor(tracer.bot.id), []);

  // The user's unanswered messages are handed back in the chat they were sent in.
  a.deepEqual(lines(tracer.conversationId).slice(-2), ['me | Tracer was retired', 'me | Tracer was retired before answering | “are you there?”']);
  a.deepEqual(lines(team.id).slice(-2), ['me | Tracer was retired', 'me | Tracer was retired before answering | “@Tracer check the deploy before lunch”']);
  // They aren't waiting for it when it comes back.
  a.equal(db.cursor(tracer.bot.id, tracer.conversationId), db.latestSeq(tracer.conversationId));
  a.equal(db.cursor(tracer.bot.id, team.id), db.latestSeq(team.id));

  // Every other bot, the primary included, is owed a short note with its next turn. Not the bot itself.
  const notes = (id) => svc.teamNoteText(svc.pendingTeamNotes(id));
  const told = 'Since your last turn:\\n- Tracer (' + short(tracer.bot.id) + ") was retired: it's off the team until it's rehired, so don't mention it, message it or hand it work.\\nThat's just so you know; it needs no reply.";
  for (const bot of [boss, scout, manager]) a.equal(notes(bot.bot.id), told);
  a.equal(notes(tracer.bot.id), '');
  // Shown once: Scout's turn ends, and it isn't told again.
  svc.settleTeamNotes(scout.bot.id, svc.pendingTeamNotes(scout.bot.id));
  a.equal(notes(scout.bot.id), '');
  a.equal(notes(boss.bot.id), told);

  // Rehired before Boss had a turn: Boss never saw it gone, so there's nothing to tell it. Scout, who did, hears it's back.
  wakes.length = 0;
  svc.rehireBot(tracer.bot.id, { by: 'me' });
  a.equal(notes(boss.bot.id), '');
  a.equal(notes(manager.bot.id), '');
  a.equal(notes(scout.bot.id), 'Since your last turn:\\n- Tracer (' + short(tracer.bot.id) + ") was rehired: it's back on the team, and can be mentioned, messaged and handed work again.\\nThat's just so you know; it needs no reply.");
  // Coming back wakes nobody, and what was handed back isn't picked up again.
  a.deepEqual(wakes, []);
  a.deepEqual(svc.openHandoffs(), []);
  // The bot itself is told once, with its first turn back.
  a.match(svc.rehireNote(tracer.bot.id), /^You were retired for less than an hour, and Outis or the primary bot has rehired you: you're back on the team\\./);
  a.match(svc.rehireNote(tracer.bot.id), /Your routines are paused until Outis turns them back on\\./);
  svc.settleRehireNote(tracer.bot.id);
  a.equal(svc.rehireNote(tracer.bot.id), '');

  // A note shown mid-turn that changes back before the turn ends is still owed its correction.
  svc.settleTeamNotes(scout.bot.id, svc.pendingTeamNotes(scout.bot.id));
  svc.retireBot(tracer.bot.id);
  const shown = svc.pendingTeamNotes(scout.bot.id);
  a.equal(shown.length, 1);
  svc.rehireBot(tracer.bot.id);
  svc.settleTeamNotes(scout.bot.id, shown);
  a.match(notes(scout.bot.id), /Tracer \\(\\w{8}\\) was rehired/);
  for (const bot of [boss, scout, manager]) svc.settleTeamNotes(bot.bot.id, svc.pendingTeamNotes(bot.bot.id));

  // The primary's manage_bot: retire and rehire, primary only. It knows what it did; the others are told.
  a.throws(() => agent.manage(scout.bot.id, { action: 'retire', bot: 'Tracer' }), /Only the primary bot can retire bots\\./);
  a.throws(() => agent.manage(scout.bot.id, { action: 'rehire', bot: 'Tracer' }), /Only the primary bot can rehire bots\\./);
  a.throws(() => agent.manage(boss.bot.id, { action: 'retire' }), /Say which bot/);
  a.throws(() => agent.manage(boss.bot.id, { action: 'retire', bot: 'Boss' }), /The primary bot can't be retired/);
  a.throws(() => agent.manage(boss.bot.id, { action: 'delete', bot: 'Tracer' }), /Tracer isn't retired\\. Retire it first with manage_bot retire/);
  const out = agent.manage(boss.bot.id, { action: 'retire', bot: 'Tracer' });
  a.equal(out.retired, true);
  a.match(out.note, /^Tracer is retired: it keeps its memory, instructions, settings and chats, its routines are paused/);
  a.equal(svc.retired(tracer.bot.id), true);
  a.equal(notes(boss.bot.id), '');
  a.match(notes(scout.bot.id), /Tracer \\(\\w{8}\\) was retired/);
  // Done by a bot, the line in the chat is the retired bot's own.
  a.deepEqual(lines(team.id).at(-1), 'bot | Tracer was retired');
  a.match(agent.manage(boss.bot.id, { action: 'retire', bot: 'Tracer' }).note, /was already retired\\. Nothing changed\\./);
  // A retired bot is still there to name, by name or id, to bring back.
  const backOut = agent.manage(boss.bot.id, { action: 'rehire', bot: short(tracer.bot.id) });
  a.equal(backOut.retired, false);
  a.match(backOut.note, /^Tracer is back: in its own chat and the groups it was in/);
  a.equal(svc.retired(tracer.bot.id), false);
  a.match(agent.manage(boss.bot.id, { action: 'rehire', bot: 'Tracer' }).note, /isn't retired\\. Nothing changed\\./);
  a.equal(notes(boss.bot.id), '');
  // Deleting through manage_bot takes a retired bot.
  agent.manage(boss.bot.id, { action: 'retire', bot: 'Tracer' });
  await agent.manage(boss.bot.id, { action: 'delete', bot: 'Tracer' });
  a.equal(db.getBot(tracer.bot.id), undefined);
  // Nothing is left owed about a bot that's gone.
  for (const bot of [boss, scout, manager]) a.equal(notes(bot.bot.id), '');
  process.exit(0);
`), 30_000);

test("the notes ride a bot's next turn; a turn cut short by retiring ends quietly; its coding threads report to the primary", () => run("turns", `
  import { strict as a } from 'node:assert';
  const minds = globalThis.openbotsMinds = new Map();
  const db = await import('./server/bots/db.ts');
  const svc = await import('./server/bots/service.ts');
  const runner = await import('./server/bots/runner.ts');
  const agent = await import('./server/bots/agent.ts');
  const threads = await import('./server/bots/threads.ts');
  const { piFlags } = await import('./server/bots/extensions.ts');
  const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
  svc.setHooks({ wake: runner.wake, stop: runner.stop, pendingAssignments: runner.pendingAssignments, pendingChats: runner.pendingChats, unseen: runner.unseen, userWoke: runner.userWoke, halt: runner.halt, background: runner.background, leftThreads: threads.leftBy });
  svc.updateSettings({ onboarding: 'done', user: { name: 'Outis' } });
  const prompts = [];
  const fake = (bot) => {
    const mind = { token: 't', loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), ended: Promise.resolve(), close() { this.exited = true; }, async send(cmd) {
      if (cmd.type === 'clear_queue') return { steering: [], followUp: [] };
      if (cmd.type === 'prompt') prompts.push({ bot: bot.id, focus: agent.getFocus(bot.id), message: cmd.message, finish(text = '') { mind.draft = text; mind.onSettled?.(); } });
      return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
    } } };
    Object.defineProperty(mind, 'sessionPath', { get: () => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', bot.id, globalThis.openbotsFocus?.get(bot.id) ?? svc.directId(bot.id))) });
    minds.set(bot.id, mind);
  };
  const until = async (check) => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); a.ok(check(), String(check)); };
  const say = (conversationId, text) => svc.postMessage(conversationId, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text });
  const events = (conversationId) => db.messages(conversationId, 50).map((r) => r.message).filter((m) => m.event).map((m) => [m.event.kind, m.event.text, m.event.detail].filter(Boolean).join(' | '));
  const boss = svc.createBot({ name: 'Boss' });
  const tracer = svc.createBot({ name: 'Tracer', role: 'Checks the work.' });
  const scout = svc.createBot({ name: 'Scout' });
  for (const b of [boss, tracer, scout]) fake(b.bot);

  // Tracer is in the middle of answering the user when it's retired.
  say(tracer.conversationId, 'Please review the login fix');
  await until(() => prompts.length === 1);
  a.equal(prompts[0].bot, tracer.bot.id);
  a.equal(runner.busy(tracer.bot.id), true);
  a.deepEqual(runner.pendingChats(tracer.bot.id), [tracer.conversationId]);
  svc.retireBot(tracer.bot.id);
  await until(() => !runner.busy(tracer.bot.id));
  await Bun.sleep(50);
  // The turn ended without a reply and without an error, and it shows nothing going on.
  a.equal(svc.getStatus(tracer.bot.id), undefined);
  a.deepEqual(events(tracer.conversationId), ['left | Tracer was retired', 'left | Tracer was retired before answering | “Please review the login fix”']);
  a.deepEqual(db.messages(tracer.conversationId, 50).filter((r) => !r.message.event).map((r) => r.message.text), ['Please review the login fix']);
  // Its Pi is closed; nothing is queued for it, and nothing can be.
  a.equal(minds.has(tracer.bot.id), false);
  fake(tracer.bot);
  runner.wake(tracer.bot.id, { kind: 'note', conversationId: tracer.conversationId, text: 'A job finished.' });
  svc.wakeBot(tracer.bot.id, { kind: 'heartbeat', conversationId: tracer.conversationId, text: 'Look in.' });
  await Bun.sleep(50);
  a.equal(prompts.length, 1);
  a.equal(runner.busy(tracer.bot.id), false);

  // Scout's next turn, whatever it's for, starts with the note. Once.
  say(scout.conversationId, 'hi');
  await until(() => prompts.length === 2);
  a.equal(prompts[1].bot, scout.bot.id);
  a.match(prompts[1].message, /^Since your last turn:\\n- Tracer \\(\\w{8}\\) was retired: it's off the team until it's rehired, so don't mention it, message it or hand it work\\.\\nThat's just so you know; it needs no reply\\.\\n\\n/);
  prompts[1].finish('[silent]');
  await until(() => !runner.busy(scout.bot.id));
  say(scout.conversationId, 'hi again');
  await until(() => prompts.length === 3);
  a.doesNotMatch(prompts[2].message, /was retired/);
  prompts[2].finish('[silent]');
  await until(() => !runner.busy(scout.bot.id));

  // A coding thread the retired bot started reports to the primary, in the primary's own chat.
  a.equal(runner.busy(boss.bot.id), false);
  await threads.tell({ botId: tracer.bot.id, conversationId: tracer.conversationId }, 'Thread “Fix login” [abcd1234] finished its turn.\\nIt said:\\nDone, PR is up.');
  await until(() => prompts.length === 4);
  const report = prompts[3];
  a.equal(report.bot, boss.bot.id);
  a.equal(report.focus, boss.conversationId);
  // The primary's own note that Tracer was retired comes with it.
  a.match(report.message, /Tracer \\(\\w{8}\\) was retired: it's off the team/);
  a.ok(report.message.includes('Tracer (' + tracer.bot.id.slice(0, 8) + ") is retired, so a coding thread it started or was following reports to you until it's rehired."), report.message);
  a.ok(report.message.includes('Thread “Fix login” [abcd1234] finished its turn.\\nIt said:\\nDone, PR is up.'));
  report.finish('[silent]');
  await until(() => !runner.busy(boss.bot.id));
  // Nothing was written in the retired bot's chat, and it wasn't woken.
  a.deepEqual(db.messages(tracer.conversationId, 50).filter((r) => !r.message.event).map((r) => r.message.text), ['Please review the login fix']);
  // Waiting on its threads doesn't show it as working either.
  runner.threadsChanged(tracer.bot.id);
  a.equal(svc.getStatus(tracer.bot.id), undefined);

  // Rehired: its threads report to it again, and its first turn back starts with where it's been.
  svc.rehireBot(tracer.bot.id);
  await threads.tell({ botId: tracer.bot.id, conversationId: tracer.conversationId }, 'Thread “Fix login” [abcd1234] finished its turn.');
  await until(() => prompts.length === 5);
  a.equal(prompts[4].bot, tracer.bot.id);
  a.match(prompts[4].message, /^You were retired for less than an hour, and Outis or the primary bot has rehired you/);
  a.ok(!prompts[4].message.includes('reports to you until'));
  // What was handed back when it was retired is history to it, not something waiting on it.
  a.ok(prompts[4].message.includes('Outis [already seen]: Please review the login fix'), prompts[4].message);
  a.ok(prompts[4].message.includes('(Tracer was retired before answering: “Please review the login fix”)'));
  prompts[4].finish('[silent]');
  await until(() => !runner.busy(tracer.bot.id));
  a.equal(svc.rehireNote(tracer.bot.id), '');
  process.exit(0);
`), 30_000);

test("a retired bot's chat is read-only over the app's routes, and still readable; retire and rehire are the user's", () => run("read-only", `
  import { strict as a } from 'node:assert';
  import { mock } from 'bun:test';
  mock.module('./server/computers/api.ts', () => ({ computerApi: () => ({ call: async () => ({}) }), computerTargets: async () => [] }));
  const db = await import('./server/bots/db.ts');
  const svc = await import('./server/bots/service.ts');
  // Loading the routes starts the runner, which sets its hooks: these replace them.
  const routesModule = await import('./server/bots/routes.ts');
  const wakes = [];
  svc.setHooks({ wake: (id, w) => wakes.push({ id, ...w }), stop() {} });
  svc.updateSettings({ user: { name: 'Outis' }, onboarding: 'done' });
  const boss = svc.createBot({ name: 'Boss' });
  const tracer = svc.createBot({ name: 'Tracer' });
  const routes = routesModule.botRoutes((h) => h);
  const call = async (path, method, params, body) => {
    const req = new Request('http://x' + path.replace(/:(\\w+)/g, (_, k) => params[k]), { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
    req.params = params;
    const res = await routes[path][method](req);
    return { status: res.status, body: await res.json() };
  };
  const message = (text) => ({ id: crypto.randomUUID(), author: 'me', text });
  const chat = { id: tracer.conversationId };
  const card = svc.postMessage(tracer.conversationId, { id: crypto.randomUUID(), author: tracer.bot.id, at: Date.now(), text: '', question: { title: 'Ship it?', options: [{ key: 'A', label: 'Yes' }, { key: 'B', label: 'No' }] } });
  const steps = svc.postMessage(tracer.conversationId, { id: crypto.randomUUID(), author: tracer.bot.id, at: Date.now(), text: '', question: { title: 'One', options: [{ key: 'A', label: 'Yes' }], steps: [{ title: 'One', options: [{ key: 'A', label: 'Yes' }] }, { title: 'Two', options: [{ key: 'A', label: 'Yes' }] }] } });
  a.equal((await call('/api/bots/conversations/:id/messages', 'POST', chat, message('hello'))).status, 200);

  // The primary can't be retired from the app either.
  const refused = await call('/api/bots/:id/retire', 'POST', { id: boss.bot.id });
  a.equal(refused.status, 400);
  a.match(refused.body.error, /primary bot can't be retired/);
  a.equal((await call('/api/bots/:id/retire', 'POST', { id: 'nobody-here' })).status, 404);

  const done = await call('/api/bots/:id/retire', 'POST', { id: tracer.bot.id });
  a.equal(done.status, 200);
  a.ok(done.body.retiredAt);
  a.equal(done.body.name, 'Tracer');

  // Nothing new goes in: no message, reaction or answer. Each says why.
  const posted = await call('/api/bots/conversations/:id/messages', 'POST', chat, message('still there?'));
  a.equal(posted.status, 400);
  a.equal(posted.body.error, 'Tracer is retired, so its chat is read-only. Rehire it to message it.');
  const patch = (messageId, body) => call('/api/bots/conversations/:id/messages/:messageId', 'PATCH', { id: tracer.conversationId, messageId }, body);
  a.match((await patch(card.id, { emoji: '👍' })).body.error, /read-only/);
  a.match((await patch(card.id, { question: { answer: 'A' } })).body.error, /read-only/);
  a.match((await patch(steps.id, { question: { answers: ['A', 'A'], submit: true } })).body.error, /read-only/);
  a.equal(db.getMessage(card.id).message.question.answer, undefined);
  a.deepEqual(wakes.filter((w) => w.id === tracer.bot.id && w.kind !== 'messages'), []);
  // Everything in it is still there to read: in the snapshot, and page by page.
  const texts = (messages) => messages.filter((m) => !m.event && !m.question).map((m) => m.text);
  const snap = await (await routes['/api/bots'].GET(new Request('http://x/api/bots'))).json();
  a.deepEqual(texts(snap.conversations.find((c) => c.id === tracer.conversationId).messages), ['hello']);
  a.ok(snap.bots.find((b) => b.id === tracer.bot.id).retiredAt);
  const page = await call('/api/bots/conversations/:id/messages', 'GET', chat);
  a.equal(page.status, 200);
  a.deepEqual(texts(page.body.messages), ['hello']);
  // Marked in the chat itself.
  a.equal(page.body.messages.at(-1).event.text, 'Tracer was retired');
  // Reading it, and marking it read, still work.
  a.equal((await call('/api/bots/conversations/:id/read', 'POST', chat)).status, 200);

  // Deleting it for good is there now, and wasn't before; rehiring opens the chat again.
  const back = await call('/api/bots/:id/rehire', 'POST', { id: tracer.bot.id });
  a.equal(back.status, 200);
  a.equal(back.body.retiredAt, undefined);
  a.equal((await call('/api/bots/conversations/:id/messages', 'POST', chat, message('welcome back'))).status, 200);
  a.equal((await patch(card.id, { question: { answer: 'A' } })).status, 200);
  a.equal((await call('/api/bots/:id', 'DELETE', { id: tracer.bot.id })).status, 400);
  a.equal((await call('/api/bots/:id/retire', 'POST', { id: tracer.bot.id })).status, 200);
  a.equal((await call('/api/bots/:id', 'DELETE', { id: tracer.bot.id })).status, 200);
  a.equal(db.getBot(tracer.bot.id), undefined);
  process.exit(0);
`), 30_000);
