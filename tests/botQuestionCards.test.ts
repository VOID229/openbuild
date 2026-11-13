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

    // Five at most, each with a title, and the app's own cards stay single.
    const count = db.messages(chat, 50).length;
    a.equal(stored(askUser(builder, { questions: Array.from({ length: 5 }, (_, i) => ({ title: 'Q' + i })) }).id).steps.length, 5);
    a.throws(() => askUser(builder, { questions: Array.from({ length: 6 }, (_, i) => ({ title: 'Q' + i })) }), /up to 5 questions/);
    a.throws(() => askUser(builder, { questions: [{ title: 'One?' }, { hint: 'no title' }] }), /Write the question/);
    a.throws(() => askUser(builder, { offer: 'team', questions: [{ title: 'One?' }, { title: 'Two?' }] }), /go with one question/);
    a.equal(db.messages(chat, 50).length, count + 1);
    process.exit(0);
  `);
}, 30_000);
