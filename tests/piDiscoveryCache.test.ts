import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Pi's unchanged archive survives server restart without transcript reads; edits still invalidate it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ob-discovery-cache-"));
  const common = `
    import { strict as a } from 'node:assert';
    import { join } from 'node:path';
    const file = join(process.env.PI_CODING_AGENT_SESSION_DIR, 'source.jsonl');
    const storage = await import('./server/storage.ts');
  `;
  async function run(script: string) {
    const child = Bun.spawn([process.execPath, "-e", common + script + "\nprocess.exit(0);"], { cwd: join(import.meta.dir, ".."), env: { ...process.env,
      OPENCHAT_DATA_DIR: join(dir, "data"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
    }, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: out + err }).toEqual({ code: 0, output: "" });
  }
  try {
    await run(`
      const fs = await import('node:fs/promises');
      await fs.mkdir(process.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true });
      const header = { type: 'session', version: 3, id: 'cached-session', cwd: '/tmp', timestamp: new Date().toISOString() };
      const user = { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'original' } };
      await fs.writeFile(file, [header, user].map(x => JSON.stringify(x)).join('\\n') + '\\n');
      const { discoverSessions } = await import('./server/pi/discovery.ts');
      await discoverSessions();
      a.equal(storage.getChat('cached-session').messages[0].content, 'original');
      a.equal(storage.listValues('pi-discovery:v3:').length, 1);
    `);
    await run(`
      const { mock } = await import('bun:test');
      const fs = await import('node:fs/promises');
      const read = fs.readFile;
      let reads = 0;
      mock.module('node:fs/promises', () => ({ ...fs, readFile: async (path, ...args) => {
        if (path === file) reads++;
        return read(path, ...args);
      } }));
      const { discoverSessions } = await import('./server/pi/discovery.ts');
      await discoverSessions();
      a.equal(reads, 0);
      await fs.appendFile(file, JSON.stringify({ type: 'message', id: 'u2', parentId: 'u', message: { role: 'user', content: 'new message' } }) + '\\n');
      await discoverSessions();
      a.equal(reads, 1);
      a.equal(storage.getChat('cached-session').messages.length, 2);
      await discoverSessions();
      a.equal(reads, 1);
    `);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
