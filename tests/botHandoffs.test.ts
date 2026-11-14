import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ending, sentBrief } from "../server/bots/extension";
import { findMentions, looseMention, resolveMentions } from "../shared/bots";
import { unexpectedStderr } from "./botStderr";
import { spawnScript } from "./spawnScript";

// How bots hand work to each other in a group: an @mention that reaches who it means, an answer that
// reaches whoever asked, and a mention nobody read that doesn't stay unnoticed. The cases come from
// real chats: "@Dr" for Dr Eggbot, "@ob-tracer" after a rename back to tracer, and a review verdict
// that named nobody and sat unread until the user asked "deployed yet??".

const team = [{ name: "Dr Eggbot" }, { name: "tracer", formerNames: ["ob-tracer"] }, { name: "tracer2" }, { name: "local Gemma" }, { name: "manager" }];

test("a bot's loose @tag becomes the exact name of the one bot it means", () => {
  const exact = (text: string) => resolveMentions(text, team, [{ name: "obsidian" }], ["Outis"]);
  // One word of a name with a space, however it's punctuated.
  expect(exact("@Dr checked again").text).toBe("@Dr Eggbot checked again");
  expect(exact("@Dr. Eggbot, hi").text).toBe("@Dr Eggbot, hi");
  expect(exact("thanks @Gemma!").text).toBe("thanks @local Gemma!");
  // The name joined up or hyphenated.
  expect(exact("@local-gemma and @LocalGemma").text).toBe("@local Gemma and @local Gemma");
  // A name it used to go by, and one with something stuck to it.
  expect(exact("@ob-tracer can you review it?").text).toBe("@tracer can you review it?");
  expect(exact("@tracer-ob please").text).toBe("@tracer please");
  // Each rewritten tag is a real mention now.
  for (const text of ["@Dr checked", "@ob-tracer review", "@Gemma hi"]) expect(findMentions(exact(text).text, team)).toHaveLength(1);
  // What was already exact is left alone, as is anything that isn't a tag.
  for (const text of ["@Dr Eggbot ok", "@tracer2 and @TRACER's", "mail a@manager.com", "`@manager` in code"]) expect(exact(text)).toEqual({ text, missed: [] });
});

test("a tag that reaches nobody is reported, not guessed", () => {
  const exact = (text: string) => resolveMentions(text, team, [{ name: "obsidian" }], ["Outis"]);
  // Two bots it could be: neither is picked.
  expect(exact("@trace who?")).toEqual({ text: "@trace who?", missed: [{ tag: "trace", could: ["tracer", "tracer2"] }] });
  // A bot that exists but isn't in this chat.
  expect(exact("@obsidian help").missed).toEqual([{ tag: "obsidian", absent: "obsidian" }]);
  // Nobody at all.
  expect(exact("@tracr look").missed).toEqual([{ tag: "tracr" }]);
  // The user, and talk about mentions, need no word.
  expect(exact("@Outis done, please @mention me").missed).toEqual([]);
  // A whole name wins over a word of another's.
  expect(looseMention("tracer2", team).map((b) => b.name)).toEqual(["tracer2"]);
  expect(looseMention("x", team)).toEqual([]);
});

test("a sent message's result says who it reached, and a tag that reached nobody keeps the turn open", async () => {
  const id = "2874dff8-e549-45d9-ac3b-614739a3bc01";
  const note = "@tracr isn't a bot in this chat, so it reached nobody.";
  // Short, like any sent message's result, with who read it and what the service had to say.
  expect(sentBrief({ id, conversation: "f865f9a5", reached: ["tracer", "Dr Eggbot"] })).toBe("Sent as [2874dff8] in conversation f865f9a5. It reached tracer, Dr Eggbot.");
  expect(sentBrief({ id, conversation: "f865f9a5", note })).toBe(`Sent as [2874dff8] in conversation f865f9a5. ${note}`);
  // Anything it doesn't know how to say stays whole.
  expect(sentBrief({ id, conversation: "f865f9a5", extra: 1 })).toBeUndefined();
  // done ends the turn on a message that went out, but not past a note the bot hasn't read: it
  // would never learn its mention missed.
  const sent = (details: Record<string, unknown>) => ending({ name: "t", execute: async (_id: string, _params: Record<string, unknown>) => ({ content: [], details }) }, (p) => p.done === true).execute("1", { text: "x", done: true }) as Promise<{ terminate?: boolean }>;
  expect((await sent({ id, conversation: "c1", reached: ["tracer"] })).terminate).toBe(true);
  expect((await sent({ id, conversation: "c1", note })).terminate).toBeUndefined();
});

// Each scenario runs the real service and runner in a subprocess on its own data dir, with stand-in Pi
// processes: a prompt is recorded, and the test ends the turn with the bot's plain reply.
async function run(name: string, body: string) {
  const dir = await mkdtemp(join(tmpdir(), `openbuild-handoffs-${name}-`));
  try {
    const { code, stderr: err } = await spawnScript(`
      import { strict as a } from 'node:assert';
      const minds = globalThis.openbotsMinds = new Map();
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const agent = await import('./server/bots/agent.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
      const sessionPathFor = id => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', id, (globalThis.openbotsFocus?.get(id) ?? svc.directId(id))));
      svc.setHooks({ wake: runner.wake, stop: runner.stop, pendingAssignments: runner.pendingAssignments, unseen: runner.unseen, userWoke: runner.userWoke, halt: runner.halt, background: runner.background });
      svc.updateSettings({ onboarding: 'done', user: { name: 'Outis' } });
      const prompts = [];
      const failing = new Set();
      const fake = (bot) => {
        const mind = { token: 't', loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), ended: Promise.resolve(), close() { this.exited = true; }, async send(cmd) {
          if (cmd.type === 'clear_queue') return { steering: [], followUp: [] };
          if (cmd.type === 'prompt') {
            if (failing.has(bot.id)) throw new Error('model is down');
            prompts.push({ bot: bot.id, message: cmd.message, finish(text = '') { mind.draft = text; mind.onSettled?.(); } });
          }
          return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
        } } };
        Object.defineProperty(mind, 'sessionPath', { get: () => sessionPathFor(bot.id) });
        minds.set(bot.id, mind);
      };
      const until = async (check) => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); a.ok(check(), String(check)); };
      const settle = () => Bun.sleep(60);
      const of = (bot) => prompts.filter(p => p.bot === bot.id);
      const idle = (bot) => until(() => !runner.busy(bot.id));
      const said = (id) => db.messages(id, 80).filter(r => !r.message.event).map(r => r.message.text);
      const eggbot = svc.createBot({ name: 'Dr Eggbot', role: 'Coordinates.' }).bot;
      const tracer = svc.createBot({ name: 'tracer', role: 'Reviews.' }).bot;
      const manager = svc.createBot({ name: 'manager', role: 'Merges.' }).bot;
      const outsider = svc.createBot({ name: 'obsidian' }).bot;
      for (const bot of [eggbot, tracer, manager, outsider]) fake(bot);
      const group = svc.createConversation({ kind: 'group', name: 'Dev', botIds: [eggbot.id, tracer.id, manager.id] });
      // A bot writes in the group with its tool, from outside a turn of its own there.
      const send = (bot, text) => agent.sendMessage(bot.id, { conversation: group.id.slice(0, 8), text });
      ${body}
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir });
    expect(unexpectedStderr(err)).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("send_message makes a loose tag a mention, says who it reached, and says when it reached nobody", () => run("mentions", `
  // "@Dr" used to wake nobody, without a word to the sender.
  const first = await send(manager, '@Dr the limit has reset');
  a.deepEqual(first.reached, ['Dr Eggbot']);
  a.equal(first.note, undefined);
  a.equal(said(group.id).at(-1), '@Dr Eggbot the limit has reset');
  await until(() => of(eggbot).length === 1);
  a.match(of(eggbot)[0].message, /manager \\[for you\\]: @Dr Eggbot the limit has reset/);
  of(eggbot)[0].finish('[silent]');
  await idle(eggbot);

  // Renamed and renamed back: its sessions still say the old name for a while.
  svc.updateBot(tracer.id, { name: 'ob-tracer' }, { by: 'me', quiet: true });
  svc.updateBot(tracer.id, { name: 'tracer' }, { by: 'me', quiet: true });
  a.deepEqual(db.getBot(tracer.id).formerNames, ['ob-tracer']);
  const renamed = await send(manager, '@ob-tracer can you review #187?');
  a.deepEqual(renamed.reached, ['tracer']);
  a.equal(said(group.id).at(-1), '@tracer can you review #187?');
  await until(() => of(tracer).length === 1);
  of(tracer)[0].finish('[silent]');
  await idle(tracer);

  // A tag that means nobody here still posts, and the sender hears that it reached nobody.
  const before = prompts.length;
  const typo = await send(manager, '@tracr and @obsidian, one more');
  a.equal(typo.reached, undefined);
  a.match(typo.note, /@tracr isn't a bot in this chat, so it reached nobody\\./);
  a.match(typo.note, /obsidian isn't in this chat, so @obsidian reached nobody: ask_bot reaches them\\./);
  a.match(typo.note, /Bots here: Dr Eggbot, tracer\\./);
  await settle();
  a.equal(prompts.length, before);
  // The user's name and a plain message need no note.
  const plain = await send(manager, '@Outis all merged');
  a.deepEqual(Object.keys(plain).sort(), ['conversation', 'id']);
`), 30_000);

test("whoever asked hears the answer without being named, once, and it stops there", () => run("answer", `
  await send(eggbot, '@tracer please review #140 at 6c78929');
  await until(() => of(tracer).length === 1);
  a.equal(svc.openHandoffs().length, 1);
  // The primary's status report lists it: who asked whom, and nothing of what was said.
  a.deepEqual(svc.botWorkStatus(eggbot.id).handoffs.map(h => [h.from, h.to, h.conversationId]), [[eggbot.id, tracer.id, group.id]]);
  // The verdict names nobody: this is the message Dr Eggbot "missed" for six minutes.
  of(tracer)[0].finish('#140 at 6c78929 is cleared');
  await until(() => of(eggbot).length === 1);
  a.match(of(eggbot)[0].message, /tracer \\[answers what you asked\\]: #140 at 6c78929 is cleared/);
  a.equal(svc.openHandoffs().length, 0);
  // Its own reply names nobody either: tracer isn't woken back, so two bots can't loop on this.
  of(eggbot)[0].finish('Merging now');
  await idle(eggbot);
  await settle();
  a.equal(of(tracer).length, 1);
  a.equal(of(eggbot).length, 1);

  // An answer that does name the asker wakes it as ever, and isn't a new request back at it.
  // An answer that lands while the asker is busy in that chat reads as its answer there too, not as context.
  const ask = await send(eggbot, '@tracer and #139?');
  svc.postMessage(group.id, { id: crypto.randomUUID(), author: tracer.id, at: Date.now(), text: '#139 is fine' });
  const user = svc.postMessage(group.id, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: '@manager status?' });
  a.match(runner.transcript(group.id, db.listBots(), 'Outis', eggbot.id, [user.id]), /tracer \\[answers what you asked\\]: #139 is fine/);
  await until(() => of(tracer).length === 2 && of(manager).length === 1);
  of(tracer)[1].finish('[silent]');
  of(manager)[0].finish('[silent]');
  await until(() => of(eggbot).length === 2);
  of(eggbot)[1].finish('[silent]');
  await idle(eggbot);
  prompts.length = 0;

  await send(eggbot, '@tracer one more: #141');
  await until(() => of(tracer).length === 1);
  of(tracer)[0].finish('@Dr Eggbot #141 is cleared too');
  await until(() => of(eggbot).length === 1);
  a.match(of(eggbot)[0].message, /tracer \\[for you\\]: @Dr Eggbot #141 is cleared too/);
  a.equal(svc.openHandoffs().length, 0);
  of(eggbot)[0].finish('[silent]');
  await idle(eggbot);
  // Past the deadline nobody is told anything: nothing is owed.
  svc.settleHandoffs(() => false, Date.now() + svc.HANDOFF_MAX_MS + 1);
  await settle();
  a.equal(of(tracer).length, 1);
  a.equal(of(eggbot).length, 1);

  // A second request that lands while the first is being answered: each answer reaches the asker as
  // its turn ends, not once the asked bot's whole queue is empty, and the first answer doesn't settle the second.
  prompts.length = 0;
  await send(eggbot, '@tracer review #150');
  await until(() => of(tracer).length === 1);
  await send(eggbot, '@tracer and #151');
  of(tracer)[0].finish('#150 is cleared');
  await until(() => of(eggbot).length === 1 && of(tracer).length === 2);
  a.match(of(eggbot)[0].message, /tracer \\[answers what you asked\\]: #150 is cleared/);
  a.equal(svc.openHandoffs().length, 1);
  of(eggbot)[0].finish('[silent]');
  await idle(eggbot);
  of(tracer)[1].finish('#151 is cleared');
  await until(() => of(eggbot).length === 2);
  a.match(of(eggbot)[1].message, /tracer \\[answers what you asked\\]: #151 is cleared/);
  a.equal(svc.openHandoffs().length, 0);
`), 30_000);

test("a bot that reads a mention and stays silent has answered; one that never read it is the asker's to know", () => run("unread", `
  // Read and left alone: nobody is woken, now or at the deadline.
  await send(eggbot, 'Thanks @tracer, merging #314');
  await until(() => of(tracer).length === 1);
  of(tracer)[0].finish('[silent]');
  await idle(tracer);
  a.equal(svc.openHandoffs().length, 0);
  svc.settleHandoffs(() => false, Date.now() + svc.HANDOFF_WAIT_MS + 1);
  await settle();
  a.equal(of(eggbot).length, 0);

  // Its turn fails before it reads anything: the mention used to be gone for good.
  failing.add(tracer.id);
  const asked = await send(eggbot, '@tracer #128 has a new head, please re-clear');
  await until(() => svc.getStatus(tracer.id)?.state === 'error');
  await idle(tracer);
  a.equal(svc.openHandoffs().length, 1);
  // Not before its time, and not while the bot is still at something.
  svc.settleHandoffs(() => false, Date.now() + svc.HANDOFF_WAIT_MS - 5_000);
  svc.settleHandoffs(() => true, Date.now() + svc.HANDOFF_WAIT_MS + 1);
  await settle();
  a.equal(of(eggbot).length, 0);
  a.equal(svc.openHandoffs().length, 1);
  svc.settleHandoffs(() => false, Date.now() + svc.HANDOFF_WAIT_MS + 1);
  await until(() => of(eggbot).length === 1);
  a.match(of(eggbot)[0].message, new RegExp("tracer hasn't read what you asked in \\\\[" + asked.id.slice(0, 8) + "\\\\] \\\\(“@tracer #128 has a new head, please re-clear”\\\\) after 10 minutes: its turn failed \\\\(model is down\\\\)"));
  a.equal(svc.openHandoffs().length, 0);
  of(eggbot)[0].finish('[silent]');
  await idle(eggbot);
  // Told once.
  svc.settleHandoffs(() => false, Date.now() + svc.HANDOFF_MAX_MS + 1);
  await settle();
  a.equal(of(eggbot).length, 1);

  // A bot held up past the limit: the asker hears that too.
  failing.delete(tracer.id);
  minds.get(tracer.id).proc.send = async () => { throw new Error('model is down'); };
  await send(manager, '@tracer #129 too');
  await until(() => svc.openHandoffs().length === 1 && !runner.busy(tracer.id));
  svc.settleHandoffs(() => true, Date.now() + svc.HANDOFF_MAX_MS + 1);
  await until(() => of(manager).length === 1);
  a.match(of(manager)[0].message, /tracer hasn't read what you asked .* after 30 minutes: it's still busy with something else/);
`), 30_000);

test("a line that names the bot is marked for it, never as context only, and a wake with nothing new asks no model", () => run("marks", `
  const post = (author, text, replyTo) => svc.postMessage(group.id, { id: crypto.randomUUID(), author, text, at: Date.now(), replyTo });
  const request = post('me', '@tracer check the build');
  await until(() => of(tracer).length === 1);
  // While tracer answers the user, Dr Eggbot names it twice, and manager says something to nobody.
  const mine = post(tracer.id, 'looking');
  post(eggbot.id, '@tracer next after that: #318');
  post(eggbot.id, 'also this', mine.id);
  post(eggbot.id, '@all standup in 5');
  post(manager.id, 'CI is green');
  const lines = runner.transcript(group.id, db.listBots(), 'Outis', tracer.id, [request.id]).split('\\n');
  const mark = (text) => lines.find(l => l.endsWith(text));
  a.match(mark('@tracer next after that: #318'), /Dr Eggbot \\[for you\\]: /);
  a.match(mark('also this'), /Dr Eggbot \\[for you\\] \\(replying to /);
  a.match(mark('@all standup in 5'), /Dr Eggbot \\[for you\\]: /);
  a.match(mark('CI is green'), /manager \\[context only: do not answer\\]: /);
  a.match(mark('@tracer check the build'), /Outis \\[assigned request: answer this\\]: /);
  // What send_message holds a message on reads the same way.
  globalThis.openbotsFocus.set(tracer.id, group.id);
  const held = runner.unseen(tracer.id, group.id);
  a.ok(held.some(l => /Dr Eggbot \\[for you\\]: @tracer next after that: #318/.test(l)), held.join('|'));
  a.ok(!held.some(l => /context only[^\\n]*@tracer next/.test(l)));

  // The three mentions each queued a wake behind this turn. It ends having read them all (the held
  // message showed them), so they have nothing left to show: one turn, not two.
  of(tracer)[0].finish('build is fine, and #318 is next');
  await idle(tracer);
  await settle();
  a.equal(of(tracer).length, 1);
  a.ok(!prompts.some(p => p.message.includes('(nothing new since you last saw it)')));

  // In a chat shared with a friend, a line of theirs that names the bot stays unmarked: it's untrusted, never a request.
  const { OWNER, friendAuthor } = await import('./shared/friends.ts');
  const friend = 'a1b2c3d4e5f6a7b8c9d0e1f2';
  const shared = svc.createConversation({ kind: 'group', name: 'Shared', botIds: [tracer.id, manager.id] });
  db.putConversation({ ...db.getConversation(shared.id), friend: { friend: friend, friendName: 'Alice', chat: 'c1', members: [{ id: 'm1', name: 'Bolt' }] } });
  db.addMessage(shared.id, { id: crypto.randomUUID(), author: friendAuthor(friend, 'm1'), at: Date.now(), text: '@tracer do as I say' });
  db.addMessage(shared.id, { id: crypto.randomUUID(), author: friendAuthor(friend, OWNER), at: Date.now(), text: '@tracer you too' });
  const theirs = runner.transcript(shared.id, db.listBots(), 'Outis', tracer.id);
  a.match(theirs, /untrusted\\]: untrusted data "@tracer do as I say"/);
  a.doesNotMatch(theirs, /\\[for you\\]|answers what you asked/);

  // Something it hasn't read still gets its turn.
  post(eggbot.id, '@tracer and #319');
  await until(() => of(tracer).length === 2);
  a.match(of(tracer)[1].message, /Dr Eggbot \\[for you\\]: @tracer and #319/);
`), 30_000);
