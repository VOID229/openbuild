import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

// Bots run on each machine's host unless the user chose a container there (Settings → Devices). A
// paired device whose owner allows only a container gets one until the user chooses, since the host
// would only fail there. A choice is saved either way and stays. Each script runs against its own
// data directory, in a process of its own; the machines and their grants are faked.
async function run(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bot-isolation-default-"));
  try {
    const { code, stderr: err } = await spawnScript(script, { OPENCHAT_DATA_DIR: dir, PI_CODING_AGENT_DIR: join(dir, "pi") });
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const FAKES = `
  import { strict as a } from 'node:assert';
  import { mock } from 'bun:test';
  const all = { files: true, terminal: true, browser: true, unisolated: true };
  const contained = { files: true, terminal: true, browser: true, unisolated: false };
  const grants = { open: all, strict: contained };
  const targets = [
    { device: 'local', name: 'Studio', status: 'ready', grants: all, engines: ['podman'] },
    { device: 'open', name: 'Laptop', status: 'ready', grants: all },
    { device: 'strict', name: 'Tower', status: 'ready', grants: contained },
    { device: 'gone', name: 'Mini', status: 'offline', message: 'Mini is unreachable (no answer). Nothing ran.' },
  ];
  const ensured = [];
  mock.module('./server/computers/index.ts', () => ({ capabilities: async () => ({ engines: ['podman'] }), engines: async () => ['podman'], procListeners: new Set() }));
  mock.module('./server/computers/api.ts', () => ({
    computerApi: (device) => ({ call: async (id, op, body) => (op === 'ensure' && ensured.push([device, body.kind]), {}), grants: async () => grants[device] }),
    computerTargets: async () => targets,
  }));
  const devices = await import('./server/devices.ts');
  for (const [id, name] of [['open', 'Laptop'], ['strict', 'Tower'], ['gone', 'Mini']]) devices.addDevice({ id, name, mode: 'lan', urls: ['http://x'], token: 't' });
  const svc = await import('./server/bots/service.ts');
  const m = await import('./server/bots/machines.ts');
  svc.setHooks({ wake() {}, stop() {} });
  const bot = svc.createBot({ name: 'Scout' }).bot.id;
  const shown = async () => Object.fromEntries((await m.machines()).map((t) => [t.device, t.isolation]));
  const ensure = async (machine) => (await m.computerOn(bot, machine), ensured.at(-1));
`;

test("with nothing chosen, bots run on the host: on this server, and on a paired device that allows Unisolated", async () => {
  await run(`${FAKES}
    a.equal(svc.getSettings().isolation, undefined);
    // Settings → Devices and the bots' own context say the host where nothing is chosen.
    a.deepEqual(await shown(), { local: 'host', open: 'host', strict: 'container', gone: 'container' });
    a.match(await m.machinesNote(), /- Studio \\(this server, used when you don't name one\\): files, terminal, browser; host \\(unisolated\\)\\./);
    a.match(await m.machinesNote(), /- Laptop \\(machine id open\\): files, terminal, browser; host \\(unisolated\\)\\./);
    a.match(await m.machinesNote(), /- Tower \\(machine id strict\\): files, terminal, browser; container\\./);
    // And that's what a tool call gets.
    a.deepEqual(await ensure(undefined), ['local', 'host']);
    a.deepEqual(await ensure('Laptop'), ['open', 'host']);
    a.deepEqual(await ensure('Tower'), ['strict', 'container']);
    // Nothing was saved: they're defaults, not choices.
    a.equal(svc.getSettings().isolation, undefined);
    process.exit(0);
  `);
});

test("a container chosen in Settings → Devices is saved and stays, on this server and a paired device", async () => {
  await run(`${FAKES}
    a.equal(m.setIsolation('local', 'container'), 'container');
    a.equal(m.setIsolation('open', 'container'), 'container');
    a.deepEqual(svc.getSettings().isolation, { local: 'container', open: 'container' });
    a.deepEqual(await shown(), { local: 'container', open: 'container', strict: 'container', gone: 'container' });
    a.deepEqual(await ensure(undefined), ['local', 'container']);
    a.deepEqual(await ensure('Laptop'), ['open', 'container']);
    // Other settings changing doesn't drop it, and neither does resetting bots.
    svc.updateSettings({ defaultModel: 'anthropic/claude-opus-5-5' });
    await svc.resetAll();
    a.deepEqual(svc.getSettings().isolation, { local: 'container', open: 'container' });
    // Host can be chosen back, for that machine alone.
    m.setIsolation('local', 'host');
    a.deepEqual(svc.getSettings().isolation, { local: 'host', open: 'container' });
    a.deepEqual(await shown(), { local: 'host', open: 'container', strict: 'container', gone: 'container' });
    a.throws(() => m.setIsolation('local', 'vm'), /Isolation is container or host/);
    a.throws(() => m.setIsolation('nowhere', 'host'), /isn't paired/);
    process.exit(0);
  `);
});

test("settings saved by a build where a container was the default: a saved host stays, and an unsaved machine moves to the host", async () => {
  await run(`${FAKES}
    // That build saved only "host", and a container as nothing at all.
    const db = await import('./server/bots/db.ts');
    db.setValue('settings', { ...db.getValue('settings'), isolation: { strict: 'host' } });
    a.deepEqual(await shown(), { local: 'host', open: 'host', strict: 'host', gone: 'container' });
    a.deepEqual(await ensure('Tower'), ['strict', 'host']);
    a.deepEqual(await ensure(undefined), ['local', 'host']);
    process.exit(0);
  `);
});
