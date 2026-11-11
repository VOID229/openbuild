import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

test("runtime maintenance commands, HTTP validation, jobs and status caching (isolated)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-runtime-updates-"));
  try {
    const { code, stderr: err } = await spawnScript(`
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
      // Runtimes without an npm package ask where their own installers look.
      const realFetch = globalThis.fetch;
      const script = (name, body) => { const path = dir + '/' + name; writeFileSync(path, '#!/bin/sh\\n' + body + '\\n'); chmodSync(path, 0o755); return path; };
      const check = async (env, value, pages) => {
        process.env[env] = value;
        globalThis.fetch = async url => { const page = pages[url]; return page === undefined ? new Response('', { status: 404 }) : new Response(page); };
        forgetRuntimeStatus();
        const all = await runtimeStatus(true);
        process.env[env] = missing;
        return all;
      };
      process.env.HERMES_BIN = missing;
      process.env.GROK_BIN = missing;
      const grokCheck = json => script('grok', 'if [ "$1" = update ]; then echo \\'' + JSON.stringify(json) + '\\'; else echo "grok 1.0.70 (f50904eaee6c) [stable]"; fi');
      let got = (await check('GROK_BIN', grokCheck({ latestVersion: '1.0.70', error: null }), {})).grok;
      a.deepEqual([got.version, got.latest, got.updateAvailable], ['1.0.70', '1.0.70', false]);
      got = (await check('GROK_BIN', grokCheck({ latestVersion: '1.0.71', error: null }), {})).grok;
      a.deepEqual([got.latest, got.updateAvailable], ['1.0.71', true]);
      got = (await check('GROK_BIN', grokCheck({ error: 'offline' }), {})).grok;
      a.equal(got.updateAvailable, false);
      a.ok(got.checkError.includes('offline'));
      const fxBin = channel => script('fx', 'if [ "$1" = status ]; then echo \\'{"update_channel":"' + channel + '"}\\'; else echo 0.0.15; fi');
      got = (await check('FX_BIN', fxBin('stable'), { 'https://releases.fx.sh/latest.txt': 'v0.0.16\\n' })).fx;
      a.deepEqual([got.latest, got.updateAvailable], ['0.0.16', true]);
      got = (await check('FX_BIN', fxBin('dev'), { 'https://releases.fx.sh/latest.txt': 'v0.0.16\\n' })).fx;
      a.deepEqual([got.latest, got.updateAvailable, got.checkError], [undefined, false, undefined]);
      const hermes = script('hermes', 'echo "Hermes Agent v0.22.6 (2026.10.30)"');
      got = (await check('HERMES_BIN', hermes, { 'https://api.github.com/repos/NousResearch/hermes-agent/releases/latest': JSON.stringify({ tag_name: 'v0.22.6' }) })).hermes;
      a.deepEqual([got.version, got.latest, got.updateAvailable], ['0.22.6', '0.22.6', false]);
      got = (await check('HERMES_BIN', hermes, {})).hermes;
      a.equal(got.updateAvailable, false);
      a.ok(got.checkError.includes('HTTP 404'));
      // Cursor's builds end in a hash: the same build is current, and a hash never makes one newer.
      const cursorBin = script('cursor', 'if [ "$1" = --version ]; then echo 2026.10.22-27dcf5f; else exit 1; fi');
      const installer = build => ({ 'https://cursor.com/install': 'DOWNLOAD_URL="https://downloads.cursor.com/lab/' + build + '/x"' });
      got = (await check('CURSOR_BIN', cursorBin, installer('2026.10.22-27dcf5f'))).cursor;
      a.deepEqual([got.latest, got.updateAvailable], ['2026.10.22-27dcf5f', false]);
      got = (await check('CURSOR_BIN', cursorBin, installer('2026.10.22-99abcde'))).cursor;
      a.equal(got.updateAvailable, false);
      got = (await check('CURSOR_BIN', cursorBin, installer('2026.10.29-1234abc'))).cursor;
      a.equal(got.updateAvailable, true);
      globalThis.fetch = realFetch;
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
    `, { OPENCHAT_DATA_DIR: dir });
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
