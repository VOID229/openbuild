import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function isolated(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "ob-usage-warm-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", script + "\nprocess.exit(0);"], {
      cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: dir, OPENCHAT_DATA_DIR: join(dir, "data"), GROK_HOME: join(dir, ".grok"), CODEX_HOME: join(dir, ".codex"), CLAUDE_CONFIG_DIR: join(dir, ".claude") },
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: out + err }).toEqual({ code: 0, output: "" });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("a stale warmed usage report renders immediately; explicit refresh waits for new data", async () => {
  await isolated(`
    import { mock } from 'bun:test';
    import { strict as a } from 'node:assert';
    let now = Date.now(); Date.now = () => now;
    let calls = 0, version = 1, release;
    let blocked;
    mock.module('./server/usage/scan.ts', () => ({
      scan: async () => { calls++; if (blocked) await blocked; return new Map(); },
      generation: () => version, pendingSources: () => [], scanProblems: () => [],
    }));
    mock.module('./server/pi/pricing.ts', () => ({ priceBook: async () => undefined, modelKey: () => '', referencePrice: () => undefined }));
    const { report } = await import('./server/usage/report.ts');
    const first = await report('30d', 'UTC');
    a.equal(calls, 1);
    now += 20000; version++;
    blocked = new Promise(resolve => { release = resolve; });
    const cached = await Promise.race([report('30d', 'UTC'), Bun.sleep(100).then(() => { throw Error('cached read waited'); })]);
    a.deepEqual(cached.totals, first.totals);
    a.equal(calls, 2);
    let finished = false;
    const fresh = report('30d', 'UTC', true).then(value => { finished = true; return value; });
    await Bun.sleep(5); a.equal(finished, false);
    release(); await fresh; a.equal(finished, true);
    a.equal(calls, 2);
  `);
});

test("warmed plan limits remain available while providers refresh, and refresh returns new limits", async () => {
  await isolated(`
    import { mock } from 'bun:test';
    import { strict as a } from 'node:assert';
    const fs = await import('node:fs/promises');
    const missing = () => Object.assign(new Error('missing fixture file'), { code: 'ENOENT' });
    mock.module('node:fs/promises', () => ({ ...fs,
      readdir: async () => [], stat: async () => { throw missing(); },
      readFile: async file => {
        if (String(file).endsWith('/.grok/auth.json')) return JSON.stringify({ 'https://accounts.x.ai/sign-in': { key: 'fixture-token' } });
        throw missing();
      },
    }));
    mock.module('./server/claude/accounts.ts', () => ({ detectAccounts: () => [] }));
    let now = Date.now(); Date.now = () => now;
    let release, blocked, percent = 25, calls = 0;
    globalThis.fetch = async url => {
      a.ok(String(url).includes('cli-chat-proxy.grok.com'));
      calls++; if (blocked) await blocked;
      return Response.json({ config: { creditUsagePercent: percent, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' } } });
    };
    const { limits } = await import('./server/usage/limits.ts');
    const first = await limits();
    a.equal(first.find(p => p.provider === 'grok').windows[0].usedPercent, 25);
    now += 61000;
    blocked = new Promise(resolve => { release = resolve; });
    const cached = await Promise.race([limits(), Bun.sleep(100).then(() => { throw Error('limits cache waited'); })]);
    a.equal(cached.find(p => p.provider === 'grok').windows[0].usedPercent, 25);
    for (let i = 0; i < 20 && calls < 2; i++) await Bun.sleep(0);
    a.equal(calls, 2);
    let finished = false;
    const fresh = limits(true).then(value => { finished = true; return value; });
    await Bun.sleep(5); a.equal(finished, false);
    percent = 75; release();
    a.equal((await fresh).find(p => p.provider === 'grok').windows[0].usedPercent, 75);
  `);
});
