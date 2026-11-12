import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import openbots from "../server/bots/extension";
import { DETACH_AFTER_MS, DETACH_WAITED_MS, DETACHABLE, RESULT_PAGE, RESULT_SUMMARY_HEAD, RESULT_SUMMARY_TAIL, RESULT_WHOLE_MAX, resultBody } from "../server/bots/jobs";
import { elsewhere, showWorking, stoppable } from "../src/lib/bots/activity";
import { unexpectedStderr } from "./botStderr";
import { spawnScript } from "./spawnScript";

// Each scenario runs the real service, runner and agent in a subprocess on its own data dir, with a
// stand-in Pi for each bot and stand-in tools: a tool call goes through agent.dispatch, as one from
// the bot's Pi does, and takes as long as the scenario says.
async function run(name: string, body: string) {
  const dir = await mkdtemp(join(tmpdir(), `openbuild-jobs-${name}-`));
  try {
    const { code, stderr: err } = await spawnScript(`
      import { strict as a } from 'node:assert';
      const minds = globalThis.openbotsMinds = new Map();
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const agent = await import('./server/bots/agent.ts');
      const jobs = await import('./server/bots/jobs.ts');
      const helpers = await import('./server/bots/helpers.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
      const { getFocus } = agent;
      const sessionPathFor = id => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', id, (globalThis.openbotsFocus?.get(id) ?? svc.directId(id))));
      svc.setHooks({ wake: runner.wake, stop: runner.stop, pendingAssignments: runner.pendingAssignments, unseen: runner.unseen, userWoke: runner.userWoke, halt: runner.halt, background: runner.background });
      jobs.setJobHooks({ waiting: runner.waitedOn, label: runner.toolLabel, changed: runner.jobsChanged });
      svc.updateSettings({ onboarding: 'done', user: { name: 'Sam' } });
      const prompts = [], steers = [], commands = [];
      const fake = (bot) => {
        const mind = { token: 't', loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', gates: {}, proc: { exited: false, lastUsed: Date.now(), ended: Promise.resolve(), close() { this.exited = true; }, async send(cmd) {
          if (mind.gates[cmd.type]) await mind.gates[cmd.type];
          commands.push({ bot: bot.id, type: cmd.type });
          if (cmd.type === 'clear_queue') return { steering: [], followUp: [] };
          if (cmd.type === 'steer') return (steers.push({ bot: bot.id, message: cmd.message }), { disposition: 'queued' });
          if (cmd.type === 'prompt') prompts.push({ bot: bot.id, focus: getFocus(bot.id), message: cmd.message, finish(text = '') { mind.draft = text; mind.onSettled?.(); } });
          return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
        } } };
        Object.defineProperty(mind, 'sessionPath', { get: () => sessionPathFor(bot.id) });
        minds.set(bot.id, mind);
        return mind;
      };
      // No helper session is ever needed here: one being started is a failure.
      const spawned = [];
      helpers.seams.spawn = (botId) => { spawned.push(botId); return { send: async () => ({}), on: () => () => {}, close() {} }; };
      // Stand-in tools, by name; everything else is the real thing.
      const real = agent.seams.handle;
      const standins = {};
      const tool = (name, impl) => { standins[name] = impl; };
      agent.seams.handle = (botId, method, p, signal) => standins[method] ? standins[method](p, signal, botId) : real(botId, method, p, signal);
      const call = (bot, method, p = {}) => agent.dispatch(bot.id, 'main', method, p);
      const gate = () => { let open; const p = new Promise((r) => (open = r)); return { p, open }; };
      const until = async (check) => { for (let i = 0; i < 600 && !check(); i++) await Bun.sleep(5); a.ok(check(), String(check)); };
      const settle = () => Bun.sleep(60);
      const post = (where, author, text) => svc.postMessage(where, { id: crypto.randomUUID(), author, text, at: Date.now() });
      const of = (bot) => prompts.filter(p => p.bot === bot.id);
      const steersOf = (bot) => steers.filter(s => s.bot === bot.id).map(s => s.message);
      const said = (id) => db.messages(id, 80).filter(r => !r.message.event).map(r => r.message.text);
      const events = (id) => db.messages(id, 80).flatMap(r => r.message.event ? [r.message.event.text] : []);
      const toolStart = (bot, name, args = {}) => runner.onRecord(bot.id, minds.get(bot.id), { type: 'tool_execution_start', toolName: name, args });
      const toolEnd = (bot, name, result = {}) => runner.onRecord(bot.id, minds.get(bot.id), { type: 'tool_execution_end', toolName: name, result });
      // The bot calls a tool, as Pi reports it and as its extension makes the call.
      const use = async (bot, name, args = {}) => {
        const { status, ...params } = args;
        toolStart(bot, name, args);
        try { return await call(bot, name, params); } finally { toolEnd(bot, name); }
      };
      const send = async (bot, text) => {
        const out = await agent.sendMessage(bot.id, { text });
        toolEnd(bot, 'send_message', { details: out });
        return out;
      };
      const turn = async (bot, n) => { await until(() => of(bot).length === n && minds.get(bot.id).steerable); return of(bot)[n - 1]; };
      const idle = (bot) => until(() => !runner.busy(bot.id));
      const alpha = svc.createBot({ name: 'Alpha', role: 'Builds things.' });
      const beta = svc.createBot({ name: 'Beta' });
      fake(alpha.bot); fake(beta.bot);
      const own = alpha.conversationId;
      const group = svc.createConversation({ kind: 'group', name: 'Team', botIds: [alpha.bot.id, beta.bot.id] });
      ${body}
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir });
    expect(unexpectedStderr(err)).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ the numbers, as decided

test("the thresholds and the result cap are the ones the measurements settled", () => {
  // docs/openbots-async-jobs.md has the tables these were read from; change both together.
  expect(DETACH_AFTER_MS).toBe(9000);
  expect(DETACH_WAITED_MS).toBe(3000);
  expect(RESULT_WHOLE_MAX).toBe(6000);
  expect([RESULT_SUMMARY_HEAD, RESULT_SUMMARY_TAIL, RESULT_PAGE]).toEqual([500, 1500, 20_000]);
});

// ------------------------------------------------------------------ 1. a call that runs long

test("a call still running at the threshold comes back as a job, the turn can end, and its result wakes the bot", () => run("detach", `
  jobs.tuning.detachAfterMs = 150;
  const build = gate();
  tool('bash', async () => { await build.p; return { exitCode: 0, output: 'built ok' }; });
  tool('read', async () => 'file text');
  post(own, 'me', 'run the build');
  await turn(alpha.bot, 1);
  // A quick call comes back with its result, as ever.
  a.equal(await use(alpha.bot, 'read', { path: 'notes.txt', status: 'Reading the notes' }), 'file text');
  a.deepEqual(jobs.jobsOf(alpha.bot.id), []);
  const began = Date.now();
  const started = await use(alpha.bot, 'bash', { command: 'make release', status: 'Building the release' });
  a.ok(Date.now() - began >= 140 && Date.now() - began < 2000, String(Date.now() - began));
  a.deepEqual([started.job, started.state], [1, 'running']);
  a.match(started.note, /carries on in the background as job 1/);
  a.match(started.note, /its result wakes you here/);
  a.match(started.note, /The jobs tool cancels it/);
  // Still its turn: the status is the turn's.
  a.equal(svc.getStatus(alpha.bot.id).jobs, undefined);
  of(alpha.bot)[0].finish('On it, back when the build is in.');
  await idle(alpha.bot);
  // Between turns it's free, and its status says what it's waiting on: the line it wrote for the call.
  const waiting = svc.getStatus(alpha.bot.id);
  a.deepEqual([waiting.state, waiting.activity, waiting.jobs, waiting.conversationId], ['working', 'Waiting on: Building the release', 1, own]);
  a.equal(of(alpha.bot).length, 1);
  build.open();
  const woke = await turn(alpha.bot, 2);
  a.equal(woke.focus, own);
  a.match(woke.message, /Job 1 finished after \\d+s: bash “make release”, which you started for “Building the release”\\./);
  a.match(woke.message, /Its result:\\n\\{\\n  "exitCode": 0,\\n  "output": "built ok"\\n\\}/);
  a.match(woke.message, /Sam hasn't written here since you started it, so the plan stands\\./);
  // It's off the board once it's in.
  a.ok(!woke.message.includes('Your job board'));
  woke.finish('Built.');
  await idle(alpha.bot);
  a.equal(svc.getStatus(alpha.bot.id), undefined);
  a.deepEqual(said(own), ['run the build', 'On it, back when the build is in.', 'Built.']);
  a.equal(spawned.length, 0);
`), 30_000);

test("a call that fails after it detached wakes the bot with the error", () => run("failed", `
  jobs.tuning.detachAfterMs = 80;
  const g = gate();
  tool('use_app', async () => { await g.p; throw new svc.BotsError('GitHub: rate limited'); });
  post(own, 'me', 'open the issue');
  await turn(alpha.bot, 1);
  const started = await use(alpha.bot, 'use_app', { app: 'github', tool: 'create_issue', status: 'Opening the issue' });
  a.equal(started.job, 1);
  of(alpha.bot)[0].finish('Opening it.');
  await idle(alpha.bot);
  g.open();
  const woke = await turn(alpha.bot, 2);
  a.match(woke.message, /Job 1 failed after \\d+s: use_app “github create_issue”, which you started for “Opening the issue”\\./);
  a.match(woke.message, /It failed:\\nError: GitHub: rate limited/);
  a.equal(jobs.jobsOf(alpha.bot.id)[0].state, 'failed');
  woke.finish('[silent]');
  await idle(alpha.bot);
`), 30_000);

// ------------------------------------------------------------------ 2. someone is waiting

test("a message that arrives while a call holds the turn frees it at the shorter threshold, with no helper", () => run("waited", `
  jobs.tuning.detachAfterMs = 60_000;
  jobs.tuning.detachWaitedMs = 200;
  const look = gate(), prices = gate(), file = gate();
  tool('bot_web_search', async () => { await look.p; return 'flights'; });
  tool('bash', async () => { await prices.p; return {}; });
  tool('read', async () => { await file.p; return 'x'; });
  post(own, 'me', 'look up flights');
  await turn(alpha.bot, 1);
  const mind = minds.get(alpha.bot.id);
  toolStart(alpha.bot, 'bot_web_search', { query: 'flights', status: 'Finding flights' });
  let done = false;
  const first = call(alpha.bot, 'bot_web_search', { query: 'flights' });
  first.then(() => (done = true));
  // Nobody is waiting: it holds the turn well past the shorter threshold.
  await Bun.sleep(450);
  a.equal(done, false);
  a.equal(runner.waitedOn(alpha.bot.id), undefined);
  post(own, 'me', 'oh and book a hotel after');
  // Already past it when they wrote: it's freed at once, and the message goes in with its result.
  const started = await first;
  a.equal(started.job, 1);
  a.match(started.note, /tell them in one short line what's running/);
  toolEnd(alpha.bot, 'bot_web_search');
  await until(() => steersOf(alpha.bot).some(m => m.includes('book a hotel')));
  a.equal(spawned.length, 0);
  // Pi hasn't handed that message to the model yet: the next call starts on the shorter threshold.
  a.equal(runner.waitedOn(alpha.bot.id), 'here');
  const began = Date.now();
  const second = await use(alpha.bot, 'bash', { command: 'prices', status: 'Checking prices' });
  a.equal(second.job, 2);
  a.ok(Date.now() - began >= 190 && Date.now() - began < 2000, String(Date.now() - began));
  // Pi hands it over (it announces the prompt's own message first, then each steer): nobody is waiting now.
  runner.onRecord(alpha.bot.id, mind, { type: 'message_start', message: { role: 'user' } });
  a.equal(runner.waitedOn(alpha.bot.id), 'here');
  runner.onRecord(alpha.bot.id, mind, { type: 'message_start', message: { role: 'user' } });
  a.equal(runner.waitedOn(alpha.bot.id), undefined);
  done = false;
  toolStart(alpha.bot, 'read', { path: 'big.log', status: 'Reading the log' });
  const third = call(alpha.bot, 'read', { path: 'big.log' });
  third.then(() => (done = true));
  await Bun.sleep(450);
  a.equal(done, false);
  // A message for it in another chat can't join this turn: the call is freed so the turn can end, and the bot is told why.
  post(group.id, 'me', '@Alpha are you around?');
  const moved = await third;
  a.equal(moved.job, 3);
  a.match(moved.note, /A message is waiting for you in another chat: end this turn now/);
  a.equal(spawned.length, 0);
  a.equal(jobs.runningJobs(alpha.bot.id).length, 3);
`), 30_000);

test("a call that returns before the shorter threshold isn't detached for a message, which goes in with its result", () => run("waited-quick", `
  jobs.tuning.detachAfterMs = 60_000;
  jobs.tuning.detachWaitedMs = 400;
  tool('bash', async () => { await Bun.sleep(150); return { exitCode: 0, output: 'ok' }; });
  post(own, 'me', 'check it');
  await turn(alpha.bot, 1);
  toolStart(alpha.bot, 'bash', { command: 'check', status: 'Checking it' });
  const pending = call(alpha.bot, 'bash', { command: 'check' });
  post(own, 'me', 'and the logs?');
  a.deepEqual(await pending, { exitCode: 0, output: 'ok' });
  a.deepEqual(jobs.jobsOf(alpha.bot.id), []);
  await until(() => steersOf(alpha.bot).some(m => m.includes('and the logs?')));
`), 30_000);

// ------------------------------------------------------------------ 3. never the bot's own voice

test("messaging, reactions and memory are never detached, however long they take", () => run("never", `
  jobs.tuning.detachAfterMs = 40;
  jobs.tuning.detachWaitedMs = 40;
  post(own, 'me', 'hello');
  await turn(alpha.bot, 1);
  const never = ['send_message', 'react', 'question', 'poll', 'vote_poll', 'html_render', 'memory', 'search', 'todo', 'routine', 'ask_bot', 'side_chat', 'manage_bot', 'apps', 'plugins', 'background', 'jobs'];
  for (const name of never) {
    a.ok(!jobs.DETACHABLE.has(name), name);
    tool(name, async () => { await Bun.sleep(160); return { real: name }; });
    a.deepEqual(await call(alpha.bot, name), { real: name });
  }
  a.deepEqual(jobs.jobsOf(alpha.bot.id), []);
  // A helper session and a friend's chat wait their calls out: only the bot's own session has a board.
  a.match(String(await agent.dispatch(alpha.bot.id, 'helper', 'jobs', {}).catch((e) => e.message)), /can only look things up/);
`), 30_000);

test("only work tools can detach", () => {
  expect([...DETACHABLE].sort()).toEqual(["bash", "bot_web_search", "browser", "edit", "openbuild", "process", "read", "use_app", "write"]);
});

// ------------------------------------------------------------------ 4. the board

test("the board rides with the prompt, takes follow-ups, and a late result is read against what changed", () => run("board", `
  jobs.tuning.detachAfterMs = 80;
  const look = gate();
  tool('bot_web_search', async () => { await look.p; return 'Flights: LIS 120 EUR'; });
  post(own, 'me', 'look up flights to Lisbon');
  const first = await turn(alpha.bot, 1);
  // Nothing running: nothing about jobs in the prompt.
  a.ok(!first.message.includes('job board'));
  await use(alpha.bot, 'bot_web_search', { query: 'flights to Lisbon', status: 'Finding flights to Lisbon' });
  first.finish('Looking, one moment.');
  await idle(alpha.bot);
  // The user adds something while it's out. The bot is free: a turn starts at once, with the board in its prompt.
  const extra = post(own, 'me', 'oh and book a hotel after');
  const second = await turn(alpha.bot, 2);
  a.match(second.message, /Your job board: what you have running in the background\\./);
  a.match(second.message, /- job 1, running for \\d+s: bot_web_search “flights to Lisbon”, for “Finding flights to Lisbon”/);
  a.match(second.message, /oh and book a hotel after/);
  // It notes the follow-up on the board and tells them.
  const queued = await use(alpha.bot, 'jobs', { action: 'follow_up', text: 'Book a hotel in Lisbon for the same dates' });
  a.deepEqual(queued.follow_ups, ['Book a hotel in Lisbon for the same dates']);
  a.match(jobs.board(alpha.bot.id, own), /for “Finding flights to Lisbon”\\n  then 1\\. Book a hotel in Lisbon for the same dates/);
  // Read from another chat, a job says where it was started.
  a.match(jobs.board(alpha.bot.id, group.id), new RegExp(', started in conversation ' + own.slice(0, 8)));
  a.match(await use(alpha.bot, 'jobs', { action: 'list' }), /Running:\\n- job 1, running for \\d+s[^\\n]*\\n  then 1\\. Book a hotel/);
  await send(alpha.bot, 'Got it, hotel right after the flights.');
  second.finish('');
  await idle(alpha.bot);
  a.equal(svc.getStatus(alpha.bot.id).activity, 'Waiting on: Finding flights to Lisbon');
  look.open();
  const third = await turn(alpha.bot, 3);
  a.match(third.message, /Job 1 finished after/);
  a.match(third.message, /Its result:\\nFlights: LIS 120 EUR/);
  // What was said since it started, and what was queued behind it: the result is read against both.
  a.ok(third.message.includes('Sam wrote a message here after you started it ([' + extra.id.slice(0, 8) + ']). If that changed the plan and this no longer matters, drop it'), third.message);
  a.match(third.message, /Queued behind it, to do now and in this order unless the plan changed:\\n1\\. Book a hotel in Lisbon for the same dates/);
  a.ok(!third.message.includes('Your job board'));
  third.finish('Flights from 120 EUR. Booking the hotel now.');
  await idle(alpha.bot);
  a.deepEqual(said(own).slice(-2), ['Got it, hotel right after the flights.', 'Flights from 120 EUR. Booking the hotel now.']);
  // A follow-up can be dropped again, and there's nothing to queue behind a job that's in.
  a.match(String(await call(alpha.bot, 'jobs', { action: 'follow_up', job: '1', text: 'x' }).catch((e) => e.message)), /already ended/);
`), 30_000);

test("follow-ups are numbered, removable and capped; a job is picked by number", () => run("follow-ups", `
  jobs.tuning.detachAfterMs = 60;
  const one = gate(), two = gate();
  tool('bash', async (p) => { await (p.command === 'one' ? one.p : two.p); return 'done ' + p.command; });
  post(own, 'me', 'both please');
  await turn(alpha.bot, 1);
  a.equal((await use(alpha.bot, 'bash', { command: 'one', status: 'Running one' })).job, 1);
  const second = await use(alpha.bot, 'bash', { command: 'two', status: 'Running two' });
  a.equal(second.job, 2);
  a.match(second.note, /You have 1 other job running\\./);
  // Two running: it has to say which.
  a.match(String(await call(alpha.bot, 'jobs', { action: 'follow_up', text: 'x' }).catch((e) => e.message)), /Say which job: 1, 2/);
  await call(alpha.bot, 'jobs', { action: 'follow_up', job: '2', text: 'Tell Sam the count' });
  await call(alpha.bot, 'jobs', { action: 'follow_up', job: 'job 2', text: 'Archive the log' });
  a.deepEqual((await call(alpha.bot, 'jobs', { action: 'follow_up', job: 2, remove: 1 })).follow_ups, ['Archive the log']);
  a.match(String(await call(alpha.bot, 'jobs', { action: 'follow_up', job: '2', remove: 5 }).catch((e) => e.message)), /no follow-up 5/);
  a.match(String(await call(alpha.bot, 'jobs', { action: 'result', job: '9' }).catch((e) => e.message)), /There's no job 9/);
  a.match((await call(alpha.bot, 'jobs', { action: 'result', job: '1' })).note, /Still running after/);
  // Both show on the status once the turn ends.
  of(alpha.bot)[0].finish('Both running.');
  await idle(alpha.bot);
  a.deepEqual([svc.getStatus(alpha.bot.id).activity, svc.getStatus(alpha.bot.id).jobs], ['Waiting on: Running one (+1 more)', 2]);
  two.open();
  const woke = await turn(alpha.bot, 2);
  a.match(woke.message, /Job 2 finished/);
  a.match(woke.message, /1\\. Archive the log/);
  // The other one is still on the board.
  a.match(woke.message, /Your job board[^]*- job 1, running for/);
  woke.finish('[silent]');
  await idle(alpha.bot);
  a.equal(svc.getStatus(alpha.bot.id).activity, 'Waiting on: Running one');
`), 30_000);

// ------------------------------------------------------------------ 5. the shape of a result

test("a short result is handed over whole; a long one as its two ends, with the rest one call away", () => {
  const exact = "x".repeat(RESULT_WHOLE_MAX);
  expect(resultBody({ id: 7 }, exact)).toBe(`Its result:\n${exact}`);
  expect(resultBody({ id: 7 }, "")).toBe("Its result:\n(no output)");
  const long = `${"HEAD".repeat(200)}${"middle\n".repeat(3000)}${"TAIL".repeat(500)}`;
  const body = resultBody({ id: 7 }, long);
  expect(body.length).toBeLessThan(RESULT_SUMMARY_HEAD + RESULT_SUMMARY_TAIL + 400);
  expect(body).toContain(long.slice(0, RESULT_SUMMARY_HEAD));
  expect(body.endsWith(long.slice(-RESULT_SUMMARY_TAIL))).toBe(true);
  expect(body).toContain(`Its result is ${long.length.toLocaleString("en-US")} characters over 3,001 lines`);
  expect(body).toContain("The whole of it is one call away: jobs with action result and job 7");
  expect(body).toContain(`[… ${(long.length - RESULT_SUMMARY_HEAD - RESULT_SUMMARY_TAIL).toLocaleString("en-US")} characters left out …]`);
});

test("a long result wakes the bot with a summary, and jobs result pages through all of it", () => run("shape", `
  jobs.tuning.detachAfterMs = 60;
  const g = gate();
  const output = 'START' + 'log line\\n'.repeat(2400) + 'FAILED: 3 tests';
  tool('bash', async () => { await g.p; return { exitCode: 1, output }; });
  post(own, 'me', 'run the tests');
  await turn(alpha.bot, 1);
  await use(alpha.bot, 'bash', { command: 'bun test', status: 'Running the tests' });
  of(alpha.bot)[0].finish('Running them.');
  await idle(alpha.bot);
  g.open();
  const woke = await turn(alpha.bot, 2);
  const whole = JSON.stringify({ exitCode: 1, output }, null, 2);
  a.ok(whole.length > 20000 && whole.length < 40000);
  a.ok(!woke.message.includes(whole));
  a.ok(woke.message.length < 4000, String(woke.message.length));
  a.ok(woke.message.includes(whole.slice(0, 500)) && woke.message.includes(whole.slice(-1500)));
  a.match(woke.message, /The whole of it is one call away: jobs with action result and job 1/);
  // One call returns a page; the next the rest.
  const page = await use(alpha.bot, 'jobs', { action: 'result', job: '1' });
  a.deepEqual([page.state, page.chars, page.offset, page.text.length], ['done', whole.length, 0, 20000]);
  a.match(page.more, /pass offset 20000/);
  const rest = await call(alpha.bot, 'jobs', { action: 'result', job: '1', offset: 20000 });
  a.equal(rest.more, undefined);
  a.equal(page.text + rest.text, whole);
  a.equal((await call(alpha.bot, 'jobs', { action: 'result', job: '1', offset: 10, limit: 5 })).text, whole.slice(10, 15));
  woke.finish('3 tests failed.');
  await idle(alpha.bot);
  a.match(await call(alpha.bot, 'jobs', { action: 'list' }), /Nothing is running\\.\\nLatest finished[^]*- job 1, finished after \\d+s: bash “bun test”, for “Running the tests” \\(2[0-9],[0-9]{3} characters\\)/);
`), 30_000);

// ------------------------------------------------------------------ 6. cancelling

test("a job can be cancelled: by the bot, and by the user's stop, and neither reports back", () => run("cancel", `
  jobs.tuning.detachAfterMs = 60;
  let aborted = 0;
  const hang = (p, signal) => new Promise((_, no) => signal.addEventListener('abort', () => { aborted++; no(new Error('aborted')); }));
  tool('bash', hang);
  const page = gate();
  tool('browser', async () => { await page.p; return { title: 'Loaded' }; });
  post(own, 'me', 'deploy it');
  await turn(alpha.bot, 1);
  await use(alpha.bot, 'bash', { command: 'deploy', status: 'Deploying' });
  await call(alpha.bot, 'jobs', { action: 'follow_up', text: 'Post the link' });
  await use(alpha.bot, 'browser', { action: 'open', url: 'https://example.test', status: 'Opening the dashboard' });
  // The bot cancels the one that's no longer wanted: a command is stopped for real.
  const out = await use(alpha.bot, 'jobs', { action: 'cancel', job: '1' });
  a.equal(out.state, 'cancelled');
  a.match(out.note, /Cancelled: it was stopped, and won't report back\\. What was queued behind it is dropped too: Post the link\\./);
  await until(() => aborted === 1);
  // One that can't be interrupted is dropped, and the bot is told it may still go through.
  a.match((await call(alpha.bot, 'jobs', { action: 'cancel', job: '2' })).note, /won't report back\\. What it was doing may still go through/);
  a.match((await call(alpha.bot, 'jobs', { action: 'cancel', job: '2' })).note, /already ended/);
  a.equal((await call(alpha.bot, 'jobs', { action: 'result', job: '1' })).note, 'It was cancelled, so it has no result.');
  of(alpha.bot)[0].finish('Cancelled both.');
  await idle(alpha.bot);
  a.equal(svc.getStatus(alpha.bot.id), undefined);
  page.open();
  await settle();
  // Neither wakes it.
  a.equal(of(alpha.bot).length, 1);
  a.deepEqual(jobs.jobsOf(alpha.bot.id).map((j) => j.state), ['cancelled', 'cancelled']);

  // The user's stop, between turns: the jobs are cancelled, and the chat says the bot stopped.
  post(own, 'me', 'deploy again');
  await turn(alpha.bot, 2);
  await use(alpha.bot, 'bash', { command: 'deploy', status: 'Deploying again' });
  of(alpha.bot)[1].finish('Deploying.');
  await idle(alpha.bot);
  a.equal(svc.getStatus(alpha.bot.id).jobs, 1);
  post(own, 'me', 'stop');
  await until(() => aborted === 2);
  a.equal(svc.getStatus(alpha.bot.id), undefined);
  a.deepEqual(events(own), ['Alpha stopped']);
  await settle();
  a.equal(of(alpha.bot).length, 2);
  a.equal(jobs.runningJobs(alpha.bot.id).length, 0);

  // And a call still holding its turn is stopped with the turn.
  jobs.tuning.detachAfterMs = 60_000;
  post(own, 'me', 'once more');
  await turn(alpha.bot, 3);
  toolStart(alpha.bot, 'bash', { command: 'deploy', status: 'Deploying once more' });
  const held = call(alpha.bot, 'bash', { command: 'deploy' }).catch((e) => e.message);
  post(own, 'me', 'never mind');
  a.equal(await held, 'aborted');
  a.equal(aborted, 3);
  await idle(alpha.bot);
  a.equal(jobs.jobsOf(alpha.bot.id).length, 3);
  // One that can't be interrupted runs to its end, and doesn't come back as a job after the stop.
  jobs.tuning.detachAfterMs = 150;
  const slow = gate();
  tool('browser', async () => { await slow.p; return { title: 'Loaded' }; });
  post(own, 'me', 'open it');
  await turn(alpha.bot, 4);
  toolStart(alpha.bot, 'browser', { action: 'open', status: 'Opening it' });
  const opening = call(alpha.bot, 'browser', { action: 'open', url: 'https://example.test' });
  post(own, 'me', 'stop');
  await idle(alpha.bot);
  await Bun.sleep(300);
  a.equal(jobs.jobsOf(alpha.bot.id).length, 3);
  slow.open();
  a.deepEqual(await opening, { title: 'Loaded' });
  await settle();
  a.equal(of(alpha.bot).length, 4);
  // jobs cancel all, with nothing running.
  a.equal((await call(alpha.bot, 'jobs', { action: 'cancel', job: 'all' })).note, 'Nothing was running.');
`), 30_000);

// ------------------------------------------------------------------ 7. nothing worth saying

test("a result that leaves nothing worth saying ends silently; one with news is told", () => run("silent", `
  jobs.tuning.detachAfterMs = 60;
  const g = [gate(), gate(), gate()];
  let n = 0;
  tool('bash', async () => { const mine = g[n++]; await mine.p; return { exitCode: 0, output: 'ok' }; });
  post(own, 'me', 'keep an eye on the deploy');
  await turn(alpha.bot, 1);
  for (let i = 0; i < 3; i++) await use(alpha.bot, 'bash', { command: 'check ' + i, status: 'Checking the deploy' });
  of(alpha.bot)[0].finish('Watching it.');
  await idle(alpha.bot);
  // Plain text that only says there's nothing: not posted.
  g[0].open();
  (await turn(alpha.bot, 2)).finish('Nothing new. [silent]');
  await idle(alpha.bot);
  a.deepEqual(said(own), ['keep an eye on the deploy', 'Watching it.']);
  // Nor through send_message.
  g[1].open();
  const quiet = await turn(alpha.bot, 3);
  a.match(quiet.message, /If there's nothing in it the user needs to hear, end with \\[silent\\]\\./);
  const held = await agent.sendMessage(alpha.bot.id, { text: 'No updates.' });
  a.deepEqual([held.sent, held.note], [false, agent.QUIET]);
  quiet.finish('[silent]');
  await idle(alpha.bot);
  a.deepEqual(said(own), ['keep an eye on the deploy', 'Watching it.']);
  // News is said.
  g[2].open();
  (await turn(alpha.bot, 4)).finish('The deploy is live.');
  await idle(alpha.bot);
  a.deepEqual(said(own), ['keep an eye on the deploy', 'Watching it.', 'The deploy is live.']);
  a.equal(svc.getStatus(alpha.bot.id), undefined);
`), 30_000);

// ------------------------------------------------------------------ 8. where a job acts and reports

test("a job acts in the chat it was started from and reports there, whatever the bot has moved on to", () => run("origin", `
  jobs.tuning.detachAfterMs = 60;
  const g = gate();
  let seen;
  tool('openbuild', async (p, signal, botId) => { await g.p; await Bun.sleep(5); seen = agent.getFocus(botId); return { merged: true }; });
  const asked = post(group.id, 'me', '@Alpha merge the fix');
  await turn(alpha.bot, 1);
  a.equal(of(alpha.bot)[0].focus, group.id);
  await use(alpha.bot, 'openbuild', { action: 'merge', project: 'app', number: 12, status: 'Merging the fix' });
  a.deepEqual(jobs.jobsOf(alpha.bot.id)[0].request, [asked.id]);
  a.equal(jobs.jobsOf(alpha.bot.id)[0].detail, 'merge app #12');
  of(alpha.bot)[0].finish('Merging.');
  await idle(alpha.bot);
  a.equal(svc.getStatus(alpha.bot.id).conversationId, group.id);
  // It's free: its own chat gets a turn at once, and that turn's prompt says the job is from elsewhere.
  post(own, 'me', 'hi');
  const second = await turn(alpha.bot, 2);
  a.equal(second.focus, own);
  a.match(second.message, new RegExp('for “Merging the fix”, started in conversation ' + group.id.slice(0, 8)));
  g.open();
  await until(() => seen);
  // The call's own work saw the group, though the bot's turn is now in its own chat.
  a.equal(seen, group.id);
  a.equal(agent.getFocus(alpha.bot.id), own);
  second.finish('hello');
  const third = await turn(alpha.bot, 3);
  a.equal(third.focus, group.id);
  a.match(third.message, /Job 1 finished after/);
  a.match(third.message, /@Alpha merge the fix/);
  third.finish('Merged.');
  await idle(alpha.bot);
  a.equal(said(group.id).at(-1), 'Merged.');
`), 30_000);

test("the browser takes one call at a time on a machine: a second waits for the job ahead of it", () => run("browser", `
  jobs.tuning.detachAfterMs = 60;
  const order = [];
  const open = gate();
  tool('browser', async (p) => { order.push('start ' + p.action); if (p.action === 'open') await open.p; order.push('end ' + p.action); return { ok: p.action }; });
  post(own, 'me', 'open the page');
  await turn(alpha.bot, 1);
  a.equal((await use(alpha.bot, 'browser', { action: 'open', url: 'https://example.test', status: 'Opening the page' })).job, 1);
  const next = await use(alpha.bot, 'browser', { action: 'snapshot', status: 'Reading the page' });
  a.equal(next.job, 2);
  a.deepEqual(order, ['start open']);
  // Another machine's browser isn't held up.
  a.deepEqual(await call(alpha.bot, 'browser', { action: 'tabs', machine: 'laptop' }), { ok: 'tabs' });
  open.open();
  await until(() => order.length === 6);
  a.deepEqual(order.filter((o) => !o.includes('tabs')), ['start open', 'end open', 'start snapshot', 'end snapshot']);
`), 30_000);

test("with four jobs out a further call holds its turn, and a job that never returns is given up on", () => run("limits", `
  jobs.tuning.detachAfterMs = 40;
  a.equal(jobs.JOB_CAP, 4);
  a.equal(jobs.JOB_MAX_MS, 30 * 60_000);
  const gates = [];
  let aborted = 0;
  tool('bash', (p, signal) => new Promise((yes, no) => { const g = gate(); gates.push(g); g.p.then(() => yes('done ' + p.command)); signal.addEventListener('abort', () => { aborted++; no(new Error('aborted')); }); }));
  post(own, 'me', 'run them all');
  await turn(alpha.bot, 1);
  for (let i = 1; i <= 4; i++) a.equal((await use(alpha.bot, 'bash', { command: 'c' + i, status: 'Running c' + i })).job, i);
  // The fifth is waited out like any call used to be.
  let done = false;
  toolStart(alpha.bot, 'bash', { command: 'c5', status: 'Running c5' });
  const fifth = call(alpha.bot, 'bash', { command: 'c5' });
  fifth.then(() => (done = true));
  await Bun.sleep(250);
  a.equal(done, false);
  gates[4].open();
  a.equal(await fifth, 'done c5');
  toolEnd(alpha.bot, 'bash');
  a.equal(jobs.runningJobs(alpha.bot.id).length, 4);
  of(alpha.bot)[0].finish('All running.');
  await idle(alpha.bot);
  a.equal((await call(alpha.bot, 'jobs', { action: 'cancel', job: 'all' })).cancelled, 4);
  await until(() => aborted === 4);
  a.equal(svc.getStatus(alpha.bot.id), undefined);

  // One that never comes back: past the limit the bot is told so, and the command is stopped.
  jobs.tuning.maxMs = 200;
  post(own, 'me', 'one more');
  const next = await turn(alpha.bot, 2);
  a.equal((await use(alpha.bot, 'bash', { command: 'stuck', status: 'Waiting on a lock' })).job, 5);
  next.finish('Started it.');
  const told = await turn(alpha.bot, 3);
  a.match(told.message, /Job 5 failed after \\d+s: bash “stuck”, which you started for “Waiting on a lock”\\./);
  a.match(told.message, /It failed:\\nError: It hadn't returned after 1s, so it was given up on and stopped\\./);
  a.equal(aborted, 5);
  a.equal(jobs.jobsOf(alpha.bot.id).find((j) => j.id === 5).state, 'failed');
  told.finish('[silent]');
  await idle(alpha.bot);
  a.equal(svc.getStatus(alpha.bot.id), undefined);
`), 30_000);

// ------------------------------------------------------------------ 9. a restart

test("a job the server lost to a restart is reported once, with what was queued behind it", () => run("restart", `
  db.setValue('jobs:' + alpha.bot.id, { next: 5, jobs: [
    { id: 3, tool: 'bash', label: 'Earlier', conversationId: own, startedAt: Date.now() - 90000, seq: 0, state: 'done', endedAt: Date.now() - 80000, told: true, followUps: [] },
    { id: 4, tool: 'bash', label: 'Running the migration', detail: 'bun migrate', conversationId: own, startedAt: Date.now() - 60000, seq: 0, state: 'running', followUps: ['Tell Sam the row count'] },
  ] });
  jobs.recover();
  const woke = await turn(alpha.bot, 1);
  a.match(woke.message, /Job 4 \\(bash “bun migrate”, for “Running the migration”\\) was cut off when OpenBuild restarted, so it has no result\\. You had queued behind it: Tell Sam the row count\\./);
  a.ok(!woke.message.includes('Your job board'));
  a.deepEqual(jobs.jobsOf(alpha.bot.id).map((j) => j.state), ['done', 'lost']);
  woke.finish('[silent]');
  await idle(alpha.bot);
  a.equal(svc.getStatus(alpha.bot.id), undefined);
  a.equal((await call(alpha.bot, 'jobs', { action: 'result', job: '4' })).note, 'It was cut off by a restart, so it has no result.');
  // Once is enough.
  jobs.recover();
  await settle();
  a.equal(of(alpha.bot).length, 1);
  // The next job carries on from the stored count.
  jobs.tuning.detachAfterMs = 40;
  const g = gate();
  tool('bash', async () => { await g.p; return 'ok'; });
  post(own, 'me', 'again');
  await turn(alpha.bot, 2);
  a.equal((await use(alpha.bot, 'bash', { command: 'bun migrate', status: 'Running it again' })).job, 5);
`), 30_000);

test("deleting a bot takes its board and its results with it", () => run("forget", `
  jobs.tuning.detachAfterMs = 40;
  const g = gate();
  let aborted = false;
  tool('bash', (p, signal) => new Promise((yes, no) => { signal.addEventListener('abort', () => { aborted = true; no(new Error('aborted')); }); g.p.then(() => yes('ok')); }));
  post(beta.conversationId, 'me', 'run it');
  await turn(beta.bot, 1);
  await use(beta.bot, 'bash', { command: 'long', status: 'Running it' });
  of(beta.bot)[0].finish('Running.');
  await idle(beta.bot);
  await svc.deleteBot(beta.bot.id);
  a.equal(aborted, true);
  a.deepEqual(jobs.jobsOf(beta.bot.id), []);
  g.open();
  await settle();
  a.equal(of(beta.bot).length, 1);
`), 30_000);

// ------------------------------------------------------------------ 10. steering between steps

test("a message that arrives while a turn is still setting Pi up joins that turn, right behind its prompt", () => run("held", `
  const g = gate();
  const mind = minds.get(alpha.bot.id);
  mind.gates.get_state = g.p;
  post(own, 'me', 'first thing');
  await until(() => mind.starting);
  // The transcript is read and the prompt isn't sent: it used to queue for a turn of its own.
  post(own, 'me', 'second thought');
  await settle();
  a.equal(steersOf(alpha.bot).length, 0);
  a.equal(of(alpha.bot).length, 0);
  mind.gates.get_state = undefined;
  g.open();
  await until(() => of(alpha.bot).length === 1 && steersOf(alpha.bot).length === 1);
  a.ok(of(alpha.bot)[0].message.includes('first thing') && !of(alpha.bot)[0].message.includes('second thought'));
  a.ok(steersOf(alpha.bot)[0].includes('second thought'));
  const mine = commands.filter((c) => c.bot === alpha.bot.id).map((c) => c.type);
  a.ok(mine.indexOf('prompt') < mine.indexOf('steer'), mine.join());
  of(alpha.bot)[0].finish('Both done.');
  await idle(alpha.bot);
  await settle();
  // One turn for both.
  a.equal(of(alpha.bot).length, 1);
  a.deepEqual(said(own), ['first thing', 'second thought', 'Both done.']);
`), 30_000);

test("a held message isn't lost when its turn never reaches a prompt, and a stop drops it", () => run("held-fail", `
  const mind = minds.get(alpha.bot.id);
  const g = gate();
  mind.gates.get_state = g.p.then(() => { throw new Error('boom'); });
  post(own, 'me', 'first thing');
  await until(() => mind.starting);
  post(own, 'me', 'second thought');
  mind.gates.get_state = undefined;
  g.open();
  // The first turn failed before prompting: the held message gets a turn of its own.
  const next = await turn(alpha.bot, 1);
  a.ok(next.message.includes('second thought'));
  a.deepEqual(events(own), ["Couldn't reply"]);
  next.finish('ok');
  await idle(alpha.bot);

  // A stop takes what a starting turn was holding with it: it stays unread, and starts nothing.
  const again = gate();
  mind.gates.get_state = again.p;
  post(own, 'me', 'third thing');
  await until(() => mind.starting);
  post(own, 'me', 'and a fourth');
  a.equal(mind.held.length, 1);
  post(own, 'me', 'stop');
  mind.gates.get_state = undefined;
  again.open();
  await idle(alpha.bot);
  await settle();
  a.equal(of(alpha.bot).length, 1);
  a.deepEqual(events(own), ["Couldn't reply", 'Alpha stopped']);
`), 30_000);

// ------------------------------------------------------------------ the app and the extension

test("a bot that's only waiting on jobs shows what it's waiting on where they started, and isn't busy elsewhere", () => {
  const waiting = { b: { state: "working" as const, activity: "Waiting on: Building the release", conversationId: "c1", jobs: 1 } };
  const working = { b: { state: "working" as const, activity: "Building the release", conversationId: "c1" } };
  const there = { id: "c1", botIds: ["b"], kind: "group" as const };
  const other = { id: "c2", botIds: ["b"], kind: "group" as const };
  expect(showWorking("c1", waiting, [])).toEqual(["b"]);
  expect(elsewhere(other, working)).toEqual([{ botId: "b", conversationId: "c1" }]);
  expect(elsewhere(other, waiting)).toEqual([]);
  // The stop button still reaches it where its jobs are, and anywhere in its own chat.
  expect(stoppable(there, waiting)).toEqual(["b"]);
  expect(stoppable({ id: "own", botIds: ["b"], kind: "direct" }, waiting)).toEqual(["b"]);
});

function fakePi() {
  const registered: any[] = [];
  const handlers: Record<string, Function[]> = {};
  let active: string[] = [];
  openbots({
    on(name: string, h: Function) { (handlers[name] ??= []).push(h); },
    registerTool(t: any) { registered.push(t); if (t.defaultActive !== false) active.push(t.name); },
    getAllTools: () => registered,
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) { active = [...new Set(names)]; },
  });
  const emit = (name: string, event: any) => (handlers[name] ?? []).map((h) => h(event)).find((out) => out !== undefined);
  return { emit, active: () => active, tool: (name: string) => registered.find((t) => t.name === name) };
}

test("the jobs tool is declared once a call becomes a job, and an app's call hands its job number over", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-jobs-ext-"));
  const socket = join(dir, "agent.sock");
  const started = { job: 3, state: "running", note: "Still running after 9s, so it carries on in the background as job 3." };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.end(JSON.stringify({ result: started })));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const before = process.env.OPENBOTS_SOCKET;
  process.env.OPENBOTS_SOCKET = socket;
  try {
    const pi = fakePi();
    expect(pi.tool("jobs").parameters.required).toEqual(["action"]);
    expect(pi.tool("jobs").parameters.properties.status).toBeUndefined();
    expect(pi.active()).not.toContain("jobs");
    // An ordinary result declares nothing.
    pi.emit("message_end", { message: { role: "toolResult", toolName: "bash", isError: false, details: { exitCode: 0, output: "ok" } } });
    expect(pi.active()).not.toContain("jobs");
    const out = await pi.tool("use_app").execute("call", { app: "github", tool: "list_issues", status: "Listing issues" });
    expect(out.details).toEqual(started);
    expect(out.content[0].text).toContain('"job": 3');
    expect(out.content[0].text).not.toContain("(no output)");
    pi.emit("message_end", { message: { role: "toolResult", toolName: "use_app", isError: false, details: out.details } });
    expect(pi.active()).toContain("jobs");
    expect(pi.tool("bash").description).toMatch(/carries on as a background job/);
  } finally {
    if (before === undefined) delete process.env.OPENBOTS_SOCKET; else process.env.OPENBOTS_SOCKET = before;
    server.closeAllConnections();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
