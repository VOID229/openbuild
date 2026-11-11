import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { finished, startScript } from "./spawnScript";

for (const safe of [false, true]) test(`bot plugin boundaries and truthful toggles (safe=${safe})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-bot-plugins-"));
  const plugins = join(dir, "plugins");
  mkdirSync(plugins);
  for (const id of ["example", "blocked", "broken"]) {
    mkdirSync(join(plugins, id));
    writeFileSync(join(plugins, id, "plugin.json"), JSON.stringify({ id, name: id, version: "1", apiVersion: id === "broken" ? 99 : 1, defaultEnabled: false, server: "server.ts" }));
    writeFileSync(join(plugins, id, "server.ts"), 'export default { onStart() {}, onStop() {} };');
  }
  const config = join(dir, "config.ts");
  writeFileSync(config, `export default { pluginsDir: ${JSON.stringify(plugins)}, disabledPlugins: ["blocked"], safeMode: ${safe} };`);
  const child = startScript(`
    import { strict as a } from 'node:assert';
    const svc = await import('./server/bots/service');
    const db = await import('./server/bots/db');
    const storage = await import('./server/storage');
    const projects = await import('./server/projects');
    const runtime = await import('./server/plugins');
    const { handle, guide } = await import('./server/bots/plugins');
    const agent = await import('./server/bots/agent');
    const { bot: primary } = svc.createBot({ name: 'Boss' });
    const { bot: other } = svc.createBot({ name: 'Author' });
    const project = await projects.addProject(${JSON.stringify(resolve("."))});
    const unrelated = await projects.addProject(${JSON.stringify(dir)});
    const grant = (id, ids, enabled = true) => svc.updateBot(id, { threads: { enabled, scope: 'choose', projects: ids } });
    const call = (id, action, rest = {}) => handle(id, { action, ...rest });
    await runtime.loadPlugins();
    a.equal(guide(db.getBot(primary.id)), '');
    await a.rejects(call(primary.id, 'list'), /require access/);
    grant(primary.id, [unrelated.id]);
    await a.rejects(call(primary.id, 'guide'), /require access/);
    grant(primary.id, [project.id], false);
    await a.rejects(call(primary.id, 'list'), /require access/);
    svc.updateBot(primary.id, { threads: { enabled: true, scope: 'all', projects: [] } });
    await call(primary.id, 'list');
    svc.updateBot(primary.id, { threads: { enabled: true, scope: 'exclude', projects: [], excluded: [project.id] } });
    await a.rejects(call(primary.id, 'list'), /require access/);
    grant(primary.id, [project.id]); grant(other.id, [project.id]);
    const before = JSON.stringify(db.getBot(other.id));
    a.match(guide(db.getBot(other.id)), /coding thread/);
    a.match((await call(other.id, 'guide')).guidance, /not sandboxed/);
    a.equal(JSON.stringify(db.getBot(other.id)), before);
    a.match(agent.contextFor(other.id), /plugins action guide/);
    for (const action of ['list', 'set', 'system', 'delete']) await a.rejects(call(other.id, action, { id: 'example', enabled: true }), /Only the primary/);
    await a.rejects(call(primary.id, 'delete'), /action is/);
    await a.rejects(call(primary.id, 'system', { enabled: 'true' }), /must be/);
    await a.rejects(call(primary.id, 'set', { id: '../outside', enabled: true }), /No such/);
    let info = await call(primary.id, 'list');
    a.equal(info.configuredEnabled, false); a.equal(info.effectiveEnabled, false);
    info = await call(primary.id, 'set', { id: 'example', enabled: true });
    a.equal(info.plugins.find(p => p.id === 'example').configuredEnabled, true);
    a.equal(info.plugins.find(p => p.id === 'example').effectiveEnabled, false);
    // In safe mode, seed the previously saved master choice and ensure it is preserved.
    if (${safe}) storage.setValue('plugins-state', JSON.stringify({ system: true, enabled: ['example'], disabled: [] }));
    info = await call(primary.id, 'system', { enabled: true });
    a.equal(info.configuredEnabled, true); a.equal(info.effectiveEnabled, ${!safe});
    a.equal(info.safe, ${safe});
    a.equal(info.plugins.find(p => p.id === 'example').serverLoaded, ${!safe});
    info = await call(primary.id, 'set', { id: 'blocked', enabled: true });
    a.equal(info.plugins.find(p => p.id === 'blocked').configuredEnabled, true);
    a.equal(info.plugins.find(p => p.id === 'blocked').blockedByConfig, true);
    a.equal(info.plugins.find(p => p.id === 'blocked').effectiveEnabled, false);
    info = await call(primary.id, 'set', { id: 'broken', enabled: true });
    a.ok(info.plugins.find(p => p.id === 'broken').error);
    a.equal(info.plugins.find(p => p.id === 'broken').effectiveEnabled, false);
    info = await call(primary.id, 'set', { id: 'example', enabled: false });
    a.equal(info.plugins.find(p => p.id === 'example').serverLoaded, false);
    info = await call(primary.id, 'system', { enabled: false });
    a.equal(info.configuredEnabled, ${safe}); a.equal(info.effectiveEnabled, false);
    // The real socket authenticates calls, and checks the bot's current grants on every call.
    agent.listen();
    const token = agent.mintToken(primary.id);
    const request = token => fetch('http://localhost/', { unix: agent.agentSocketPath(), method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'plugins', params: { action: 'list' } }) });
    a.equal((await request('wrong')).status, 401);
    a.equal((await request(token)).status, 200);
    grant(primary.id, []);
    a.equal((await request(token)).status, 403);
    agent.revokeToken(token);
    a.equal((await request(token)).status, 401);
    process.exit(0);
  `, { OPENCHAT_DATA_DIR: dir, OPENBUILD_CONFIG: config, OPENBUILD_SAFE: "0" });
  try {
    const { code, stdout: out, stderr: err } = await finished(child);
    expect({ code, error: code ? out + err : "" }).toEqual({ code: 0, error: "" });
  } finally { child.kill(); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
