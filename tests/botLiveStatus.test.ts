// The status a bot's turn sends to the app, end to end: the real service and runner in a subprocess
// on their own data dir, with a stand-in Pi whose records the test feeds one at a time. Every check
// reads the status straight after the record that should have changed it, with no wait in between:
// the status moves in the same tick as the step.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unexpectedStderr } from "./botStderr";
import { spawnScript } from "./spawnScript";

async function run(name: string, body: string) {
  const dir = await mkdtemp(join(tmpdir(), `openbuild-live-status-${name}-`));
  try {
    const { code, stderr: err } = await spawnScript(`
      import { strict as a } from 'node:assert';
      const minds = globalThis.openbotsMinds = new Map();
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const agent = await import('./server/bots/agent.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
      const { WORKING_PHRASES } = await import('./shared/bots.ts');
      const sessionPathFor = id => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', id, (globalThis.openbotsFocus?.get(id) ?? svc.directId(id))));
      svc.setHooks({ wake: runner.wake, stop: runner.stop, pendingAssignments: runner.pendingAssignments, unseen: runner.unseen, userWoke: runner.userWoke, halt: runner.halt, background: runner.background });
      svc.updateSettings({ onboarding: 'done' });
      const prompts = [];
      const fake = (bot) => {
        const mind = { token: 't', loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), ended: Promise.resolve(), close() { this.exited = true; }, async send(cmd) {
          if (cmd.type === 'clear_queue') return { steering: [], followUp: [] };
          if (cmd.type === 'steer') return { disposition: 'queued' };
          if (cmd.type === 'prompt') prompts.push({ bot: bot.id, finish() { runner.onRecord(bot.id, mind, { type: 'agent_settled' }); } });
          return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
        } } };
        Object.defineProperty(mind, 'sessionPath', { get: () => sessionPathFor(bot.id) });
        minds.set(bot.id, mind);
        return mind;
      };
      const until = async (check) => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); a.ok(check(), String(check)); };
      const post = (where, author, text) => svc.postMessage(where, { id: crypto.randomUUID(), author, text, at: Date.now() });
      const alpha = svc.createBot({ name: 'Alpha' });
      const beta = svc.createBot({ name: 'Beta' });
      const mind = fake(alpha.bot); fake(beta.bot);
      const own = alpha.conversationId;
      const group = svc.createConversation({ kind: 'group', name: 'Team', botIds: [alpha.bot.id, beta.bot.id] });
      // Every status the app is sent for Alpha, in order, and whether it's typing.
      const sent = [];
      svc.subscribe((e) => { if (e.t === 'status' && e.botId === alpha.bot.id) sent.push(e.status); });
      const status = () => svc.getStatus(alpha.bot.id);
      const line = () => status()?.activity;
      const typing = (where = own) => (svc.snapshot().typing[where] ?? []).includes(alpha.bot.id);
      const plain = (text) => WORKING_PHRASES.includes(text);
      const feed = (record) => runner.onRecord(alpha.bot.id, mind, record);
      const update = (event) => feed({ type: 'message_update', assistantMessageEvent: event });
      const start = (toolName, toolCallId, args = {}) => feed({ type: 'tool_execution_start', toolName, toolCallId, args });
      const end = (toolName, toolCallId, result = {}) => feed({ type: 'tool_execution_end', toolName, toolCallId, result });
      const turn = async (where = own, text = 'do the thing') => { const before = prompts.length; post(where, 'me', text); await until(() => prompts.length > before && mind.steerable); return prompts.at(-1); };
      const over = async (prompt) => { prompt.finish(); await until(() => !runner.busy(alpha.bot.id)); };
      ${body}
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir });
    expect(unexpectedStderr(err)).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a turn's status follows each step as it starts and ends, and is never Thinking", () => run("steps", `
  post(own, 'me', 'update my notes');
  // At work from the moment the message lands, before Pi has even been asked: plain words, not Thinking.
  a.equal(status()?.state, 'working');
  a.equal(line(), 'Working on it');
  await until(() => prompts.length === 1 && mind.steerable);
  sent.length = 0;
  feed({ type: 'agent_start' });
  feed({ type: 'turn_start' });
  feed({ type: 'message_start', message: { role: 'assistant', content: [] } });
  update({ type: 'thinking_start', contentIndex: 0 });
  update({ type: 'thinking_delta', contentIndex: 0, delta: 'They want the notes file changed.' });
  a.equal(line(), 'Working on it');
  // The model reasoning changes nothing the status says, so nothing is sent for it.
  a.deepEqual(sent, []);

  // The model starts writing a call: the status says which tool at once, then the bot's own line as
  // soon as that argument is written, while the file's text is still streaming.
  sent.length = 0;
  update({ type: 'toolcall_start', contentIndex: 1, id: 'c1', toolName: 'write' });
  a.equal(line(), 'Writing a file');
  update({ type: 'toolcall_delta', contentIndex: 1, delta: '{"status":"Updating your no' });
  a.equal(line(), 'Writing a file');
  update({ type: 'toolcall_delta', contentIndex: 1, delta: 'tes","path":"/home/x/notes.md","content":"' });
  a.equal(line(), 'Updating your notes');
  for (let i = 0; i < 200; i++) update({ type: 'toolcall_delta', contentIndex: 1, delta: 'more of the file ' });
  update({ type: 'toolcall_end', contentIndex: 1, toolCall: { type: 'toolCall', id: 'c1', name: 'write', arguments: { status: 'Updating your notes', path: '/home/x/notes.md', content: '…' } } });
  feed({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'c1', name: 'write', arguments: { status: 'Updating your notes' } }] } });
  // Two hundred deltas, two statuses: only a change is sent.
  a.deepEqual(sent.map((s) => s.activity), ['Writing a file', 'Updating your notes']);
  start('write', 'c1', { status: 'Updating your notes', path: '/home/x/notes.md', content: '…' });
  a.equal(line(), 'Updating your notes');
  a.equal(status().quiet, undefined);

  // The tool ends: its line is gone in the same tick, replaced by plain work while the model decides what's next.
  end('write', 'c1');
  a.equal(line(), 'Getting it done');
  feed({ type: 'turn_end' });
  feed({ type: 'turn_start' });
  feed({ type: 'message_start', message: { role: 'assistant', content: [] } });
  update({ type: 'thinking_delta', contentIndex: 0, delta: 'Now check it.' });
  a.equal(line(), 'Getting it done');

  // A tool with no line of its own says what it reads; an unknown one is named.
  start('read', 'c2', { path: '/home/x/notes.md' });
  a.equal(line(), 'Reading notes.md');
  end('read', 'c2');
  a.equal(line(), 'Making progress');
  start('linear_create_issue', 'c3', {});
  a.equal(line(), 'Using linear create issue');
  end('linear_create_issue', 'c3');
  a.equal(line(), 'Sorting it out');

  // A page is named in the status while its HTML is still being written.
  update({ type: 'toolcall_start', contentIndex: 0, id: 'c4', toolName: 'html_render' });
  a.equal(line(), 'Drawing a page');
  update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"title":"Weekly signups","html":"<!doctype html><title>' });
  a.equal(line(), 'Drawing Weekly signups');
  feed({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } });
  a.ok(plain(line()), line());

  // Pi's own waits are steps too.
  feed({ type: 'compaction_start', reason: 'threshold' });
  a.equal(line(), 'Summarizing the conversation so far');
  feed({ type: 'compaction_end', reason: 'threshold' });
  a.ok(plain(line()), line());
  feed({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529 overloaded' });
  a.equal(line(), 'Trying again');
  feed({ type: 'auto_retry_end', success: true, attempt: 2 });
  a.ok(plain(line()), line());

  // Nothing sent in the whole turn ever said Thinking, or nothing.
  await over(prompts[0]);
  a.equal(status(), undefined);
  for (const s of sent) if (s.state === 'working') a.ok(s.activity && !/thinking/i.test(s.activity), JSON.stringify(s));
`), 30_000);

test("text streaming reads Writing a reply; a [silent] in the making and text after a sent message don't", () => run("writing", `
  const first = await turn();
  feed({ type: 'message_start', message: { role: 'assistant', content: [] } });
  update({ type: 'text_start', contentIndex: 0 });
  a.equal(line(), 'Working on it');
  update({ type: 'text_delta', contentIndex: 0, delta: 'Sure, ' });
  a.equal(line(), 'Writing a reply');
  update({ type: 'text_delta', contentIndex: 0, delta: 'here is what I found.' });
  a.equal(line(), 'Writing a reply');
  // The reply is shown while the turn settles, and the status still says what that is.
  feed({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Sure, here is what I found.' }] } });
  a.equal(typing(), true);
  a.equal(line(), 'Writing a reply');
  await over(first);
  a.equal(status(), undefined);
  a.equal(typing(), false);

  // Text that goes on to a tool call was the bot between steps: the call takes the line over at once.
  const second = await turn();
  feed({ type: 'message_start', message: { role: 'assistant', content: [] } });
  update({ type: 'text_delta', contentIndex: 0, delta: 'Let me check the build.' });
  a.equal(line(), 'Writing a reply');
  update({ type: 'toolcall_start', contentIndex: 1, id: 'b1', toolName: 'bash' });
  a.equal(line(), 'Running a command');
  update({ type: 'toolcall_delta', contentIndex: 1, delta: '{"status":"Checking why the build failed","command":"bun run build"}' });
  a.equal(line(), 'Checking why the build failed');
  start('bash', 'b1', { status: 'Checking why the build failed', command: 'bun run build' });
  end('bash', 'b1');
  a.ok(plain(line()), line());

  // Writing a message with its tool: the chat shows it typing, and the status says the same.
  update({ type: 'toolcall_start', contentIndex: 0, id: 's1', toolName: 'send_message' });
  a.equal(typing(), true);
  a.equal(line(), 'Writing a reply');
  start('send_message', 's1', { text: 'It was a missing import.' });
  const out = await agent.sendMessage(alpha.bot.id, { text: 'It was a missing import.' });
  end('send_message', 's1', { details: out });
  // Sent: typing stops with it, and what's left of the turn stays out of the chat.
  a.equal(typing(), false);
  a.equal(status().quiet, true);
  a.ok(plain(line()), line());
  // The closing [silent] isn't a reply, nor is anything else after a message went out.
  feed({ type: 'message_start', message: { role: 'assistant', content: [] } });
  update({ type: 'text_delta', contentIndex: 0, delta: '[sil' });
  update({ type: 'text_delta', contentIndex: 0, delta: 'ent]' });
  a.ok(plain(line()), line());
  await over(second);

  // A turn that only ever says [silent] never claims to be writing.
  const third = await turn();
  sent.length = 0;
  feed({ type: 'message_start', message: { role: 'assistant', content: [] } });
  for (const delta of ['[', 'sil', 'ent', ']']) update({ type: 'text_delta', contentIndex: 0, delta });
  feed({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '[silent]' }] } });
  a.deepEqual(sent.filter((s) => s.activity === 'Writing a reply'), []);
  a.equal(typing(), false);
  await over(third);
`), 30_000);

test("tools side by side each keep their line until their own end, and a sent message doesn't hide work still running", () => run("parallel", `
  const prompt = await turn();
  start('bash', 'p1', { status: 'Building the app', command: 'make' });
  start('bash', 'p2', { status: 'Running the tests', command: 'make test' });
  a.equal(line(), 'Running the tests');
  // A call that becomes a background job takes its own status as its label, not the newest call's.
  a.equal(runner.toolLabel(alpha.bot.id, 'bash'), 'Running the tests');
  start('read', 'p0', { path: 'a.md' });
  a.equal(runner.toolLabel(alpha.bot.id, 'bash'), 'Running the tests');
  a.equal(runner.toolLabel(alpha.bot.id, 'read'), undefined);
  end('read', 'p0');
  // The first of two bash calls ends: the other is still running, and still showing.
  end('bash', 'p2');
  a.equal(line(), 'Building the app');
  a.equal(mind.tool.name, 'bash');
  end('bash', 'p1');
  a.ok(plain(line()), line());
  a.equal(mind.tool, undefined);

  // A message sent beside work that's still going: the work keeps its line.
  start('openbuild', 'p3', { action: 'read', thread: '1a2b3c4d', status: 'Reading the fix thread' });
  a.equal(status().thread, '1a2b3c4d');
  start('send_message', 'p4', { text: 'Looking at the thread now.' });
  const out = await agent.sendMessage(alpha.bot.id, { text: 'Looking at the thread now.' });
  end('send_message', 'p4', { details: out });
  a.equal(typing(), false);
  a.equal(status().quiet, undefined);
  a.equal(line(), 'Reading the fix thread');
  a.equal(status().thread, '1a2b3c4d');
  end('openbuild', 'p3');
  a.equal(status().thread, undefined);
  a.ok(plain(line()), line());
  // Two bubbles written in one response: it's typing until the last one is out.
  update({ type: 'toolcall_start', contentIndex: 0, id: 'm1', toolName: 'send_message' });
  update({ type: 'toolcall_start', contentIndex: 1, id: 'm2', toolName: 'send_message' });
  start('send_message', 'm1', { text: 'One.' });
  end('send_message', 'm1', { details: await agent.sendMessage(alpha.bot.id, { text: 'One.' }) });
  a.equal(typing(), true);
  start('send_message', 'm2', { text: 'Two.' });
  end('send_message', 'm2', { details: await agent.sendMessage(alpha.bot.id, { text: 'Two.' }) });
  a.equal(typing(), false);
  a.equal(status().quiet, true);
  await over(prompt);
`), 30_000);

test("a record that trails in after the turn doesn't put the bot back to work, and the next turn starts clean", () => run("trailing", `
  const first = await turn();
  start('bash', 't1', { status: 'Deploying the site', command: './deploy.sh' });
  a.equal(line(), 'Deploying the site');
  // The turn ends with the tool's end never seen.
  await over(first);
  a.equal(status(), undefined);
  sent.length = 0;
  end('bash', 't1');
  update({ type: 'toolcall_start', contentIndex: 0, id: 't2', toolName: 'read' });
  start('read', 't2', { path: 'late.md' });
  a.equal(status(), undefined);
  a.deepEqual(sent, []);
  // The next turn shows nothing of the last one.
  const second = await turn();
  a.equal(line(), 'Working on it');
  update({ type: 'thinking_delta', contentIndex: 0, delta: 'hm' });
  a.equal(line(), 'Working on it');
  a.equal(mind.tool, undefined);
  await over(second);
`), 30_000);

test("a group bot still deciding shows nothing, and shows its step the moment it starts writing a call", () => run("deciding", `
  const prompt = await turn(group.id, '@Alpha can you check the build?');
  a.equal(status().deciding, true);
  // Loading tools is still making up its mind.
  update({ type: 'toolcall_start', contentIndex: 0, id: 'l1', toolName: 'load_tools' });
  start('load_tools', 'l1', { tools: ['bash'] });
  a.equal(status().deciding, true);
  end('load_tools', 'l1');
  a.equal(status().deciding, true);
  // It starts writing a real call: decided, and on show before the call has even run.
  update({ type: 'toolcall_start', contentIndex: 0, id: 'g1', toolName: 'bash' });
  a.equal(status().deciding, undefined);
  a.equal(status().quiet, undefined);
  a.equal(line(), 'Running a command');
  update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"status":"Checking the build",' });
  a.equal(line(), 'Checking the build');
  await over(prompt);
`), 30_000);

test("a fallback taking over says so, until that model gets going", () => run("fallback", `
  // The switch is logged for the server's owner; it isn't this test's subject.
  console.warn = () => {};
  svc.updateBot(alpha.bot.id, { model: 'main/one', fallbackModels: ['spare/two'] });
  let on;
  const base = mind.proc.send.bind(mind.proc);
  mind.proc.send = async (cmd) => {
    if (cmd.type === 'get_state') return on ? { model: { provider: on.split('/')[0], id: on.split('/')[1] } } : {};
    if (cmd.type === 'get_available_models') return { models: [{ provider: 'spare', id: 'two' }] };
    if (cmd.type === 'set_model') {
      const id = cmd.provider + '/' + cmd.modelId;
      if (id === 'main/one') throw new Error('Model not found: ' + id);
      on = id;
      return {};
    }
    return base(cmd);
  };
  post(own, 'me', 'hello');
  await until(() => prompts.length === 1 && mind.steerable);
  a.equal(on, 'spare/two');
  a.deepEqual(sent.map((s) => s.activity), ['Working on it', 'Trying another model']);
  // Its first sign of life puts the line back on the work itself.
  update({ type: 'thinking_delta', contentIndex: 0, delta: 'ok' });
  a.equal(line(), 'Working on it');
  start('read', 'f1', { path: 'a.md' });
  a.equal(line(), 'Reading a.md');
  await over(prompts[0]);
  a.equal(status(), undefined);
`), 30_000);
