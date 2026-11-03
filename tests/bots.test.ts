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

test("send_message, models and check-ins against a real bots database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-"));
  try {
    await Bun.write(join(dir, "pi", "settings.json"), JSON.stringify({ defaultProvider: "openrouter", defaultModel: "deepseek/flash" }));
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      import * as db from './server/bots/db.ts';
      import * as svc from './server/bots/service.ts';
      import { sendMessage, setFocus, routine } from './server/bots/agent.ts';
      import { applyModel, applyEffort, successfulMessageTool, transcript } from './server/bots/runner.ts';

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
