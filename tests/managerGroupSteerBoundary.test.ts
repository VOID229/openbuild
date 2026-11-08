import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unexpectedStderr } from './botStderr';

// Scoped group steers through timeout recovery: the real service routing and runner, with a fake Pi
// that keeps its own steering queue and answers late the way Pi 1.5 does, in a subprocess on its own data dir.
async function run(name: string, body: string) {
  const dir = await mkdtemp(join(tmpdir(), `openbuild-group-steer-recovery-${name}-`));
  try {
    const child = Bun.spawn([process.execPath, '-e', `
      import { strict as a } from 'node:assert';
      const minds = globalThis.openbotsMinds = new Map();
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const { PiTimeoutError } = await import('./server/pi/rpc.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
      svc.setHooks({ wake: runner.wake, stop: runner.stop });
      svc.updateSettings({ onboarding: 'done' });
      const prompts = [], steers = [], commands = [], piQueue = [];
      // A command Pi didn't answer in time: it answers later, and only then does what it was asked.
      const late = (ms, data, then) => {
        const err = new PiTimeoutError('Pi didn\\'t answer in time');
        err.answered = new Promise((done) => setTimeout(() => { then?.(); done({ type: 'response', success: true, data }); }, ms));
        return err;
      };
      const pi = { steer: async (cmd) => (piQueue.push(cmd.message), { disposition: 'queued' }), prompt: async () => ({}) };
      const alpha = svc.createBot({ name: 'Alpha' });
      const beta = svc.createBot({ name: 'Beta' });
      const group = svc.createConversation({ kind: 'group', name: 'Team', botIds: [alpha.bot.id, beta.bot.id] });
      const mind = { token: 't', loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), ended: Promise.resolve(), close() { this.exited = true; }, async send(cmd) {
        commands.push(cmd.type);
        if (cmd.type === 'clear_queue') return { steering: piQueue.splice(0), followUp: [] };
        if (cmd.type === 'steer') {
          steers.push({ message: cmd.message, images: (cmd.images ?? []).map(i => i.data) });
          return pi.steer(cmd);
        }
        if (cmd.type === 'prompt') {
          prompts.push({ message: cmd.message, images: (cmd.images ?? []).map(i => i.data), drained: piQueue.splice(0), finish(text) { piQueue.splice(0); mind.draft = text; mind.onSettled?.(); } });
          return pi.prompt(cmd);
        }
        return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
      } } };
      // This reusable fake exercises recovery, not on-disk Pi session loading.
      Object.defineProperty(mind, 'sessionPath', { get: () => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', alpha.bot.id, globalThis.openbotsFocus?.get(alpha.bot.id) ?? alpha.conversationId)) });
      minds.set(alpha.bot.id, mind);
      const until = async (check) => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); a.ok(check()); };
      const settle = () => Bun.sleep(40);
      const post = (text, image) => svc.postMessage(group.id, { id: crypto.randomUUID(), author: 'me', text, at: Date.now(), ...(image ? { images: ['data:image/png;base64,' + image] } : {}) });
      const lineFor = (message, text) => message.split('\\n').find(l => l.endsWith(': ' + text));
      const assignedIn = (text) => prompts.filter(p => lineFor(p.message, text)?.includes('[assigned request: answer this]'));
      ${body}
      process.exit(0);
    `], { cwd: join(import.meta.dir, '..'), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: 'pipe', stderr: 'pipe' });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(unexpectedStderr(err.replace(/^\[bots\] [0-9a-f-]{36} fallback one\/primary → two\/fallback: overloaded\n/gm, ""))).toBe('');
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('fallback waits for a group steer still in preflight', () => run('fallback-preflight', `
  svc.updateBot(alpha.bot.id, { model: 'one/primary', fallbackModels: ['two/fallback'] });
  post('@Alpha START');
  await until(() => prompts.length === 1 && mind.steerable);
  let accept;
  pi.steer = (cmd) => new Promise(done => { accept = () => { piQueue.push(cmd.message); done({ disposition: 'queued' }); }; });
  post('@Alpha PENDING', 'PPPP');
  await until(() => steers.length === 1 && accept);
  runner.onRecord(alpha.bot.id, mind, { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'overloaded' } });
  mind.onSettled?.();
  await settle();
  a.equal(prompts.length, 1, 'fallback must not start while earlier steer preflight is unresolved');
  accept();
  await until(() => prompts.length === 2 && mind.steerable);
  a.deepEqual(prompts[1].drained, []);
  prompts[1].finish('DONE');
  await until(() => prompts.length === 3 && mind.steerable);
  a.match(lineFor(prompts[2].message, '@Alpha PENDING'), /assigned request/);
  prompts[2].finish('DONE');
  await until(() => !runner.busy(alpha.bot.id));
`), 30_000);
