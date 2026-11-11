import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

// Each script runs against its own data directory, in a process of its own.
async function run(script: string, setup: (dir: string) => Promise<void> = async () => {}) {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bot-primary-settings-"));
  try {
    await setup(dir);
    const { code, stderr: err } = await spawnScript(script, { OPENCHAT_DATA_DIR: dir, PI_CODING_AGENT_DIR: join(dir, "pi") });
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("manage_bot computers lists every machine for any bot, and runs_on or isolation are refused whole", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    import { mock } from 'bun:test';
    let targets = [
      { device: 'local', name: 'Studio', status: 'ready', grants: { files: true, terminal: true, browser: true, unisolated: true }, engines: ['podman'] },
      { device: 'dev1', name: 'Laptop', status: 'ready', grants: { files: true, terminal: true, browser: false, unisolated: false } },
      { device: 'dev2', name: 'Tower', status: 'offline', message: 'Tower is unreachable (no answer). Nothing ran.' },
      { device: 'dev3', name: 'MacBook', status: 'access', grants: { files: false, terminal: false, browser: false, unisolated: false } },
    ];
    mock.module('./server/computers/api.ts', () => ({ computerApi: () => ({ call: async () => ({}) }), computerTargets: async () => targets }));
    const devices = await import('./server/devices.ts');
    for (const [id, name] of [['dev1', 'Laptop'], ['dev2', 'Tower'], ['dev3', 'MacBook']]) devices.addDevice({ id, name, mode: 'lan', urls: ['http://x'], token: 't' });
    const db = await import('./server/bots/db.ts');
    const svc = await import('./server/bots/service.ts');
    const { manage, contextFor } = await import('./server/bots/agent.ts');
    const { machinesNote, setIsolation } = await import('./server/bots/machines.ts');
    svc.setHooks({ wake() {}, stop() {} });
    const primary = svc.createBot({ name: 'Boss' }).bot;
    const helper = svc.createBot({ name: 'Helper' }).bot;
    a.match(contextFor(primary.id), /manage_bot computers lists them/);
    a.match(contextFor(primary.id), /set per machine by the user, in Settings → Devices/);
    a.doesNotMatch(contextFor(primary.id), /runs_on/);

    // Every machine with its status, tools and isolation: no single choice, and any bot may look.
    setIsolation('dev1', 'host');
    for (const who of [primary.id, helper.id]) {
      const listed = await manage(who, { action: 'computers' });
      a.deepEqual(listed.computers.map((c) => [c.id, c.name, c.status, c.tools, c.isolation]), [
        ['local', 'Studio (this server)', 'ready', ['files', 'terminal', 'browser'], 'container'],
        ['dev1', 'Laptop', 'ready', ['files', 'terminal'], 'host'],
        ['dev2', 'Tower', 'offline', [], 'container'],
        ['dev3', 'MacBook', 'access', [], 'container'],
      ]);
      a.match(listed.computers[2].message, /unreachable/);
      a.equal('bots' in listed, false);
      a.match(listed.note, /Every bot reaches every ready machine/);
    }

    // Each bot's context lists them, with what's wrong where and how the owner allows it.
    const note = await machinesNote();
    a.match(note, /run on this server unless you pass machine/);
    a.match(note, /- Studio \\(this server, used when you don't name one\\): files, terminal, browser; container\\./);
    a.match(note, /- Laptop \\(machine id dev1\\): files, terminal \\(not browser\\); host chosen, but it only allows a container, so its tools fail\\./);
    a.match(note, /- Tower \\(machine id dev2\\): unreachable right now/);
    a.match(note, /- MacBook \\(machine id dev3\\): hasn't allowed this server's bots anything. Its owner allows them on MacBook, in Settings → Devices → Using this device → /);
    a.match(note, /never runs somewhere else instead/);

    // runs_on and isolation chose one computer: refused whole, for create and update, primary or not, writing nothing.
    const refused = /Bots don't have one computer to choose anymore: every bot reaches every machine.*Nothing changed/;
    const before = JSON.stringify(db.listBots());
    for (const params of [{ runs_on: 'Laptop' }, { isolation: 'host' }, { runs_on: 'local', isolation: 'container', effort: 'high' }]) {
      a.throws(() => manage(primary.id, { action: 'update', bot: 'Helper', name: 'Renamed', ...params }), refused);
      a.throws(() => manage(helper.id, { action: 'update', ...params }), refused);
    }
    a.throws(() => manage(primary.id, { action: 'create', name: 'Scout', runs_on: 'dev1' }), refused);
    a.equal(JSON.stringify(db.listBots()), before);
    process.exit(0);
  `);
});

test("a computer saved by an earlier build stays as it was and doesn't steer any tool", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    import { mock } from 'bun:test';
    const calls = [];
    mock.module('./server/computers/index.ts', () => ({ capabilities: async () => ({ engines: ['podman'] }), engines: async () => ['podman'], procListeners: new Set() }));
    mock.module('./server/computers/api.ts', () => ({ computerApi: (device) => ({ call: async (id, op, body) => (calls.push([device, op, body.kind]), {}), exec: async () => ({ exitCode: 0 }) }), computerTargets: async () => [] }));
    const devices = await import('./server/devices.ts');
    devices.addDevice({ id: 'dev1', name: 'Laptop', mode: 'lan', urls: ['http://x'], token: 't' });
    const db = await import('./server/bots/db.ts');
    const svc = await import('./server/bots/service.ts');
    const { manage } = await import('./server/bots/agent.ts');
    const { computerOn } = await import('./server/bots/machines.ts');
    svc.setHooks({ wake() {}, stop() {} });
    const primary = svc.createBot({ name: 'Boss' }).bot;
    db.putBot({ ...db.getBot(primary.id), computer: { device: 'dev1', kind: 'host' } });
    // The default is this server, in its container, not the saved device or kind.
    await computerOn(primary.id, undefined);
    a.deepEqual(calls.at(-1), ['local', 'ensure', 'container']);
    // The app can't change it either: a computer in a patch is ignored.
    svc.updateBot(primary.id, { computer: { device: 'local', kind: 'container' }, name: 'Boss' }, { by: 'me' });
    a.deepEqual(db.getBot(primary.id).computer, { device: 'dev1', kind: 'host' });
    a.deepEqual(svc.pendingChangeNotes(primary.id), []);
    // A note about it from before is dropped, and nothing else about the bot is lost.
    db.setValue('change-notes', [{ botId: primary.id, field: 'computer', from: 'not chosen yet', to: 'Laptop, container', at: 1 }]);
    a.deepEqual(svc.pendingChangeNotes(primary.id), []);
    a.equal(db.getBot(primary.id).name, 'Boss');
    a.equal((await manage(primary.id, { action: 'computers' })).computers.length, 0);
    process.exit(0);
  `);
});

test("a bot's effort goes from the app or manage_bot to Pi, and back to Pi's default when cleared", async () => {
  await run(
    `
    import { strict as a } from 'node:assert';
    const db = await import('./server/bots/db.ts');
    const svc = await import('./server/bots/service.ts');
    const { manage } = await import('./server/bots/agent.ts');
    const { applyEffort } = await import('./server/bots/runner.ts');
    svc.setHooks({ wake() {}, stop() {} });
    const primary = svc.createBot({ name: 'Boss' }).bot;
    const pi = (levels) => { const sent = []; return { sent, proc: { send: async (cmd) => (sent.push(cmd), cmd.type === 'get_available_thinking_levels' ? { levels } : undefined) } }; };

    // From the app: a level is saved, empty or null clears it, anything else is refused.
    svc.updateBot(primary.id, { effort: 'xhigh' }, { by: 'me' });
    a.equal(db.getBot(primary.id).effort, 'xhigh');
    let p = pi(['off', 'low', 'medium', 'high', 'xhigh']);
    await applyEffort(p.proc, primary.id);
    a.deepEqual(p.sent.at(-1), { type: 'set_thinking_level', level: 'xhigh' });
    a.throws(() => svc.updateBot(primary.id, { effort: 'turbo' }), /Effort is off, minimal/);
    a.equal(db.getBot(primary.id).effort, 'xhigh');
    svc.updateBot(primary.id, { effort: '' }, { by: 'me' });
    a.equal(db.getBot(primary.id).effort, undefined);
    // Pi keeps the last level in a running process, so default is asked for: Pi's own default level, clamped to the model.
    p = pi(['off', 'low', 'medium', 'high', 'xhigh']);
    await applyEffort(p.proc, primary.id);
    a.deepEqual(p.sent.at(-1), { type: 'set_thinking_level', level: 'low' });
    p = pi(['off', 'high']);
    await applyEffort(p.proc, primary.id);
    a.deepEqual(p.sent.at(-1), { type: 'set_thinking_level', level: 'off' });

    // From manage_bot: the same field, and default clears it the same way.
    await manage(primary.id, { action: 'update', effort: 'Max' });
    a.equal(db.getBot(primary.id).effort, 'max');
    await manage(primary.id, { action: 'update', effort: 'default' });
    a.equal(db.getBot(primary.id).effort, undefined);
    svc.updateBot(primary.id, { effort: 'high' });
    svc.updateBot(primary.id, { effort: null });
    a.equal(db.getBot(primary.id).effort, undefined);
    process.exit(0);
  `,
    async (dir) => {
      await Bun.write(join(dir, "pi", "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
    },
  );
});

test("what the user changes in a bot's settings reaches the primary once, on its next turn, as one note per setting", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    import { mock } from 'bun:test';
    mock.module('./server/computers/api.ts', () => ({ computerApi: () => ({ call: async () => ({}) }), computerTargets: async () => [{ device: 'local', name: 'Studio', status: 'ready', grants: { files: true, terminal: true, browser: true, unisolated: true }, engines: ['podman'] }] }));
    const db = await import('./server/bots/db.ts');
    const svc = await import('./server/bots/service.ts');
    const { manage } = await import('./server/bots/agent.ts');
    const wakes = [];
    svc.setHooks({ wake: (id, w) => wakes.push([id, w]), stop() {} });
    const primary = svc.createBot({ name: 'Boss' }).bot;
    const manager = svc.createBot({ name: 'Manager' }).bot;
    const gone = svc.createBot({ name: 'Gone' }).bot;
    svc.updateSettings({ user: { name: 'Outis' } });
    // Bubbles only: each change's activity line in the bot's own chat is tested in botSettingLines.
    const chats = () => [primary, manager].map((b) => db.messages(svc.directId(b.id), 500).filter((r) => !r.message.event).length).join();
    const before = chats();
    const text = () => svc.changeNoteText(primary.id, svc.pendingChangeNotes(primary.id));

    // The app's PATCH route is the user. A run of changes to one setting reads as one, from where it started.
    const { botRoutes } = await import('./server/bots/routes.ts');
    const routes = botRoutes((h) => h);
    const patch = async (id, body) => {
      const req = new Request('http://x/api/bots/' + id, { method: 'PATCH', body: JSON.stringify(body) });
      req.params = { id };
      const res = await routes['/api/bots/:id'].PATCH(req);
      a.equal(res.status, 200);
    };
    await patch(manager.id, { effort: 'medium' });
    await patch(manager.id, { effort: 'high' });
    await patch(manager.id, { model: 'google/gemini-4', instructions: 'Run the threads.' });
    // A computer from the app, as an older tab sends it, is ignored and not noted.
    await patch(manager.id, { computer: { device: 'local', kind: 'host' } });
    a.equal(db.getBot(manager.id).computer, undefined);
    await patch(manager.id, { fallbackModels: ['openai/gpt-6'] });
    await patch(primary.id, { noFallbacks: true });
    // Not noted: settings outside the list, and a change put back.
    await patch(manager.id, { name: 'Manager', proactivity: 'low', look: { shape: 'orb', color: 'green' } });
    await patch(primary.id, { model: 'google/gemini-4' });
    await patch(primary.id, { model: '' });
    await patch(gone.id, { effort: 'low' });
    await svc.deleteBot(gone.id);
    a.equal(text(), [
      'Since your last turn, in the app\\'s settings:',
      "- Outis changed Manager's effort from default to high.",
      "- Outis changed Manager's model from default to google/gemini-4.",
      "- Outis changed Manager's instructions.",
      "- Outis changed Manager's fallback models from the default fallbacks to openai/gpt-6.",
      '- Outis changed your fallback models from the default fallbacks to no fallback.',
      "That's just so you know; it needs no reply, and don't change it back unless asked.",
    ].join('\\n'));
    // No chat bubble, no wake-up, and only the primary hears.
    a.equal(chats(), before);
    a.equal(wakes.filter(([, w]) => w.kind !== 'messages').length, 0);
    a.deepEqual(svc.pendingChangeNotes(manager.id), []);

    // What the primary does itself isn't noted, and replaces the user's note on that setting: it knows what it set.
    await manage(primary.id, { action: 'update', bot: 'Manager', effort: 'low', instructions: 'Mine now.' });
    a.deepEqual(svc.pendingChangeNotes(primary.id).map((n) => n.field), ['model', 'fallbacks', 'fallbacks']);
    await patch(manager.id, { effort: 'xhigh' });
    a.match(text(), /Manager's effort from low to xhigh/);

    // Shown in a turn, they're done; one changed again meanwhile starts from what the primary saw.
    const shown = svc.pendingChangeNotes(primary.id);
    await Bun.sleep(2);
    await patch(manager.id, { model: 'openai/gpt-6' });
    svc.settleChangeNotes(primary.id, shown);
    a.equal(text().split('\\n')[1], "- Outis changed Manager's model from google/gemini-4 to openai/gpt-6.");
    a.equal(text().split('\\n').length, 3);
    svc.settleChangeNotes(primary.id, svc.pendingChangeNotes(primary.id));
    a.equal(text(), '');
    process.exit(0);
  `);
});

test("the primary's next turn opens with the note, and the turn after doesn't repeat it", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    const minds = globalThis.openbotsMinds = new Map();
    const svc = await import('./server/bots/service.ts');
    const runner = await import('./server/bots/runner.ts');
    const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
      const sessionPathFor = id => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', id, (globalThis.openbotsFocus?.get(id) ?? svc.directId(id))));
    const primary = svc.createBot({ name: 'Boss' });
    const helper = svc.createBot({ name: 'Helper' });
    svc.updateSettings({ user: { name: 'Outis' } });
    const prompts = [];
    for (const bot of [primary.bot, helper.bot]) {
      const mind = { token: 'test', loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), close() {}, async send(cmd) {
        if (cmd.type === 'prompt') prompts.push({ ...cmd, bot: bot.id, finish(text) { mind.draft = text; mind.onSettled?.(); } });
        return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
      } } };
      Object.defineProperty(mind, 'sessionPath', { get: () => sessionPathFor(bot.id) });
        minds.set(bot.id, mind);
    }
    svc.setHooks({ wake: runner.wake, stop: runner.stop });
    const until = async (check) => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); a.ok(check()); };
    const post = (where, text) => svc.postMessage(where, { id: crypto.randomUUID(), author: 'me', text, at: Date.now() });

    svc.updateBot(helper.bot.id, { effort: 'high' }, { by: 'me' });
    // Nothing wakes for it.
    await Bun.sleep(30);
    a.equal(prompts.length, 0);
    // Another bot's turn doesn't take it.
    post(helper.conversationId, 'hi helper');
    await until(() => prompts.length === 1);
    a.doesNotMatch(prompts[0].message, /changed/);
    prompts[0].finish('[silent]');
    await until(() => !runner.busy(helper.bot.id));
    post(primary.conversationId, 'hi boss');
    await until(() => prompts.length === 2);
    a.match(prompts[1].message, /^Since your last turn, in the app's settings:\\n- Outis changed Helper's effort from default to high\\./);
    a.match(prompts[1].message, /hi boss/);
    prompts[1].finish('[silent]');
    await until(() => !runner.busy(primary.bot.id));
    post(primary.conversationId, 'again');
    await until(() => prompts.length === 3);
    a.doesNotMatch(prompts[2].message, /Since your last turn/);
    prompts[2].finish('[silent]');
    await until(() => !runner.busy(primary.bot.id));
    process.exit(0);
  `);
});

test("a change the user takes back while the primary's turn is under way is corrected on its next turn", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    const minds = globalThis.openbotsMinds = new Map();
    const svc = await import('./server/bots/service.ts');
    const runner = await import('./server/bots/runner.ts');
    const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
      const sessionPathFor = id => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', id, (globalThis.openbotsFocus?.get(id) ?? svc.directId(id))));
    const primary = svc.createBot({ name: 'Boss' });
    const helper = svc.createBot({ name: 'Helper' });
    svc.updateSettings({ user: { name: 'Outis' } });
    const prompts = [];
    for (const bot of [primary.bot, helper.bot]) {
      const mind = { token: 'test', loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), close() {}, async send(cmd) {
        if (cmd.type === 'prompt') prompts.push({ ...cmd, bot: bot.id, finish(text) { mind.draft = text; mind.onSettled?.(); } });
        return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
      } } };
      Object.defineProperty(mind, 'sessionPath', { get: () => sessionPathFor(bot.id) });
        minds.set(bot.id, mind);
    }
    svc.setHooks({ wake: runner.wake, stop: runner.stop });
    const until = async (check) => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); a.ok(check()); };
    const post = (where, text) => svc.postMessage(where, { id: crypto.randomUUID(), author: 'me', text, at: Date.now() });
    const turn = async (where, bot, text) => {
      const n = prompts.length;
      post(where, text);
      await until(() => prompts.length === n + 1);
      return prompts[n];
    };
    const end = async (prompt) => { prompt.finish('[silent]'); await until(() => !runner.busy(prompt.bot)); };

    // The primary takes default → high into a turn; the user puts it back to default before the turn ends,
    // and another bot's turn ends meanwhile too.
    svc.updateBot(helper.bot.id, { effort: 'high' }, { by: 'me' });
    const first = await turn(primary.conversationId, primary.bot, 'one');
    a.match(first.message, /Helper's effort from default to high\\./);
    svc.updateBot(helper.bot.id, { effort: '' }, { by: 'me' });
    a.equal(svc.changeNoteText(primary.bot.id, svc.pendingChangeNotes(primary.bot.id)), '');
    await end(await turn(helper.conversationId, helper.bot, 'meanwhile'));
    await end(first);
    // It last heard high, so it hears it's back to default, once.
    const second = await turn(primary.conversationId, primary.bot, 'two');
    a.match(second.message, /- Outis changed Helper's effort from high to default\\./);
    await end(second);
    const third = await turn(primary.conversationId, primary.bot, 'three');
    a.doesNotMatch(third.message, /Since your last turn/);
    await end(third);

    // Taken back before the primary ever saw it: nothing to say, then or later.
    svc.updateBot(helper.bot.id, { model: 'google/gemini-4' }, { by: 'me' });
    svc.updateBot(helper.bot.id, { model: '' }, { by: 'me' });
    const fourth = await turn(primary.conversationId, primary.bot, 'four');
    a.doesNotMatch(fourth.message, /Since your last turn/);
    await end(fourth);
    a.deepEqual(svc.pendingChangeNotes(primary.bot.id), []);
    process.exit(0);
  `);
});

test("a settings correction survives edits in the same millisecond as the note the primary saw", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    const svc = await import('./server/bots/service.ts');
    svc.setHooks({ wake() {}, stop() {} });
    const primary = svc.createBot({ name: 'Boss' }).bot;
    const helper = svc.createBot({ name: 'Helper' }).bot;
    Date.now = () => 1_800_000_000_000;

    svc.updateBot(helper.id, { effort: 'high' }, { by: 'me' });
    const shown = svc.pendingChangeNotes(primary.id);
    a.equal(shown.length, 1);
    a.equal(shown[0].to, 'high');
    // The user takes it back after the primary read it, without the clock advancing.
    svc.updateBot(helper.id, { effort: '' }, { by: 'me' });
    svc.settleChangeNotes(primary.id, shown);
    const correction = svc.pendingChangeNotes(primary.id);
    a.equal(correction.length, 1, 'the primary still needs the correction');
    a.equal(correction[0].at, shown[0].at);
    a.deepEqual([correction[0].from, correction[0].to], ['high', 'default']);
    a.match(svc.changeNoteText(primary.id, correction), /Helper's effort from high to default/);
    // Once the correction is shown, it is consumed even though its timestamp is unchanged.
    svc.settleChangeNotes(primary.id, correction);
    a.deepEqual(svc.pendingChangeNotes(primary.id), []);

    // Edits ending at the value it already saw need no correction.
    svc.updateBot(helper.id, { effort: 'high' }, { by: 'me' });
    const same = svc.pendingChangeNotes(primary.id);
    svc.updateBot(helper.id, { effort: 'low' }, { by: 'me' });
    svc.updateBot(helper.id, { effort: 'high' }, { by: 'me' });
    svc.settleChangeNotes(primary.id, same);
    a.deepEqual(svc.pendingChangeNotes(primary.id), []);
    process.exit(0);
  `);
});
