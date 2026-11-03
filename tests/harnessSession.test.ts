import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("copy identity reads native mappings and Pi headers without creating sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-session-id-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      import { join } from 'node:path';
      import * as storage from './server/storage.ts';
      import { harnessSession } from './server/harnessSession.ts';
      a.deepEqual(await harnessSession('not-started'), { runtime: undefined, id: null });
      a.equal(storage.getValue('thread-runtime:not-started'), undefined);
      for (const runtime of ['codex', 'claude', 'cursor', 'fx', 'opencode', 'grok', 'hermes']) {
        storage.setValue(runtime + '-session:ob-thread', JSON.stringify({ id: runtime + '-native' }));
        storage.setValue('thread-runtime:ob-thread', runtime);
        a.deepEqual(await harnessSession('ob-thread'), { runtime, id: runtime + '-native' });
      }
      const file = join(process.env.OPENCHAT_DATA_DIR, 'pi.jsonl');
      await Bun.write(file, JSON.stringify({ type: 'session', id: 'native-pi-id' }) + '\\n' + '{}');
      storage.setValue('pi-session:imported-pi', JSON.stringify({ file }));
      a.deepEqual(await harnessSession('imported-pi'), { runtime: 'pi', id: 'native-pi-id' });
      storage.setValue('pi-session:missing-pi', JSON.stringify({ file: file + '.missing' }));
      a.deepEqual(await harnessSession('missing-pi'), { runtime: 'pi', id: null });
      storage.setValue('claude-session:broken-id', '{');
      a.deepEqual(await harnessSession('broken-id'), { runtime: 'claude', id: null });
      storage.setValue('thread-runtime:durable-id', 'durable');
      a.deepEqual(await harnessSession('durable-id'), { runtime: 'durable', id: null });
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
