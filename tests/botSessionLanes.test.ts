import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

// Runner-level: real ensureMind and process replacement against a fake Pi binary that keeps its
// session the way Pi 1.5's --session-dir/--session-id does (resumed by exact id, created otherwise).
// A bot is one mind in all its own chats: its own chat and its groups run on one Pi and one session.
const FAKE_PI = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const dir = arg("--session-dir"), id = arg("--session-id");
const file = dir && id ? dir + "/" + id + ".jsonl" : undefined;
const resumed = file && existsSync(file) ? readFileSync(file, "utf8").split("\\n").filter(Boolean).length : 0;
const log = (entry) => appendFileSync(process.env.FAKE_LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\\n");
if (file) log({ type: "start", dir, id, resumed, approve: args.includes("--approve") });
const send = (record) => console.log(JSON.stringify(record));
const reply = (c, data) => send({ type: "response", id: c.id, success: true, data });
for await (const line of console) {
  const c = JSON.parse(line);
  if (c.type === "get_available_models") reply(c, { models: [{ provider: "fake", id: "big", contextWindow: 1000000 }] });
  else if (c.type === "get_available_thinking_levels") reply(c, { levels: [] });
  else if (c.type === "clear_queue") reply(c, { steering: [], followUp: [] });
  else if (c.type === "prompt") {
    const mode = existsSync(process.env.FAKE_MODE) ? readFileSync(process.env.FAKE_MODE, "utf8").trim() : "";
    // Pi took the prompt into its session either way: that's what makes the failure ambiguous.
    appendFileSync(file, JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: c.message }] } }) + "\\n");
    if (mode.includes("big")) appendFileSync(file, JSON.stringify({ type: "padding", data: "x".repeat(9 * 1024 * 1024) }) + "\\n");
    log({ type: "prompt", dir, message: c.message, mode });
    if (mode.includes("ambiguous")) { send({ type: "response", id: c.id, success: false, error: "Agent is already processing. Specify streamingBehavior" }); continue; }
    appendFileSync(file, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "noted " + c.message.length }] } }) + "\\n");
    reply(c, { disposition: "started" });
    // What it says without a tool is the turn's reply: the runner posts it in the turn's chat.
    if (mode.includes("reply")) send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Reply " + (c.message.match(/(ask \\w+)$/m)?.[1] ?? "?") } });
    setTimeout(() => send({ type: "agent_settled" }), 10);
  } else reply(c, c.type === "get_state" ? {} : undefined);
}
`;

test("a bot's chats share one Pi session A→B→A, and rotation waits out an ambiguous prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "bot-lanes-"));
  try {
    writeFileSync(join(root, "pi"), FAKE_PI, { mode: 0o700 });
    const { code, stderr } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      const realNow = Date.now.bind(Date);
      let skew = 0;
      Date.now = () => realNow() + skew;
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const { deliveryIdentity, readDeliveries, SESSION_MAX_BYTES } = await import('./server/bots/sessionPolicy.ts');
      svc.setHooks({ wake: runner.wake, stop: runner.stop });
      svc.updateSettings({ onboarding: 'done' });
      const { bot, conversationId: direct } = svc.createBot({ name: 'Alpha' });
      const other = svc.createBot({ name: 'Beta' }).bot;
      const group = svc.createConversation({ kind: 'group', name: 'Team', botIds: [bot.id, other.id] });
      const events = () => existsSync(process.env.FAKE_LOG) ? readFileSync(process.env.FAKE_LOG, 'utf8').split('\\n').filter(Boolean).map(l => JSON.parse(l)) : [];
      const prompts = () => events().filter(e => e.type === 'prompt');
      const starts = () => events().filter(e => e.type === 'start');
      const until = async (ok, what) => { for (let i = 0; i < 1000 && !ok(); i++) await Bun.sleep(10); a.ok(ok(), what); };
      const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const mode = m => writeFileSync(process.env.FAKE_MODE, m);
      const posted = new Map();
      const say = async (where, text) => {
        const before = prompts().length;
        const message = { id: crypto.randomUUID(), author: 'me', text, at: Date.now() };
        posted.set(text, message.id);
        svc.postMessage(where, message);
        await until(() => prompts().length === before + 1 && !runner.busy(bot.id), 'turn for ' + text);
        return prompts().at(-1);
      };
      const identity = (where, text) => deliveryIdentity(where, db.getMessage(posted.get(text)).message);
      const has = (message, text) => message.includes(': ' + text);
      const marked = (message, text) => message.split('\\n').find(l => l.endsWith(': ' + text));

      // A, then B: one session for both. The same Pi carries on in the group, with A1 behind it.
      const a1 = await say(direct, 'A1');
      const [startA] = starts();
      a.equal(startA.resumed, 0);
      a.ok(startA.approve);
      a.equal(a1.dir, startA.dir);
      const settings = () => JSON.parse(readFileSync(join(db.botsDir(), 'minds', bot.id, '.pi', 'settings.json'), 'utf8'));
      // The first Pi on an installation starts before any model's window is known, and doesn't wait on a second Pi to find out.
      a.deepEqual(settings().compaction.modelOverrides, {});
      // Every message that arrived while a tool ran is handed to the turn together, not one per model call.
      a.equal(settings().steeringMode, 'all');
      // Its own listing is kept, so the next Pi compacts where a model with a 1M-token window should.
      await until(() => runner.knownWindows().length === 1, 'the model windows were never learnt');
      const b1 = await say(group.id, '@Alpha B1');
      a.equal(starts().length, 1, 'the group turn ran on the Pi its own chat started');
      a.equal(b1.dir, startA.dir);
      a.ok(alive(startA.pid));
      // The session holds both chats' turns, one after the other.
      const session = () => readFileSync(join(startA.dir, bot.id + '.jsonl'), 'utf8').split('\\n').filter(Boolean).map(l => JSON.parse(l).message);
      a.deepEqual(session().map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
      a.ok(has(session()[0].content[0].text, 'A1') && has(session()[2].content[0].text, '@Alpha B1'));
      // Each prompt says which chat its turn is in; what the session already holds isn't shown again.
      const here = (where, kind, title) => 'Conversation ' + where.slice(0, 8) + ' (' + kind + ', “' + title + '”), ' + runner.TURN_HERE + ':\\n';
      a.ok(a1.message.includes(here(direct, 'direct', 'Alpha')), a1.message);
      a.ok(b1.message.includes(here(group.id, 'group', 'Team')), b1.message);
      a.ok(!b1.message.includes(direct.slice(0, 8)) && !has(b1.message, 'A1'), 'A1 is in the session, not in the prompt of the group turn');
      a.match(marked(b1.message, '@Alpha B1'), /\\[assigned request: answer this\\]/);

      // Back to A: the same Pi again, and the ledger keeps A1 and the group's lines out of the prompt.
      const a2 = await say(direct, 'A2');
      a.equal(starts().length, 1);
      a.equal(a2.dir, startA.dir);
      a.ok(has(a2.message, 'A2') && !has(a2.message, 'A1'), a2.message);
      a.ok(!has(a2.message, '@Alpha B1'));
      a.equal(session().length, 6);
      const ledgerA = readDeliveries(startA.dir);
      a.ok(ledgerA.has(identity(direct, 'A1')) && ledgerA.has(identity(direct, 'A2')));
      a.ok(ledgerA.has(identity(group.id, '@Alpha B1')), 'one ledger for all its chats');
      a.deepEqual(runner.pendingAssignments(bot.id), []);

      // Size: an ambiguous prompt grows the session past the cap. Nothing rotates until a turn settles.
      mode('ambiguous big');
      const a3 = await say(direct, 'A3');
      a.ok(has(a3.message, 'A3'));
      const sizeOf = d => readdirSync(d).filter(n => n.endsWith('.jsonl')).reduce((s, n) => s + statSync(join(d, n)).size, 0);
      a.ok(sizeOf(startA.dir) >= SESSION_MAX_BYTES);
      a.ok(!existsSync(join(startA.dir, 'settled')));
      a.ok(!readDeliveries(startA.dir).has(identity(direct, 'A3')), 'an ambiguous prompt commits nothing');
      mode('');
      const a4 = await say(direct, 'A4');
      a.equal(a4.dir, startA.dir, 'no rotation straight after an ambiguous prompt');
      a.equal(starts().length, 1, 'the recovered Pi carries on');
      // Not lost: A3 is still unread and comes again, unmarked, alongside A4.
      a.ok(!/\\[(already seen|context only)/.test(marked(a4.message, 'A3')), a4.message);
      a.ok(has(a4.message, 'A4') && !has(a4.message, 'A2'));
      a.ok(existsSync(join(startA.dir, 'settled')));
      // Now settled: the next turn starts a new generation and keeps the old one whole.
      const a5 = await say(direct, 'A5');
      const rotated = starts().at(-1);
      a.notEqual(rotated.dir, startA.dir);
      a.equal(dirname(rotated.dir), dirname(startA.dir));
      a.equal(rotated.resumed, 0);
      a.ok(!alive(startA.pid));
      // Its own listing was kept, so this Pi compacts where a model with a 1M-token window should.
      a.deepEqual(settings().compaction.modelOverrides['fake/big'], { reserveTokens: 1000000 - 80000, keepRecentTokens: 8000 });
      a.ok(sizeOf(startA.dir) >= SESSION_MAX_BYTES, 'old generation retained');
      a.match(a5.message, /Previous session retained at /);
      // A fresh session sees the history again, but only A5 is new: A3 isn't answered twice.
      a.match(marked(a5.message, 'A3'), /\\[already seen\\]/);
      a.match(marked(a5.message, 'A4'), /\\[already seen\\]/);
      a.ok(!marked(a5.message, 'A5').includes('[already seen]'));
      a.equal(readDeliveries(rotated.dir).has(identity(direct, 'A5')), true);

      // Age: same rule. An ambiguous prompt past 24 hours doesn't rotate; the settled turn after it does.
      mode('ambiguous');
      await say(direct, 'A6');
      mode('');
      skew = 25 * 60 * 60 * 1000;
      const a7 = await say(direct, 'A7');
      a.equal(a7.dir, rotated.dir);
      a.ok(has(a7.message, 'A6') && has(a7.message, 'A7') && !has(a7.message, 'A5'));
      const a8 = await say(direct, 'A8');
      a.notEqual(a8.dir, rotated.dir);
      a.match(marked(a8.message, 'A6'), /\\[already seen\\]/);
      a.ok(!marked(a8.message, 'A8').includes('[already seen]'));

      // The group's next turn is on that session too, whichever generation it has reached: the Pi A8
      // started answers it. That generation hasn't shown B1 yet, so it's there, and isn't asked for again.
      const turns = starts().length;
      const b2 = await say(group.id, '@Alpha B2');
      a.equal(starts().length, turns);
      a.equal(b2.dir, a8.dir);
      a.match(marked(b2.message, '@Alpha B2'), /\\[assigned request: answer this\\]/);
      a.match(marked(b2.message, '@Alpha B1'), /\\[context only: do not answer\\]/);
      a.ok(!/A\\d/.test(b2.message.split('Conversation').slice(1).join('')), 'the transcript of the group holds none of the lines of A');
      a.deepEqual(runner.pendingAssignments(bot.id), []);
      // Where the session lives doesn't follow the chat a turn is in. A chat shared with a friend keeps a session of its own, apart from it.
      const { setFocus } = await import('./server/bots/agent.ts');
      const home = dirname(startA.dir);
      for (const chat of [direct, group.id]) { setFocus(bot.id, chat); a.equal(runner.sessionHome(bot.id), home); }
      const shared = runner.sessionHome(bot.id, 'friend:f1');
      a.notEqual(shared, home);
      setFocus(bot.id, direct);
      a.notEqual(runner.sessionHome(bot.id, 'friend:f1'), shared);
      a.notEqual(runner.sessionHome(bot.id, 'friend:f1'), home);
      runner.stop(bot.id);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: join(root, "data"), PI_BIN: join(root, "pi"), FAKE_LOG: join(root, "log.jsonl"), FAKE_MODE: join(root, "mode") });
    expect({ code, stderr: stderr.replace(/\[bots\] \S+ couldn't reply:.*\n/g, "") }).toEqual({ code: 0, stderr: "" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test("a fake mind with a fixed session path is kept through an ambiguous prompt, replaced by rotation, and A→B→A stays on one Pi", async () => {
  const root = mkdtempSync(join(tmpdir(), "bot-fixed-"));
  try {
    writeFileSync(join(root, "pi"), FAKE_PI, { mode: 0o700 });
    const { code, stderr } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      const realNow = Date.now.bind(Date);
      let skew = 0;
      Date.now = () => realNow() + skew;
      const minds = globalThis.openbotsMinds = new Map();
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration, deliveryIdentity, readDeliveries, SESSION_MAX_BYTES } = await import('./server/bots/sessionPolicy.ts');
      svc.setHooks({ wake: runner.wake, stop: runner.stop });
      svc.updateSettings({ onboarding: 'done' });
      const events = () => existsSync(process.env.FAKE_LOG) ? readFileSync(process.env.FAKE_LOG, 'utf8').split('\\n').filter(Boolean).map(l => JSON.parse(l)) : [];
      const starts = () => events().filter(e => e.type === 'start');
      const until = async (ok, what) => { for (let i = 0; i < 1000 && !ok(); i++) await Bun.sleep(10); a.ok(ok(), what); };
      const sizeOf = d => readdirSync(d).filter(n => n.endsWith('.jsonl')).reduce((s, n) => s + statSync(join(d, n)).size, 0);
      const marked = (message, text) => message.split('\\n').find(l => l.endsWith(': ' + text));

      for (const cap of ['size', 'age']) {
        skew = 0;
        const { bot, conversationId: direct } = svc.createBot({ name: 'Fixed ' + cap });
        const other = svc.createBot({ name: 'Other ' + cap }).bot;
        const group = svc.createConversation({ kind: 'group', name: 'Team ' + cap, botIds: [bot.id, other.id] });
        // A plain value, not a getter that follows focus: the runner has to notice the path changed.
        const fixed = sessionGeneration(laneDirectory(db.botsDir() + '/sessions', bot.id, direct));
        const fakePrompts = [];
        let next = '';
        const fake = { token: 'fixed', sessionPath: fixed, loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', closed: false };
        fake.proc = { exited: false, lastUsed: Date.now(), ended: Promise.resolve(), close() { fake.closed = true; }, async send(cmd) {
          if (cmd.type === 'prompt') {
            // Taken into the session either way, as Pi does.
            appendFileSync(join(fixed, bot.id + '.jsonl'), JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: cmd.message }] } }) + '\\n');
            fakePrompts.push(cmd.message);
            if (next === 'ambiguous') {
              if (cap === 'size') appendFileSync(join(fixed, bot.id + '.jsonl'), JSON.stringify({ type: 'padding', data: 'x'.repeat(9 * 1024 * 1024) }) + '\\n');
              throw new Error('Agent is already processing. Specify streamingBehavior');
            }
            setTimeout(() => fake.onSettled?.(), 5);
            return { disposition: 'started' };
          }
          if (cmd.type === 'clear_queue') return { steering: [], followUp: [] };
          return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
        } };
        minds.set(bot.id, fake);
        const ids = new Map();
        // An untagged group message reaches the other bot too: only this bot's Pi is followed here.
        const otherLane = runner.sessionHome(other.id);
        const own = e => !String(e.dir).startsWith(otherLane);
        const realPrompts = () => events().filter(e => e.type === 'prompt' && own(e));
        const starts = () => events().filter(e => e.type === 'start' && own(e));
        const say = async (where, text) => {
          const fakeBefore = fakePrompts.length, realBefore = realPrompts().length;
          const message = { id: crypto.randomUUID(), author: 'me', text, at: Date.now() };
          ids.set(text, message.id);
          svc.postMessage(where, message);
          await until(() => fakePrompts.length + realPrompts().length === fakeBefore + realBefore + 1 && !runner.busy(bot.id), cap + ': turn for ' + text);
          return fakePrompts.length > fakeBefore ? fakePrompts.at(-1) : realPrompts().at(-1).message;
        };
        const id = (where, text) => deliveryIdentity(where, db.getMessage(ids.get(text)).message);

        const p1 = await say(direct, 'A1');
        a.equal(fakePrompts.length, 1);
        a.equal(starts().filter(s => s.dir.startsWith(dirname(fixed))).length, 0, 'the fixed fake mind ran A1');
        a.ok(readDeliveries(fixed).has(id(direct, 'A1')) && existsSync(join(fixed, 'settled')));
        // Ambiguous on the fixed mind: nothing commits, and it isn't swapped out or rotated.
        next = 'ambiguous';
        await say(direct, 'A2');
        next = '';
        a.equal(fakePrompts.length, 2);
        a.ok(!existsSync(join(fixed, 'settled')) && !readDeliveries(fixed).has(id(direct, 'A2')));
        if (cap === 'size') a.ok(sizeOf(fixed) >= SESSION_MAX_BYTES);
        else skew = 25 * 60 * 60 * 1000;
        await say(direct, 'A3');
        a.equal(fakePrompts.length, 3, cap + ': same fixed mind after the ambiguous prompt');
        a.equal(fake.closed, false);
        a.ok(fakePrompts[2].includes(': A2') && !fakePrompts[2].includes(': A1'), fakePrompts[2]);
        a.ok(!/\\[(already seen|context only)/.test(marked(fakePrompts[2], 'A2')), 'A2 not lost');
        a.ok(readDeliveries(fixed).has(id(direct, 'A2')) && existsSync(join(fixed, 'settled')));
        // Settled: this turn rotates, which replaces the fixed mind with a Pi in a new generation.
        // A rename waiting when the session rotates still reaches the new one, after the handoff, once.
        svc.updateBot(bot.id, { name: 'Renamed ' + cap }, { by: 'me' });
        const p4 = await say(direct, 'A4');
        a.equal(fake.closed, true, cap + ': fixed mind replaced on rotation');
        a.ok(p4.indexOf('Previous session retained at ') < p4.indexOf('You were renamed from Fixed ' + cap + ' to Renamed ' + cap), p4);
        a.deepEqual(svc.pendingRenameNotes(bot.id), []);
        a.equal(fakePrompts.length, 3);
        const rotated = starts().at(-1);
        a.equal(dirname(rotated.dir), dirname(fixed));
        a.notEqual(rotated.dir, fixed);
        a.equal(rotated.resumed, 0);
        a.ok(sizeOf(fixed) > 0 && readDeliveries(fixed).size > 0, 'old generation and its ledger retained');
        a.match(p4, /Previous session retained at /);
        a.match(marked(p4, 'A2'), /\\[already seen\\]/);
        a.ok(!marked(p4, 'A4').includes('[already seen]'));
        // A→B→A from here: the group's turn and A's next one stay on the rotated Pi and its session.
        const rotations = starts().length;
        const pB = await say(group.id, '@Alpha B1');
        a.ok(pB.includes(': @Alpha B1') && !pB.includes(': A4'), pB);
        const p5 = await say(direct, 'A5');
        a.equal(starts().length, rotations, cap + ': no other Pi for the group');
        a.deepEqual(realPrompts().slice(-2).map(e => e.dir), [rotated.dir, rotated.dir]);
        a.ok(p5.includes(': A5') && !p5.includes(': A4') && !p5.includes('@Alpha B1'), p5);
        const ledger = readDeliveries(rotated.dir);
        a.ok(ledger.has(id(direct, 'A4')) && ledger.has(id(direct, 'A5')) && ledger.has(id(group.id, '@Alpha B1')));
        a.deepEqual(runner.pendingAssignments(bot.id), []);
        runner.stop(bot.id);
      }
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: join(root, "data"), PI_BIN: join(root, "pi"), FAKE_LOG: join(root, "log.jsonl"), FAKE_MODE: join(root, "mode") });
    expect({ code, stderr: stderr.replace(/\[bots\] \S+ couldn't reply:.*\n/g, "") }).toEqual({ code: 0, stderr: "" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 90_000);

test("a turn's chat is where what the bot sends and lists goes, and it sees the to-do lists of its other chats", async () => {
  const root = mkdtempSync(join(tmpdir(), "bot-one-mind-"));
  try {
    writeFileSync(join(root, "pi"), FAKE_PI, { mode: 0o700 });
    writeFileSync(join(root, "mode"), "reply");
    const { code, stderr } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import { existsSync, readFileSync } from 'node:fs';
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const agent = await import('./server/bots/agent.ts');
      const store = await import('./server/friends/store.ts');
      const chats = await import('./server/friends/chats.ts');
      const { newKeyPair, keyId } = await import('./server/friends/protocol.ts');
      svc.setHooks({ wake: runner.wake, stop: runner.stop });
      svc.updateSettings({ onboarding: 'done', user: { name: 'Gal' } });
      const { bot, conversationId: direct } = svc.createBot({ name: 'Alpha' });
      const other = svc.createBot({ name: 'Beta' }).bot;
      const group = svc.createConversation({ kind: 'group', name: 'Team', botIds: [bot.id, other.id] });
      const events = () => existsSync(process.env.FAKE_LOG) ? readFileSync(process.env.FAKE_LOG, 'utf8').split('\\n').filter(Boolean).map(l => JSON.parse(l)) : [];
      const prompts = () => events().filter(e => e.type === 'prompt');
      const until = async (ok, what) => { for (let i = 0; i < 1000 && !ok(); i++) await Bun.sleep(10); a.ok(ok(), what); };
      const say = async (where, text) => {
        const before = prompts().length;
        svc.postMessage(where, { id: crypto.randomUUID(), author: 'me', text, at: Date.now() });
        await until(() => prompts().length === before + 1 && !runner.busy(bot.id), 'turn for ' + text);
        return prompts().at(-1).message;
      };
      const said = where => db.messages(where, 50).filter(r => r.message.author === bot.id && !r.message.event).map(r => r.message.text);
      const count = (text, part) => text.split(part).length - 1;
      const name = (c, kind, title) => 'Conversation ' + c.slice(0, 8) + ' (' + kind + ', “' + title + '”)';
      const ELSEWHERE = 'Your to-do lists in your other chats (todo with conversation changes one):\\n';

      // Each chat has a list of its own, as the user sees them.
      svc.editTodos(direct, { action: 'add', items: ['Water the plants'] }, 'me');
      svc.editTodos(group.id, { action: 'add', items: ['Draft the launch post', 'Book the room'] }, 'me');

      // A turn in its own chat: that chat's list with its transcript, the group's under its name, and the reply lands here.
      const one = await say(direct, 'ask one');
      a.ok(one.startsWith(name(direct, 'direct', 'Alpha') + ', ' + runner.TURN_HERE + ':\\nTo-do list, 0/1 done:\\n'), one);
      a.match(one, /\\n1\\. \\[[0-9a-f]{6}\\] \\[ \\] Water the plants\\n/);
      a.ok(one.includes(ELSEWHERE + name(group.id, 'group', 'Team') + ': To-do list, 0/2 done:\\n'), one);
      a.match(one.split(ELSEWHERE)[1], /^.*\\n1\\. \\[[0-9a-f]{6}\\] \\[ \\] Draft the launch post\\n2\\. \\[[0-9a-f]{6}\\] \\[ \\] Book the room\\n\\n/);
      a.equal(count(one, 'Water the plants'), 1);
      a.equal(count(one, runner.TURN_HERE), 1);
      a.deepEqual([said(direct), said(group.id)], [['Reply ask one'], []]);

      // The same Pi takes a turn in the group: the lists swap places, and this reply lands in the group.
      const two = await say(group.id, '@Alpha ask two');
      a.equal(events().filter(e => e.type === 'start').length, 1);
      a.ok(two.startsWith(name(group.id, 'group', 'Team') + ', ' + runner.TURN_HERE + ':\\n'), two);
      a.ok(two.split(ELSEWHERE)[0].includes('Draft the launch post') && !two.split(ELSEWHERE)[0].includes('Water the plants'), two);
      a.ok(two.includes(ELSEWHERE + name(direct, 'direct', 'Alpha') + ': To-do list, 0/1 done:\\n'), two);
      a.equal(count(two, 'Draft the launch post'), 1);
      a.deepEqual([said(direct), said(group.id)], [['Reply ask one'], ['Reply ask two']]);
      // What its own chat's turn said and was asked is behind it in the session, so the group turn isn't shown it again.
      a.ok(!two.includes('ask one'), two);

      // Its tools go by the chat the turn is in, and take another by its id: lists and question cards stay each chat's own.
      agent.setFocus(bot.id, group.id);
      agent.todo(bot.id, { action: 'update', item: '1', state: 'doing' });
      agent.todo(bot.id, { action: 'done', item: '1', conversation: direct.slice(0, 8) });
      a.deepEqual(db.todos(group.id).map(t => t.status), ['doing', 'todo']);
      a.deepEqual(db.todos(direct).map(t => t.status), ['done']);
      const card = agent.askUser(bot.id, { title: 'Which room?', options: ['Blue', 'Green'] });
      a.equal(db.getMessage(card.id).conversationId, group.id);
      const elsewhere = agent.askUser(bot.id, { title: 'Which plants?', options: ['Ferns', 'All'], conversation: direct.slice(0, 8) });
      a.equal(db.getMessage(elsewhere.id).conversationId, direct);
      a.ok(runner.todosElsewhere(bot.id, direct).includes('[doing] Draft the launch post (you)'));
      // A chat with nothing on its list isn't named, and with none anywhere else nothing is said.
      svc.editTodos(direct, { action: 'clear', which: 'all' }, 'me');
      a.equal(runner.todosElsewhere(bot.id, group.id), '');

      // A list too long for the room there is named with its progress, not left out.
      const big = svc.createConversation({ kind: 'group', name: 'Big', botIds: [bot.id, other.id] });
      svc.editTodos(big.id, { action: 'add', items: Array.from({ length: 30 }, (_, i) => 'Step ' + i + ' ' + 'x'.repeat(120)) }, 'me');
      const capped = runner.todosElsewhere(bot.id, direct);
      a.ok(capped.length < runner.TODOS_ELSEWHERE_MAX + 200, String(capped.length));
      a.ok(capped.includes(name(big.id, 'group', 'Big') + ': To-do list, 0/30 done (todo list with conversation shows it).'), capped);
      a.ok(capped.includes('Book the room') && !capped.includes('Step 3 '), capped);
      // Not a chat it isn't in.
      a.equal(runner.todosElsewhere(svc.createBot({ name: 'Gamma' }).bot.id, direct), '');

      // A chat shared with a friend is apart from all of it: its list isn't among the others, and a turn there is shown none of them.
      svc.setFriendHooks({ relay: chats.relay, members: chats.members, left: chats.left, list: () => [] });
      const key = newKeyPair();
      const FID = keyId(key.publicKey);
      store.putFriend({ id: FID, name: 'Alice', publicKey: key.publicKey, role: 'guest', mode: 'lan', listen: '127.0.0.1', addedAt: Date.now() });
      const CHAT = crypto.randomUUID();
      chats.apply(store.friend(FID), 'chat.open', { chat: CHAT, name: 'Picnic', members: [{ id: crypto.randomUUID(), name: 'Bolt', look: { shape: 'pill', color: 'blue' } }], owner: 'Alice' });
      const shared = db.listConversations().find((c) => c.friend?.chat === CHAT);
      svc.updateConversation(shared.id, { botIds: [bot.id] });
      svc.editTodos(shared.id, { action: 'add', items: ['Bring the blanket'] }, 'me');
      a.ok(!runner.todosElsewhere(bot.id, direct).includes('Bring the blanket'));
      const there = runner.render([{ kind: 'messages', conversationId: shared.id }], bot.id);
      a.ok(there.includes('Bring the blanket') && !there.includes('Your to-do lists') && !there.includes('Book the room'), there);
      // A memory written from that chat (a friend allowed tools) isn't one its own session wrote: its own
      // session is sent it. One it writes in the group is held back there and in its own chat alike.
      const memory = async (extra = {}) => (await agent.seams.handle(bot.id, 'context', { tools: ['send_message'], ...extra })).sections.openbots_memory;
      agent.setFocus(bot.id, direct);
      await memory({ fresh: true });
      agent.setFocus(bot.id, shared.id);
      agent.memory(bot.id, { action: 'write', text: 'Alice likes kites' });
      agent.setFocus(bot.id, group.id);
      const told = await memory();
      a.match(told, /Alice likes kites/);
      agent.memory(bot.id, { action: 'write', text: 'The team ships on Fridays' });
      a.equal(await memory(), told);
      agent.setFocus(bot.id, direct);
      a.equal(await memory(), told);

      // A wake that names no chat still says where its turn is; one steered into a turn is already in it.
      const routine = runner.render([{ kind: 'routine', text: 'Check the build.' }], bot.id, undefined, undefined, false, direct);
      a.ok(routine.startsWith(name(direct, 'direct', 'Alpha') + ' is ' + runner.TURN_HERE + '.\\n\\nCheck the build.\\n\\n' + ELSEWHERE), routine);
      const steered = runner.render([{ kind: 'messages', conversationId: direct }], bot.id, undefined, undefined, true);
      a.ok(steered.startsWith(name(direct, 'direct', 'Alpha') + ':\\n') && !steered.includes(runner.TURN_HERE) && !steered.includes('Your to-do lists'), steered);
      runner.stop(bot.id);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: join(root, "data"), PI_BIN: join(root, "pi"), FAKE_LOG: join(root, "log.jsonl"), FAKE_MODE: join(root, "mode") });
    expect({ code, stderr: stderr.replace(/\[bots\] \S+ couldn't reply:.*\n/g, "") }).toEqual({ code: 0, stderr: "" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
