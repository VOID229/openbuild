import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('mixed group wakes preserve assigned delivery and never steer pending user requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbuild-mixed-delivery-'));
  try {
    const child = Bun.spawn([process.execPath, '-e', `
      import { strict as a } from 'node:assert';
      import { mock } from 'bun:test';
      const decisions = [];
      mock.module('./server/bots/router.ts', () => ({ routeGroup: () => new Promise(resolve => decisions.push(resolve)) }));
      const minds = globalThis.openbotsMinds = new Map();
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { getFocus } = await import('./server/bots/agent.ts');
      const alpha = svc.createBot({ name: 'Alpha' });
      const beta = svc.createBot({ name: 'Beta' });
      const group = svc.createConversation({ kind: 'group', name: 'Mixed', botIds: [alpha.bot.id, beta.bot.id] });
      const prompts = [], steers = [];
      for (const bot of [alpha.bot, beta.bot]) {
        const mind = { token: 'test', loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), close() {}, async send(cmd) {
          if (cmd.type === 'steer') steers.push(cmd);
          if (cmd.type === 'prompt') prompts.push({ ...cmd, bot: bot.id, focus: getFocus(bot.id), finish(text) { mind.draft = text; mind.onSettled?.(); } });
          return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
        } } };
        minds.set(bot.id, mind);
      }
      svc.setHooks({ wake: runner.wake, stop: runner.stop });
      const until = async check => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); a.ok(check()); };
      const post = (where, author, text, image) => svc.postMessage(where, { id: crypto.randomUUID(), author, text, at: Date.now(), ...(image ? { images: ['data:image/png;base64,' + image] } : {}) });
      for (const unscopedFirst of [false, true]) {
        let index = prompts.length;
        post(alpha.conversationId, 'me', 'BLOCK');
        await until(() => prompts.length === index + 1 && minds.get(alpha.bot.id).steerable);
        const pending = post(group.id, 'me', 'PENDING', 'AAAA');
        const trigger = post(group.id, alpha.bot.id, 'react here');
        let explicit;
        if (!unscopedFirst) explicit = post(group.id, 'me', '@Alpha ASSIGNED', 'BBBB');
        svc.toggleReaction(group.id, trigger.id, '👍', 'me');
        post(group.id, beta.bot.id, '@Alpha BOT MENTION');
        if (unscopedFirst) explicit = post(group.id, 'me', '@Alpha ASSIGNED', 'BBBB');
        prompts[index].finish('BLOCK DONE');
        await until(() => prompts.length === index + 2 && minds.get(alpha.bot.id).steerable);
        const first = prompts[index + 1];
        // A group wake during a live turn must queue, never steer the unread transcript.
        post(group.id, beta.bot.id, '@Alpha LIVE MENTION');
        svc.toggleReaction(group.id, trigger.id, '✅', 'me');
        runner.wake(alpha.bot.id, { kind: 'note', conversationId: group.id, text: 'NOTE' });
        a.equal(steers.length, 0);
        first.finish('GROUP ONE');
        await until(() => prompts.length === index + 3 && minds.get(alpha.bot.id).steerable);
        prompts[index + 2].finish('GROUP TWO');
        // The live-turn note may batch with the remaining unscoped turn, or follow it.
        await until(() => !runner.busy(alpha.bot.id) || prompts.length === index + 4);
        if (prompts.length === index + 4) {
          await until(() => minds.get(alpha.bot.id).steerable);
          prompts[index + 3].finish('NOTE DONE');
        }
        await until(() => !runner.busy(alpha.bot.id));
        const groupPrompts = prompts.slice(index + 1);
        const assigned = groupPrompts.filter(p => p.message.includes('[assigned request: answer this]: @Alpha ASSIGNED'));
        a.equal(assigned.length, 1);
        a.deepEqual(assigned[0].images.map(i => i.data), ['BBBB']);
        for (const p of groupPrompts) {
          a.ok(p.message.includes('[context only: do not answer]: PENDING'), p.message);
          if (p !== assigned[0]) a.equal((p.images ?? []).length, 0);
        }
        a.equal(db.getMessage(pending.id).message.seenBy, undefined);
        a.deepEqual(db.getMessage(explicit.id).message.seenBy, [alpha.bot.id]);
        const before = prompts.length;
        decisions.shift()([beta.bot.id]);
        await until(() => prompts.length === before + 1 && minds.get(beta.bot.id).steerable);
        a.ok(prompts[before].message.includes('[assigned request: answer this]: PENDING'));
        a.deepEqual(prompts[before].images.map(i => i.data), ['AAAA']);
        prompts[before].finish('PENDING DONE');
        await until(() => !runner.busy(beta.bot.id));
        a.deepEqual(db.getMessage(pending.id).message.seenBy, [beta.bot.id]);
      }
      a.equal(steers.length, 0);
      a.equal(db.messages(group.id).filter(r => r.message.text === 'PENDING DONE').length, 2);
      process.exit(0);
    `], { cwd: join(import.meta.dir, '..'), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: 'pipe', stderr: 'pipe' });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe('');
    expect(code).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
