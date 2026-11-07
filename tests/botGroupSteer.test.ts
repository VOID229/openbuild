import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unexpectedStderr } from './botStderr';

// Every scenario runs against the real service routing and runner, with fake Pi processes, in a
// subprocess on its own data dir.
async function run(name: string, body: string) {
  const dir = await mkdtemp(join(tmpdir(), `openbuild-group-steer-${name}-`));
  try {
    const child = Bun.spawn([process.execPath, '-e', `
      import { strict as a } from 'node:assert';
      const minds = globalThis.openbotsMinds = new Map();
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { getFocus } = await import('./server/bots/agent.ts');
      svc.setHooks({ wake: runner.wake, stop: runner.stop });
      svc.updateSettings({ onboarding: 'done' });
      const prompts = [], steers = [], commands = [];
      // Pi's own steering queue: a run that finishes has read it, one that errors leaves it for the
      // next prompt to read first, and clear_queue empties it.
      const piQueues = new Map();
      const piQueue = (bot) => piQueues.get(bot.id) ?? piQueues.set(bot.id, []).get(bot.id);
      // steer(bot, cmd) decides what a steer does: resolve, throw, or wait on a promise.
      const pi = { steer: async () => ({}) };
      const fake = (bot) => {
        const mind = { token: 't', loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), close() {}, async send(cmd) {
          commands.push({ bot: bot.id, type: cmd.type });
          if (cmd.type === 'clear_queue') return { steering: piQueue(bot).splice(0), followUp: [] };
          if (cmd.type === 'steer') {
            const entry = { bot: bot.id, focus: getFocus(bot.id), message: cmd.message, images: (cmd.images ?? []).map(i => i.data), ok: undefined };
            steers.push(entry);
            try {
              const out = await pi.steer(bot, cmd);
              if ((out?.disposition ?? 'queued') === 'queued') piQueue(bot).push(cmd.message);
              entry.ok = true;
              return out;
            } catch (err) { entry.ok = false; throw err; }
          }
          if (cmd.type === 'prompt') prompts.push({ bot: bot.id, focus: getFocus(bot.id), message: cmd.message, images: (cmd.images ?? []).map(i => i.data), drained: piQueue(bot).splice(0), finish(text) { piQueue(bot).splice(0); mind.draft = text; mind.onSettled?.(); }, fail(error) { runner.onRecord(bot.id, mind, { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: error } }); mind.onSettled?.(); } });
          return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
        } } };
        minds.set(bot.id, mind);
        return mind;
      };
      const until = async (check) => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); a.ok(check()); };
      const settle = () => Bun.sleep(30);
      let now = Date.now();
      const post = (where, author, text, { image, replyTo, at } = {}) => svc.postMessage(where, { id: crypto.randomUUID(), author, text, at: at ?? now, replyTo, ...(image ? { images: ['data:image/png;base64,' + image] } : {}) });
      const of = (bot) => prompts.filter(p => p.bot === bot.id);
      const steersOf = (bot) => steers.filter(s => s.bot === bot.id);
      const lineFor = (message, text) => message.split('\\n').find(l => l.endsWith(': ' + text));
      const alpha = svc.createBot({ name: 'Alpha' });
      const beta = svc.createBot({ name: 'Beta' });
      fake(alpha.bot); fake(beta.bot);
      a.ok(db.getBot(alpha.bot.id).primary);
      const group = svc.createConversation({ kind: 'group', name: 'Team', botIds: [alpha.bot.id, beta.bot.id] });
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

test('a busy group recipient is steered its request whether mentioned, replied to, followed or the primary', () => run('routing', `
  const start = post(group.id, 'me', '@Alpha START');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  const said = post(group.id, alpha.bot.id, 'alpha said');
  const cases = [
    ['mention', () => post(group.id, 'me', '@Alpha MENTION', { image: 'MMMM' }), '@Alpha MENTION', ['MMMM']],
    ['reply', () => post(group.id, 'me', 'REPLY', { replyTo: said.id }), 'REPLY', []],
    ['follow', () => post(group.id, 'me', 'FOLLOW', { image: 'FFFF' }), 'FOLLOW', ['FFFF']],
    ['primary', () => post(group.id, 'me', 'PRIMARY', { at: now + 21 * 60_000 }), 'PRIMARY', []],
  ];
  for (const [mode, send, text, images] of cases) {
    const before = steers.length;
    const message = send();
    await until(() => steers.length === before + 1 && steers.at(-1).ok);
    const steer = steers.at(-1);
    a.equal(steer.bot, alpha.bot.id, mode);
    a.equal(steer.focus, group.id, mode);
    a.ok(lineFor(steer.message, text)?.includes('[new, for you]'), mode + ': ' + steer.message);
    // Only the request itself: not the transcript, not the turn's own request or earlier steers.
    for (const other of ['START', 'MENTION', 'REPLY', 'FOLLOW', 'PRIMARY'].filter(t => !text.includes(t))) a.ok(!steer.message.includes(other), mode + ' leaked ' + other);
    a.ok(!steer.message.includes('[silent]'), mode);
    a.match(steer.message, /otherwise carry on/);
    a.deepEqual(steer.images, images, mode);
    await until(() => db.getMessage(message.id).message.seenBy?.includes(alpha.bot.id));
  }
  // Steered, so none of them waits for a turn of its own, and Beta was never woken.
  a.equal(steersOf(beta.bot).length, 0);
  a.equal(of(beta.bot).length, 0);
  of(alpha.bot)[0].finish('DONE');
  await until(() => !runner.busy(alpha.bot.id));
  await settle();
  a.equal(of(alpha.bot).length, 1);
  a.equal(db.getMessage(start.id).message.seenBy?.length, 1);
`), 30_000);

test('mixed recipients each get only their own requests and images', () => run('mixed', `
  post(group.id, 'me', '@Alpha START');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  // Beta's request goes to Beta alone: idle, so a turn of its own, with its image.
  const betaOnly = post(group.id, 'me', '@Beta BETA ONLY', { image: 'BBBB' });
  await until(() => of(beta.bot).length === 1 && minds.get(beta.bot.id).steerable);
  a.match(lineFor(of(beta.bot)[0].message, '@Beta BETA ONLY'), /\\[assigned request: answer this\\]/);
  a.deepEqual(of(beta.bot)[0].images, ['BBBB']);
  await settle();
  a.equal(steersOf(alpha.bot).length, 0);
  // A request for both, while both are busy in the group: each is steered it, with its image only.
  const both = post(group.id, 'me', '@Alpha @Beta BOTH', { image: 'CCCC' });
  await until(() => steersOf(alpha.bot).length === 1 && steersOf(beta.bot).length === 1 && steers.every(s => s.ok));
  for (const bot of [alpha.bot, beta.bot]) {
    const [steer] = steersOf(bot);
    a.ok(lineFor(steer.message, '@Alpha @Beta BOTH')?.includes('[new, for you]'), steer.message);
    a.deepEqual(steer.images, ['CCCC']);
    a.ok(!steer.message.includes('START'));
  }
  a.ok(!steersOf(alpha.bot)[0].message.includes('BETA ONLY'));
  // Another request for Beta never reaches Alpha's turn.
  post(group.id, 'me', '@Beta AGAIN', { image: 'DDDD' });
  await until(() => steersOf(beta.bot).length === 2 && steersOf(beta.bot)[1].ok);
  a.deepEqual(steersOf(beta.bot)[1].images, ['DDDD']);
  a.equal(steersOf(alpha.bot).length, 1);
  await until(() => db.getMessage(both.id).message.seenBy?.length === 2);
  a.deepEqual(db.getMessage(betaOnly.id).message.seenBy, [beta.bot.id]);
  of(alpha.bot)[0].finish('A');
  of(beta.bot)[0].finish('B');
  await until(() => !runner.busy(alpha.bot.id) && !runner.busy(beta.bot.id));
  await settle();
  a.equal(prompts.length, 2);
`), 30_000);

test('a request in another conversation waits for its own turn instead of steering', () => run('cross', `
  const other = svc.createConversation({ kind: 'group', name: 'Other', botIds: [alpha.bot.id, beta.bot.id] });
  post(group.id, 'me', '@Alpha START');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  post(other.id, 'me', '@Alpha ELSEWHERE', { image: 'EEEE' });
  post(alpha.conversationId, 'me', 'DIRECT');
  await settle();
  a.equal(steers.length, 0);
  a.deepEqual(svc.snapshot().status[alpha.bot.id].waiting?.sort(), [other.id, alpha.conversationId].sort());
  of(alpha.bot)[0].finish('DONE');
  await until(() => of(alpha.bot).length === 2 && minds.get(alpha.bot.id).steerable);
  const next = of(alpha.bot)[1];
  a.equal(next.focus, other.id);
  a.match(lineFor(next.message, '@Alpha ELSEWHERE'), /\\[assigned request: answer this\\]/);
  a.deepEqual(next.images, ['EEEE']);
  // Busy in the other group: a request back in the first one waits as well.
  post(group.id, 'me', '@Alpha BACK');
  await settle();
  a.equal(steers.length, 0);
  next.finish('DONE');
  await until(() => of(alpha.bot).length === 3 && minds.get(alpha.bot.id).steerable);
  of(alpha.bot)[2].finish('DONE');
  await until(() => of(alpha.bot).length === 4 && minds.get(alpha.bot.id).steerable);
  of(alpha.bot)[3].finish('DONE');
  await until(() => !runner.busy(alpha.bot.id));
  a.deepEqual(of(alpha.bot).map(p => p.focus), [group.id, other.id, alpha.conversationId, group.id]);
  a.match(lineFor(of(alpha.bot)[3].message, '@Alpha BACK'), /\\[assigned request: answer this\\]/);
`), 30_000);

test('a steer that fails queues its request, and those behind it, once each and in order', () => run('failed', `
  post(group.id, 'me', '@Alpha START');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  let reject;
  pi.steer = () => new Promise((_, no) => { reject = no; });
  const failed = post(group.id, 'me', '@Alpha FAILS', { image: 'FFFF' });
  await until(() => steers.length === 1 && reject);
  // Sent while the first is still on its way: it waits on it, and isn't sent once that one fails.
  const behind = post(group.id, 'me', '@Alpha BEHIND', { image: 'GGGG' });
  await settle();
  a.equal(steers.length, 1);
  reject(new Error('Pi is gone'));
  await settle();
  a.equal(steers.length, 1);
  // With requests still waiting, a later one queues behind them instead of jumping ahead.
  pi.steer = async () => ({});
  const later = post(group.id, 'me', '@Alpha LATER');
  await settle();
  a.equal(steers.length, 1);
  for (const m of [failed, behind, later]) a.ok(!db.getMessage(m.id).message.seenBy?.includes(alpha.bot.id));
  of(alpha.bot)[0].finish('DONE');
  await until(() => of(alpha.bot).length === 2 && minds.get(alpha.bot.id).steerable);
  of(alpha.bot)[1].finish('DONE');
  await until(() => !runner.busy(alpha.bot.id));
  await settle();
  a.equal(of(alpha.bot).length, 2);
  const retry = of(alpha.bot)[1];
  const lines = ['@Alpha FAILS', '@Alpha BEHIND', '@Alpha LATER'].map(t => lineFor(retry.message, t));
  for (const l of lines) a.match(l, /\\[assigned request: answer this\\]/);
  a.ok(retry.message.indexOf('FAILS') < retry.message.indexOf('BEHIND') && retry.message.indexOf('BEHIND') < retry.message.indexOf('LATER'));
  a.deepEqual(retry.images, ['FFFF', 'GGGG']);
  for (const m of [failed, behind, later]) a.deepEqual(db.getMessage(m.id).message.seenBy, [alpha.bot.id]);
`), 30_000);

test('a request steered into a model that fails before acting is answered in a turn of its own', () => run('retry', `
  svc.updateBot(alpha.bot.id, { model: 'one/primary', fallbackModels: ['two/fallback'] });
  a.deepEqual(runner.modelChain(alpha.bot.id), ['one/primary', 'two/fallback']);
  post(group.id, 'me', '@Alpha START');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  const steered = post(group.id, 'me', '@Alpha STEERED', { image: 'SSSS' });
  await until(() => steers.length === 1 && steers[0].ok);
  // The primary fails before doing anything: the fallback retries the turn, and the steered request
  // isn't in its prompt, so it gets a turn of its own afterwards. Pi still holds the unread steer,
  // which the fallback would read too: it's cleared first.
  a.equal(piQueue(alpha.bot).length, 1);
  of(alpha.bot)[0].fail('overloaded');
  await until(() => of(alpha.bot).length === 2 && minds.get(alpha.bot.id).steerable);
  a.deepEqual(of(alpha.bot)[1].drained, []);
  const alphaCommands = commands.filter(c => c.bot === alpha.bot.id).map(c => c.type);
  a.ok(alphaCommands.indexOf('clear_queue') > alphaCommands.indexOf('steer') && alphaCommands.indexOf('clear_queue') < alphaCommands.lastIndexOf('prompt'), alphaCommands.join());
  a.ok(!lineFor(of(alpha.bot)[1].message, '@Alpha STEERED')?.includes('answer this'));
  of(alpha.bot)[1].finish('DONE');
  await until(() => of(alpha.bot).length === 3 && minds.get(alpha.bot.id).steerable);
  a.match(lineFor(of(alpha.bot)[2].message, '@Alpha STEERED'), /\\[assigned request: answer this\\]/);
  a.deepEqual(of(alpha.bot)[2].images, ['SSSS']);
  of(alpha.bot)[2].finish('DONE');
  await until(() => !runner.busy(alpha.bot.id));
  await settle();
  a.equal(of(alpha.bot).length, 3);
  a.equal(steers.length, 1);
  a.deepEqual(db.getMessage(steered.id).message.seenBy, [alpha.bot.id]);
`), 30_000);

test('steering never moves the cursor past a bot message still waiting its turn', () => run('cursor', `
  post(group.id, 'me', '@Alpha START');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  const start = db.latestSeq(group.id);
  // A bot's mention is an unscoped wake: it queues, it is never steered.
  post(group.id, beta.bot.id, '@Alpha PING');
  post(group.id, 'me', '@Alpha STEERED');
  await until(() => steers.length === 1 && steers[0].ok);
  a.ok(!steers[0].message.includes('PING'));
  of(alpha.bot)[0].finish('DONE');
  await until(() => of(alpha.bot).length === 2 && minds.get(alpha.bot.id).steerable);
  a.equal(db.cursor(alpha.bot.id, group.id), start);
  const ping = lineFor(of(alpha.bot)[1].message, '@Alpha PING');
  a.ok(ping && !ping.includes('[already seen]'), of(alpha.bot)[1].message);
  of(alpha.bot)[1].finish('[silent]');
  await until(() => !runner.busy(alpha.bot.id));
  a.equal(steers.length, 1);
`), 30_000);

test('a steer an extension handled is done with, even when the model then fails over', () => run('handled', `
  svc.updateBot(alpha.bot.id, { model: 'one/primary', fallbackModels: ['two/fallback'] });
  post(group.id, 'me', '@Alpha START');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  pi.steer = async () => ({ disposition: 'handled' });
  const handled = post(group.id, 'me', '@Alpha /command');
  await until(() => steers.length === 1 && steers[0].ok);
  await until(() => db.getMessage(handled.id).message.seenBy?.includes(alpha.bot.id));
  of(alpha.bot)[0].fail('overloaded');
  await until(() => of(alpha.bot).length === 2 && minds.get(alpha.bot.id).steerable);
  of(alpha.bot)[1].finish('DONE');
  await until(() => !runner.busy(alpha.bot.id));
  await settle();
  a.equal(of(alpha.bot).length, 2);
  a.ok(!commands.some(c => c.type === 'clear_queue'));
`), 30_000);

// The model fails before acting while a group steer still hasn't been answered, with another behind it.
const boundary = (accepted: boolean) => `
  svc.updateBot(alpha.bot.id, { model: 'one/primary', fallbackModels: ['two/fallback'] });
  post(group.id, 'me', '@Alpha START');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  let answer;
  pi.steer = () => new Promise((ok, no) => { answer = (yes) => yes ? ok({ disposition: 'queued' }) : no(new Error('Pi didn\\'t answer "steer" in time')); });
  const pending = post(group.id, 'me', '@Alpha PENDING', { image: 'PPPP' });
  await until(() => steers.length === 1 && answer);
  const behind = post(group.id, 'me', '@Alpha BEHIND', { image: 'BBBB' });
  await settle();
  a.equal(steers.length, 1);
  of(alpha.bot)[0].fail('overloaded');
  await settle();
  // The fallback doesn't start until the steer is answered, and nothing joins the turn meanwhile.
  a.equal(of(alpha.bot).length, 1);
  const later = post(group.id, 'me', '@Alpha LATER');
  await settle();
  a.equal(steers.length, 1);
  answer(${accepted});
  await until(() => of(alpha.bot).length === 2 && minds.get(alpha.bot.id).steerable);
  const fallback = of(alpha.bot)[1];
  // Pi has nothing left for the fallback to read: it was cleared, or never queued.
  a.deepEqual(fallback.drained, []);
  const alphaCommands = commands.filter(c => c.bot === alpha.bot.id).map(c => c.type);
  a.equal(alphaCommands.includes('clear_queue'), ${accepted});
  if (${accepted}) a.ok(alphaCommands.indexOf('clear_queue') < alphaCommands.lastIndexOf('prompt'), alphaCommands.join());
  const assigned = (text) => of(alpha.bot).filter(p => lineFor(p.message, text)?.includes('[assigned request: answer this]'));
  for (const text of ['@Alpha PENDING', '@Alpha BEHIND', '@Alpha LATER']) a.equal(assigned(text).length, 0, text);
  fallback.finish('DONE');
  await until(() => of(alpha.bot).length === 3 && minds.get(alpha.bot.id).steerable);
  of(alpha.bot)[2].finish('DONE');
  await until(() => !runner.busy(alpha.bot.id));
  await settle();
  // Each request once, in a turn of its own after the fallback's, each image once.
  a.equal(of(alpha.bot).length, 3);
  a.equal(steers.length, 1);
  for (const text of ['@Alpha PENDING', '@Alpha BEHIND', '@Alpha LATER']) a.equal(assigned(text).length, 1, text);
  a.deepEqual(of(alpha.bot)[2].images.sort(), ['BBBB', 'PPPP']);
  a.deepEqual(of(alpha.bot)[2].drained, []);
  for (const m of [pending, behind, later]) a.deepEqual(db.getMessage(m.id).message.seenBy, [alpha.bot.id]);
`;

test('a fallback waits for a group steer Pi answers late, then answers it and those behind it once', () => run('boundary-ack', boundary(true)), 30_000);
test('a fallback waits for a group steer that times out, then answers it and those behind it once', () => run('boundary-timeout', boundary(false)), 30_000);
