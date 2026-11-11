import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

async function isolated(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "ob-usage-warm-"));
  try {
    const { code, stdout: out, stderr: err } = await spawnScript(script + "\nprocess.exit(0);", { HOME: dir, OPENCHAT_DATA_DIR: join(dir, "data"), GROK_HOME: join(dir, ".grok"), CODEX_HOME: join(dir, ".codex"), CLAUDE_CONFIG_DIR: join(dir, ".claude") });
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

test("warmed plan limits wait for fresh provider readings and deduplicate explicit refresh", async () => {
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
    let release, blocked, percent = 25, calls = 0, limited = false;
    globalThis.fetch = async url => {
      a.ok(String(url).includes('cli-chat-proxy.grok.com'));
      calls++; if (blocked) await blocked;
      if (limited) return new Response('', { status: 429 });
      return Response.json({ config: { creditUsagePercent: percent, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' } } });
    };
    const { limits } = await import('./server/usage/limits.ts');
    const first = await limits();
    a.equal(first.find(p => p.provider === 'grok').windows[0].usedPercent, 25);
    now += 61000;
    blocked = new Promise(resolve => { release = resolve; });
    let normalFinished = false;
    const normal = limits().then(value => { normalFinished = true; return value; });
    for (let i = 0; i < 20 && calls < 2; i++) await Bun.sleep(0);
    a.equal(calls, 2);
    a.equal(normalFinished, false);
    let finished = false;
    const fresh = limits(true).then(value => { finished = true; return value; });
    await Bun.sleep(5); a.equal(finished, false);
    percent = 75; release();
    a.equal((await normal).find(p => p.provider === 'grok').windows[0].usedPercent, 75);
    a.equal((await fresh).find(p => p.provider === 'grok').windows[0].usedPercent, 75);
    const lastGood = (await limits()).find(p => p.provider === 'grok');
    blocked = undefined; limited = true; now += 61000;
    const stale = (await limits(true)).find(p => p.provider === 'grok');
    a.equal(stale.windows[0].usedPercent, 75);
    a.equal(stale.asOf, lastGood.asOf);
    a.equal(stale.stale, true);
    a.match(stale.error, /429/);
    a.equal(stale.resetCredits, undefined);
    now += 61000;
    a.equal((await limits(true)).find(p => p.provider === 'grok').asOf, lastGood.asOf);
    limited = false; percent = 80; now += 61000;
    const recovered = (await limits(true)).find(p => p.provider === 'grok');
    a.equal(recovered.windows[0].usedPercent, 80);
    a.equal(recovered.stale, undefined);
    a.equal(recovered.error, undefined);
  `);
});

test("opening limits after an in-flight prefetch still requests fresh readings", async () => {
  await isolated(`
    import { mock } from 'bun:test';
    import { strict as a } from 'node:assert';
    const effects = [];
    mock.module('react', () => ({
      useEffect: fn => effects.push(fn), useState: () => [],
      useSyncExternalStore: () => '',
    }));
    let release;
    const urls = [];
    globalThis.fetch = async url => {
      urls.push(url);
      if (urls.length === 1) await new Promise(resolve => { release = resolve; });
      return Response.json({ providers: [], checkedAt: Date.now() });
    };
    const { loadLimits, useUsageLimits } = await import('./src/lib/usageStats.ts');
    const prefetch = loadLimits();
    useUsageLimits();
    effects[0]();
    a.equal(urls.length, 1);
    release(); await prefetch;
    for (let i = 0; i < 20 && urls.length < 2; i++) await Bun.sleep(0);
    a.deepEqual(urls, ['/api/usage/limits', '/api/usage/limits?fresh=1']);
  `);
});

// Two Codex homes signed in to different accounts, and Grok; answers set per account.
const providerFixture = `
  import { mock } from 'bun:test';
  import { strict as a } from 'node:assert';
  const fs = await import('node:fs/promises');
  const missing = () => Object.assign(new Error('missing fixture file'), { code: 'ENOENT' });
  const home = process.env.HOME;
  mock.module('node:fs/promises', () => ({ ...fs,
    readdir: async (dir, opts) => {
      if (dir === home && opts?.withFileTypes) return [{ name: '.codex-2', isDirectory: () => true }];
      throw missing();
    },
    stat: async () => { throw missing(); },
    readFile: async file => {
      file = String(file);
      if (file.endsWith('/.grok/auth.json')) return JSON.stringify({ 'https://accounts.x.ai/sign-in': { key: 'fixture-token' } });
      if (file === home + '/.codex/auth.json') return JSON.stringify({ tokens: { access_token: 'one', account_id: 'one' } });
      if (file === home + '/.codex-2/auth.json') return JSON.stringify({ tokens: { access_token: 'two', account_id: 'two' } });
      throw missing();
    },
  }));
  mock.module('./server/claude/accounts.ts', () => ({ detectAccounts: () => [] }));
  let now = Date.now(); Date.now = () => now;
  const calls = { one: 0, two: 0, grok: 0 };
  const answer = { one: () => ({ used: 40 }), two: () => ({ used: 10 }), grok: () => ({ used: 5 }) };
  globalThis.fetch = async (url, init) => {
    const who = String(url).includes('grok.com') ? 'grok' : init.headers['chatgpt-account-id'];
    calls[who]++;
    const r = answer[who]();
    if (r.status) return new Response('', { status: r.status, headers: r.headers });
    if (r.throws) throw r.throws;
    if (who === 'grok') return Response.json({ config: { creditUsagePercent: r.used, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' } } });
    return Response.json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: r.used, limit_window_seconds: 18000 } } });
  };
  const { limits } = await import('./server/usage/limits.ts');
  const read = async (force = false) => Object.fromEntries((await limits(force)).map(p => [p.id.replace(/^\\w+:(acct:)?/, ''), p]));
`;

test("a 429 holds that account for its Retry-After, through polls and forced opens, keeping its last reading", async () => {
  await isolated(providerFixture + `
    const good = await read();
    a.equal(good.one.windows[0].usedPercent, 40);
    a.deepEqual(calls, { one: 1, two: 1, grok: 1 });
    answer.one = () => ({ status: 429, headers: { 'retry-after': '600' } });
    now += 61000;
    const limited = await read(true);
    a.equal(calls.one, 2);
    a.equal(limited.one.errorKind, 'rateLimited');
    a.match(limited.one.error, /limiting how often usage can be checked/);
    a.equal(limited.one.retryAt, now + 600000);
    a.equal(limited.one.stale, true);
    a.equal(limited.one.asOf, good.one.asOf);
    a.equal(limited.one.windows[0].usedPercent, 40);
    // The other account and other providers keep being read normally.
    a.equal(limited.two.error, undefined);
    a.equal(limited.two.stale, undefined);
    // Polls every minute and repeated opens for 9 minutes never ask the throttled account again.
    for (let i = 0; i < 9; i++) {
      now += 61000;
      const r = await read(i % 2 === 0);
      a.equal(r.one.errorKind, 'rateLimited');
      a.equal(r.one.windows[0].usedPercent, 40);
      a.equal(r.one.asOf, good.one.asOf);
    }
    a.equal(calls.one, 2);
    a.equal(calls.two, 11);
    answer.one = () => ({ used: 55 });
    now += 61000;
    const back = await read();
    a.equal(calls.one, 3);
    a.equal(back.one.windows[0].usedPercent, 55);
    a.equal(back.one.stale, undefined);
    a.equal(back.one.errorKind, undefined);
    a.equal(back.one.retryAt, undefined);
  `);
});

test("a 429 without Retry-After backs off, doubling, and stays within the bounds", async () => {
  await isolated(providerFixture + `
    await read();
    answer.grok = () => ({ status: 429 });
    const waits = [];
    now += 61000;
    let r = await read(true);
    for (let i = 0; i < 7; i++) {
      a.equal(r.grok.errorKind, 'rateLimited');
      waits.push(Math.round((r.grok.retryAt - now) / 60000));
      const asked = calls.grok, retryAt = r.grok.retryAt;
      // Up to the hold's end nothing is asked; at it, one request goes out.
      now = retryAt - 15000; r = await read(true);
      a.equal(calls.grok, asked);
      a.equal(r.grok.retryAt, retryAt);
      now = retryAt; r = await read(true);
      a.equal(calls.grok, asked + 1);
    }
    a.deepEqual(waits, [2, 4, 8, 16, 32, 60, 60]);
    const { holdDelay } = await import('./server/usage/limits.ts');
    a.equal(holdDelay(1, 1000), 60000);
    a.equal(holdDelay(1, 5 * 3600000), 3600000);
  `);
});

test("refused sign-ins and unreachable providers are told apart from throttling and from a used-up plan", async () => {
  await isolated(providerFixture + `
    answer.two = () => ({ used: 100 });
    const full = await read();
    a.equal(full.two.windows[0].usedPercent, 100);
    a.equal(full.two.error, undefined);
    answer.one = () => ({ status: 401 });
    answer.grok = () => ({ throws: Object.assign(new TypeError('Unable to connect'), { code: 'ConnectionRefused' }) });
    now += 61000;
    const r = await read(true);
    a.equal(r.one.errorKind, 'auth');
    a.equal(r.one.retryAt, undefined);
    a.equal(r.grok.errorKind, 'network');
    a.match(r.grok.error, /couldn't be reached/);
    a.equal(r.grok.windows[0].usedPercent, 5);
    a.equal(r.grok.stale, true);
    // Neither is held: the next check asks again.
    now += 61000;
    await read();
    a.equal(calls.one, 3);
    a.equal(calls.grok, 3);
  `);
});
