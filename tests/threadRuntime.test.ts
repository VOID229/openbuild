import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("thread runtime is immutable, persistent, and legacy-safe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-runtime-"));
  const run = async (script: string) => {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      import * as storage from './server/storage.ts';
      import { claimRuntime, threadRuntime, runtimeChangeAllowed } from './server/threadRuntime.ts';
      ${script}
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  };
  try {
    await run(`
      a.equal(threadRuntime('new-thread'), undefined);
      claimRuntime('new-thread', 'durable');
      claimRuntime('new-thread', 'durable');
      a.throws(() => claimRuntime('new-thread', 'pi'), /cannot change/);
      a.equal(runtimeChangeAllowed({ id: 'new-thread', updatedAt: 1, runtime: 'pi' }), false);
      a.equal(runtimeChangeAllowed({ id: 'new-thread', updatedAt: 1, runtime: 'durable' }), true);
      storage.putChat({ id: 'legacy-thread', updatedAt: 1, messages: [{}] });
      a.throws(() => claimRuntime('legacy-thread', 'durable'), /cannot change/);
      storage.setValue('pi-session:discovered-thread', '{}');
      a.throws(() => claimRuntime('discovered-thread', 'durable'), /cannot change/);
      a.equal(runtimeChangeAllowed({ id: 'invalid', updatedAt: 1, runtime: 'oops' }), false);
      claimRuntime('cursor-thread', 'cursor');
      a.equal(threadRuntime('cursor-thread'), 'cursor');
      a.throws(() => claimRuntime('cursor-thread', 'pi'), /cannot change/);
      a.equal(runtimeChangeAllowed({ id: 'cursor-thread', updatedAt: 1, runtime: 'cursor' }), true);
      a.equal(runtimeChangeAllowed({ id: 'cursor-thread', updatedAt: 1, runtime: 'codex' }), false);
      storage.setValue('cursor-session:cursor-discovered', '{}');
      a.equal(threadRuntime('cursor-discovered'), 'cursor');
      storage.putChat({ id: 'cursor-chat', updatedAt: 1, runtime: 'cursor', messages: [{}] });
      a.equal(threadRuntime('cursor-chat'), 'cursor');
      claimRuntime('codex-thread', 'codex');
      a.equal(threadRuntime('codex-thread'), 'codex');
      a.throws(() => claimRuntime('codex-thread', 'pi'), /cannot change/);
      a.equal(runtimeChangeAllowed({ id: 'codex-thread', updatedAt: 1, runtime: 'codex' }), true);
      a.equal(runtimeChangeAllowed({ id: 'codex-thread', updatedAt: 1, runtime: 'fx' }), false);
      storage.setValue('codex-session:codex-discovered', '{}');
      a.equal(threadRuntime('codex-discovered'), 'codex');
      storage.putChat({ id: 'codex-chat', updatedAt: 1, runtime: 'codex', messages: [{}] });
      a.equal(threadRuntime('codex-chat'), 'codex');
    `);
    await run(`a.equal(threadRuntime('cursor-thread'), 'cursor'); a.throws(() => claimRuntime('cursor-thread', 'codex')); a.equal(threadRuntime('new-thread'), 'durable'); a.throws(() => claimRuntime('new-thread', 'pi')); a.equal(threadRuntime('codex-thread'), 'codex'); a.throws(() => claimRuntime('codex-thread', 'fx'));`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
