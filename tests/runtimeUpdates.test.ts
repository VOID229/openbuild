import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("runtime maintenance commands, HTTP validation, jobs and status caching (isolated)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-runtime-updates-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      import { writeFileSync, chmodSync, mkdirSync, symlinkSync } from 'node:fs';
      const dir = process.env.OPENCHAT_DATA_DIR;
      const missing = dir + '/missing';
      for (const id of ['PI', 'CLAUDE', 'CODEX', 'CURSOR', 'FX', 'OPENCODE']) process.env[id + '_BIN'] = missing;
      delete process.env.OPENCODE_SERVER_URL;
      process.env.PI_CODING_AGENT_DIR = dir + '/agent';
      const { runtimeStatus, forgetRuntimeStatus, runtimeUpdateCommand, assertRuntimeUpdated } = await import('./server/runtimes.ts');
      const { codexUpdateCommand } = await import('./server/codex/install.ts');
      const { currentJob, startJob, jobStream } = await import('./server/pi/jobs.ts');
      const { piRoutes } = await import('./server/pi/routes.ts');
      const routes = piRoutes(handler => handler);
      const post = (body, path = '/api/runtimes/update') => routes[path].POST(new Request('http://localhost' + path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
      const wait = async job => { while (!job.done) await Bun.sleep(10); };

      const first = runtimeStatus();
      a.equal(runtimeStatus(), first);
      await first;
      a.equal(runtimeStatus(), first);
      const fresh = runtimeStatus(true);
      a.notEqual(fresh, first);
      a.equal(runtimeStatus(), fresh);
      await fresh;
      forgetRuntimeStatus();
      a.notEqual(runtimeStatus(), fresh);
      // Cached detailed status avoids re-running --version and fresh really re-probes.
      const versionBin = dir + '/version-agent';
      writeFileSync(versionBin, '#!/bin/sh\\necho 1.0.0\\n');
      chmodSync(versionBin, 0o755);
      process.env.PI_BIN = versionBin;
      globalThis.fetch = async () => Response.json({ version: '2.0.0' });
      forgetRuntimeStatus();
      const v1 = runtimeStatus();
      a.equal(runtimeStatus(), v1);
      a.equal((await v1).pi.version, '1.0.0');
      writeFileSync(versionBin, '#!/bin/sh\\necho 2.0.0\\n');
      a.equal((await runtimeStatus()).pi.version, '1.0.0');
      a.equal((await runtimeStatus(true)).pi.version, '2.0.0');
      process.env.PI_BIN = missing;
      forgetRuntimeStatus();
      const beforeUpdate = runtimeStatus();
      await beforeUpdate;
      a.equal((await post({ runtime: 'sh', command: 'touch /tmp/unsafe' })).status, 400);
      a.equal((await post('{')).status, 400);
      a.equal((await post({ runtime: 'codex' })).status, 400);
      process.env.OPENCODE_SERVER_URL = 'http://remote.invalid';
      a.equal((await post({ runtime: 'opencode' })).status, 400);
      delete process.env.OPENCODE_SERVER_URL;

      const bin = dir + '/fake-agent';
      writeFileSync(bin, '#!/bin/sh\\nsleep 0.15\\necho update-output\\nexit 3\\n');
      chmodSync(bin, 0o755);
      for (const id of ['PI', 'CLAUDE', 'CODEX', 'CURSOR', 'FX', 'OPENCODE']) process.env[id + '_BIN'] = bin;
      a.deepEqual(runtimeUpdateCommand('pi'), [bin, 'update', '--self']);
      a.deepEqual(runtimeUpdateCommand('pi', true), [bin, 'update', '--all']);
      a.deepEqual(runtimeUpdateCommand('claude'), [bin, 'update']);
      a.deepEqual(runtimeUpdateCommand('codex'), [bin, 'update']);
      // All installations delegate to the selected CLI itself.
      const npmPrefix = dir + '/custom-node';
      const launcher = npmPrefix + '/lib/node_modules/@openai/codex/bin/codex.js';
      mkdirSync(npmPrefix + '/lib/node_modules/@openai/codex/bin', { recursive: true });
      writeFileSync(launcher, '');
      const npmBin = dir + '/npm-codex';
      symlinkSync(launcher, npmBin);
      a.deepEqual(codexUpdateCommand(npmBin), [npmBin, 'update']);
      const standalone = dir + '/standalone/releases/1.0.0/bin/codex';
      mkdirSync(dir + '/standalone/releases/1.0.0/bin', { recursive: true });
      writeFileSync(standalone, '');
      const standaloneBin = dir + '/standalone-codex';
      symlinkSync(standalone, standaloneBin);
      a.deepEqual(codexUpdateCommand(standaloneBin), [standaloneBin, 'update']);
      a.throws(() => assertRuntimeUpdated({ installed: true, version: '1.0.0', latest: '2.0.0', updateAvailable: true, bin, install: '' }), /did not update the executable/);
      assertRuntimeUpdated({ installed: true, version: '2.0.0', latest: '2.0.0', updateAvailable: false, install: '' });
      for (const runtime of ['fx', 'cursor', 'opencode']) {
        const command = runtimeUpdateCommand(runtime);
        a.deepEqual(command, [bin, runtime === 'cursor' ? 'update' : 'upgrade']);
      }
      a.throws(() => runtimeUpdateCommand('durable'), /installed locally/);
      // Don't actually run any installer; only the fake Claude command is executed.
      const response = await post({ runtime: 'claude', command: 'arbitrary', all: true });
      a.equal(response.status, 200);
      const job = currentJob();
      a.equal((await response.json()).job, job.id);
      a.deepEqual(job.command, [bin, 'update']);
      const busy = await post({ runtime: 'codex' });
      a.equal(busy.status, 409);
      a.equal((await busy.json()).job, job.id);
      a.equal(startJob('must not replace', ['invalid']), job);
      await wait(job);
      a.equal(job.code, 3);
      for (const id of ['PI', 'CLAUDE', 'CODEX', 'CURSOR', 'FX', 'OPENCODE']) process.env[id + '_BIN'] = missing;
      const afterUpdate = runtimeStatus();
      a.notEqual(afterUpdate, beforeUpdate);
      await afterUpdate;
      const stream = await new Response(jobStream(job)).text();
      a.ok(stream.includes('update-output'));
      a.ok(stream.includes('"done":true,"code":3'));
      // Failed spawn still finishes the shared job and allows the next one.
      const failed = startJob('missing executable', [missing]);
      await wait(failed);
      a.equal(failed.code, 127);
      a.ok(failed.lines.length);
      const next = startJob('next', [process.execPath, '-e', 'process.exit(0)']);
      await wait(next);
      a.equal(next.code, 0);
      let verifying = false;
      const verified = startJob('verify before success', [process.execPath, '-e', 'process.exit(0)'], async job => {
        verifying = true;
        await Bun.sleep(50);
        a.equal(job.done, false);
        a.equal(startJob('cannot replace verification', ['invalid']), job);
        throw new Error('executable is still old');
      });
      await wait(verified);
      a.equal(verifying, true);
      a.equal(verified.code, 1);
      a.ok(verified.lines.some(line => line.includes('executable is still old')));
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
