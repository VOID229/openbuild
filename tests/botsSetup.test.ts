import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PI_SITE, PiSetupNotice, setupText } from "../src/components/bots/PiSetupNotice";
import type { Bot } from "../src/lib/bots/types";
import { piBin } from "../server/pi/install";
import { spawnScript } from "./spawnScript";

/** Runs `script` against its own data and Pi directories: nothing here may touch the real ones. */
async function isolated(prefix: string, script: string, env: Record<string, string> = {}, quiet = /^$/) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    const { code, stderr: err } = await spawnScript(script, { OPENCHAT_DATA_DIR: dir, PI_CODING_AGENT_DIR: join(dir, "agent"), ...env });
    expect(err.split("\n").filter((line) => line && !quiet.test(line))).toEqual([]);
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the welcome waits for Pi: installed first, then a provider, and says hello once both are there", async () => {
  await isolated("openbuild-bots-setup-", `
    import { strict as a } from 'node:assert';
    import * as db from './server/bots/db.ts';
    import * as svc from './server/bots/service.ts';
    const woken = [];
    svc.setHooks({ wake: (botId, wake) => woken.push({ botId, wake }), stop() {} });
    let need = { need: 'missing' };
    let asked = 0;
    svc.setPiCheck(async () => (asked++, need));
    const events = [];
    const unsubscribe = svc.subscribe((e) => e.t === 'setup' && events.push(e));
    svc.ensureStarted();
    const bot = db.listBots()[0];
    const conversationId = svc.directId(bot.id);

    // No Pi: the bot isn't woken into an error, and the chat is told why.
    await svc.greetOnFirstOpen();
    a.equal(woken.length, 0);
    a.equal(db.messages(conversationId, 10).length, 0);
    a.deepEqual(svc.piSetup(), { need: 'missing' });
    a.deepEqual(svc.snapshot().setup, { need: 'missing' });
    a.deepEqual(events.at(-1), { t: 'setup', setup: { need: 'missing' } });
    a.equal(svc.getSettings().onboarding, 'active');
    // Opening it again asks again, and says nothing new while nothing changed.
    await svc.greetOnFirstOpen();
    a.equal(events.length, 1);

    // Pi installed but signed in nowhere: a different notice, still no wake.
    need = { need: 'no-provider' };
    await svc.greetOnFirstOpen();
    a.equal(woken.length, 0);
    a.deepEqual(svc.snapshot().setup, { need: 'no-provider' });
    a.deepEqual(events.at(-1), { t: 'setup', setup: { need: 'no-provider' } });

    // A Pi that fails to answer is said to be unreachable, not missing a provider.
    svc.setPiCheck(async () => { throw new Error('pi exited with code 1'); });
    await svc.greetOnFirstOpen();
    a.deepEqual(svc.piSetup(), { need: 'unreachable', error: 'pi exited with code 1' });
    a.equal(woken.length, 0);
    svc.setPiCheck(async () => (asked++, need));

    // With a tab open, the scheduler looks again by itself (Pi set up from a terminal, say).
    need = undefined;
    const before = asked;
    svc.tick(() => false);
    for (let i = 0; i < 200 && !woken.length; i++) await Bun.sleep(5);
    a.ok(asked > before);
    // Ready: the usual welcome, worded as always, and the notice goes.
    a.equal(woken.length, 1);
    a.equal(woken[0].botId, bot.id);
    a.equal(woken[0].wake.conversationId, conversationId);
    a.match(woken[0].wake.text, /Introduce yourself/);
    a.match(woken[0].wake.text, /offer "team"/);
    a.equal(svc.piSetup(), undefined);
    a.equal(svc.snapshot().setup, undefined);
    a.deepEqual(events.at(-1), { t: 'setup', setup: undefined });
    a.equal(svc.getSettings().onboarding, 'done');

    // Once only (the scheduler's usual look-ins start now, and aren't welcomes).
    await svc.greetOnFirstOpen(true);
    svc.tick(() => false);
    await Bun.sleep(20);
    a.equal(woken.filter((w) => w.wake.kind === 'note').length, 1);
    unsubscribe();
    process.exit(0);
  `);
});

test("checks that overlap ask Pi again rather than greeting on a stale answer", async () => {
  await isolated("openbuild-bots-setup-race-", `
    import { strict as a } from 'node:assert';
    import * as svc from './server/bots/service.ts';
    const woken = [];
    svc.setHooks({ wake: (botId, wake) => woken.push(wake), stop() {} });
    let need = { need: 'no-provider' };
    const fresh = [];
    let release;
    svc.setPiCheck((f) => { fresh.push(f); return fresh.length === 1 ? new Promise((r) => (release = () => r(need))) : Promise.resolve(need); });
    svc.ensureStarted();
    const first = svc.greetOnFirstOpen();
    // A sign-in finishes while Pi is still being asked: one answer covers both, asked afresh.
    need = undefined;
    const second = svc.greetOnFirstOpen();
    release();
    await Promise.all([first, second]);
    a.deepEqual(fresh, [false, true]);
    a.equal(woken.length, 1);
    a.equal(svc.piSetup(), undefined);
    process.exit(0);
  `);
});

test("installing Pi or signing in from Settings greets without a reload", async () => {
  await isolated("openbuild-bots-setup-recover-", `
    import { strict as a } from 'node:assert';
    import * as svc from './server/bots/service.ts';
    import { forgetModels } from './server/pi/sessions.ts';
    const runner = await import('./server/bots/runner.ts');
    svc.ensureStarted();
    runner.startBots();
    const woken = [];
    // The real wiring, with Pi's answer and the bot's wake stood in for.
    svc.setHooks({ wake: (botId, wake) => woken.push(wake), stop() {} });
    let need = { need: 'missing' };
    svc.setPiCheck(async () => need);
    await svc.greetOnFirstOpen();
    a.deepEqual(svc.piSetup(), { need: 'missing' });

    // Pi's install job finishing (or a sign-in) drops its model listing: that's the cue to look again.
    need = { need: 'no-provider' };
    forgetModels();
    for (let i = 0; i < 200 && svc.piSetup()?.need !== 'no-provider'; i++) await Bun.sleep(5);
    a.deepEqual(svc.piSetup(), { need: 'no-provider' });
    a.equal(woken.length, 0);

    need = undefined;
    forgetModels();
    for (let i = 0; i < 200 && !woken.length; i++) await Bun.sleep(5);
    a.equal(woken.length, 1);
    a.match(woken[0].text, /Introduce yourself/);
    a.equal(svc.piSetup(), undefined);
    process.exit(0);
  `);
});

test("Pi isn't there when its executable isn't", async () => {
  await isolated("openbuild-bots-setup-nopi-", `
    import { strict as a } from 'node:assert';
    const { piSetup } = await import('./server/bots/runner.ts');
    a.deepEqual(await piSetup(true), { need: 'missing' });
    process.exit(0);
  `, { PI_BIN: "/nonexistent/openbuild-test/pi" });
});

// Real Pi with nothing signed in and no provider keys in the environment.
test.skipIf(!piBin())("a Pi with no provider has no models to greet with", async () => {
  const env = Object.fromEntries(Object.keys(process.env).filter((k) => /_API_KEY$|_TOKEN$|^AWS_|^GOOGLE_|^AZURE_/.test(k)).map((k) => [k, ""]));
  await isolated("openbuild-bots-setup-noprov-", `
    import { strict as a } from 'node:assert';
    import { mkdirSync } from 'node:fs';
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    const { piSetup } = await import('./server/bots/runner.ts');
    a.deepEqual(await piSetup(true), { need: 'no-provider' });
    process.exit(0);
  `, { ...env, PI_BIN: piBin()! }, /^\[pi\] model scope unavailable/); // No managed install in an isolated agent dir to read a scope from.
}, 30_000);

const egg = { id: "egg", name: "Dr Eggbot", look: { shape: "puff", color: "white" }, primary: true, instructions: "", memory: [], routines: [], createdAt: 0 } as Bot;

test("the notice says which of the two is missing, links to pi.dev and leads into Settings", () => {
  const missing = renderToStaticMarkup(createElement(PiSetupNotice, { setup: { need: "missing" }, bot: egg }));
  expect(missing).toContain("Pi isn&#x27;t installed");
  expect(missing).toContain("OpenBots needs Pi installed and a provider connected to work.");
  expect(missing).toContain("Install Pi in Settings");
  expect(missing).toContain(`href="${PI_SITE}"`);
  expect(missing).toContain("Check again");
  expect(missing).not.toContain("no provider is connected");

  const noProvider = renderToStaticMarkup(createElement(PiSetupNotice, { setup: { need: "no-provider" }, bot: egg }));
  expect(noProvider).toContain("Pi is installed but no provider is connected yet");
  expect(noProvider).toContain("Connect a provider");
  expect(noProvider).toContain(`href="${PI_SITE}"`);
  expect(noProvider).not.toContain("isn&#x27;t installed");

  // Each button opens the section that fixes it.
  expect(setupText({ need: "missing" }, "Dr Eggbot").action?.section).toBe("pi");
  expect(setupText({ need: "no-provider" }, "Dr Eggbot").action?.section).toBe("keys");
  expect(setupText({ need: "unreachable", error: "pi exited with code 1" }, "Dr Eggbot").hint).toContain("pi exited with code 1");
  // Another device's bots are set up there, so this one's Settings aren't offered.
  const remote = setupText({ need: "missing" }, "Dr Eggbot", "cachyos");
  expect(remote.action).toBeUndefined();
  expect(remote.hint).toContain("Set it up on cachyos");
});
