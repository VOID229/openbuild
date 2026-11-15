// The question tool asking several things in one card: what a bot may put in one, what's kept as
// the user answers, and that the bot learns nothing until the card is submitted.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import openbots from "../server/bots/extension";
import { ASK_INSTEAD, ASKING } from "../server/bots/agent";
import { answersText } from "../shared/bots";
import { spawnScript } from "./spawnScript";

/** Runs a script against a bots database of its own, in a process of its own. */
async function isolated(name: string, script: string) {
  const dir = await mkdtemp(join(tmpdir(), `openbuild-bots-${name}-`));
  try {
    const { code, stderr: err } = await spawnScript(script, { OPENCHAT_DATA_DIR: dir, PI_CODING_AGENT_DIR: join(dir, "pi") });
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("question takes up to five questions in one call, and the bot is told to group related ones", () => {
  const tools: any[] = [];
  openbots({ on() {}, registerTool(t: any) { tools.push(t); } } as any);
  const question = tools.find((t) => t.name === "question");
  const listed = question.parameters.properties.questions;
  expect(listed.maxItems).toBe(5);
  expect(Object.keys(listed.items.properties)).toEqual(["title", "hint", "options"]);
  // One question still goes in title, so nothing is required of every call.
  expect(question.parameters.required).toEqual([]);
  expect(question.description).toContain("Related questions go together in questions");
  expect(question.description).not.toContain("one question per call");
  for (const text of [ASKING, ASK_INSTEAD]) {
    expect(text).toContain("in one call as questions");
    expect(text).not.toMatch(/one call per question|several calls/);
  }
});

test("the message that delivers a submitted card pairs each answer with its question", () => {
  const options = [{ key: "A", label: "Postgres" }, { key: "B", label: "SQLite" }];
  expect(answersText([{ title: "Which database?", options, answer: "B" }, { title: "When?", options: [], answer: "Sundays at 3am" }])).toBe("1. Which database? → SQLite\n2. When? → Sundays at 3am");
});

test("a card of several questions keeps answers as they're given and tells the bot nothing until it's submitted", async () => {
  await isolated("steps", `
    import { strict as a } from 'node:assert';
    import * as db from './server/bots/db.ts';
    const svc = await import('./server/bots/service.ts');
    const runner = await import('./server/bots/runner.ts');
    const routes = await import('./server/bots/routes.ts');
    const { askUser, setFocus } = await import('./server/bots/agent.ts');
    const builder = svc.createBot({ name: 'Builder' }).bot.id;
    const chat = svc.directId(builder);
    const wakes = [];
    svc.setHooks({ wake: (id, w) => wakes.push(w), stop() {}, pendingAssignments: () => [], unseen: runner.unseen });
    setFocus(builder, chat);
    const lines = () => runner.render([{ kind: 'messages', conversationId: chat }], builder);
    const stored = id => db.getMessage(id).message.question;

    const asked = askUser(builder, { questions: [
      { title: 'Which database?', hint: 'Both are set up.', options: ['Postgres', 'SQLite'] },
      { title: 'When should the backup run?', options: ['Every night'] },
      { title: 'Deploy when green?', options: ['Yes', 'No'] },
    ] });
    a.match(asked.note, /3 questions in one card\\. Nothing reaches you until they submit/);
    const q = stored(asked.id);
    a.deepEqual(q.steps.map(s => [s.title, s.hint, s.options.map(o => o.key + ' ' + o.label)]), [
      ['Which database?', 'Both are set up.', ['A Postgres', 'B SQLite']],
      ['When should the backup run?', undefined, ['A Every night']],
      ['Deploy when green?', undefined, ['A Yes', 'B No']],
    ]);
    // The first one stands for the card wherever one line of it shows.
    a.deepEqual([q.title, q.hint, q.options.length, db.getMessage(asked.id).message.text], ['Which database?', 'Both are set up.', 2, 'Which database?']);
    a.match(lines(), /\\(asked with question, 3 in one card: 1\\. “Which database\\?” \\[Postgres \\/ SQLite\\]; 2\\. “When should the backup run\\?” \\[Every night\\]; 3\\. “Deploy when green\\?” \\[Yes \\/ No\\], not answered yet\\)/);
    // Every question of the card is found by search, not just the first.
    a.ok(db.searchMessages('backup', [chat]).some(r => r.message.id === asked.id));

    // Answers are kept as they're picked, in any order, and can change. The bot sees none of them.
    wakes.length = 0;
    svc.answerSteps(chat, asked.id, ['B', null, null], false);
    svc.answerSteps(chat, asked.id, ['A', '  Sundays at 3am  ', null], false);
    a.deepEqual(stored(asked.id).steps.map(s => s.answer), ['A', 'Sundays at 3am', undefined]);
    a.equal(stored(asked.id).submitted, undefined);
    a.equal(wakes.length, 0);
    a.match(lines(), /3\\. “Deploy when green\\?” \\[Yes \\/ No\\], not answered yet\\)/);
    a.doesNotMatch(lines(), /Sundays|→/);

    // Submit takes an answer to every question, and a card of several isn't answered one at a time.
    a.throws(() => svc.answerSteps(chat, asked.id, ['A', 'Sundays at 3am', null], true), /Question 3 still needs an answer/);
    a.throws(() => svc.answerQuestion(chat, asked.id, 'A'), /several questions/);
    a.equal(stored(asked.id).submitted, undefined);
    a.equal((await routes.patchMine(chat, asked.id, { question: { answers: ['B', null, 'A'], submit: true } })).status, 400);

    // Submitted, as the app sends it: final, and now the transcript has every answer by its question.
    const done = routes.patchMine(chat, asked.id, { question: { answers: ['B', 'Sundays at 3am', 'A'], submit: true } });
    a.equal(done.status, 200);
    a.equal((await done.json()).question.submitted, true);
    a.match(lines(), /1\\. “Which database\\?” \\[Postgres \\/ SQLite\\] → SQLite; 2\\. “When should the backup run\\?” \\[Every night\\] → Sundays at 3am; 3\\. “Deploy when green\\?” \\[Yes \\/ No\\] → Yes, answered\\)/);
    svc.answerSteps(chat, asked.id, ['A', 'Never', 'B'], false);
    a.deepEqual(stored(asked.id).steps.map(s => s.answer), ['B', 'Sundays at 3am', 'A']);
    a.equal(stored(asked.id).submitted, true);

    // One question in the list is the card as it always was; so is a call with a title.
    for (const one of [askUser(builder, { questions: [{ title: 'Just one?', options: ['Yes', 'No'] }] }), askUser(builder, { title: 'Just one?', options: ['Yes', 'No'] })]) {
      a.match(one.note, /^The user answers in the chat\\./);
      a.deepEqual([stored(one.id).title, stored(one.id).steps, stored(one.id).options.length], ['Just one?', undefined, 2]);
      a.throws(() => svc.answerSteps(chat, one.id, ['A'], true), /isn't a card of several questions/);
      svc.answerQuestion(chat, one.id, 'A');
      a.equal(stored(one.id).answer, 'A');
    }

    // Five at most, each with a title, and a passed-on thread question stays single.
    const count = db.messages(chat, 50).length;
    a.equal(stored(askUser(builder, { questions: Array.from({ length: 5 }, (_, i) => ({ title: 'Q' + i })) }).id).steps.length, 5);
    a.throws(() => askUser(builder, { questions: Array.from({ length: 6 }, (_, i) => ({ title: 'Q' + i })) }), /up to 5 questions/);
    a.throws(() => askUser(builder, { questions: [{ title: 'One?' }, { hint: 'no title' }] }), /Write the question/);
    a.throws(() => askUser(builder, { thread: 'abc', questions: [{ title: 'One?' }, { title: 'Two?' }] }), /go with one question/);
    a.equal(db.messages(chat, 50).length, count + 1);
    process.exit(0);
  `);
}, 30_000);

test("a card keeps the whole hint a bot writes, and one past any sensible length ends at a word, never mid-word", async () => {
  await isolated("hints", `
    import { strict as a } from 'node:assert';
    import * as db from './server/bots/db.ts';
    const svc = await import('./server/bots/service.ts');
    const { askUser, setFocus, QUESTION_HINT_MAX } = await import('./server/bots/agent.ts');
    const builder = svc.createBot({ name: 'Builder' }).bot.id;
    setFocus(builder, svc.directId(builder));
    const stored = id => db.getMessage(id).message.question;

    // Past 200 characters, as bots write them: once cut at "…a failure neve", with no ellipsis.
    const hint = 'The checks run on every push, and a red one blocks the merge until it passes again. Turning on the nightly run as well means a flaky test is caught before a release goes out, so a failure never reaches the users unnoticed.';
    a.ok(hint.length > 200);
    const one = askUser(builder, { title: 'Turn on the nightly run?', hint, options: ['Yes', 'No'] });
    a.equal(stored(one.id).hint, hint);
    // The same in a card of several.
    const many = askUser(builder, { questions: [{ title: 'Nightly?', hint }, { title: 'Weekly?', hint: 'Short.' }] });
    a.deepEqual(stored(many.id).steps.map(s => s.hint), [hint, 'Short.']);

    // A hint past any sensible length still ends at a word, and says it was cut.
    const huge = askUser(builder, { title: 'Too much?', hint: 'word '.repeat(400) }).id;
    a.ok(stored(huge).hint.length <= QUESTION_HINT_MAX);
    a.match(stored(huge).hint, /word…$/);
    // An empty hint is no hint.
    a.equal(stored(askUser(builder, { title: 'None?', hint: '   ' }).id).hint, undefined);
    process.exit(0);
  `);
}, 30_000);

test("question tells a bot it can close a card it asked, with a reason or the answer it settled on", () => {
  const tools: any[] = [];
  openbots({ on() {}, registerTool(t: any) { tools.push(t); } } as any);
  const question = tools.find((t) => t.name === "question");
  expect(Object.keys(question.parameters.properties)).toEqual(expect.arrayContaining(["close", "reason", "answer"]));
  expect(question.description).toContain("close it: close with its id, and reason or answer");
  expect(question.description).toContain("closing wakes nobody");
});

test("a bot closes a card it asked: it can't be answered anymore, shows why, and wakes nobody", async () => {
  await isolated("close", `
    import { strict as a } from 'node:assert';
    import * as db from './server/bots/db.ts';
    const svc = await import('./server/bots/service.ts');
    const runner = await import('./server/bots/runner.ts');
    const routes = await import('./server/bots/routes.ts');
    const { askUser, setFocus } = await import('./server/bots/agent.ts');
    const builder = svc.createBot({ name: 'Builder' }).bot.id;
    const other = svc.createBot({ name: 'Scout' }).bot.id;
    const chat = svc.directId(builder);
    const group = svc.createConversation({ kind: 'group', name: 'Team', botIds: [builder, other] }).id;
    const wakes = [];
    svc.setHooks({ wake: (id, w) => wakes.push([id, w]), stop() {}, pendingAssignments: () => [], unseen: runner.unseen });
    setFocus(builder, chat);
    const lines = (c = chat, bot = builder) => runner.render([{ kind: 'messages', conversationId: c }], bot);
    const stored = id => db.getMessage(id).message.question;

    // The user said "merge" in a message instead of tapping the card.
    const merge = askUser(builder, { title: 'Merge #351 now?', options: ['Merge it', 'Wait for me'] });
    svc.postMessage(chat, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: 'merge' });
    wakes.length = 0;
    const count = db.messages(chat, 50).length;

    // Only the bot that asked can close it, and only a question card.
    setFocus(other, group);
    a.throws(() => askUser(other, { close: merge.id }), /no question card with that id/);
    a.throws(() => svc.closeQuestion(chat, merge.id, other), /Only the bot that asked/);
    const said = db.messages(chat, 50).find(r => r.message.text === 'merge').message.id;
    a.throws(() => askUser(builder, { close: said }), /no question card with that id/);
    a.throws(() => askUser(builder, { close: merge.id, title: 'Something else?' }), /close goes on its own/);
    a.equal(stored(merge.id).closed, undefined);

    // Closed by its short id from another chat, settling on one of its options: that one is checked.
    setFocus(builder, group);
    const closed = askUser(builder, { close: '[' + merge.id.slice(0, 8) + ']', answer: 'merge it', reason: '  You said merge\\n in the chat  ' });
    a.match(closed.note, /^Closed: the user sees it can't be answered anymore/);
    a.equal(closed.id, undefined);
    a.deepEqual([stored(merge.id).closed, stored(merge.id).answer, stored(merge.id).reason], ['bot', 'A', 'You said merge in the chat']);
    a.match(lines(), /\\(asked with question: “Merge #351 now\\?” \\[Merge it \\/ Wait for me\\], closed by you, settled: Merge it \\(You said merge in the chat\\)\\)/);
    // Nothing posted, nobody woken.
    a.equal(db.messages(chat, 50).length, count);
    a.deepEqual(wakes, []);

    // Closed, it can't be answered: refused as a plain 400 (a 409 would make the app drop the workspace).
    a.throws(() => svc.answerQuestion(chat, merge.id, 'B'), /That question was closed/);
    a.equal((await routes.patchMine(chat, merge.id, { question: { answer: 'B' } })).status, 400);
    a.equal(stored(merge.id).answer, 'A');
    // Nor can the message an answer sends reach the bot, from a tab that posts it anyway: refused,
    // not kept, nobody woken. Any other reply to the card is a message like any other.
    const post = (text, replyTo = merge.id) => routes.postMine(chat, { id: crypto.randomUUID(), author: 'me', text, replyTo });
    a.equal((await post('B: Wait for me')).status, 400);
    a.match(await (await post('A: Merge it')).text(), /That question was closed/);
    a.equal(db.messages(chat, 50).length, count);
    a.deepEqual(wakes, []);
    a.equal((await post('Why did you close it?')).status, 200);
    a.equal(db.messages(chat, 50).length, count + 1);
    a.ok(wakes.some(([id]) => id === builder));
    wakes.length = 0;
    // Closing it again changes nothing.
    a.match(askUser(builder, { close: merge.id, reason: 'Again' }).note, /already closed\\. Nothing changed/);
    a.equal(stored(merge.id).reason, 'You said merge in the chat');

    // A card the user already answered stays as they answered it. Its answer's message goes, as ever.
    setFocus(builder, chat);
    const answered = askUser(builder, { title: 'Deploy?', options: ['Yes', 'No'] });
    svc.answerQuestion(chat, answered.id, 'B');
    a.equal((await post('B: No', answered.id)).status, 200);
    wakes.length = 0;
    a.match(askUser(builder, { close: answered.id, answer: 'Yes', reason: 'Changed my mind' }).note, /already answered that card.*Nothing changed/);
    a.deepEqual([stored(answered.id).closed, stored(answered.id).answer, stored(answered.id).reason], [undefined, 'B', undefined]);

    // No longer relevant: no answer, and the reason alone. Words that aren't an option show as words.
    const stale = askUser(builder, { title: 'Rotate the key?', options: ['Yes', 'No'] });
    askUser(builder, { close: stale.id, reason: 'x'.repeat(500) });
    a.equal(stored(stale.id).answer, undefined);
    a.equal(stored(stale.id).reason.length, 200);
    const typed = askUser(builder, { title: 'Which day?', options: ['Monday'] });
    askUser(builder, { close: typed.id, answer: 'Friday' });
    a.deepEqual([stored(typed.id).answer, stored(typed.id).reason], ['Friday', undefined]);
    a.match(lines(), /“Which day\\?” \\[Monday\\], closed by you, settled: Friday\\)/);

    // Another bot reads that its asker closed it.
    const there = askUser(builder, { title: 'Ship it?', options: ['Yes'], conversation: group });
    askUser(builder, { close: there.id, reason: 'Shipped' });
    a.match(lines(group, other), /“Ship it\\?” \\[Yes\\], closed by its asker \\(Shipped\\)\\)/);

    // A card of several questions closes too, before it's submitted, and can't be submitted after.
    const many = askUser(builder, { questions: [{ title: 'Database?', options: ['Postgres', 'SQLite'] }, { title: 'When?' }] });
    svc.answerSteps(chat, many.id, ['B', null], false);
    askUser(builder, { close: many.id, answer: 'SQLite, nightly', reason: 'Settled in the chat' });
    a.deepEqual([stored(many.id).closed, stored(many.id).answer, stored(many.id).submitted], ['bot', 'SQLite, nightly', undefined]);
    a.throws(() => svc.answerSteps(chat, many.id, ['B', 'Nightly'], true), /That card was closed/);
    a.equal((await post('1. Database? → SQLite\\n2. When? → Nightly', many.id)).status, 400);
    a.deepEqual(wakes, []);
    a.match(lines(), /2 in one card: 1\\. “Database\\?” \\[Postgres \\/ SQLite\\]; 2\\. “When\\?”, closed by you, settled: SQLite, nightly \\(Settled in the chat\\)\\)/);
    // A submitted one stays as it is, and its answers' message goes as ever.
    const done = askUser(builder, { questions: [{ title: 'One?' }, { title: 'Two?' }] });
    svc.answerSteps(chat, done.id, ['1', '2'], true);
    a.equal((await post('1. One? → 1\\n2. Two? → 2', done.id)).status, 200);
    wakes.length = 0;
    a.match(askUser(builder, { close: done.id }).note, /already answered/);
    a.equal(stored(done.id).closed, undefined);
    a.deepEqual(wakes, []);
    process.exit(0);
  `);
}, 30_000);
