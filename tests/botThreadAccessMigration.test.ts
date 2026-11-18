import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

// "Run coding agents" became the one switch for what three others used to grant apart, and on by default.
// Bots saved before keep what the user chose: run against a database written in the old shape, in a
// data directory and process of its own.
test("saved grants fold into Run coding agents: on gains the rest, off stays off, none gets the new default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-thread-access-"));
  try {
    const { code, stdout, stderr } = await spawnScript(
      `
      import { strict as a } from 'node:assert';
      import { Database } from 'bun:sqlite';
      import { mkdirSync } from 'node:fs';
      import { join } from 'node:path';
      const folder = join(process.env.OPENCHAT_DATA_DIR, 'bots');
      mkdirSync(folder, { recursive: true });
      const old = new Database(join(folder, 'bots.sqlite'), { create: true, strict: true });
      old.exec('CREATE TABLE bots (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
      const put = (id, threads, n) => old.query('INSERT INTO bots (id, data, created_at) VALUES (?, ?, ?)').run(id, JSON.stringify({ id, name: id, role: '', instructions: '', createdAt: n, look: { shape: 'orb', color: 'green' }, ...(threads ? { threads } : {}) }), n);
      put('on-bare', { enabled: true, scope: 'choose', projects: ['p1'] }, 1);
      put('on-full', { enabled: true, scope: 'all', projects: [], others: true, choosePermission: true, approve: true, merge: true }, 2);
      put('off', { enabled: false, scope: 'exclude', projects: [], excluded: ['p2'], others: true, approve: true, merge: true }, 3);
      put('never', undefined, 4);
      old.close();

      const db = await import('./server/bots/db.ts');
      const threads = (id) => db.getBot(id).threads;
      // On: the folded switches are gone, and with them any doubt: it has what they gave.
      a.deepEqual(threads('on-bare'), { enabled: true, scope: 'choose', projects: ['p1'] });
      a.deepEqual(threads('on-full'), { enabled: true, scope: 'all', projects: [], merge: true });
      // Off: the user said no to less than turning it on now gives, so it stays off. Its projects
      // and merge switch are kept for when they turn it back on.
      a.deepEqual(threads('off'), { enabled: false, scope: 'exclude', projects: [], excluded: ['p2'], merge: true });
      // Never chosen: the old default was off by omission. It gets the new one.
      a.deepEqual(threads('never'), { enabled: true, scope: 'all', projects: [] });

      // Once: a bot saved without a grant after that has none, as every reader assumes, until the
      // user gives it one. Running again changes nothing else.
      const before = JSON.stringify(db.listBots());
      db.putBot({ ...db.getBot('never'), id: 'later', threads: undefined });
      db.migrateThreadAccess(db.db);
      db.migrateThreadAccess(db.db);
      a.equal(threads('later'), undefined);
      a.equal(JSON.stringify(db.listBots().filter((b) => b.id !== 'later')), before);

      // A grant that comes back with the old switches (an old browser's save) doesn't keep them.
      const svc = await import('./server/bots/service.ts');
      svc.setHooks({ wake() {}, stop() {} });
      svc.updateBot('on-bare', { threads: { enabled: true, scope: 'choose', projects: ['p1'], others: false, approve: false, choosePermission: false } });
      a.deepEqual(threads('on-bare'), { enabled: true, scope: 'choose', projects: ['p1'], excluded: [], merge: false });
      // New bots start with it on, in every project, and merging off.
      a.deepEqual(svc.createBot({ name: 'Fresh' }).bot.threads, { enabled: true, scope: 'all', projects: [] });
      process.exit(0);
      `,
      { OPENCHAT_DATA_DIR: dir, PI_BIN: join(dir, "no-pi"), PI_CODING_AGENT_DIR: join(dir, "pi"), OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json") },
    );
    if (code !== 0) console.error(stdout, stderr);
    expect(stderr).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
