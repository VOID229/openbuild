// A bot at work in one chat, through the real service and runner: its own chat shows it busy, and a
// group it's only a member of doesn't, until a message there names it (an @mention): then that group
// shows it holding on, its message next in line. A message there said to everyone doesn't.
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnScript } from './spawnScript';

test('a bot busy in its own chat shows busy only there, and in a group once a message there names it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbuild-bots-busy-per-chat-'));
  try {
    const { code, stderr: err } = await spawnScript(`
      import { strict as a } from 'node:assert';
      const minds = globalThis.openbotsMinds = new Map();
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
      const sessionPathFor = id => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', id, (globalThis.openbotsFocus?.get(id) ?? svc.directId(id))));
      const { busyBots, elsewhere, showWorking } = await import('./src/lib/bots/activity.ts');
      // No helper session starts for a message that finds the bot mid-call (botResponsiveness.test.ts).
      const helpers = await import('./server/bots/helpers.ts');
      helpers.seams.spawn = () => ({ send: async (cmd) => (cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {}), on: () => () => {}, close() {} });
      const egg = svc.createBot({ name: 'Eggbot' });
      const pip = svc.createBot({ name: 'Pip' });
      const dev = svc.createConversation({ kind: 'group', name: 'Dev', botIds: [egg.bot.id, pip.bot.id] });
      const ops = svc.createConversation({ kind: 'group', name: 'Ops', botIds: [egg.bot.id, pip.bot.id] });
      const prompts = [];
      for (const bot of [egg.bot, pip.bot]) {
        const mind = { token: 'test', loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), close() {}, async send(cmd) {
          if (cmd.type === 'prompt') prompts.push({ ...cmd, bot: bot.id, mind, finish() { mind.onSettled?.(); } });
          return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
        } } };
        Object.defineProperty(mind, 'sessionPath', { get: () => sessionPathFor(bot.id) });
        minds.set(bot.id, mind);
      }
      svc.setHooks({ wake: runner.wake, stop: runner.stop });
      const until = async check => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); a.ok(check()); };
      const snap = () => svc.snapshot();
      const busy = c => busyBots(c, snap().status, snap().typing);
      const shown = c => showWorking(c.id, snap().status, snap().typing[c.id] ?? []);
      const post = (where, text) => svc.postMessage(where, { id: crypto.randomUUID(), author: 'me', text, at: Date.now() });
      const mine = id => prompts.filter(p => p.bot === id);
      const solo = { id: egg.conversationId, kind: 'direct', botIds: [egg.bot.id] };

      // At work in its own chat: busy there, and nowhere else.
      post(egg.conversationId, 'Look into the flaky test');
      await until(() => mine(egg.bot.id).length === 1 && minds.get(egg.bot.id).steerable);
      runner.onRecord(egg.bot.id, mine(egg.bot.id)[0].mind, { type: 'tool_execution_start', toolName: 'bash', args: { status: 'Running the tests' } });
      a.equal(snap().status[egg.bot.id].conversationId, egg.conversationId);
      a.deepEqual(busy(solo), [egg.bot.id]);
      a.deepEqual(busy(dev), []);
      a.deepEqual(busy(ops), []);
      a.deepEqual(elsewhere(dev, snap().status), []);

      // A message to the whole of Ops: every bot there decides whether it's theirs, so the busy one
      // doesn't show holding on there.
      post(ops.id, 'Anyone around?');
      a.deepEqual(snap().status[egg.bot.id].undecided, [ops.id]);
      a.equal(busy(ops).includes(egg.bot.id), false);
      a.equal(shown(ops).includes(egg.bot.id), false);

      // Named in Dev: that group shows it holding on, its message next, while Ops still doesn't.
      post(dev.id, '@Eggbot can you check the deploy too?');
      a.ok(snap().status[egg.bot.id].waiting.includes(dev.id));
      a.ok(!snap().status[egg.bot.id].undecided?.includes(dev.id));
      a.deepEqual(busy(dev), [egg.bot.id]);
      a.deepEqual(shown(dev), [egg.bot.id]);
      a.equal(busy(ops).includes(egg.bot.id), false);
      a.deepEqual(busy(solo), [egg.bot.id]);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir });
    expect(err).toBe('');
    expect(code).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
