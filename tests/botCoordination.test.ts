import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs a script against a bots database of its own, in a process of its own. */
async function isolated(name: string, script: string) {
  const dir = await mkdtemp(join(tmpdir(), `openbuild-bots-${name}-`));
  try {
    const child = Bun.spawn([process.execPath, "-e", script], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir, PI_CODING_AGENT_DIR: join(dir, "pi") }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a request to several bots picks one to answer: a bot it names, then whose own role fits, then the primary", async () => {
  await isolated("lead", `
    import { strict as a } from 'node:assert';
    const svc = await import('./server/bots/service.ts');
    const { render } = await import('./server/bots/runner.ts');
    // Instructions as real teams write them: each says what it's for first, and then names other bots'
    // jobs, the primary's most of all.
    const dr = svc.createBot({ name: 'Dr Eggbot', instructions: "You're the primary and you run the team. Tracer reviews code and pull requests and hunts down bugs; Manager plans the work, watches checks and merges pull requests once they're green; Researcher looks things up. Route each request to whoever fits, review plans before they start, keep Outis posted on what shipped and what's blocked, and step in on anything nobody owns." }).bot.id;
    const manager = svc.createBot({ name: 'Manager', instructions: "You manage the work and merge pull requests once their checks are green. Break requests into tasks, start OpenBuild threads for them, and wait for Tracer to review before merging. Keep track of what has shipped, what's blocked and who's on what, and say so plainly when asked for status." }).bot.id;
    const tracer = svc.createBot({ name: 'Tracer', instructions: "You review code and pull requests and hunt down bugs. Read diffs line by line, run the tests, and report each finding with its file and line and why it's wrong. Be skeptical and specific. Never merge anything yourself; that's Manager's call once you've signed off." }).bot.id;
    const group = svc.createConversation({ kind: 'group', name: 'Team', botIds: [dr, manager, tracer] });
    const wakes = [];
    svc.setHooks({ wake: (id, w) => wakes.push({ id, ...w }), stop() {} });
    let at = Date.now();
    const post = text => { wakes.length = 0; return svc.postMessage(group.id, { id: crypto.randomUUID(), author: 'me', at: at += 3_600_000, text }); };
    const lead = text => { post(text); a.ok(wakes.length > 1, text); a.ok(wakes.every(w => w.lead === wakes[0].lead), text); return wakes[0].lead; };

    // Nobody named: whose own role it is, never the primary for naming everyone's.
    a.equal(lead('@all review PR 204?'), tracer);
    a.equal(lead('@all is 204 merged?'), manager);
    // A bot named in it, even untagged, answers.
    a.equal(lead('@all tracer find bugs'), tracer);
    a.equal(lead('@all Manager, what do you think of the logo?'), manager);
    // Several named: whose own role fits; when none does, the primary.
    a.equal(lead('@Dr Eggbot @Manager is PR #199 merged?'), manager);
    a.equal(lead('@Dr Eggbot @Tracer can you review the login change?'), tracer);
    a.equal(lead('@Tracer @Dr Eggbot hello there'), dr);
    // The primary only if it was asked: otherwise whoever was named first.
    a.equal(lead('@Tracer @Manager hello there'), tracer);
    // Nothing fits, or two fit as well: the primary.
    a.equal(lead('@all quick hello'), dr);
    a.equal(lead('@all what should we have for lunch?'), dr);
    a.equal(lead('@all review and merge it'), dr);
    // One bot asked: no lead, as before.
    post('@Tracer thoughts?');
    a.deepEqual(wakes.map(w => [w.id, w.lead]), [[tracer, undefined]]);
    a.equal(svc.pickLead('anything', [manager]), manager);
    // Any bot's role counts, whatever it's called; only its own first sentence does.
    const pip = svc.createBot({ name: 'Pip', instructions: 'You test every change by hand on a real phone. Ask Tracer to review code.' }).bot.id;
    a.equal(svc.pickLead('can someone test the new login?', [dr, manager, pip]), pip);
    a.equal(svc.pickLead('can someone review the new login?', [dr, manager, pip]), dr);

    // The lead is told it answers for everyone; the others, that it does and what's still theirs.
    const m = post('@Dr Eggbot @Manager is PR #199 merged?');
    const job = [{ kind: 'messages', conversationId: group.id, messageIds: [m.id], lead: manager }];
    a.match(render(job, manager), /\\[assigned request: answer this; it went to others too, and you answer for all of you\\]/);
    const theirs = render(job, dr);
    a.match(theirs, /\\[asked of several bots; Manager answers it\\. Reply only if it asks each of you, or with what's yours alone/);
    a.doesNotMatch(theirs, /assigned request: answer this/);
    process.exit(0);
  `);
});

test("send_message holds a message when someone wrote since the turn began, shows it once, then sends", async () => {
  await isolated("fresh", `
    import { strict as a } from 'node:assert';
    import * as db from './server/bots/db.ts';
    const svc = await import('./server/bots/service.ts');
    const runner = await import('./server/bots/runner.ts');
    const { sendMessage, setFocus, HELD } = await import('./server/bots/agent.ts');
    const dr = svc.createBot({ name: 'Dr Eggbot' }).bot.id;
    const manager = svc.createBot({ name: 'Manager' }).bot.id;
    const group = svc.createConversation({ kind: 'group', name: 'Team', botIds: [dr, manager] });
    svc.setHooks({ wake() {}, stop() {}, pendingAssignments: () => [], unseen: runner.unseen });
    const ask = svc.postMessage(group.id, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: '@Dr Eggbot @Manager is PR #199 merged?' });
    // Manager's turn shows the chat as it is now.
    globalThis.openbotsMinds.set(manager, { shown: new Map([[group.id, db.latestSeq(group.id)]]), steered: [] });
    globalThis.openbotsPumping.add(manager);
    setFocus(manager, group.id);

    // Nothing new: it goes straight out.
    const first = await sendMessage(manager, { text: 'Checking' });
    a.ok(first.id);
    // Dr answers meanwhile. Manager's next bubble comes back with it, unsent.
    svc.postMessage(group.id, { id: crypto.randomUUID(), author: dr, at: Date.now(), text: 'Yes, we just merged it.' });
    const count = db.messages(group.id, 50).length;
    const held = await sendMessage(manager, { text: 'Yes, it was merged.' });
    a.equal(held.sent, false);
    a.equal(held.note, HELD);
    a.match(held.new, /Dr Eggbot \\[context only: do not answer\\]: Yes, we just merged it\\./);
    a.equal(db.messages(group.id, 50).length, count);
    // Shown once: sending again goes through.
    a.ok((await sendMessage(manager, { text: 'Plus the deploy is out.' })).id);

    // A request steered into the turn was already shown; the bot's own lines and activity never hold it.
    const steered = svc.postMessage(group.id, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: '@Manager and the deploy?' });
    globalThis.openbotsMinds.get(manager).steered = [{ kind: 'messages', conversationId: group.id, messageIds: [steered.id] }];
    svc.postMessage(group.id, { id: crypto.randomUUID(), author: manager, at: Date.now(), text: '', event: { kind: 'routine', text: 'Ran a routine' } });
    a.ok((await sendMessage(manager, { text: 'Out since noon.' })).id);

    // Outside a turn, or in a conversation the turn never showed, there's nothing to compare with.
    globalThis.openbotsPumping.delete(manager);
    svc.postMessage(group.id, { id: crypto.randomUUID(), author: dr, at: Date.now(), text: 'Another' });
    a.ok((await sendMessage(manager, { text: 'Late' })).id);
    a.deepEqual(runner.unseen(dr, group.id), []);
    process.exit(0);
  `);
});

test("a side chat between several bots: read-only to the user, capped, closed once, reported back by its opener", async () => {
  await isolated("huddle", `
    import { strict as a } from 'node:assert';
    import * as db from './server/bots/db.ts';
    const svc = await import('./server/bots/service.ts');
    const runner = await import('./server/bots/runner.ts');
    const { sideChat, sendMessage, setFocus } = await import('./server/bots/agent.ts');
    const dr = svc.createBot({ name: 'Dr Eggbot' });
    const tracer = svc.createBot({ name: 'Tracer' }).bot.id;
    const manager = svc.createBot({ name: 'Manager' }).bot.id;
    const group = svc.createConversation({ kind: 'group', name: 'Team', botIds: [dr.bot.id, tracer, manager] });
    const wakes = [];
    let woke = false;
    svc.setHooks({ wake: (id, w) => wakes.push({ id, ...w }), stop() {}, pendingAssignments: id => id === dr.bot.id ? [{ conversationId: group.id, messageIds: [ask.id] }] : [], userWoke: () => woke });
    const ask = svc.postMessage(group.id, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: 'How should we split the release?' });
    setFocus(dr.bot.id, group.id);
    const start = { action: 'start', bots: ['Tracer', 'Manager'], topic: 'How do we split the release? Answer in a line.' };

    // Only a bot answering the user can open one.
    a.throws(() => sideChat(dr.bot.id, start), /answering the user/);
    woke = true;
    wakes.length = 0;
    const opened = sideChat(dr.bot.id, start);
    a.equal(opened.limit, 9);
    const side = db.listConversations().find(c => c.huddle);
    a.equal(side.kind, 'side');
    a.deepEqual(side.botIds, [dr.bot.id, tracer, manager]);
    a.equal(side.name, 'How do we split the release? Answer in a line.');
    a.deepEqual(side.huddle.request, [ask.id]);
    // The group hears where they went, as an activity line that wakes nobody, and the opener's question asks them both.
    const line = db.messages(group.id, 5).at(-1).message;
    a.deepEqual(line.event, { kind: 'message', text: 'Dr Eggbot is talking it over with Tracer and Manager', detail: 'How do we split the release? Answer in a line.', conversationId: side.id });
    a.deepEqual(wakes.map(w => [w.id, w.conversationId]), [[tracer, side.id], [manager, side.id]]);

    // Nobody in it opens another; the user only reads.
    a.throws(() => sideChat(tracer, { ...start, bots: ['Manager'], report_to: group.id.slice(0, 8) }), /already in an open side chat/);
    a.throws(() => sideChat(dr.bot.id, start), /already in an open side chat/);
    a.throws(() => svc.postMessage(side.id, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: 'Me too' }), /read along/);

    // A turn in it stays in it: nothing goes to the group, mentions included.
    setFocus(tracer, side.id);
    await a.rejects(() => sendMessage(tracer, { text: '@Manager over here', conversation: group.id.slice(0, 8) }), /in a side chat: say it there\\. Dr Eggbot reports back/);
    a.match(runner.render([{ kind: 'messages', conversationId: side.id }], tracer), /temporary side chat Dr Eggbot opened to work something out; 8 of its 9 messages are left\\. .*Dr Eggbot reports back/);

    // Its last allowed message closes it, wakes nobody in it, and asks the opener to report back on the request.
    for (let i = 0; i < 7; i++) svc.postMessage(side.id, { id: crypto.randomUUID(), author: i % 2 ? manager : tracer, at: Date.now(), text: 'Point ' + i });
    a.equal(db.getConversation(side.id).huddle.closedAt, undefined);
    wakes.length = 0;
    svc.postMessage(side.id, { id: crypto.randomUUID(), author: manager, at: Date.now(), text: 'Ship it in two.' });
    a.ok(db.getConversation(side.id).huddle.closedAt);
    a.equal(wakes.length, 1);
    const report = wakes[0];
    a.equal(report.id, dr.bot.id);
    a.equal(report.kind, 'note');
    a.equal(report.conversationId, group.id);
    a.deepEqual(report.messageIds, [ask.id]);
    a.match(report.text, /closed\\. It reached its 9-message limit\\./);
    a.match(report.text, /you: How do we split the release\\?/);
    a.match(report.text, /Manager: Ship it in two\\./);
    a.match(report.text, /report back here, once, for everyone, in one message/);
    a.equal(db.messages(side.id, 1)[0].message.event.text, 'Side chat closed');
    // Closed is closed: no more messages, and closing again does nothing.
    a.throws(() => svc.postMessage(side.id, { id: crypto.randomUUID(), author: tracer, at: Date.now(), text: 'One more' }), /closed/);
    a.deepEqual(sideChat(tracer, { action: 'close', conversation: side.id.slice(0, 8) }), { note: "It's already closed." });
    svc.closeHuddle(side.id, 'Again', dr.bot.id);
    a.equal(wakes.length, 1);
    a.match(runner.render([{ kind: 'messages', conversationId: side.id }], tracer), /It's closed now/);
    // ask_bot's one-to-one side chats are never a huddle.
    a.equal(db.listConversations().filter(c => c.kind === 'side').length, 1);

    // A member can close one early, and a quiet one or one past five minutes closes on the tick.
    setFocus(dr.bot.id, group.id);
    sideChat(dr.bot.id, { ...start, bots: ['Tracer'] });
    const early = db.listConversations().find(c => c.huddle && !c.huddle.closedAt);
    setFocus(tracer, early.id);
    wakes.length = 0;
    a.match(sideChat(tracer, { action: 'close' }).note, /Dr Eggbot reports back/);
    a.deepEqual(wakes.map(w => [w.id, w.kind]), [[dr.bot.id, 'note']]);
    a.match(wakes[0].text, /Tracer closed it\\./);
    sideChat(dr.bot.id, { ...start, bots: ['Manager'] });
    const quiet = db.listConversations().find(c => c.huddle && !c.huddle.closedAt);
    svc.tick(id => id === manager);
    a.equal(db.getConversation(quiet.id).huddle.closedAt, undefined);
    db.putConversation({ ...db.getConversation(quiet.id), createdAt: Date.now() - svc.HUDDLE_MAX_MS });
    svc.tick(id => id === manager);
    a.ok(db.getConversation(quiet.id).huddle.closedAt);
    a.match(wakes.at(-1).text, /five minutes were up/);
    process.exit(0);
  `);
});

test("only a turn answering the user's request can open a side chat", async () => {
  await isolated("woke", `
    import { strict as a } from 'node:assert';
    const svc = await import('./server/bots/service.ts');
    const runner = await import('./server/bots/runner.ts');
    const bot = svc.createBot({ name: 'Solo' });
    const other = svc.createBot({ name: 'Other' }).bot.id;
    const group = svc.createConversation({ kind: 'group', name: 'G', botIds: [bot.bot.id, other] });
    const mind = { steered: [] };
    globalThis.openbotsMinds.set(bot.bot.id, mind);
    a.equal(runner.userWoke(bot.bot.id, group.id), false);
    mind.steered = [{ kind: 'messages', conversationId: group.id }];
    a.equal(runner.userWoke(bot.bot.id, group.id), false, 'a bot mention in a group');
    mind.steered = [{ kind: 'note', conversationId: group.id, messageIds: ['x'] }];
    a.equal(runner.userWoke(bot.bot.id, group.id), false, 'a report-back note');
    mind.steered = [{ kind: 'messages', conversationId: group.id, messageIds: ['x'] }];
    a.equal(runner.userWoke(bot.bot.id, group.id), true);
    mind.steered = [{ kind: 'messages', conversationId: bot.conversationId }];
    a.equal(runner.userWoke(bot.bot.id, bot.conversationId), true, 'the user in its own chat');
    process.exit(0);
  `);
});

test("a bot's reaction wakes no bot, but the bot it reacted to sees it on its next turn, even on a message it was already shown", async () => {
  await isolated("reaction-seen", `
    import { strict as a } from 'node:assert';
    import * as db from './server/bots/db.ts';
    const svc = await import('./server/bots/service.ts');
    const { render } = await import('./server/bots/runner.ts');
    const { deliveryIdentity } = await import('./server/bots/sessionPolicy.ts');
    const dr = svc.createBot({ name: 'Dr Eggbot' }).bot.id;
    const manager = svc.createBot({ name: 'Manager' }).bot.id;
    const group = svc.createConversation({ kind: 'group', name: 'Team', botIds: [dr, manager] });
    const wakes = [];
    svc.setHooks({ wake: (id, w) => wakes.push({ id, ...w }), stop() {} });
    const answer = svc.postMessage(group.id, { id: crypto.randomUUID(), author: dr, at: Date.now(), text: 'Yes, we just merged it.' });
    // Dr's last turn was shown its answer: the ledger has it as it was then.
    const delivered = new Set(db.messages(group.id, 50).map(r => deliveryIdentity(group.id, r.message)));
    const turn = [{ kind: 'messages', conversationId: group.id }];
    a.doesNotMatch(render(turn, dr, delivered), /merged it/);
    wakes.length = 0;
    svc.toggleReaction(group.id, answer.id, '👍', manager);
    a.deepEqual(wakes, []);
    // Dr's next turn, whatever wakes it, shows the message again with the reaction under it.
    a.match(render(turn, dr, delivered), /\\[[0-9a-f]{8}\\] Dr Eggbot[^\\n]*: Yes, we just merged it\\.\\n  reactions: #1 👍 from Manager/);
    process.exit(0);
  `);
});
