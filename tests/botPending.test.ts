import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a sent message shows its bot busy at once: starting, busy elsewhere, or after a reply in the same chat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbuild-bots-pending-'));
  try {
    const child = Bun.spawn([process.execPath, '-e', `
      import { strict as a } from 'node:assert';
      const minds = globalThis.openbotsMinds = new Map();
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { holding, showWorking } = await import('./src/lib/bots/activity.ts');
      const boss = svc.createBot({ name: 'Boss' });
      const helper = svc.createBot({ name: 'Helper' });
      const group = svc.createConversation({ kind: 'group', name: 'Pending', botIds: [boss.bot.id, helper.bot.id] });
      const prompts = [], steers = [];
      for (const bot of [boss.bot, helper.bot]) {
        const mind = { token: 'test', loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), close() {}, async send(cmd) {
          if (cmd.type === 'prompt') prompts.push({ ...cmd, bot: bot.id, mind, finish() { mind.onSettled?.(); } });
          if (cmd.type === 'steer') steers.push({ ...cmd, bot: bot.id });
          return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
        } } };
        minds.set(bot.id, mind);
      }
      svc.setHooks({ wake: runner.wake, stop: runner.stop });
      const until = async check => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); a.ok(check()); };
      const status = id => svc.snapshot().status[id];
      const typing = () => svc.snapshot().typing[group.id] ?? [];
      const post = (where, text) => svc.postMessage(where, { id: crypto.randomUUID(), author: 'me', text, at: Date.now() });

      // Starting: the primary is working in the group before postMessage even returns.
      post(group.id, 'Hello');
      a.equal(status(boss.bot.id).state, 'working');
      a.equal(status(boss.bot.id).conversationId, group.id);
      a.deepEqual(showWorking(group.id, svc.snapshot().status, typing()), [boss.bot.id]);
      await until(() => prompts.length === 1 && minds.get(boss.bot.id).steerable);

      // After a reply, it's quiet in the chat; a new message there shows it busy again straight away.
      runner.onRecord(boss.bot.id, prompts[0].mind, { type: 'tool_execution_end', toolName: 'send_message', result: {} });
      a.equal(status(boss.bot.id).quiet, true);
      post(group.id, 'One more thing');
      a.equal(status(boss.bot.id).quiet, undefined);
      a.deepEqual(showWorking(group.id, svc.snapshot().status, typing()), [boss.bot.id]);
      // Tools after the reply keep it showing.
      runner.onRecord(boss.bot.id, prompts[0].mind, { type: 'tool_execution_start', toolName: 'bash', args: { status: 'Checking the logs' } });
      a.equal(status(boss.bot.id).quiet, undefined);
      a.equal(status(boss.bot.id).activity, 'Checking the logs');

      // Busy elsewhere: a message in its own chat shows it holding on there, at once.
      post(boss.conversationId, 'Are you there?');
      a.ok(holding(status(boss.bot.id), boss.conversationId));
      a.deepEqual(showWorking(boss.conversationId, svc.snapshot().status, svc.snapshot().typing[boss.conversationId] ?? []), [boss.bot.id]);

      // The follow-up in the group was steered into the turn it's working on, not held for another.
      a.equal(steers.length, 1);
      a.ok(steers[0].message.includes('[new, for you]: One more thing'));
      prompts[0].finish();
      await until(() => prompts.length === 2 && minds.get(boss.bot.id).steerable);
      a.equal(status(boss.bot.id).conversationId, boss.conversationId);
      prompts[1].finish();
      await until(() => !runner.busy(boss.bot.id));
      a.equal(status(boss.bot.id)?.state ?? 'idle', 'idle');
      process.exit(0);
    `], { cwd: join(import.meta.dir, '..'), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: 'pipe', stderr: 'pipe' });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe('');
    expect(code).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
