import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyUpdate, HELPER_TOOLS, isStopRequest, onlySilent, replyBubbles, saysSilent } from "../shared/bots";
import openbots, { CATALOG_BRIEF } from "../server/bots/extension";
import { piBin } from "../server/pi/install";
import { stoppable } from "../src/lib/bots/activity";
import { unexpectedStderr } from "./botStderr";
import { spawnScript } from "./spawnScript";

// Each scenario runs the real service and runner in a subprocess on its own data dir, with stand-in
// Pi processes for the bots' main sessions and for their helper sessions.
async function run(name: string, body: string) {
  const dir = await mkdtemp(join(tmpdir(), `openbuild-responsive-${name}-`));
  try {
    const { code, stderr: err } = await spawnScript(`
      import { strict as a } from 'node:assert';
      const minds = globalThis.openbotsMinds = new Map();
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const agent = await import('./server/bots/agent.ts');
      const helpers = await import('./server/bots/helpers.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
      const { getFocus } = agent;
      const sessionPathFor = id => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', id, (globalThis.openbotsFocus?.get(id) ?? svc.directId(id))));
      svc.setHooks({ wake: runner.wake, stop: runner.stop, pendingAssignments: runner.pendingAssignments, unseen: runner.unseen, userWoke: runner.userWoke, halt: runner.halt, background: runner.background });
      svc.updateSettings({ onboarding: 'done' });
      const prompts = [], steers = [], commands = [];
      const fake = (bot) => {
        const mind = { token: 't', loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), ended: Promise.resolve(), close() { this.exited = true; }, async send(cmd) {
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
      // Helper sessions: each one spawned is kept, and answers when the test says so.
      const spawned = [];
      let helperLevels = ['off', 'minimal', 'low', 'medium', 'high'];
      helpers.seams.spawn = (botId, flags, env) => {
        const listeners = new Set();
        const h = { botId, flags, env, commands: [], closed: false, prompt: undefined,
          async send(cmd) { h.commands.push(cmd); if (cmd.type === 'prompt') h.prompt = cmd.message; return cmd.type === 'get_available_thinking_levels' ? { levels: helperLevels } : {}; },
          on(l) { listeners.add(l); return () => listeners.delete(l); },
          close() { h.closed = true; },
          answer(text) { for (const l of listeners) l({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] } }); for (const l of listeners) l({ type: 'agent_settled' }); } };
        spawned.push(h);
        return h;
      };
      const until = async (check) => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); a.ok(check(), String(check)); };
      const settle = () => Bun.sleep(40);
      const post = (where, author, text) => svc.postMessage(where, { id: crypto.randomUUID(), author, text, at: Date.now() });
      const of = (bot) => prompts.filter(p => p.bot === bot.id);
      const steersOf = (bot) => steers.filter(s => s.bot === bot.id).map(s => s.message);
      const did = (bot, type) => commands.filter(c => c.bot === bot.id && c.type === type).length;
      const said = (id) => db.messages(id, 80).filter(r => !r.message.event).map(r => r.message.text);
      const events = (id) => db.messages(id, 80).flatMap(r => r.message.event ? [r.message.event.text] : []);
      const toolStart = (bot, name, args = {}) => runner.onRecord(bot.id, minds.get(bot.id), { type: 'tool_execution_start', toolName: name, args });
      const toolEnd = (bot, name, result = {}) => runner.onRecord(bot.id, minds.get(bot.id), { type: 'tool_execution_end', toolName: name, result });
      // The bot writes to the chat with its tool, as Pi reports it.
      const send = async (bot, text) => {
        const out = await agent.sendMessage(bot.id, { text });
        toolEnd(bot, 'send_message', { details: out });
        return out;
      };
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

// ------------------------------------------------------------------ 1. a word before slow work

test("the system prompt asks for one quick ack before real work, a reaction when that says enough, and one back to the user's", () => run("ack-prompt", `
  const rules = agent.contextSections(alpha.bot.id).openbots.split('\\n\\n');
  const ack = rules.filter(r => r.includes('Got it, switching to X'));
  a.deepEqual(ack, [agent.RESPONSIVE]);
  // Before real work and when steered mid-work, with the first tool call so it costs no model call of its own.
  a.match(ack[0], /before real work they asked for, and whenever they steer you mid-work, send one short ack with your first tool call/);
  // Not overdone.
  a.match(ack[0], /At most one per user message, and none when the answer itself comes fast\\./);
  // A reaction instead of a sentence, and a reaction back to the user's.
  a.match(ack[0], /When a reaction says enough \\(👍 to "ok go" or "thanks"\\), react instead of writing\\./);
  a.match(ack[0], /When the user reacts to something of yours, react back so they know you saw it, most of all mid-work\\./);
  // Short: one paragraph of the always-on prompt.
  a.ok(ack[0].length < 450, String(ack[0].length));
  // Nothing in the prompt says a reaction can be let be any more.
  a.doesNotMatch(agent.contextFor(alpha.bot.id), /owe a reply to every message or reaction|doesn't need an answer/);
  a.match(agent.contextFor(alpha.bot.id), /You don't owe every message a reply: with nothing to add, end your turn with the plain reply \\[silent\\]\\./);
`), 30_000);

test("the runner steers no late nudge of its own into a turn that keeps the user waiting", () => run("ack-no-nudge", `
  a.equal(runner.ACK_NUDGE, undefined);
  post(own, 'me', 'build the thing');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  // A slow tool with nothing said yet used to get "the user is waiting" at once.
  toolStart(alpha.bot, 'bash', { command: 'make' });
  await settle();
  toolEnd(alpha.bot, 'bash');
  toolStart(alpha.bot, 'search', { query: 'decision' });
  await settle();
  a.deepEqual(steersOf(alpha.bot), []);
  // Nothing of the runner's sits in Pi's queue, so there's nothing to clear when the turn ends.
  const cleared = did(alpha.bot, 'clear_queue');
  of(alpha.bot)[0].finish('done');
  await until(() => !runner.busy(alpha.bot.id));
  await settle();
  a.equal(did(alpha.bot, 'clear_queue'), cleared);
  a.equal(of(alpha.bot).length, 1);
  a.deepEqual(said(own), ['build the thing', 'done']);
`), 30_000);

test("a message steered into a working turn asks for one quick ack, and a reaction steered in for one back", () => run("ack-steer", `
  post(own, 'me', 'run the build');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  // The turn's own prompt says how to reply; the ack before real work is the system prompt's.
  a.match(of(alpha.bot)[0].message, /Use send_message to reply/);
  a.doesNotMatch(of(alpha.bot)[0].message, /arrived while you were working/);
  await send(alpha.bot, 'On it.');
  const mine = db.messages(own, 5).at(-1).message;

  // They steer it mid-work: the message itself says to show it landed, once, and carry on.
  post(own, 'me', 'use release mode');
  await until(() => steersOf(alpha.bot).length === 1);
  const steer = steersOf(alpha.bot)[0];
  a.match(steer, /use release mode/);
  a.ok(steer.endsWith('This arrived while you were working. ' + runner.STEER_ACK), steer);
  a.match(runner.STEER_ACK, /one short send_message \\(the answer if that's quick, otherwise what you'll do now, like "Got it, switching to X"\\), or just a reaction when that says enough\\. Then fold it in and carry on\\./);
  // Mid-work it isn't told how to end a turn.
  a.doesNotMatch(steer, /\\[silent\\]|Use send_message to reply/);

  // They react to its message mid-work: it's told to react back, not that it can let it be.
  svc.toggleReaction(own, mine.id, '👍', 'me');
  await until(() => steersOf(alpha.bot).length === 2);
  const reacted = steersOf(alpha.bot)[1];
  a.match(reacted, /reacted 👍 to your message \\[\\w{8}\\]: “On it\\.”\\. That's reaction #1 there\\. React back to it with react's to_reaction so they know you saw it, and write only if it calls for words\\. Mid-work, carry on after\\./);
  a.ok(reacted.includes(svc.REACT_BACK));
  a.doesNotMatch(reacted, /doesn't need an answer|if you like|arrived while you were working|Use send_message to reply/);
  of(alpha.bot)[0].finish('');
  await until(() => !runner.busy(alpha.bot.id));

  // A reaction while it's idle gets a turn of its own, with the same ask.
  svc.toggleReaction(own, mine.id, '🎉', 'me');
  await until(() => of(alpha.bot).length === 2);
  a.ok(of(alpha.bot)[1].message.includes('reacted 🎉 to your message'));
  a.ok(of(alpha.bot)[1].message.includes(svc.REACT_BACK));
  of(alpha.bot)[1].finish('[silent]');
  await until(() => !runner.busy(alpha.bot.id));
  a.deepEqual(said(own), ['run the build', 'On it.', 'use release mode']);
`), 30_000);

// ------------------------------------------------------------------ 2. helper sessions

test("a helper runs on the bot's own chosen model at low reasoning, and never another", () => run("helper-model", `
  const record = () => { const sent = []; return { sent, send: async (cmd) => (sent.push(cmd), cmd.type === 'get_available_thinking_levels' ? { levels: helperLevels } : {}) }; };
  a.equal(helpers.HELPER_EFFORT, 'low');
  // The model the user chose for this bot.
  svc.updateBot(alpha.bot.id, { model: 'acme/big-one', effort: 'max' });
  let p = record();
  await helpers.applyHelperModel(p, alpha.bot.id);
  a.deepEqual(p.sent.map(c => c.type), ['set_model', 'get_available_thinking_levels', 'set_thinking_level']);
  a.deepEqual([p.sent[0].provider, p.sent[0].modelId, p.sent[2].level], ['acme', 'big-one', 'low']);
  // No model of its own: the bots' default the user chose.
  svc.updateSettings({ defaultModel: 'acme/default-one' });
  p = record();
  await helpers.applyHelperModel(p, beta.bot.id);
  a.deepEqual([p.sent[0].provider, p.sent[0].modelId, p.sent.at(-1).level], ['acme', 'default-one', 'low']);
  // No choice anywhere: the one its main session settled on, and failing that Pi's own default, untouched.
  svc.updateSettings({ defaultModel: '' });
  db.setValue('primary:' + beta.bot.id, 'acme/settled');
  p = record();
  await helpers.applyHelperModel(p, beta.bot.id);
  a.equal(p.sent[0].modelId, 'settled');
  db.setValue('primary:' + beta.bot.id, null);
  p = record();
  await helpers.applyHelperModel(p, beta.bot.id);
  a.deepEqual(p.sent.map(c => c.type), ['get_available_thinking_levels', 'set_thinking_level']);
  // A model without "low" gets the nearest level it has; one with none is left alone.
  helperLevels = ['minimal', 'high'];
  p = record();
  await helpers.applyHelperModel(p, alpha.bot.id);
  a.equal(p.sent.at(-1).level, 'minimal');
  helperLevels = [];
  p = record();
  await helpers.applyHelperModel(p, alpha.bot.id);
  a.ok(!p.sent.some(c => c.type === 'set_thinking_level'));
  // A chosen model that can't be set fails the helper: it never runs on something else.
  await a.rejects(helpers.applyHelperModel({ send: async (cmd) => { if (cmd.type === 'set_model') throw new Error('model not found'); return { levels: [] }; } }, alpha.bot.id), /model not found/);
`), 30_000);

test("a handed-off check runs on a helper with only lookup tools, and its result wakes the bot where it asked", () => run("lookup", `
  post(own, 'me', 'is CI green?');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  const out = agent.background(alpha.bot.id, { task: 'Check whether CI is green on main.' });
  a.equal(out.started, true);
  a.match(out.note, /Don't wait/);
  await until(() => spawned.length === 1 && spawned[0].prompt);
  const h = spawned[0];
  a.deepEqual(helpers.backgroundJobs(alpha.bot.id), { running: ['lookup'], queued: [] });
  // The bot's own lookup tools through its extension, under a token of its own; nothing the user sees.
  a.equal(h.flags[h.flags.indexOf('--tools') + 1], 'bash,read,search,bot_web_search');
  a.ok(h.flags.includes('-e') && !h.flags.includes('--no-tools'));
  a.ok(h.env.OPENBOTS_TOKEN && h.env.OPENBOTS_HELPER === '1');
  a.deepEqual(h.commands.filter(c => c.type === 'set_thinking_level').map(c => c.level), ['low']);
  a.match(h.prompt, /Check whether CI is green on main\\./);
  // The turn it came from doesn't wait for it.
  of(alpha.bot)[0].finish('Checking CI, back in a moment.');
  await until(() => !runner.busy(alpha.bot.id));
  a.deepEqual(said(own), ['is CI green?', 'Checking CI, back in a moment.']);
  h.answer('Green: 14 of 14 checks passed.');
  await until(() => of(alpha.bot).length === 2);
  a.equal(of(alpha.bot)[1].focus, own);
  a.match(of(alpha.bot)[1].message, /Your helper finished[\\s\\S]*Green: 14 of 14 checks passed\\./);
  a.ok(h.closed);
  a.deepEqual(helpers.backgroundJobs(alpha.bot.id), { running: [], queued: [] });
  // Nothing of the helper's own reached the chat.
  a.deepEqual(said(own), ['is CI green?', 'Checking CI, back in a moment.']);
  of(alpha.bot)[1].finish('CI is green.');
  await until(() => !runner.busy(alpha.bot.id));
`), 30_000);

test("a helper session's token only looks things up", () => run("helper-lane", `
  const ctx = await agent.handleHelper(alpha.bot.id, 'context', {});
  a.match(ctx.sections.openbots_helper, /Alpha/);
  for (const method of ['send_message', 'react', 'memory', 'ask_bot', 'background', 'manage_bot', 'openbuild', 'write', 'edit', 'routine', 'side_chat'])
    await a.rejects(agent.handleHelper(alpha.bot.id, method, { text: 'hi', conversation: own }), /only look things up/, method);
  a.deepEqual(said(own), []);
`), 30_000);

// ------------------------------------------------------------------ 3. ask_bot doesn't block

test("ask_bot returns at once, and the answer wakes the asker where it asked from", () => run("ask", `
  post(own, 'me', 'ask Beta for the port');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  const began = Date.now();
  const out = await agent.askBot(alpha.bot.id, { bot: 'Beta', text: 'which port?' });
  a.ok(Date.now() - began < 1000);
  a.match(out.note, /Don't wait for Beta/);
  a.deepEqual(helpers.backgroundJobs(alpha.bot.id).running, ['ask']);
  // The asker's turn ends without the answer.
  of(alpha.bot)[0].finish('Asked Beta.');
  await until(() => !runner.busy(alpha.bot.id));
  const side = db.listConversations().find(c => c.kind === 'side');
  await until(() => of(beta.bot).length === 1);
  a.equal(of(beta.bot)[0].focus, side.id);
  post(side.id, beta.bot.id, 'port 4096');
  of(beta.bot)[0].finish('');
  await until(() => of(alpha.bot).length === 2);
  // One wake, in the chat it asked from, with the answer in it: not a second turn in the side chat.
  a.equal(of(alpha.bot)[1].focus, own);
  a.match(of(alpha.bot)[1].message, /Beta answered what you asked[\\s\\S]*port 4096/);
  of(alpha.bot)[1].finish('It is 4096.');
  await until(() => !runner.busy(alpha.bot.id) && !runner.busy(beta.bot.id));
  await settle();
  a.equal(of(alpha.bot).length, 2);
  a.deepEqual(helpers.backgroundJobs(alpha.bot.id), { running: [], queued: [] });
  a.deepEqual(said(own), ['ask Beta for the port', 'Asked Beta.', 'It is 4096.']);
`), 30_000);

// ------------------------------------------------------------------ 4. a reply during a long tool

test("a message that arrives during a long tool gets a quick helper reply, and still reaches the turn", () => run("side-reply", `
  svc.updateBot(alpha.bot.id, { model: 'acme/big-one' });
  post(own, 'me', 'run the build');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  // Not in a tool: the turn can read it itself, so no helper.
  post(own, 'me', 'use release mode');
  await until(() => steersOf(alpha.bot).some(m => m.includes('use release mode')));
  a.equal(spawned.length, 0);
  toolStart(alpha.bot, 'bash', { command: 'make', status: 'Building the release' });
  post(own, 'me', 'how long will it take?');
  await until(() => spawned.length === 1 && spawned[0].prompt);
  const h = spawned[0];
  // Steered into the main turn as ever.
  await until(() => steersOf(alpha.bot).some(m => m.includes('how long will it take?')));
  // The helper: same model, low reasoning, no tools, and it knows what the main turn is doing.
  a.deepEqual(h.commands.filter(c => c.type === 'set_model').map(c => c.provider + '/' + c.modelId), ['acme/big-one']);
  a.deepEqual(h.commands.filter(c => c.type === 'set_thinking_level').map(c => c.level), ['low']);
  a.ok(h.flags.includes('--no-tools') && !h.flags.includes('--tools'));
  a.equal(h.env.OPENBOTS_TOKEN, undefined);
  a.match(h.prompt, /You are Alpha/);
  a.match(h.prompt, /Building the release/);
  a.match(h.prompt, /how long will it take\\?/);
  // One at a time per chat.
  post(own, 'me', 'hello?');
  await settle();
  a.equal(spawned.length, 1);
  h.answer('Still building, a couple of minutes more.');
  await until(() => said(own).includes('Still building, a couple of minutes more.'));
  a.equal(db.messages(own, 5).at(-1).message.author, alpha.bot.id);
  a.ok(h.closed);
  // No extra steer for it: the main turn is shown what was said for it when it next writes there, once.
  a.equal(steersOf(alpha.bot).length, 3);
  toolEnd(alpha.bot, 'bash');
  const held = await agent.sendMessage(alpha.bot.id, { text: 'Still building.' });
  a.equal(held.sent, false);
  a.match(held.new, /Alpha: Still building, a couple of minutes more\./);
  await send(alpha.bot, 'Built.');
  of(alpha.bot)[0].finish('');
  await until(() => !runner.busy(alpha.bot.id));
  await settle();
  a.equal(of(alpha.bot).length, 1);
  a.deepEqual(said(own).slice(-2), ['Still building, a couple of minutes more.', 'Built.']);
`), 30_000);

test("a side reply is dropped when the turn answered first, or the helper has nothing to say", () => run("side-reply-drop", `
  post(own, 'me', 'run the build');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  toolStart(alpha.bot, 'bash', { command: 'make' });
  post(own, 'me', 'status?');
  await until(() => spawned.length === 1 && spawned[0].prompt);
  toolEnd(alpha.bot, 'bash');
  await send(alpha.bot, 'Halfway there.');
  spawned[0].answer('Still working on it.');
  await settle();
  a.ok(!said(own).includes('Still working on it.'));

  toolStart(alpha.bot, 'bash', { command: 'make test' });
  post(own, 'me', 'ok thanks');
  await until(() => spawned.length === 2 && spawned[1].prompt);
  spawned[1].answer('[silent]');
  await settle();
  a.deepEqual(said(own), ['run the build', 'status?', 'Halfway there.', 'ok thanks']);
  // A bot busy in one chat tells the user so in another, where the message waits its turn.
  post(group.id, 'me', '@Alpha are you around?');
  await until(() => spawned.length === 3 && spawned[2].prompt);
  a.match(spawned[2].prompt, /busy in another chat/);
  spawned[2].answer('In the middle of a build, with you shortly.');
  await until(() => said(group.id).includes('In the middle of a build, with you shortly.'));
  toolEnd(alpha.bot, 'bash');
  of(alpha.bot)[0].finish('');
  await until(() => of(alpha.bot).length === 2);
  a.equal(of(alpha.bot)[1].focus, group.id);
  of(alpha.bot)[1].finish('');
  await until(() => !runner.busy(alpha.bot.id));
`), 30_000);

// ------------------------------------------------------------------ 5. stop

test("stop phrasing: the whole message has to be a stop, however it's put", () => {
  for (const text of ["stop", "Stop!", "STOP.", "cancel", "cancel that", "never mind", "Nevermind.", "nvm", "forget it", "ok forget it please", "no stop", "please stop", "stop it", "stop now", "@Alpha stop", "stop @Alpha", "wait, stop", "actually never mind", "forget about it", "stop what you're doing", "stop what you’re doing", "abort", "that's enough", "stop stop stop", "cancel it, thanks", "just stop working on that", "don't bother", "halt", "Never mind!!", "never mind, stop", "stop, please stop", "ok cancel that and forget it"])
    expect([text, isStopRequest(text)]).toEqual([text, true]);
  for (const text of ["stop the dev server", "can you stop the container?", "never mind the tests, do the docs", "don't stop", "cancel my subscription", "forget it exists and rewrite it", "I can't stop laughing", "how do I cancel a fetch request", "stop by the store", "nonstop", "", "stop using tabs", "ok", "enough tests for now, write the docs", "never mind, use postgres instead", "what does abort do", "stopwatch", "should I stop?", "why did it stop", "the build was cancelled", "never mind and stop the server", "stop and think", "stop " + "x".repeat(80)])
    expect([text, isStopRequest(text)]).toEqual([text, false]);
});

test("a user's stop aborts the turn and cancels the bot's background work, without a reply or an error", () => run("stop", `
  post(own, 'me', 'deploy everything');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  agent.background(alpha.bot.id, { task: 'Check the deploy queue.' });
  await agent.askBot(alpha.bot.id, { bot: 'Beta', text: 'ready?' });
  await until(() => spawned.length === 1 && spawned[0].prompt && of(beta.bot).length === 1);
  of(beta.bot)[0].finish('');
  a.deepEqual(helpers.backgroundJobs(alpha.bot.id).running.sort(), ['ask', 'lookup']);
  toolStart(alpha.bot, 'bash', { command: './deploy.sh' });
  minds.get(alpha.bot.id).draft = 'Deploying now and';
  const stop = post(own, 'me', 'never mind, stop');
  await until(() => !runner.busy(alpha.bot.id));
  // Pi was aborted, its queue cleared first; the Pi itself is kept for the next message.
  a.equal(did(alpha.bot, 'abort'), 1);
  a.ok(commands.findIndex(c => c.type === 'clear_queue') < commands.findIndex(c => c.type === 'abort'));
  a.equal(minds.get(alpha.bot.id).proc.exited, false);
  // Helpers and waits are gone.
  a.ok(spawned[0].closed);
  a.deepEqual(helpers.backgroundJobs(alpha.bot.id), { running: [], queued: [] });
  // The chat says it stopped: no reply, no half-written text, no error, and the stop isn't answered.
  await settle();
  a.deepEqual(said(own), ['deploy everything', 'never mind, stop']);
  a.deepEqual(events(own).filter(t => !/message (to|from)/.test(t)), ['Alpha stopped']);
  a.deepEqual(db.getMessage(stop.id).message.seenBy, [alpha.bot.id]);
  a.equal(svc.getStatus(alpha.bot.id), undefined);
  a.equal(of(alpha.bot).length, 1);
  // What the cancelled jobs would have brought back wakes nobody.
  spawned[0].answer('Queue is empty.');
  post(db.listConversations().find(c => c.kind === 'side').id, beta.bot.id, 'ready');
  await settle();
  const woken = of(alpha.bot).slice(1);
  a.ok(!woken.some(p => /Your helper finished|Beta answered what you asked/.test(p.message)));
  for (const p of woken) p.finish('[silent]');
  await until(() => !runner.busy(alpha.bot.id));
  // It works again on the next message.
  const before = of(alpha.bot).length;
  post(own, 'me', 'ok, just deploy the docs');
  await until(() => of(alpha.bot).length === before + 1);
  a.match(of(alpha.bot).at(-1).message, /just deploy the docs/);
  of(alpha.bot).at(-1).finish('Docs deployed.');
  await until(() => !runner.busy(alpha.bot.id));
  a.equal(said(own).at(-1), 'Docs deployed.');
`), 30_000);

test("words that only contain a stop are ordinary messages, and a stop with nothing to stop is too", () => run("stop-not", `
  post(own, 'me', 'start the servers');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  post(own, 'me', 'stop the dev server on 3000 first');
  await until(() => steersOf(alpha.bot).some(m => m.includes('stop the dev server on 3000 first')));
  a.equal(did(alpha.bot, 'abort'), 0);
  a.deepEqual(events(own), []);
  of(alpha.bot)[0].finish('Done.');
  await until(() => !runner.busy(alpha.bot.id));
  // Idle: "never mind" is just something the user said, and the bot reads it.
  post(own, 'me', 'never mind');
  await until(() => of(alpha.bot).length === 2);
  a.match(of(alpha.bot)[1].message, /never mind/);
  a.deepEqual(events(own), []);
  of(alpha.bot)[1].finish('[silent]');
  await until(() => !runner.busy(alpha.bot.id));
`), 30_000);

test("the stop button's route stops the chat's bots; in a group a stop reaches only the bot it's said to", () => run("stop-route", `
  const { stopWork } = await import('./server/bots/routes.ts');
  const { allowedOperation } = await import('./server/bots/workspace.ts');
  a.ok(allowedOperation('POST', '/api/bots/conversations/' + own + '/stop'));
  // Nothing going: nothing stopped, nothing said.
  a.deepEqual(await stopWork(own, {}).json(), { stopped: [] });
  a.deepEqual(events(own), []);
  a.equal(stopWork('nope', {}).status, 404);

  post(own, 'me', 'long job');
  await until(() => of(alpha.bot).length === 1 && minds.get(alpha.bot.id).steerable);
  toolStart(alpha.bot, 'bash', { command: 'sleep 600' });
  // Waiting behind the turn, here and in the group.
  runner.wake(alpha.bot.id, { kind: 'note', conversationId: own, text: 'A process finished.' });
  post(group.id, 'me', '@Alpha and one more thing');
  a.deepEqual(await stopWork(own, {}).json(), { stopped: [alpha.bot.id] });
  await until(() => did(alpha.bot, 'abort') === 1);
  a.deepEqual(events(own), ['Alpha stopped']);
  // What waited in this chat went with it; the group's request keeps its place and runs next.
  await until(() => of(alpha.bot).length === 2);
  a.equal(of(alpha.bot)[1].focus, group.id);
  a.match(of(alpha.bot)[1].message, /and one more thing/);
  a.ok(!of(alpha.bot)[1].message.includes('A process finished.'));
  // Both at work in the group: "@Beta stop" stops Beta alone.
  post(group.id, 'me', '@Beta check the logs');
  await until(() => of(beta.bot).length === 1 && minds.get(beta.bot.id).steerable);
  post(group.id, 'me', '@Beta stop');
  await until(() => did(beta.bot, 'abort') === 1);
  await settle();
  a.equal(did(alpha.bot, 'abort'), 1);
  a.deepEqual(events(group.id).filter(t => /stopped/.test(t)), ['Beta stopped']);
  a.ok(runner.busy(alpha.bot.id));
  of(alpha.bot)[1].finish('Noted.');
  await until(() => !runner.busy(alpha.bot.id) && !runner.busy(beta.bot.id));
  a.equal(of(alpha.bot).length, 2);
  a.equal(of(beta.bot).length, 1);
`), 30_000);

test("the composer offers stop for the bots its route would stop", () => {
  const working = (conversationId: string, waiting?: string[]) => ({ state: "working" as const, conversationId, waiting });
  expect(stoppable({ id: "dm", kind: "direct", botIds: ["a"] }, { a: working("group") })).toEqual(["a"]);
  expect(stoppable({ id: "dm", kind: "direct", botIds: ["a"] }, {})).toEqual([]);
  expect(stoppable({ id: "dm", kind: "direct", botIds: ["a"] }, { a: { state: "error" } })).toEqual([]);
  expect(stoppable({ id: "g", kind: "group", botIds: ["a", "b", "c"] }, { a: working("g"), b: working("dm"), c: working("dm", ["g"]) })).toEqual(["a", "c"]);
});

// ------------------------------------------------------------------ 6. quiet on wakes

test("the silent marker and an empty update are recognised wherever they're written", () => {
  expect(saysSilent("Nothing new, staying [silent].")).toBe(true);
  expect(saysSilent("[ Silent ]")).toBe(true);
  expect(saysSilent("it was silent")).toBe(false);
  expect(onlySilent('"[silent]".')).toBe(true);
  expect(onlySilent("ok [silent]")).toBe(false);
  expect(replyBubbles("Sure!\n\n[silent].")).toEqual(["Sure!"]);
  expect(replyBubbles("Done.[silent]\n\n[silent][silent]")).toEqual(["Done."]);
  expect(replyBubbles("Reply [silent] to stay quiet.")).toEqual(["Reply [silent] to stay quiet."]);
  for (const text of ["Nothing new.", "No updates", "All quiet, nothing to report.", "nothing new here", "No changes yet.", "Still nothing", "  "]) expect([text, emptyUpdate(text)]).toEqual([text, true]);
  for (const text of ["Nothing new except the build passed", "No", "The build is green", "No updates needed: I merged it", "nothing to report but PR 3 failed", "All good, the deploy went out at 3pm and the smoke tests passed"]) expect([text, emptyUpdate(text)]).toEqual([text, false]);
});

test("a wake with nothing new posts nothing, as plain text or through send_message; news still goes out", () => run("quiet", `
  const note = async (text) => {
    const n = of(alpha.bot).length;
    runner.wake(alpha.bot.id, { kind: 'note', conversationId: own, text });
    await until(() => of(alpha.bot).length === n + 1 && minds.get(alpha.bot.id).steerable);
    return of(alpha.bot)[n];
  };
  const done = () => until(() => !runner.busy(alpha.bot.id));
  // Plain text that says it's staying silent, or only that there's nothing, never reaches the chat.
  for (const text of ['Nothing new. [silent]', 'The thread finished, nothing for the user. [SILENT]', 'No updates.', 'All quiet, nothing to report']) {
    (await note('Thread “x” finished its turn.')).finish(text);
    await done();
    a.deepEqual(said(own), [], text);
  }
  // send_message on such a wake is held when it says nothing new.
  let turn = await note('Thread “x” finished its turn.');
  a.equal(runner.background(alpha.bot.id, own), true);
  let out = await agent.sendMessage(alpha.bot.id, { text: 'Nothing to report.' });
  a.deepEqual([out.sent, out.note], [false, agent.QUIET]);
  a.deepEqual(said(own), []);
  // News goes out.
  await send(alpha.bot, 'The build failed on lint: 3 errors in api.ts.');
  turn.finish('');
  await done();
  a.deepEqual(said(own), ['The build failed on lint: 3 errors in api.ts.']);
  // Saying the same thing again on the next wake is nothing new either.
  turn = await note('Thread “x” finished its turn.');
  out = await agent.sendMessage(alpha.bot.id, { text: 'the build failed on lint: 3 errors in api.ts' });
  a.equal(out.sent, false);
  turn.finish('The tests pass now.');
  await done();
  a.deepEqual(said(own), ['The build failed on lint: 3 errors in api.ts.', 'The tests pass now.']);
  // A check-in is the same kind of wake.
  runner.wake(alpha.bot.id, { kind: 'heartbeat', conversationId: own, text: 'Check in.' });
  await until(() => of(alpha.bot).length === 7);
  of(alpha.bot)[6].finish('Nothing new here.');
  await done();
  a.equal(said(own).length, 2);

  // The user asked: "No updates." is their answer, typed or sent.
  post(own, 'me', 'any updates?');
  await until(() => of(alpha.bot).length === 8 && minds.get(alpha.bot.id).steerable);
  a.equal(runner.background(alpha.bot.id, own), false);
  out = await send(alpha.bot, 'No updates.');
  a.ok(out.id);
  of(alpha.bot)[7].finish('');
  await done();
  post(own, 'me', 'and now?');
  await until(() => of(alpha.bot).length === 9);
  of(alpha.bot)[8].finish('Nothing new.');
  await done();
  a.deepEqual(said(own).slice(-4), ['any updates?', 'No updates.', 'and now?', 'Nothing new.']);
  // A routine was asked for: what it says goes out, even the same line as last time.
  runner.wake(alpha.bot.id, { kind: 'routine', conversationId: own, text: 'Routine “Morning”. Say good morning.' });
  await until(() => of(alpha.bot).length === 10 && minds.get(alpha.bot.id).steerable);
  a.equal(runner.background(alpha.bot.id, own), false);
  await send(alpha.bot, 'Nothing new.');
  of(alpha.bot)[9].finish('');
  await done();
  a.equal(said(own).at(-1), 'Nothing new.');
`), 30_000);

// ------------------------------------------------------------------ 7. the cap on background jobs

test("a bot runs three background jobs at once: more wait their turn or are skipped with a reason, and stop clears them", () => run("cap", `
  a.equal(helpers.BACKGROUND_JOB_CAP, 3);
  const open = [];
  const job = () => { let finish; const ran = { started: false, aborted: false, finish: () => finish() }; open.push(ran); return [(signal) => { ran.started = true; signal.addEventListener('abort', () => { ran.aborted = true; finish(); }); return new Promise((r) => (finish = r)); }, ran]; };
  const start = (opts) => { const [run] = job(); return helpers.startJob(alpha.bot.id, 'lookup', run, opts); };
  a.deepEqual([start(), start(), start()].map(s => s.state), ['started', 'started', 'started']);
  // Over the cap: one that can wait is queued, one that can't is skipped, and neither throws.
  a.equal(start().state, 'queued');
  const skipped = start({ queue: false });
  a.equal(skipped.state, 'skipped');
  a.match(skipped.reason, /3 background jobs are already running/);
  a.deepEqual(helpers.backgroundJobs(alpha.bot.id), { running: ['lookup', 'lookup', 'lookup'], queued: ['lookup'] });
  a.deepEqual(open.map(j => j.started), [true, true, true, false, false]);
  // Another bot has its own three.
  { const [run] = job(); a.equal(helpers.startJob(beta.bot.id, 'lookup', run).state, 'started'); }
  // A slot frees: the one waiting starts.
  open[0].finish();
  await until(() => open[3].started);
  a.deepEqual(helpers.backgroundJobs(alpha.bot.id), { running: ['lookup', 'lookup', 'lookup'], queued: [] });
  // The line itself is bounded.
  for (let i = 0; i < helpers.BACKGROUND_QUEUE_MAX; i++) a.equal(start().state, 'queued');
  const full = start();
  a.equal(full.state, 'skipped');
  a.match(full.reason, /more are waiting/);
  // Through the tool: queued says so, and a full line is refused in words the bot can act on.
  svc.setHooks({ wake() {}, stop() {} });
  a.throws(() => agent.background(alpha.bot.id, { task: 'one more' }), /Not started: 3 background jobs are running[\\s\\S]*Do it yourself/);
  a.equal(helpers.cancelJobs(alpha.bot.id), 3 + helpers.BACKGROUND_QUEUE_MAX);
  await settle();
  a.deepEqual(helpers.backgroundJobs(alpha.bot.id), { running: [], queued: [] });
  a.ok(open.filter(j => j.started).length === 5 && open.filter(j => j.aborted).length === 3);
  a.match(agent.background(alpha.bot.id, { task: 'now there is room' }).note, /^Started/);
  // A job that throws frees its slot and takes nothing down with it.
  helpers.cancelJobs(alpha.bot.id);
  a.equal(helpers.startJob(alpha.bot.id, 'reply', async () => { throw new helpers.JobCancelled(); }).state, 'started');
  await settle();
  a.deepEqual(helpers.backgroundJobs(alpha.bot.id).running, []);
`), 30_000);

// ------------------------------------------------------------------ the extension's side of it

function tools(env: Record<string, string | undefined> = {}) {
  const registered: any[] = [];
  const handlers: Record<string, Function[]> = {};
  let active: string[] = [];
  const before = { ...process.env };
  Object.assign(process.env, env);
  try {
    openbots({
      on(name: string, h: Function) { (handlers[name] ??= []).push(h); },
      registerTool(t: any) { registered.push(t); active.push(t.name); },
      getAllTools: () => registered,
      getActiveTools: () => [...active],
      setActiveTools(names: string[]) { active = names; },
    });
    for (const h of handlers.session_start ?? []) h({ reason: "startup" }, { sessionManager: { getBranch: () => [] } });
  } finally {
    for (const key of Object.keys(env)) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
  }
  return { registered, active: () => active, tool: (name: string) => registered.find((t) => t.name === name) };
}

test("ask_bot says it doesn't wait, background is a catalog tool, and a helper keeps the tools it was started with", () => {
  const main = tools();
  expect(main.tool("ask_bot").description).toMatch(/doesn't wait/);
  expect(CATALOG_BRIEF.ask_bot).not.toMatch(/wait for/);
  expect(main.tool("background").parameters.required).toEqual(["status", "task"]);
  expect(CATALOG_BRIEF.background).toBeTruthy();
  // A new main session puts catalog tools back out until they're loaded; a helper has nothing to load them with.
  expect(main.active()).not.toContain("bash");
  const helper = tools({ OPENBOTS_HELPER: "1" });
  for (const name of HELPER_TOOLS) expect(helper.active()).toContain(name);
});

test("a tool call stops waiting when the turn is aborted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-responsive-abort-"));
  const socket = join(dir, "agent.sock");
  // A service that never answers, like a command still running.
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const before = process.env.OPENBOTS_SOCKET;
  process.env.OPENBOTS_SOCKET = socket;
  try {
    const bash = tools().tool("bash");
    const abort = new AbortController();
    const running = bash.execute("call", { command: "sleep 600", status: "Waiting" }, abort.signal);
    await Bun.sleep(50);
    abort.abort();
    const out = await Promise.race([running, Bun.sleep(2000).then(() => "still waiting")]);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe("Error: Stopped.");
    // Already aborted: it doesn't start at all.
    expect((await bash.execute("call", { command: "ls", status: "Listing" }, abort.signal)).isError).toBe(true);
  } finally {
    if (before === undefined) delete process.env.OPENBOTS_SOCKET; else process.env.OPENBOTS_SOCKET = before;
    server.closeAllConnections();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ all of it on a real Pi

const pi = piBin();

// Real Pi and the real extension against a fake model and a slow search: the nudge reaches the model
// with the slow tool's result, a real helper session answers meanwhile, and stop really ends the run.
test.skipIf(!pi)("on a real Pi: a steered message asks for an ack with no nudge of the runner's, a helper replies during a slow tool, and stop aborts it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-responsive-pi-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "shared-test-key" } }));
    const { code, stderr: err } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import { writeFileSync } from 'node:fs';
      const sse = (delta, finish) => 'data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish ?? null }] }) + '\\n\\n';
      const say = (text) => sse({ role: 'assistant', content: text }) + sse({}, 'stop') + 'data: [DONE]\\n\\n';
      const use = (name, args) => sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + name + Math.random().toString(36).slice(2, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) + sse({}, 'tool_calls') + 'data: [DONE]\\n\\n';
      const seen = { rule: false, nudge: false, steered: false, ack: false, held: false, helper: [], hung: false, unexpected: undefined, lookup: undefined, result: undefined };
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 120, async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/search') {
          if (url.searchParams.get('q') === 'hang') { seen.hung = true; await Bun.sleep(60_000); }
          else if (url.searchParams.get('q') === 'tea') await Bun.sleep(6000);
          return Response.json({ results: [{ title: 'Tea result', url: 'https://tea.test/', content: 'About tea' }] });
        }
        const body = await req.json();
        const system = JSON.stringify(body.messages.filter((m) => m.role === 'system' || m.role === 'developer'));
        const reply = (out) => new Response(out, { headers: { 'content-type': 'text/event-stream' } });
        if (system.includes('background helper session') && (body.tools ?? []).length) {
          // A helper that looks things up: the lookup tools and nothing else, and it knows whose it is.
          seen.lookup = { tools: body.tools.map((t) => t.function.name).sort(), system };
          return reply(body.messages.at(-1).role === 'tool' ? say('Found: ' + (JSON.stringify(body.messages.at(-1).content).includes('Tea result') ? 'Tea result' : 'nothing')) : use('bot_web_search', { query: 'quick', provider: 'searxng', status: 'Looking' }));
        }
        if (system.includes('background helper session')) {
          // The helper: no tools, the same model, and told what the main session is in the middle of.
          seen.helper.push({ model: body.model, tools: (body.tools ?? []).length, prompt: JSON.stringify(body.messages.at(-1).content) });
          return reply(say('Still searching, one sec.'));
        }
        const lastAssistant = body.messages.findLastIndex((m) => m.role === 'assistant');
        const tail = JSON.stringify(body.messages.slice(lastAssistant + 1));
        // The always-on prompt carries the rule: one quick ack before real work.
        seen.rule ||= system.includes('send one short ack with your first tool call');
        // The user's message, steered in: Pi hands it over once the call ahead of it is done, and it asks for the ack itself.
        if (tail.includes('how long')) { seen.steered = true; seen.ack = tail.includes('This arrived while you were working. Show you saw it before you go on'); }
        // The runner adds no message of its own to say so.
        if (tail.includes("hasn't heard from you yet")) seen.nudge = true;
        if (tail.includes('Your helper finished')) { seen.result = tail; return reply(say('[silent]')); }
        if (tail.includes('PING')) return reply(say('pong'));
        // Its message was held to show it what the helper already said; it sends its own after all.
        if (tail.includes('Not sent yet')) { seen.held = tail.includes('Still searching, one sec.'); return reply(use('send_message', { text: 'all done' })); }
        if (tail.includes('HANG')) return reply(use('bot_web_search', { query: 'hang', provider: 'searxng', status: 'Looking into it' }));
        if (tail.includes('Loaded bot_web_search')) return reply(use('bot_web_search', { query: 'tea', provider: 'searxng', status: 'Finding tea sources' }));
        if (tail.includes('Tea result')) {
          return reply(use('send_message', { text: 'all done' }));
        }
        if (tail.includes('SEARCH')) return reply(use('load_tools', { names: ['bot_web_search'] }));
        if (body.messages.at(-1).role === 'tool') return reply(say('[silent]'));
        seen.unexpected = tail.slice(0, 300);
        return reply(say('[silent]'));
      } });
      writeFileSync(process.env.PI_CODING_AGENT_DIR + '/models.json', JSON.stringify({ providers: { mock: { baseUrl: 'http://127.0.0.1:' + server.port + '/v1', api: 'openai-completions', models: [{ id: 'm' }] } } }));
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      svc.updateSettings({ defaultModel: 'mock/m', searxng: ['http://127.0.0.1:' + server.port], onboarding: 'done' });
      const alpha = svc.createBot({ name: 'Alpha' });
      runner.startBots();
      const own = alpha.conversationId;
      const post = (text) => svc.postMessage(own, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text });
      const said = () => db.messages(own, 50).filter((r) => !r.message.event).map((r) => r.message.text);
      const events = () => db.messages(own, 50).flatMap((r) => r.message.event ? [r.message.event.text] : []);
      const until = async (check, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end && !check()) await Bun.sleep(50); a.ok(check(), String(check) + ' ' + JSON.stringify({ said: said(), events: events(), status: svc.getStatus(alpha.bot.id) })); };

      post('SEARCH tea');
      await until(() => svc.getStatus(alpha.bot.id)?.activity === 'Finding tea sources');
      post('how long?');
      // The helper's reply lands while the search is still out.
      await until(() => said().includes('Still searching, one sec.'));
      a.ok(!said().includes('all done'));
      await until(() => said().includes('all done'));
      a.deepEqual(said(), ['SEARCH tea', 'how long?', 'Still searching, one sec.', 'all done']);
      // The model got their new message with the tool's result, asking for a quick ack; the runner steered nothing of its own.
      a.equal(seen.held, true);
      await until(() => seen.steered);
      a.equal(seen.ack, true);
      a.equal(seen.rule, true);
      a.equal(seen.nudge, false);
      a.equal(seen.unexpected, undefined);
      a.equal(seen.helper.length, 1);
      a.deepEqual([seen.helper[0].model, seen.helper[0].tools], ['m', 0]);
      a.match(seen.helper[0].prompt, /Finding tea sources/);
      await until(() => !runner.busy(alpha.bot.id));

      // A search that never comes back: stop ends the run now, not when the tool would have.
      post('HANG');
      await until(() => seen.hung && svc.getStatus(alpha.bot.id)?.activity === 'Looking into it');
      const began = Date.now();
      post('stop');
      await until(() => !runner.busy(alpha.bot.id) && !svc.getStatus(alpha.bot.id), 20000);
      a.ok(Date.now() - began < 20000);
      a.deepEqual(events().filter((t) => t !== 'Alpha stopped'), []);
      a.equal(events().length, 1);
      a.deepEqual(said().slice(-2), ['HANG', 'stop']);
      // The same Pi and session carry on with the next message.
      post('PING');
      await until(() => said().at(-1) === 'pong');
      await until(() => !runner.busy(alpha.bot.id));
      a.deepEqual(events(), ['Alpha stopped']);

      // A handed-off check: a real helper session with the lookup tools runs it, and its answer wakes the bot.
      const agent = await import('./server/bots/agent.ts');
      a.equal(agent.background(alpha.bot.id, { task: 'LOOKUP the tea result.' }).started, true);
      await until(() => seen.result);
      a.match(seen.result, /Found: Tea result/);
      a.deepEqual(seen.lookup.tools, ['bash', 'bot_web_search', 'read', 'search']);
      a.match(seen.lookup.system, /You're working for Alpha/);
      await until(() => !runner.busy(alpha.bot.id));
      a.equal(said().at(-1), 'pong');
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: join(dir, "data"), PI_CODING_AGENT_DIR: agentDir, PI_BIN: pi!, PI_OFFLINE: "1", OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json") });
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
