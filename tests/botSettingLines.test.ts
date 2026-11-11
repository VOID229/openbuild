import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

// Each script runs against its own data directory, in a process of its own.
async function run(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bot-setting-lines-"));
  try {
    const { code, stderr: err } = await spawnScript(script, { OPENCHAT_DATA_DIR: dir, PI_CODING_AGENT_DIR: join(dir, "pi") });
    expect(err.replace(/^\[bots\] [0-9a-f-]{36} fallback xai\/grok-4.7 → openai\/gpt-6.1-sol: down\n/gm, "")).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// What every script starts with: two bots, a paired laptop, a project, and the app's PATCH route.
const SETUP = `
  import { strict as a } from 'node:assert';
  import { mock } from 'bun:test';
  mock.module('./server/computers/api.ts', () => ({ computerApi: () => ({ call: async () => ({}) }), computerTargets: async () => [
    { device: 'local', name: 'Studio', status: 'ready', grants: { files: true, terminal: true, browser: true, unisolated: true }, engines: ['podman'] },
    { device: 'dev1', name: 'Laptop', status: 'ready', grants: { files: true, terminal: true, browser: true, unisolated: true } },
  ] }));
  const realExtensions = await import('./server/bots/extensions.ts');
  mock.module('./server/bots/extensions.ts', () => ({ ...realExtensions, botModels: async () => ({ models: [{ provider: 'xai', id: 'grok-4.7', name: 'Grok 4.7' }, { provider: 'openai', id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol' }] }) }));
  const devices = await import('./server/devices.ts');
  devices.addDevice({ id: 'dev1', name: 'Laptop', mode: 'lan', urls: ['http://x'], token: 't' });
  const db = await import('./server/bots/db.ts');
  const svc = await import('./server/bots/service.ts');
  const { manage } = await import('./server/bots/agent.ts');
  const wakes = [];
  svc.setHooks({ wake: (id, w) => wakes.push([id, w]), stop() {} });
  svc.rememberModelNames([{ provider: 'xai', id: 'grok-4.7', name: 'Grok 4.7' }, { provider: 'openai', id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol' }]);
  const primary = svc.createBot({ name: 'Boss' }).bot;
  const helper = svc.createBot({ name: 'Juniper' }).bot;
  const { botRoutes } = await import('./server/bots/routes.ts');
  const routes = botRoutes((h) => h);
  const patch = async (id, body) => {
    const req = new Request('http://x/api/bots/' + id, { method: 'PATCH', body: JSON.stringify(body) });
    req.params = { id };
    const res = await routes['/api/bots/:id'].PATCH(req);
    a.equal(res.status, 200);
  };
  // The activity lines in a bot's own chat, oldest first.
  const lines = (bot) => db.messages(svc.directId(bot.id), 500).map((r) => r.message).filter((m) => m.event?.kind === 'changed');
  const texts = (bot) => lines(bot).map((m) => m.event.text);
`;

test("a change in the app's settings posts one activity line in the bot's chat, old value to new", async () => {
  await run(`${SETUP}
    await patch(helper.id, { model: 'xai/grok-4.7' });
    await patch(helper.id, { model: 'openai/gpt-6.1-sol' });
    await patch(helper.id, { effort: 'high' });
    await patch(helper.id, { fallbackModels: ['xai/grok-4.7'] });
    await patch(helper.id, { noFallbacks: true });
    // Bots reach every machine now: a computer in a patch changes nothing and says nothing.
    await patch(helper.id, { computer: { device: 'dev1', kind: 'host' } });
    await patch(helper.id, { proactivity: 'high' });
    a.deepEqual(texts(helper), [
      "Juniper's model: default → Grok 4.7",
      "Juniper's model: Grok 4.7 → GPT 6.1 Sol",
      "Juniper's effort: default → high",
      "Juniper's fallbacks: the defaults → Grok 4.7",
      "Juniper's fallbacks: Grok 4.7 → none",
      "Juniper's check-ins: every 3 hours → every hour",
    ]);
    // An activity line, by the bot in its own chat, about it: no bubble, no unread mark, no wake-up.
    const [first] = lines(helper);
    a.deepEqual([first.author, first.text, first.event.bot], [helper.id, '', helper.id]);
    a.equal(db.getConversation(svc.directId(helper.id)).unread, undefined);
    a.equal(wakes.length, 0);
    a.deepEqual(texts(primary), []);
    process.exit(0);
  `);
});

test("OpenBuild access names its projects and the switches that changed", async () => {
  await run(`${SETUP}
    const { addProject } = await import('./server/projects.ts');
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const site = await addProject(mkdtempSync(join(process.env.OPENCHAT_DATA_DIR, 'site-')));
    const base = { enabled: true, scope: 'choose', projects: [site.id] };
    await patch(helper.id, { threads: base });
    await patch(helper.id, { threads: { ...base, merge: true, approve: true } });
    await patch(helper.id, { threads: { ...base, merge: true, approve: true, scope: 'all' } });
    await patch(helper.id, { threads: { ...base, enabled: false, merge: true, approve: true, scope: 'all' } });
    a.deepEqual(texts(helper), [
      \`Juniper's OpenBuild: off → on; OpenBuild projects: none → \${site.name}\`,
      "Juniper's answer permission prompts: off → on; merge pull requests: off → on",
      \`Juniper's OpenBuild projects: \${site.name} → all\`,
      "Juniper's OpenBuild: on → off",
    ]);
    process.exit(0);
  `);
});

test("a save that changes several settings is one line; one that changes nothing is none", async () => {
  await run(`${SETUP}
    await patch(helper.id, { model: 'xai/grok-4.7', effort: 'low', computer: { device: 'local', kind: 'host' } });
    a.deepEqual(texts(helper), ["Juniper's model: default → Grok 4.7; effort: default → low"]);
    // The same values again, the defaults said out loud, and fields that aren't announced.
    await patch(helper.id, { model: 'xai/grok-4.7', effort: 'low', computer: { device: 'local', kind: 'host' } });
    await patch(primary.id, { proactivity: 'normal', computer: { device: 'local', kind: 'container' }, effort: '' });
    await patch(helper.id, { instructions: 'Keep notes.', look: { shape: 'orb', color: 'green' } });
    a.equal(lines(helper).length, 1);
    a.deepEqual(texts(primary), []);
    // A bot getting its first computer by default (the first computer tool call) changes nothing it shows.
    svc.updateBot(primary.id, { computer: { device: 'local', kind: 'container' } });
    a.deepEqual(texts(primary), []);
    process.exit(0);
  `);
});

test("the primary's manage_bot changes post the same lines, and a new bot's first settings don't", async () => {
  await run(`${SETUP}
    await manage(primary.id, { action: 'update', bot: 'Juniper', model: 'openai/gpt-6.1-sol', effort: 'max' });
    // Refused whole: nothing changes, nothing is said.
    a.throws(() => manage(primary.id, { action: 'update', bot: 'Juniper', runs_on: 'Laptop' }), /Nothing changed/);
    await manage(primary.id, { action: 'update', bot: 'Juniper', effort: 'max' });
    await manage(primary.id, { action: 'update', fallback: 'none' });
    a.deepEqual(texts(helper), [
      "Juniper's model: default → GPT 6.1 Sol; effort: default → max",
    ]);
    a.deepEqual(texts(primary), ["Boss's fallbacks: the defaults → none"]);
    // Made with a model: the "New bot" line is all there is.
    const made = await manage(primary.id, { action: 'create', name: 'Scout', model: 'xai/grok-4.7' });
    a.equal(db.getBot(made.id).model, 'xai/grok-4.7');
    a.deepEqual(texts({ id: made.id }), []);
    a.equal(wakes.filter(([, w]) => w.kind !== 'note').length, 0);
    process.exit(0);
  `);
});

test("a setting the list doesn't know yet still gets a line, without values that aren't plain", async () => {
  await run(`${SETUP}
    const bot = db.getBot(helper.id);
    a.deepEqual(svc.settingChanges(bot, { ...bot, sandbox: 'strict' }), ['sandbox: unset → strict']);
    a.deepEqual(svc.settingChanges(bot, { ...bot, machines: { dev1: { tools: ['files'] } } }), ['machines: changed']);
    a.deepEqual(svc.settingChanges(bot, { ...bot, instructions: 'New.', look: { shape: 'orb', color: 'red' }, createdAt: 1 }), []);
    process.exit(0);
  `);
});

test("a model changed while a fallback answers isn't announced again as that model coming back", async () => {
  await run(`${SETUP}
    const { withFallbacks } = await import('./server/bots/runner.ts');
    const { ModelFailure } = await import('./server/bots/runner.ts');
    await patch(helper.id, { model: 'xai/grok-4.7', fallbackModels: ['openai/gpt-6.1-sol'] });
    const chain = () => [db.getBot(helper.id).model, 'openai/gpt-6.1-sol'];
    // The primary fails and the fallback takes over: that notice is as it was.
    await withFallbacks(helper.id, undefined, chain(), async (model, i, ran) => {
      if (i === 0) throw new ModelFailure('down');
      ran({ name: 'GPT 6.1 Sol' });
    });
    // The user picks another model; it answers. The settings line said so, and nothing else does.
    await patch(helper.id, { model: 'xai/grok-5' });
    await withFallbacks(helper.id, undefined, chain(), async (model, i, ran) => ran({ name: 'Grok 5' }));
    const events = db.messages(svc.directId(helper.id), 500).map((r) => r.message.event).filter(Boolean).map((e) => [e.kind, e.text]);
    a.deepEqual(events, [
      ['changed', "Juniper's model: default → Grok 4.7; fallbacks: the defaults → GPT 6.1 Sol"],
      ['model', 'Switched to GPT 6.1 Sol'],
      ['changed', "Juniper's model: Grok 4.7 → grok-5"],
    ]);
    process.exit(0);
  `);
});
