import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnScript } from './spawnScript';

test('a group message reaches every bot there, and only the ones that act show; a sent message shows its bot busy at once otherwise', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbuild-bots-pending-'));
  try {
    const { code, stderr: err } = await spawnScript(`
      import { strict as a } from 'node:assert';
      const minds = globalThis.openbotsMinds = new Map();
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
      const sessionPathFor = id => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', id, (globalThis.openbotsFocus?.get(id) ?? svc.directId(id))));
      const { busyBots, holding, showWorking } = await import('./src/lib/bots/activity.ts');
      // A bot busy in a tool answers a new message through a helper session (botResponsiveness.test.ts): a stand-in, so no real Pi starts here.
      const helpers = await import('./server/bots/helpers.ts');
      const quickReplies = [];
      helpers.seams.spawn = (botId) => (quickReplies.push(botId), { send: async (cmd) => (cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {}), on: () => () => {}, close() {} });
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
        Object.defineProperty(mind, 'sessionPath', { get: () => sessionPathFor(bot.id) });
        minds.set(bot.id, mind);
      }
      svc.setHooks({ wake: runner.wake, stop: runner.stop });
      const until = async check => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); a.ok(check()); };
      const status = id => svc.snapshot().status[id];
      const typing = () => svc.snapshot().typing[group.id] ?? [];
      const post = (where, text) => svc.postMessage(where, { id: crypto.randomUUID(), author: 'me', text, at: Date.now() });

      const mine = id => prompts.filter(p => p.bot === id);
      const shownWorking = () => showWorking(group.id, svc.snapshot().status, typing());

      // Every bot in the group gets it. The one answering for the group (Boss, the primary) shows at
      // work at once, as in its own chat: the user is waiting on it. The other decides whether any of it
      // is its own, and nothing shows of it, not even a mascot, until it acts.
      post(group.id, 'Hello');
      for (const id of [boss.bot.id, helper.bot.id]) {
        a.equal(status(id).state, 'working');
        a.equal(status(id).conversationId, group.id);
      }
      a.equal(status(boss.bot.id).deciding, undefined);
      a.equal(status(boss.bot.id).quiet, undefined);
      a.equal(status(helper.bot.id).deciding, true);
      a.deepEqual(shownWorking(), [boss.bot.id]);
      a.deepEqual(busyBots(group, svc.snapshot().status, svc.snapshot().typing), [boss.bot.id]);
      await until(() => mine(boss.bot.id).length === 1 && mine(helper.bot.id).length === 1 && minds.get(boss.bot.id).steerable && minds.get(helper.bot.id).steerable);
      // Pi taking the prompt and the model's first call coming in don't change what shows of the lead.
      a.deepEqual(shownWorking(), [boss.bot.id]);

      // Picking up a tool to make up its mind isn't acting; a real one is, and from then it shows.
      const helperMind = mine(helper.bot.id)[0].mind;
      runner.onRecord(helper.bot.id, helperMind, { type: 'tool_execution_start', toolName: 'load_tools', args: {} });
      a.equal(status(helper.bot.id).deciding, true);
      runner.onRecord(helper.bot.id, helperMind, { type: 'tool_execution_end', toolName: 'load_tools', result: {} });
      runner.onRecord(helper.bot.id, helperMind, { type: 'tool_execution_start', toolName: 'bash', args: { status: 'Looking into it' } });
      a.equal(status(helper.bot.id).deciding, undefined);
      a.deepEqual(shownWorking().sort(), [boss.bot.id, helper.bot.id].sort());
      runner.onRecord(helper.bot.id, helperMind, { type: 'tool_execution_end', toolName: 'bash', result: {} });
      runner.onRecord(boss.bot.id, mine(boss.bot.id)[0].mind, { type: 'tool_execution_start', toolName: 'bash', args: { status: 'Looking into it' } });
      a.equal(status(boss.bot.id).activity, 'Looking into it');
      runner.onRecord(boss.bot.id, mine(boss.bot.id)[0].mind, { type: 'tool_execution_end', toolName: 'bash', result: {} });
      // The other is done.
      mine(helper.bot.id)[0].finish();
      await until(() => !runner.busy(helper.bot.id));
      a.equal(status(helper.bot.id)?.state ?? 'idle', 'idle');

      // After a reply, it's quiet in the chat; a new message there shows it busy again straight away.
      runner.onRecord(boss.bot.id, mine(boss.bot.id)[0].mind, { type: 'tool_execution_end', toolName: 'send_message', result: {} });
      a.equal(status(boss.bot.id).quiet, true);
      post(group.id, 'One more thing');
      a.equal(status(boss.bot.id).quiet, undefined);
      a.deepEqual(shownWorking(), [boss.bot.id]);
      // Tools after the reply keep it showing.
      runner.onRecord(boss.bot.id, mine(boss.bot.id)[0].mind, { type: 'tool_execution_start', toolName: 'bash', args: { status: 'Checking the logs' } });
      a.equal(status(boss.bot.id).quiet, undefined);
      a.equal(status(boss.bot.id).activity, 'Checking the logs');

      // Busy elsewhere: a message in its own chat shows it holding on there, at once.
      post(boss.conversationId, 'Are you there?');
      a.ok(holding(status(boss.bot.id), boss.conversationId));
      a.deepEqual(showWorking(boss.conversationId, svc.snapshot().status, svc.snapshot().typing[boss.conversationId] ?? []), [boss.bot.id]);

      // The follow-up in the group was steered into the turn it's working on, not held for another.
      const delivered = steers.filter(s => s.bot === boss.bot.id);
      a.equal(delivered.length, 1);
      a.ok(delivered[0].message.includes('[new, for you'));
      a.ok(delivered[0].message.includes('One more thing'));
      // The other bot, only deciding, is steered nothing.
      a.equal(steers.filter(s => s.bot === helper.bot.id).length, 0);
      mine(boss.bot.id)[0].finish();
      await until(() => mine(boss.bot.id).length === 2 && minds.get(boss.bot.id).steerable);
      a.equal(status(boss.bot.id).conversationId, boss.conversationId);
      mine(boss.bot.id)[1].finish();
      await until(() => !runner.busy(boss.bot.id));
      a.equal(status(boss.bot.id)?.state ?? 'idle', 'idle');
      await until(() => mine(helper.bot.id).length === 2);
      mine(helper.bot.id)[1].finish();
      await until(() => !runner.busy(helper.bot.id));
      // The message that found it inside one of its own calls started no helper reply: that call stops
      // holding the turn once someone is waiting (jobs.ts), and the bot answers itself.
      a.deepEqual(quickReplies, []);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir });
    expect(err).toBe('');
    expect(code).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test('a group request steered into a turn still deciding, naming that bot, shows it at work at once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbuild-bots-pending-steer-'));
  try {
    const { code, stderr: err } = await spawnScript(`
      import { strict as a } from 'node:assert';
      const minds = globalThis.openbotsMinds = new Map();
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
      const sessionPathFor = id => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', id, (globalThis.openbotsFocus?.get(id) ?? svc.directId(id))));
      const { showWorking } = await import('./src/lib/bots/activity.ts');
      const helpers = await import('./server/bots/helpers.ts');
      helpers.seams.spawn = () => ({ send: async (cmd) => (cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {}), on: () => () => {}, close() {} });
      const boss = svc.createBot({ name: 'Boss' });
      const helper = svc.createBot({ name: 'Helper' });
      const group = svc.createConversation({ kind: 'group', name: 'Steered', botIds: [boss.bot.id, helper.bot.id] });
      const prompts = [], steers = [];
      for (const bot of [boss.bot, helper.bot]) {
        const mind = { token: 'test', loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), close() {}, async send(cmd) {
          if (cmd.type === 'prompt') prompts.push({ ...cmd, bot: bot.id, mind, finish() { mind.onSettled?.(); } });
          if (cmd.type === 'steer') steers.push({ ...cmd, bot: bot.id });
          return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
        } } };
        Object.defineProperty(mind, 'sessionPath', { get: () => sessionPathFor(bot.id) });
        minds.set(bot.id, mind);
      }
      svc.setHooks({ wake: runner.wake, stop: runner.stop });
      const until = async check => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); a.ok(check()); };
      const status = id => svc.snapshot().status[id];
      const shownWorking = () => showWorking(group.id, svc.snapshot().status, svc.snapshot().typing[group.id] ?? []);
      const post = text => svc.postMessage(group.id, { id: crypto.randomUUID(), author: 'me', text, at: Date.now() });
      const mine = id => prompts.filter(p => p.bot === id);

      // Boss answers for the group; Helper only decides whether any of it is its own.
      post('Hello');
      await until(() => mine(helper.bot.id).length === 1 && minds.get(helper.bot.id).steerable);
      a.equal(status(helper.bot.id).deciding, true);
      a.deepEqual(shownWorking(), [boss.bot.id]);

      // Asked by name while it decides: the request is steered into that turn, and the user is waiting on it now.
      post('@Helper can you check the logs?');
      await until(() => steers.some(s => s.bot === helper.bot.id));
      a.ok(steers.find(s => s.bot === helper.bot.id).message.includes('check the logs'));
      a.equal(status(helper.bot.id).deciding, undefined);
      a.equal(status(helper.bot.id).quiet, undefined);
      a.deepEqual(shownWorking().sort(), [boss.bot.id, helper.bot.id].sort());

      for (const id of [boss.bot.id, helper.bot.id]) mine(id)[0].finish();
      await until(() => !runner.busy(boss.bot.id) && !runner.busy(helper.bot.id));
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir });
    expect(err).toBe('');
    expect(code).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
