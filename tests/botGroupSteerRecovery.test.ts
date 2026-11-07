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
    expect(unexpectedStderr(err)).toBe('');
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a group steer Pi queues late, after the turn settled, and the one behind it are answered once in a turn of their own', () => run('late', `
  post('@Alpha START');
  await until(() => prompts.length === 1 && mind.steerable);
  const start = db.latestSeq(group.id);
  // Pi doesn't answer the steer in time; its preflight ends after the run has settled, and it queues it then.
  pi.steer = async (cmd) => { throw late(120, { disposition: 'queued' }, () => piQueue.push(cmd.message)); };
  const first = post('@Alpha LATE', 'AAAA');
  await until(() => steers.length === 1);
  // Behind the overdue steer: waits on it, and isn't sent at all once the turn has let go.
  const behind = post('@Alpha BEHIND', 'BBBB');
  await settle();
  a.equal(steers.length, 1);
  prompts[0].finish('DONE');
  await until(() => prompts.length === 2 && mind.steerable);
  // Recovery came first: Pi's queue cleared after the late answer, aborted, and only then a new prompt.
  const at = (type, from = 0) => commands.indexOf(type, from);
  const answeredFirst = at('steer');
  a.ok(answeredFirst < at('clear_queue') && at('clear_queue') < at('abort') && at('abort') < commands.lastIndexOf('prompt'), commands.join());
  a.equal(mind.needsRecovery, false);
  a.equal(steers.length, 1);
  // The turn never read either: each is assigned once, with its own image, nothing replayed from Pi's queue.
  const next = prompts[1];
  a.deepEqual(next.drained, []);
  a.equal(assignedIn('@Alpha LATE').length, 1);
  a.equal(assignedIn('@Alpha BEHIND').length, 1);
  a.deepEqual(next.images.sort(), ['AAAA', 'BBBB']);
  a.ok(!lineFor(next.message, '@Alpha START')?.includes('answer this'));
  // The cursor didn't move past what the first turn never read.
  a.equal(db.cursor(alpha.bot.id, group.id), start);
  next.finish('DONE');
  await until(() => !runner.busy(alpha.bot.id));
  await settle();
  a.equal(prompts.length, 2);
  for (const m of [first, behind]) a.deepEqual(db.getMessage(m.id).message.seenBy, [alpha.bot.id]);
`), 30_000);

test('a prompt that times out recovers before anything else runs, and a group steer it never read gets its own turn', () => run('prompt-timeout', `
  let gate;
  pi.prompt = () => new Promise((_, no) => { gate = () => no(late(60, { disposition: 'started' })); });
  post('@Alpha START');
  await until(() => prompts.length === 1 && mind.steerable && gate);
  // Accepted into Pi's queue while the prompt still hasn't been answered.
  const steered = post('@Alpha QUEUED', 'QQQQ');
  await until(() => steers.length === 1 && piQueue.length === 1);
  pi.prompt = async () => ({});
  gate();
  await until(() => prompts.length === 2 && mind.steerable);
  a.ok(commands.indexOf('abort') < commands.lastIndexOf('prompt'), commands.join());
  // The original request isn't replayed: the turn failed and said so.
  a.ok(db.messages(group.id).some(r => r.message.event?.kind === 'error'));
  a.equal(assignedIn('@Alpha START').length, 1);
  const next = prompts[1];
  a.deepEqual(next.drained, []);
  a.match(lineFor(next.message, '@Alpha QUEUED'), /\\[assigned request: answer this\\]/);
  a.deepEqual(next.images, ['QQQQ']);
  next.finish('DONE');
  await until(() => !runner.busy(alpha.bot.id));
  await settle();
  a.equal(prompts.length, 2);
  a.deepEqual(db.getMessage(steered.id).message.seenBy, [alpha.bot.id]);
`), 30_000);

test('a group steer the turn read is never replayed once the turn had side effects', () => run('side-effects', `
  svc.updateBot(alpha.bot.id, { model: 'one/primary', fallbackModels: ['two/fallback'] });
  post('@Alpha START');
  await until(() => prompts.length === 1 && mind.steerable);
  const start = db.latestSeq(group.id);
  post('@Alpha READ');
  await until(() => steers.length === 1 && piQueue.length === 1);
  // Pi reads it, runs a tool, then the model errors: no fallback, no new turn for either request.
  piQueue.splice(0);
  runner.onRecord(alpha.bot.id, mind, { type: 'tool_execution_start', toolName: 'bash', args: {} });
  runner.onRecord(alpha.bot.id, mind, { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'overloaded' } });
  mind.onSettled?.();
  await until(() => !runner.busy(alpha.bot.id));
  await settle();
  a.equal(prompts.length, 1);
  a.equal(steers.length, 1);
  a.ok(db.messages(group.id).some(r => r.message.event?.kind === 'error'));
  // A failed turn leaves the cursor alone.
  a.ok(db.cursor(alpha.bot.id, group.id) <= start);
`), 30_000);

// The primary errors before acting while a group steer is still in Pi's preflight, with another behind it.
// `ack` is how Pi answers it: in time but slowly, or only after the RPC deadline.
const boundary = (ack: 'delayed' | 'timeout') => `
  svc.updateBot(alpha.bot.id, { model: 'one/primary', fallbackModels: ['two/fallback'] });
  post('@Alpha START');
  await until(() => prompts.length === 1 && mind.steerable);
  let accept;
  pi.steer = (cmd) => ${ack === 'delayed'
    ? `new Promise((done) => { accept = () => { piQueue.push(cmd.message); done({ disposition: 'queued' }); }; })`
    : `new Promise((_, no) => { let go; const answered = new Promise((r) => (go = r)); accept = () => { piQueue.push(cmd.message); go(); }; const err = late(0, { disposition: 'queued' }); err.answered = answered.then(() => ({ type: 'response', success: true, data: { disposition: 'queued' } })); no(err); })`};
  const pending = post('@Alpha PENDING', 'PPPP');
  await until(() => steers.length === 1 && accept);
  const behind = post('@Alpha BEHIND', 'BBBB');
  await settle();
  a.equal(steers.length, 1);
  runner.onRecord(alpha.bot.id, mind, { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'overloaded' } });
  mind.onSettled?.();
  await settle();
  a.equal(prompts.length, 1, 'fallback must not start while the steer is unanswered');
  const separate = post('@Alpha SEPARATE', 'SSSS');
  await settle();
  a.equal(steers.length, 1);
  accept();
  await until(() => prompts.length === 2 && mind.steerable);
  const fallback = prompts[1];
  a.deepEqual(fallback.drained, []);
  const clear = commands.indexOf('clear_queue'), prompt = commands.lastIndexOf('prompt');
  a.ok(clear > commands.indexOf('steer') && clear < prompt, commands.join());
  // A steer answered after its deadline left Pi to recover: aborted before the fallback's prompt.
  a.equal(commands.slice(clear, prompt).includes('abort'), ${ack === 'timeout'});
  a.ok(!mind.needsRecovery);
  for (const text of ['@Alpha PENDING', '@Alpha BEHIND', '@Alpha SEPARATE']) a.equal(assignedIn(text).length, 0, text);
  fallback.finish('DONE');
  await until(() => prompts.length === 3 && mind.steerable);
  prompts[2].finish('DONE');
  await until(() => !runner.busy(alpha.bot.id));
  await settle();
  // Each request once, in its own turn after the fallback's, each image once, nothing replayed from Pi.
  a.equal(prompts.length, 3);
  a.equal(steers.length, 1);
  for (const text of ['@Alpha PENDING', '@Alpha BEHIND', '@Alpha SEPARATE']) a.equal(assignedIn(text).length, 1, text);
  a.deepEqual(prompts[2].images.sort(), ['BBBB', 'PPPP', 'SSSS']);
  a.deepEqual(prompts[2].drained, []);
  a.equal(assignedIn('@Alpha START').length, 2);
  for (const m of [pending, behind, separate]) a.deepEqual(db.getMessage(m.id).message.seenBy, [alpha.bot.id]);
`;

test('a fallback waits for a group steer Pi acks slowly, then each request is answered once', () => run('boundary-delayed', boundary('delayed')), 30_000);
test('a fallback recovers from a group steer Pi acks after its deadline, then each request is answered once', () => run('boundary-timeout', boundary('timeout')), 30_000);

test('a model that acted before failing gets no fallback, even with a group steer still unanswered', () => run('boundary-acted', `
  svc.updateBot(alpha.bot.id, { model: 'one/primary', fallbackModels: ['two/fallback'] });
  post('@Alpha START');
  await until(() => prompts.length === 1 && mind.steerable);
  const start = db.latestSeq(group.id);
  let accept;
  pi.steer = (cmd) => new Promise((done) => { accept = () => { piQueue.push(cmd.message); done({ disposition: 'queued' }); }; });
  post('@Alpha PENDING', 'PPPP');
  await until(() => steers.length === 1 && accept);
  runner.onRecord(alpha.bot.id, mind, { type: 'tool_execution_start', toolName: 'bash', args: {} });
  runner.onRecord(alpha.bot.id, mind, { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'overloaded' } });
  mind.onSettled?.();
  await settle();
  a.equal(prompts.length, 1);
  // Answered after the turn failed: Pi never read it, so it's cleared and gets its own turn, once.
  accept();
  await until(() => prompts.length === 2 && mind.steerable);
  a.deepEqual(prompts[1].drained, []);
  a.equal(assignedIn('@Alpha START').length, 1);
  a.equal(assignedIn('@Alpha PENDING').length, 1);
  a.deepEqual(prompts[1].images, ['PPPP']);
  prompts[1].finish('DONE');
  await until(() => !runner.busy(alpha.bot.id));
  await settle();
  a.equal(prompts.length, 2);
  a.ok(db.messages(group.id).some(r => r.message.event?.kind === 'error'));
  a.ok(db.cursor(alpha.bot.id, group.id) >= start);
`), 30_000);

test('a fallback recovers first even when the overdue group steer was handled, not queued', () => run('boundary-handled', `
  svc.updateBot(alpha.bot.id, { model: 'one/primary', fallbackModels: ['two/fallback'] });
  post('@Alpha START');
  await until(() => prompts.length === 1 && mind.steerable);
  let accept;
  pi.steer = () => new Promise((_, no) => { const err = late(0, {}); err.answered = new Promise((r) => (accept = () => r({ type: 'response', success: true, data: { disposition: 'handled' } }))); no(err); });
  const handled = post('@Alpha /command');
  await until(() => steers.length === 1 && accept);
  runner.onRecord(alpha.bot.id, mind, { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'overloaded' } });
  mind.onSettled?.();
  await settle();
  a.equal(prompts.length, 1);
  accept();
  await until(() => prompts.length === 2 && mind.steerable);
  // Nothing to put back, but Pi was overdue: recovered from before the fallback's prompt.
  a.ok(commands.lastIndexOf('abort') > commands.indexOf('steer') && commands.lastIndexOf('abort') < commands.lastIndexOf('prompt'), commands.join());
  a.ok(!mind.needsRecovery);
  prompts[1].finish('DONE');
  await until(() => !runner.busy(alpha.bot.id));
  await settle();
  a.equal(prompts.length, 2);
  a.equal(assignedIn('@Alpha /command').length, 0);
  a.deepEqual(db.getMessage(handled.id).message.seenBy, [alpha.bot.id]);
`), 30_000);
