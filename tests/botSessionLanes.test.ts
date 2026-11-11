import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runner-level: real ensureMind and process replacement against a fake Pi binary that keeps its
// session the way Pi 1.5's --session-dir/--session-id does (resumed by exact id, created otherwise).
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
    setTimeout(() => send({ type: "agent_settled" }), 10);
  } else reply(c, c.type === "get_state" ? {} : undefined);
}
`;

test("a bot's conversations resume their own Pi session A→B→A, and rotation waits out an ambiguous prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "bot-lanes-"));
  try {
    writeFileSync(join(root, "pi"), FAKE_PI, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, "-e", `
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

      // A, then B: each conversation gets its own session; switching retires the other Pi first.
      const a1 = await say(direct, 'A1');
      const [startA] = starts();
      a.equal(startA.resumed, 0);
      a.ok(startA.approve);
      a.equal(a1.dir, startA.dir);
      const compaction = JSON.parse(readFileSync(join(db.botsDir(), 'minds', bot.id, '.pi', 'settings.json'), 'utf8')).compaction;
      a.deepEqual(compaction.modelOverrides['fake/big'], { reserveTokens: 1000000 - 131072, keepRecentTokens: 8000 });
      const b1 = await say(group.id, '@Alpha B1');
      const startB = starts().at(-1);
      a.notEqual(startB.pid, startA.pid);
      a.notEqual(startB.dir, startA.dir);
      a.equal(startB.resumed, 0);
      a.ok(!has(b1.message, 'A1'), 'A1 leaked into B');
      a.match(marked(b1.message, '@Alpha B1'), /\\[assigned request: answer this\\]/);
      a.ok(!alive(startA.pid), 'A was replaced, not left running');

      // Back to A: Pi resumes A's own session file, and the ledger keeps A1 out of the prompt.
      const a2 = await say(direct, 'A2');
      const resumedA = starts().at(-1);
      a.notEqual(resumedA.pid, startB.pid);
      a.equal(resumedA.dir, startA.dir);
      a.equal(resumedA.resumed, 2, 'A1 and its answer');
      a.ok(!alive(startB.pid));
      a.ok(has(a2.message, 'A2') && !has(a2.message, 'A1'), a2.message);
      a.ok(!has(a2.message, '@Alpha B1'));
      const ledgerA = readDeliveries(startA.dir);
      a.ok(ledgerA.has(identity(direct, 'A1')) && ledgerA.has(identity(direct, 'A2')));
      a.ok(!ledgerA.has(identity(group.id, '@Alpha B1')), 'ledgers are per conversation');
      a.ok(readDeliveries(startB.dir).has(identity(group.id, '@Alpha B1')));
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
      a.equal(starts().length, 3, 'the recovered Pi carries on');
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
      a.ok(!alive(resumedA.pid));
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

      // B's lane rotates on its own clock, inside B's lane, and B1 isn't asked for again.
      const b2 = await say(group.id, '@Alpha B2');
      const backToB = starts().at(-1);
      a.equal(dirname(backToB.dir), dirname(startB.dir));
      a.notEqual(backToB.dir, startB.dir);
      a.equal(backToB.resumed, 0);
      a.equal(sizeOf(startB.dir) > 0, true, 'old B generation retained');
      a.match(marked(b2.message, '@Alpha B2'), /\\[assigned request: answer this\\]/);
      a.match(marked(b2.message, '@Alpha B1'), /\\[context only: do not answer\\]/);
      a.ok(!/A\\d/.test(b2.message.split('Conversation').slice(1).join('')), 'no A context in B');
      a.deepEqual(runner.pendingAssignments(bot.id), []);
      runner.stop(bot.id);
      process.exit(0);
    `], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, OPENCHAT_DATA_DIR: join(root, "data"), PI_BIN: join(root, "pi"), FAKE_LOG: join(root, "log.jsonl"), FAKE_MODE: join(root, "mode") },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ code, stderr: stderr.replace(/\[bots\] \S+ couldn't reply:.*\n/g, "") }).toEqual({ code: 0, stderr: "" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test("a fake mind with a fixed session path is kept through an ambiguous prompt, then replaced by rotation and by A→B→A", async () => {
  const root = mkdtempSync(join(tmpdir(), "bot-fixed-"));
  try {
    writeFileSync(join(root, "pi"), FAKE_PI, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, "-e", `
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
        const otherLane = laneDirectory(db.botsDir() + '/sessions', other.id, group.id);
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
        // A→B→A from here: B gets its own Pi, and A's next Pi resumes the rotated file.
        const pB = await say(group.id, '@Alpha B1');
        const startB = starts().at(-1);
        a.notEqual(startB.pid, rotated.pid);
        a.notEqual(dirname(startB.dir), dirname(fixed));
        a.ok(!pB.includes(': A4'));
        const p5 = await say(direct, 'A5');
        const backToA = starts().at(-1);
        a.equal(backToA.dir, rotated.dir);
        a.equal(backToA.resumed, 2, 'A4 and its answer');
        a.ok(p5.includes(': A5') && !p5.includes(': A4') && !p5.includes('@Alpha B1'), p5);
        const ledger = readDeliveries(rotated.dir);
        a.ok(ledger.has(id(direct, 'A4')) && ledger.has(id(direct, 'A5')) && !ledger.has(id(group.id, '@Alpha B1')));
        a.deepEqual(runner.pendingAssignments(bot.id), []);
        runner.stop(bot.id);
      }
      process.exit(0);
    `], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, OPENCHAT_DATA_DIR: join(root, "data"), PI_BIN: join(root, "pi"), FAKE_LOG: join(root, "log.jsonl"), FAKE_MODE: join(root, "mode") },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ code, stderr: stderr.replace(/\[bots\] \S+ couldn't reply:.*\n/g, "") }).toEqual({ code: 0, stderr: "" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 90_000);
