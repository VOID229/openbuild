// A bot pointed at a group (Bot.target) mainly works there: what would go to its own chat (check-ins,
// routines that name no chat, background results, errors) goes to the group, with its status and the
// mascots that show it at work. The user sets it from the app (PATCH /api/bots/:id) and the bot itself
// with manage_bot target. A message the user writes in its own chat is still answered there.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { busyBots, homeHere, stoppable } from "../src/lib/bots/activity";
import { validTarget, type BotStatus } from "../shared/bots";
import { spawnScript } from "./spawnScript";

const solo = { id: "solo", kind: "direct" as const, botIds: ["pip"] };
const group = { id: "dev", kind: "group" as const, botIds: ["pip", "egg"] };
const other = { id: "ops", kind: "group" as const, botIds: ["pip"] };

test("the group a bot is pointed at stands for it as its own chat does otherwise", () => {
  const working: BotStatus = { state: "working", activity: "Running the tests", conversationId: "ops" };
  // No target: its own chat shows it busy wherever it works, and a group only its work there.
  expect(homeHere(solo, working)).toBe(true);
  expect(busyBots(solo, { pip: working }, {})).toEqual(["pip"]);
  expect(busyBots(group, { pip: working }, {})).toEqual([]);
  expect(stoppable(solo, { pip: working })).toEqual(["pip"]);
  // Pointed at Dev: Dev shows it busy (and can stop it) wherever it works, and its own chat doesn't.
  const pointed = { ...working, home: "dev" };
  expect(homeHere(group, pointed)).toBe(true);
  expect(homeHere(solo, pointed)).toBe(false);
  expect(busyBots(group, { pip: pointed }, {})).toEqual(["pip"]);
  expect(busyBots(solo, { pip: pointed }, {})).toEqual([]);
  expect(stoppable(group, { pip: pointed })).toEqual(["pip"]);
  expect(stoppable(solo, { pip: pointed })).toEqual([]);
  // At work in its own chat, that chat shows it there still.
  expect(busyBots(solo, { pip: { ...pointed, conversationId: "solo" } }, {})).toEqual(["pip"]);
  // And another group it's in shows nothing of work that isn't there.
  expect(busyBots(other, { pip: { ...pointed, conversationId: "solo" } }, {})).toEqual([]);
});

test("only a group the bot is in, and not one shared with a friend, can be its target", () => {
  expect(validTarget(group, "pip")).toBe(true);
  expect(validTarget(group, "tally")).toBe(false);
  expect(validTarget(solo, "pip")).toBe(false);
  expect(validTarget({ ...group, friend: { friend: "f", friendName: "Alice", members: [] } as never }, "pip")).toBe(false);
  expect(validTarget(undefined, "pip")).toBe(false);
});

test("a target is set and cleared by the user and the bot, persists, and routes the bot's own-chat work to the group", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-target-"));
  try {
    const { code, stderr } = await spawnScript(
      `
      import { strict as a } from 'node:assert';
      const svc = await import('./server/bots/service.ts');
      const db = await import('./server/bots/db.ts');
      const agent = await import('./server/bots/agent.ts');
      const wakes = [];
      svc.setHooks({ wake: (botId, wake) => wakes.push({ botId, ...wake }), stop() {} });
      svc.updateSettings({ quietHours: { from: 0, to: 0 } });
      const egg = svc.createBot({ name: 'Eggbot' });
      svc.updateBot(egg.bot.id, { primary: true });
      const pip = svc.createBot({ name: 'Pip' });
      const dev = svc.createConversation({ kind: 'group', name: 'Dev', botIds: [egg.bot.id, pip.bot.id] });
      const tally = svc.createBot({ name: 'Tally' });
      const ops = svc.createConversation({ kind: 'group', name: 'Ops', botIds: [egg.bot.id, tally.bot.id] });
      const events = id => db.messages(id, 50).map(r => r.message.event?.text).filter(Boolean);

      // No target: its own chat.
      a.equal(svc.homeId(pip.bot.id), pip.conversationId);

      // The user points it at Dev from the app.
      svc.updateBot(pip.bot.id, { target: dev.id }, { by: 'me' });
      a.equal(db.getBot(pip.bot.id).target, dev.id);
      a.equal(svc.fullBot(pip.bot.id).target, dev.id);
      a.equal(svc.homeId(pip.bot.id), dev.id);
      a.ok(events(dev.id).includes('Pip now works here'));
      a.ok(events(pip.conversationId).includes('Pip now works in a group'));
      // Nothing else about it changed, so no settings line says so.
      a.ok(!events(pip.conversationId).some(t => /target/.test(t)));

      // Its status names the group that stands for it.
      svc.setStatus(pip.bot.id, { state: 'working', activity: 'Checking in', conversationId: dev.id });
      a.equal(svc.getStatus(pip.bot.id).home, dev.id);

      // A check-in goes to the group.
      wakes.length = 0;
      svc.tick(() => false);
      const beat = wakes.find(w => w.botId === pip.bot.id && w.kind === 'heartbeat');
      a.ok(beat, 'a heartbeat');
      a.equal(beat.conversationId, dev.id);

      // A routine that names no chat, and one that reports to its own chat (where it was made), run in
      // the group. One that names another chat still runs there.
      const due = Date.now() - 1000;
      db.putRoutine(pip.bot.id, { id: crypto.randomUUID(), title: 'Morning summary', schedule: 'in 2 hours', enabled: true, followUp: true, nextRunAt: due, createdAt: due });
      db.putRoutine(pip.bot.id, { id: crypto.randomUUID(), title: 'Standup', schedule: 'in 2 hours', enabled: true, followUp: true, conversationId: pip.conversationId, nextRunAt: due, createdAt: due });
      wakes.length = 0;
      svc.tick(() => true);
      const routines = wakes.filter(w => w.botId === pip.bot.id && w.kind === 'routine');
      a.deepEqual(routines.map(w => w.conversationId), [dev.id, dev.id]);
      a.ok(events(dev.id).includes('Followed up'));

      // A group it isn't in, or one shared with a friend, can't be its target.
      a.throws(() => svc.updateBot(pip.bot.id, { target: ops.id }, { by: 'me' }), /a group it's in/);
      const shared = svc.createConversation({ kind: 'group', name: 'With Alice', botIds: [pip.bot.id], friend: { friend: 'f1', friendName: 'Alice', members: [] } });
      a.throws(() => svc.setTarget(pip.bot.id, shared.id), /shared with a friend/);
      a.equal(svc.homeId(pip.bot.id), dev.id);

      // The bot points itself back at its own chat, and then at Dev again.
      const back = agent.manage(pip.bot.id, { action: 'target', conversation: 'own' });
      a.equal(back.target, null);
      a.equal(db.getBot(pip.bot.id).target, undefined);
      a.equal(svc.homeId(pip.bot.id), pip.conversationId);
      a.ok(events(pip.conversationId).includes('Pip works in its own chat again'));
      svc.setStatus(pip.bot.id, { state: 'working', activity: 'Checking in', conversationId: dev.id });
      a.equal(svc.getStatus(pip.bot.id).home, undefined);
      const again = agent.manage(pip.bot.id, { action: 'target', conversation: dev.id.slice(0, 8) });
      a.equal(again.target, dev.id.slice(0, 8));
      a.equal(svc.homeId(pip.bot.id), dev.id);
      // Its status follows at once.
      a.equal(svc.getStatus(pip.bot.id).home, dev.id);
      // Its context says where it works, and how to go back.
      a.match(agent.contextSections(pip.bot.id).openbots_team, /You're pointed at the group “Dev”/);
      a.doesNotMatch(agent.contextSections(egg.bot.id).openbots_team, /pointed at/);

      // Another bot can't point it anywhere; the primary can.
      a.throws(() => agent.manage(pip.bot.id, { action: 'target', bot: 'Eggbot', conversation: dev.id }), /only point yourself/);
      agent.manage(egg.bot.id, { action: 'target', bot: 'Pip', conversation: 'own' });
      a.equal(svc.homeId(pip.bot.id), pip.conversationId);
      agent.manage(egg.bot.id, { action: 'target', bot: 'Pip', conversation: dev.id });
      a.equal(svc.homeId(pip.bot.id), dev.id);

      // Taken out of the group, it goes back to its own chat.
      svc.updateConversation(dev.id, { botIds: [egg.bot.id] });
      a.equal(db.getBot(pip.bot.id).target, undefined);
      a.equal(svc.homeId(pip.bot.id), pip.conversationId);

      // And a group that's deleted takes the target with it.
      const qa = svc.createConversation({ kind: 'group', name: 'QA', botIds: [egg.bot.id, pip.bot.id] });
      svc.setTarget(pip.bot.id, qa.id, { by: 'me' });
      svc.deleteConversation(qa.id);
      a.equal(db.getBot(pip.bot.id).target, undefined);
      a.equal(svc.homeId(pip.bot.id), pip.conversationId);
      process.exit(0);
    `,
      { OPENCHAT_DATA_DIR: dir },
    );
    expect(stderr).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a pointed bot's turn with no chat of its own runs in the group, while a message in its own chat is answered there", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-target-turn-"));
  try {
    const { code, stderr } = await spawnScript(
      `
      import { strict as a } from 'node:assert';
      const minds = globalThis.openbotsMinds = new Map();
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const agent = await import('./server/bots/agent.ts');
      const db = await import('./server/bots/db.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
      // A bot is one session in all its chats (#373): the fake mind is that one, wherever the bot is focused.
      const sessionPathFor = id => sessionGeneration(runner.sessionHome(id));
      const { busyBots } = await import('./src/lib/bots/activity.ts');
      const helpers = await import('./server/bots/helpers.ts');
      helpers.seams.spawn = () => ({ send: async (cmd) => (cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {}), on: () => () => {}, close() {} });
      const pip = svc.createBot({ name: 'Pip' });
      const egg = svc.createBot({ name: 'Eggbot' });
      const dev = svc.createConversation({ kind: 'group', name: 'Dev', botIds: [egg.bot.id, pip.bot.id] });
      const prompts = [];
      const mind = { token: 'test', loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), close() {}, async send(cmd) {
        if (cmd.type === 'prompt') prompts.push({ ...cmd, finish() { mind.onSettled?.(); } });
        return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
      } } };
      Object.defineProperty(mind, 'sessionPath', { get: () => sessionPathFor(pip.bot.id) });
      minds.set(pip.bot.id, mind);
      svc.setHooks({ wake: runner.wake, stop: runner.stop });
      const until = async check => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); a.ok(check()); };
      const snap = () => svc.snapshot();
      const own = { id: pip.conversationId, kind: 'direct', botIds: [pip.bot.id] };
      svc.setTarget(pip.bot.id, dev.id, { by: 'me' });

      // A note with no chat of its own (a process that finished, say): its turn is in Dev.
      runner.wake(pip.bot.id, { kind: 'note', text: 'A process on your computer finished.' });
      await until(() => prompts.length === 1 && mind.steerable);
      runner.onRecord(pip.bot.id, mind, { type: 'tool_execution_start', toolName: 'bash', args: { status: 'Reading the log' } });
      const st = snap().status[pip.bot.id];
      a.equal(st.conversationId, dev.id);
      a.equal(st.home, dev.id);
      a.deepEqual(busyBots(dev, snap().status, snap().typing), [pip.bot.id]);
      a.deepEqual(busyBots(own, snap().status, snap().typing), []);
      // What it writes without naming a chat goes to the group.
      await agent.sendMessage(pip.bot.id, { text: 'The build finished: all green.' });
      a.ok(db.messages(dev.id, 20).some(r => r.message.author === pip.bot.id && r.message.text === 'The build finished: all green.'));
      a.ok(!db.messages(pip.conversationId, 20).some(r => r.message.text === 'The build finished: all green.'));
      prompts[0].finish();
      await until(() => snap().status[pip.bot.id]?.state !== 'working');

      // The user writes in its own chat: that's where it answers.
      svc.postMessage(pip.conversationId, { id: crypto.randomUUID(), author: 'me', text: 'Quick one, just between us', at: Date.now() });
      await until(() => prompts.length === 2 && mind.steerable);
      a.equal(snap().status[pip.bot.id].conversationId, pip.conversationId);
      a.deepEqual(busyBots(own, snap().status, snap().typing), [pip.bot.id]);
      await agent.sendMessage(pip.bot.id, { text: 'Sure, here.' });
      a.ok(db.messages(pip.conversationId, 20).some(r => r.message.author === pip.bot.id && r.message.text === 'Sure, here.'));
      prompts[1].finish();
      process.exit(0);
    `,
      { OPENCHAT_DATA_DIR: dir },
    );
    expect(stderr).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
