import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSilent, replyBubbles } from "../shared/bots";

test("[silent] never becomes a bubble", () => {
  expect(isSilent(" [SILENT]\n")).toBe(true);
  expect(isSilent("[silent] but not really")).toBe(false);
  expect(replyBubbles("[silent]")).toEqual([]);
  expect(replyBubbles("Sure!\n\n[silent]")).toEqual(["Sure!"]);
  expect(replyBubbles("One\n\nTwo")).toEqual(["One", "Two"]);
});

test("computer tools never silently fall back to unrestricted host access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-computer-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      import { mock } from 'bun:test';
      let engines = [];
      const calls = [];
      mock.module('./server/computers/index.ts', () => ({ capabilities: async () => ({ engines }), procListeners: new Set() }));
      mock.module('./server/computers/api.ts', () => ({ computerApi: (device) => ({ call: async (id, op, body) => { calls.push({ device, id, op, body }); return {}; } }) }));
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const { sendMessage, setFocus } = await import('./server/bots/agent.ts');
      const { bot, conversationId } = svc.createBot({ name: 'Sandbox' });
      setFocus(bot.id, conversationId);
      await a.rejects(sendMessage(bot.id, { text: 'Screenshot', attach_screenshot: true }), /Choose a computer explicitly/);
      a.equal(calls.length, 0);
      a.equal(db.getBot(bot.id).computer, undefined);
      engines = ['podman'];
      await sendMessage(bot.id, { text: 'Screenshot', attach_screenshot: true });
      a.deepEqual(db.getBot(bot.id).computer, { device: 'local', kind: 'container' });
      a.equal(calls[0].body.kind, 'container');
      engines = [];
      svc.updateBot(bot.id, { computer: { device: 'local', kind: 'host' } });
      calls.length = 0;
      await sendMessage(bot.id, { text: 'Explicit host screenshot', attach_screenshot: true });
      a.equal(calls[0].body.kind, 'host');
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the first bot writes its own welcome, only when OpenBots is first opened", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-welcome-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      import * as db from './server/bots/db.ts';
      import * as svc from './server/bots/service.ts';
      const woken = [];
      svc.setHooks({ wake: (botId, wake) => woken.push({ botId, wake }), stop() {} });
      svc.ensureStarted();
      const bot = db.listBots()[0];
      const conversationId = svc.directId(bot.id);
      a.equal(bot.primary, true);
      a.equal(svc.getSettings().onboarding, 'active');
      a.equal(db.messages(conversationId, 10).length, 0);
      a.equal(woken.length, 0);

      svc.greetOnFirstOpen();
      a.deepEqual(woken.map(w => [w.botId, w.wake.kind, w.wake.conversationId]), [[bot.id, 'note', conversationId]]);

      // Still working on it: a second tab doesn't ask twice.
      svc.setStatus(bot.id, { state: 'working' });
      svc.greetOnFirstOpen();
      a.equal(woken.length, 1);

      // A failed try stays visible for a moment, then the next open clears it and tries again.
      svc.setStatus(bot.id, { state: 'idle' });
      const failure = { id: crypto.randomUUID(), author: bot.id, at: Date.now(), text: '', event: { kind: 'error', text: "Couldn't reply" } };
      db.addMessage(conversationId, failure);
      svc.greetOnFirstOpen();
      a.equal(woken.length, 1);
      db.updateMessage({ ...failure, at: Date.now() - 61_000 });
      svc.greetOnFirstOpen();
      a.equal(woken.length, 2);
      a.equal(db.messages(conversationId, 10).length, 0);

      // Once anything has been said, opening it again is just opening it.
      svc.postMessage(conversationId, { id: crypto.randomUUID(), author: bot.id, at: Date.now(), text: 'Welcome!' });
      svc.greetOnFirstOpen();
      a.equal(woken.length, 2);
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("send_message, models and check-ins against a real bots database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-"));
  try {
    await Bun.write(join(dir, "pi", "settings.json"), JSON.stringify({ defaultProvider: "openrouter", defaultModel: "deepseek/flash" }));
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      import * as db from './server/bots/db.ts';
      import * as svc from './server/bots/service.ts';
      import { sendMessage, setFocus, routine } from './server/bots/agent.ts';
      import { applyModel, applyEffort, successfulMessageTool, transcript, onRecord, activityFor } from './server/bots/runner.ts';

      const { bot, conversationId } = svc.createBot({ name: 'Egg' });
      setFocus(bot.id, conversationId);
      const count = () => db.messages(conversationId, 50).length;

      // [silent] through send_message posts nothing; real text still does.
      const before = count();
      const skipped = await sendMessage(bot.id, { text: ' [silent] ' });
      a.equal(skipped.id, undefined);
      a.match(skipped.note, /Nothing was sent/);
      a.equal(count(), before);
      await sendMessage(bot.id, { text: 'hello' });
      a.equal(count(), before + 1);

      // A session resumes on its last model, so "default" has to switch back; matching models don't re-send.
      const fake = (provider, id) => {
        const sent = [];
        return { sent, send: async (cmd) => { sent.push(cmd); return cmd.type === 'get_state' ? { model: { provider, id } } : {}; } };
      };
      let proc = fake('anthropic', 'old');
      await applyModel(proc, bot.id);
      a.deepEqual(proc.sent.at(-1), { type: 'set_model', provider: 'openrouter', modelId: 'deepseek/flash' });
      proc = fake('openrouter', 'deepseek/flash');
      await applyModel(proc, bot.id);
      a.equal(proc.sent.length, 1);

      svc.updateBot(bot.id, { model: 'anthropic/picked' });
      proc = fake('openrouter', 'deepseek/flash');
      await applyModel(proc, bot.id);
      a.deepEqual(proc.sent.at(-1), { type: 'set_model', provider: 'anthropic', modelId: 'picked' });
      svc.updateBot(bot.id, { model: '' });
      a.equal(db.getBot(bot.id).model, undefined);

      // A model Pi refuses fails the run rather than falling back quietly.
      svc.updateBot(bot.id, { model: 'anthropic/gone' });
      await a.rejects(applyModel({ send: async (cmd) => { if (cmd.type === 'set_model') throw new Error('Model not found'); return {}; } }, bot.id), /Model not found/);

      // Effort uses Pi's supported levels, after the model has been selected.
      svc.updateBot(bot.id, { effort: 'high' });
      const effortCommands = [];
      await applyEffort({ send: async (cmd) => { effortCommands.push(cmd); return { levels: ['off', 'low', 'medium'] }; } }, bot.id);
      a.deepEqual(effortCommands, [{ type: 'get_available_thinking_levels' }, { type: 'set_thinking_level', level: 'medium' }]);
      svc.updateBot(bot.id, { effort: 'low' });
      effortCommands.length = 0;
      await applyEffort({ send: async (cmd) => { effortCommands.push(cmd); return { levels: ['low', 'high'] }; } }, bot.id);
      a.deepEqual(effortCommands.at(-1), { type: 'set_thinking_level', level: 'low' });
      effortCommands.length = 0;
      await applyEffort({ send: async (cmd) => { effortCommands.push(cmd); return { levels: [] }; } }, bot.id);
      a.equal(effortCommands.length, 1);

      // Starting, failing, or skipping a messaging tool must not suppress final-text fallback.
      const event = { type: 'tool_execution_end', toolName: 'send_message', isError: false, result: { details: { id: 'posted' } } };
      a.equal(successfulMessageTool({ ...event, type: 'tool_execution_start' }), false);
      a.equal(successfulMessageTool({ ...event, isError: true }), false);
      a.equal(successfulMessageTool({ ...event, result: { isError: true, details: { id: 'posted' } } }), false);
      a.equal(successfulMessageTool({ ...event, result: { details: { note: 'Nothing was sent' } } }), false);
      a.equal(successfulMessageTool(event), true);
      a.equal(successfulMessageTool({ ...event, toolName: 'question' }), true);
      a.equal(successfulMessageTool({ ...event, toolName: 'remember' }), false);

      // A missing selector used to match the first routine via startsWith('').
      const makeRoutine = (id, title) => svc.saveRoutine(bot.id, { id, title, schedule: 'every hour', enabled: true });
      const first = makeRoutine('routine-one', 'Same');
      const second = makeRoutine('routine-two', 'Same');
      for (const action of ['pause', 'resume', 'remove']) {
        a.throws(() => routine(bot.id, { action }), /Name the routine/);
        a.throws(() => routine(bot.id, { action, id: 'routine-' }), /ambiguous/);
        a.throws(() => routine(bot.id, { action, title: 'Same' }), /ambiguous/);
      }
      a.equal(db.routines(bot.id).length, 2);
      a.equal(db.routines(bot.id).find(r => r.id === first.id).enabled, true);
      routine(bot.id, { action: 'pause', id: first.id });
      a.equal(db.routines(bot.id).find(r => r.id === first.id).enabled, false);
      const other = svc.createBot({ name: 'Other' });
      svc.updateBot(other.bot.id, { proactivity: 'off' });
      a.throws(() => routine(other.bot.id, { action: 'remove', id: second.id }), /No such routine/);
      a.throws(() => svc.saveRoutine(other.bot.id, { ...second, title: 'stolen' }), /routine/i);
      a.equal(db.routineOwner(second.id), bot.id);

      // The chat shows typing only while a message is being written; other work shows as an activity.
      const mind = { proc: { send: async () => ({}) }, token: '', busy: true, sent: false, draft: '', typing: false, quiet: false, activity: 'Thinking' };
      const typingNow = () => (svc.snapshot().typing[conversationId] ?? []).includes(bot.id);
      onRecord(bot.id, mind, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } });
      a.equal(typingNow(), false);
      onRecord(bot.id, mind, { type: 'tool_execution_start', toolName: 'browser', args: { action: 'open', url: 'https://www.example.com/x' } });
      a.equal(svc.snapshot().status[bot.id].activity, 'Opening example.com');
      a.equal(typingNow(), false);
      onRecord(bot.id, mind, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', toolName: 'send_message', contentIndex: 0 } });
      a.equal(typingNow(), true);
      onRecord(bot.id, mind, { type: 'tool_execution_end', toolName: 'send_message', result: {} });
      a.equal(typingNow(), false);
      a.equal(svc.snapshot().status[bot.id].quiet, true);
      onRecord(bot.id, mind, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '[sil' } });
      a.equal(typingNow(), false);
      a.equal(activityFor('read', { path: '/home/x/notes.md' }), 'Reading notes.md');
      svc.setStatus(bot.id, { state: 'idle' });

      // Group instructions are included in the actual bot transcript.
      const group = svc.createConversation({ kind: 'group', name: 'Garden', botIds: [bot.id, other.bot.id], instructions: 'Only discuss the garden.' });
      a.match(transcript(group.id, db.listBots(), 'User', bot.id), /Group instructions: Only discuss the garden/);

      // Changing the pace restarts the clock, and off stays off.
      db.setValue('hb:' + bot.id, 1);
      svc.updateBot(bot.id, { proactivity: 'low' });
      a.ok(db.getValue('hb:' + bot.id) > Date.now() + 7 * 3600 * 1000);
      svc.updateBot(bot.id, { proactivity: 'off' });
      a.equal(db.getBot(bot.id).proactivity, 'off');
      svc.updateSettings({ quietHours: { from: 0, to: 0 } });
      db.setValue('hb:' + bot.id, 1);
      const woken = [];
      svc.setHooks({ wake: (id, w) => woken.push(w), stop() {} });
      svc.tick(() => false);
      a.deepEqual(woken.filter((w) => w.kind === 'heartbeat'), []);
      svc.updateBot(bot.id, { proactivity: 'high' });
      db.setValue('hb:' + bot.id, 1);
      svc.tick(() => false);
      a.equal(woken.filter((w) => w.kind === 'heartbeat').length, 1);

      // A relative one-shot is consumed instead of being moved forward at each tick.
      const createdAt = Date.now() - 2 * 3600_000;
      const followUp = svc.saveRoutine(bot.id, { id: 'relative-follow-up', title: 'Later', schedule: 'in 1 hour', enabled: true, followUp: true, conversationId });
      db.putRoutine(bot.id, { ...followUp, createdAt, nextRunAt: createdAt + 3600_000 });
      svc.tick(() => false);
      a.equal(db.routines(bot.id).some(r => r.id === followUp.id), false);
      const onceCount = woken.filter(w => w.kind === 'routine').length;
      svc.tick(() => false);
      a.equal(woken.filter(w => w.kind === 'routine').length, onceCount);

      // Typed answers survive whole.
      const q = { id: crypto.randomUUID(), author: bot.id, at: Date.now(), text: 'Name?', question: { title: 'Name?', options: [{ key: 'A', label: 'Pip' }] } };
      svc.postMessage(conversationId, q);
      const long = 'x'.repeat(300);
      svc.answerQuestion(conversationId, q.id, long);
      a.equal(db.getMessage(q.id).message.question.answer, long);
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir, PI_CODING_AGENT_DIR: join(dir, "pi") }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("any number of routines stay active at once, each bot's separate, each in its own turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-routines-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      const minds = globalThis.openbotsMinds = new Map();
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const { getFocus } = await import('./server/bots/agent.ts');
      const { wake, stop } = await import('./server/bots/runner.ts');
      svc.setHooks({ wake, stop });
      svc.updateSettings({ onboarding: 'done' });

      const prompts = [], steers = [];
      const fakeMind = (botId) => {
        const mind = { token: 't', busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), close() {}, send: async (cmd) => {
          if (cmd.type === 'steer') steers.push({ botId, message: cmd.message });
          if (cmd.type === 'prompt') {
            prompts.push({ botId, focus: getFocus(botId), message: cmd.message });
            setTimeout(() => mind.onSettled?.(), 1);
          }
          return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
        } } };
        minds.set(botId, mind);
      };
      const first = svc.createBot({ name: 'First' });
      const second = svc.createBot({ name: 'Second' });
      for (const { bot } of [first, second]) {
        svc.updateBot(bot.id, { proactivity: 'off' });
        fakeMind(bot.id);
      }
      const group = svc.createConversation({ kind: 'group', name: 'Both', botIds: [first.bot.id, second.bot.id] });
      const add = (botId, task, conversationId, enabled = true) => {
        const r = svc.saveRoutine(botId, { id: crypto.randomUUID(), title: task, schedule: 'every hour', enabled, task, conversationId });
        db.putRoutine(botId, { ...r, nextRunAt: Date.now() - 1000 });
        return r;
      };
      const expected = new Map();
      const addMany = (botId, prefix, count, conversationId, home) => {
        for (let i = 0; i < count; i++) {
          const task = prefix + '<' + i + '>';
          add(botId, task, conversationId);
          expected.set(task, { botId, conversationId: home });
        }
      };
      addMany(first.bot.id, 'first-dm', 25, undefined, first.conversationId);
      addMany(first.bot.id, 'first-group', 5, group.id, group.id);
      addMany(second.bot.id, 'second-dm', 10, undefined, second.conversationId);
      const paused = add(first.bot.id, 'paused<0>', undefined, false);
      a.equal(db.routines(first.bot.id).length, 31);
      a.equal(db.routines(second.bot.id).length, 10);

      svc.tick(() => false);
      for (let i = 0; i < 500 && prompts.length < expected.size; i++) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 20));

      // Every due routine ran exactly once, alone, as the right bot, reporting to its own conversation.
      a.equal(steers.length, 0);
      a.equal(prompts.length, expected.size);
      const ran = new Set();
      for (const p of prompts) {
        const tasks = [...new Set([...p.message.matchAll(/[a-z-]+<[0-9]+>/g)].map((m) => m[0]))];
        const own = tasks.filter((t) => p.message.includes('Routine “' + t + '”'));
        a.equal(own.length, 1, p.message);
        const want = expected.get(own[0]);
        a.equal(p.botId, want.botId);
        a.equal(p.focus, want.conversationId);
        ran.add(own[0]);
      }
      a.equal(ran.size, expected.size);
      a.ok(!prompts.some((p) => p.message.includes('Routine “paused')));

      // They all stay on, scheduled for their next run; pausing one leaves its neighbours alone.
      for (const r of db.routines(second.bot.id)) a.ok(r.enabled && r.nextRunAt > Date.now());
      const [one, two] = db.routines(second.bot.id);
      svc.updateRoutine(second.bot.id, one.id, { enabled: false });
      a.equal(db.routines(second.bot.id).filter((r) => r.enabled).length, 9);
      a.equal(db.routines(second.bot.id).find((r) => r.id === two.id).enabled, true);
      a.equal(db.routines(first.bot.id).filter((r) => r.enabled).length, 30);
      svc.updateRoutine(first.bot.id, paused.id, { enabled: true });
      a.ok(db.routines(first.bot.id).find((r) => r.id === paused.id).nextRunAt > Date.now());

      // A message in the chat a bot is working in still joins the turn; one elsewhere waits for its own.
      prompts.length = 0;
      let release;
      minds.get(first.bot.id).proc.send = async (cmd) => {
        if (cmd.type === 'steer') steers.push({ botId: first.bot.id, message: cmd.message });
        if (cmd.type === 'prompt') {
          prompts.push({ botId: first.bot.id, focus: getFocus(first.bot.id), message: cmd.message });
          if (prompts.length === 1) release = () => minds.get(first.bot.id).onSettled?.();
          else setTimeout(() => minds.get(first.bot.id).onSettled?.(), 1);
        }
        return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
      };
      wake(first.bot.id, { kind: 'messages', conversationId: first.conversationId });
      for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setTimeout(r, 5));
      wake(first.bot.id, { kind: 'messages', conversationId: first.conversationId });
      wake(first.bot.id, { kind: 'messages', conversationId: group.id });
      await new Promise((r) => setTimeout(r, 10));
      a.equal(steers.length, 1);
      release();
      for (let i = 0; i < 200 && prompts.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
      a.deepEqual(prompts.map((p) => p.focus), [first.conversationId, group.id]);
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("bots write their own instructions, and only a blank slate is open to a non-primary bot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-instructions-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      import * as db from './server/bots/db.ts';
      import * as svc from './server/bots/service.ts';
      import { manage, contextFor, remember, setFocus } from './server/bots/agent.ts';
      svc.setHooks({ wake() {}, stop() {} });
      const primary = svc.createBot({ name: 'Boss' }).bot;
      const blank = svc.createBot({ name: 'Blank' }).bot;
      a.equal(primary.primary, true);

      // The primary is told to write its own, and when to give other bots theirs. Done writing, the nudge goes.
      a.match(contextFor(primary.id), /You don't have instructions yet/);
      a.match(contextFor(primary.id), /When you make a bot, decide whether/);
      manage(primary.id, { action: 'update', instructions: 'Help Outis plan.' });
      a.equal(db.getBot(primary.id).instructions, 'Help Outis plan.');
      a.doesNotMatch(contextFor(primary.id), /You don't have instructions yet/);
      a.match(contextFor(primary.id), /Help Outis plan/);

      // Giving a new bot instructions is optional, either way works.
      const withJob = manage(primary.id, { action: 'create', name: 'Coach', instructions: 'Track runs.' });
      const without = manage(primary.id, { action: 'create', name: 'Later' });
      a.equal(db.getBot(withJob.id).instructions, 'Track runs.');
      a.equal(db.getBot(without.id).instructions, '');

      // Remembering goes to the bot's memory without saying anything in the chat.
      const blankChat = svc.directId(blank.id);
      setFocus(blank.id, blankChat);
      remember(blank.id, { text: 'Likes tea.' });
      a.equal(db.messages(blankChat, 10).length, 0);
      a.match(contextFor(blank.id), /Likes tea/);
      setFocus(blank.id, undefined);

      // Every bot hears that its memory and routines are its own to run, and doesn't get the primary's guidance.
      a.match(contextFor(blank.id), /any number of routines active at once/);
      a.doesNotMatch(contextFor(blank.id), /When you make a bot/);

      // A non-primary bot can fill in its own blank, not overwrite what's there or touch anyone else.
      manage(blank.id, { action: 'update', instructions: 'First draft.' });
      a.equal(db.getBot(blank.id).instructions, 'First draft.');
      a.throws(() => manage(blank.id, { action: 'update', instructions: 'Rewritten.' }), /Say what to change/);
      a.equal(db.getBot(blank.id).instructions, 'First draft.');
      a.throws(() => manage(blank.id, { action: 'update', bot: without.id, instructions: 'Nope.' }), /only change yourself/);
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
