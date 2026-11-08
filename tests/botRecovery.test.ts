import { expect, test } from "bun:test";
import { promptSafely, recoverPrompt, ModelFailure } from "../server/bots/runner";
import { PiTimeoutError } from "../server/pi/rpc";

test("lost prompt acknowledgement aborts active Pi before releasing the caller, without replay", async () => {
  let active = false;
  let release!: () => void;
  const barrier = new Promise<void>(r => release = r);
  const commands: string[] = [];
  const mind = { steerable: true, needsRecovery: false, proc: { async send<T>(c: { type: string }): Promise<T> {
    commands.push(c.type);
    if (c.type === "prompt") {
      expect(active).toBe(false);
      active = true; // RPC deadline does not cancel accepted work.
      throw new PiTimeoutError('Pi didn\'t answer "prompt" in time');
    }
    expect(active).toBe(true);
    if (c.type === "clear_queue") return { steering: [] } as T;
    await barrier;
    active = false;
    return undefined as T;
  } } };
  let finished = false;
  const result = promptSafely(mind, { type: "prompt" }).catch(e => { finished = true; return e; });
  await Bun.sleep(5);
  expect(commands).toEqual(["prompt", "clear_queue", "abort"]);
  expect(finished).toBe(false);
  expect(mind.steerable).toBe(false);
  release();
  const error = await result;
  expect(error).toBeInstanceOf(PiTimeoutError);
  expect(error).not.toBeInstanceOf(ModelFailure);
  expect(active).toBe(false);
  expect(mind.needsRecovery).toBe(false);
});

test("failed abort quarantines session until a later idle barrier succeeds", async () => {
  const commands: string[] = [];
  let aborts = 0;
  const mind = { needsRecovery: false, proc: { async send<T>(c: { type: string }): Promise<T> {
    commands.push(c.type);
    if (c.type === "prompt" || (c.type === "abort" && ++aborts === 1)) throw new PiTimeoutError("deadline");
    return undefined as T;
  } } };
  await expect(promptSafely(mind, { type: "prompt" })).rejects.toBeInstanceOf(PiTimeoutError);
  expect(mind.needsRecovery).toBe(true);
  await recoverPrompt(mind);
  expect(mind.needsRecovery).toBe(false);
  expect(commands).toEqual(["prompt", "clear_queue", "abort", "clear_queue", "abort"]);
});

test("real RPC timeout leaves child active until recovery abort; late response cannot complete another prompt", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { PiProcess } = await import("../server/pi/rpc");
  const dir = mkdtempSync("/tmp/openbots-recovery-");
  const previous = process.env.PI_BIN;
  const bin = `${dir}/pi`;
  writeFileSync(bin, `#!${process.execPath}
let active = false;
const reply = (c, data) => console.log(JSON.stringify({type:'response',id:c.id,success:true,data}));
for await (const line of console) {
 const c = JSON.parse(line);
 if (c.type === 'prompt') { active = true; setTimeout(() => reply(c, {disposition:'started'}), 80); }
 if (c.type === 'get_state') reply(c, {isStreaming:active});
 if (c.type === 'clear_queue') reply(c, {steering:[], followUp:[]});
 if (c.type === 'abort') { await Bun.sleep(20); active = false; reply(c); }
}
`, { mode: 0o700 });
  process.env.PI_BIN = bin;
  const proc = new PiProcess([], dir);
  try {
    await proc.send({ type: "get_state" }); // Child ready before short deadline.
    await expect(proc.send({ type: "prompt" }, 5)).rejects.toBeInstanceOf(PiTimeoutError);
    expect((await proc.send({ type: "get_state" })).isStreaming).toBe(true);
    const mind = { proc, needsRecovery: true };
    await recoverPrompt(mind);
    await Bun.sleep(100); // Late acknowledgement from timed-out prompt.
    expect((await proc.send({ type: "get_state" })).isStreaming).toBe(false);
    expect(proc.exited).toBe(false);
  } finally {
    proc.close(0);
    if (previous === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("busy rejection is recovered without passing it to model fallback", async () => {
  const commands: string[] = [];
  const mind = { proc: { async send<T>(c: { type: string }): Promise<T> {
    commands.push(c.type);
    if (c.type === "prompt") throw new Error("Agent is already processing. Specify streamingBehavior");
    return undefined as T;
  } } };
  await expect(promptSafely(mind, { type: "prompt" })).rejects.toBeInstanceOf(PiTimeoutError);
  expect(commands).toEqual(["prompt", "clear_queue", "abort"]);
});

// Pi 1.5 runs RPC commands concurrently. A prompt's preflight (input handlers, sign-in check) is async
// and the session is idle until it ends, so abort returns at once and the prompt starts afterwards.
async function fakePi(script: string, body: (proc: import("../server/pi/rpc").PiProcess) => Promise<void>) {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { PiProcess } = await import("../server/pi/rpc");
  const dir = mkdtempSync("/tmp/openbots-recovery-");
  const previous = process.env.PI_BIN;
  writeFileSync(`${dir}/pi`, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  process.env.PI_BIN = `${dir}/pi`;
  const proc = new PiProcess([], dir);
  try {
    await proc.send({ type: "get_state" });
    await body(proc);
  } finally {
    proc.close(0);
    if (previous === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

const LATE_PREFLIGHT = `
let active = false, starts = 0;
const out = (r) => console.log(JSON.stringify(r));
const reply = (c, data) => out({type:'response',id:c.id,command:c.type,success:true,data});
for await (const line of console) {
  const c = JSON.parse(line);
  if (c.type === 'get_state') reply(c, {isStreaming:active, starts});
  if (c.type === 'clear_queue') reply(c, {steering:[], followUp:[]});
  // Idle while the preflight runs: abort has nothing to wait for.
  if (c.type === 'abort') { if (active) { await Bun.sleep(10); active = false; out({type:'agent_settled'}); } reply(c); }
  if (c.type === 'prompt') setTimeout(() => { active = true; starts++; reply(c, {disposition:'started'}); out({type:'agent_start'}); }, 150);
}
`;

test("a prompt whose preflight starts its run after abort returned idle is stopped before the caller is released", () => fakePi(LATE_PREFLIGHT, async (proc) => {
  const mind = { proc, needsRecovery: false, steerable: true };
  await expect(promptSafely(mind, { type: "prompt", message: "old" }, 20)).rejects.toBeInstanceOf(PiTimeoutError);
  expect(mind.needsRecovery).toBe(false);
  expect(await proc.send<{ isStreaming: boolean; starts: number }>({ type: "get_state" })).toEqual({ isStreaming: false, starts: 1 });
  // Nothing left to start late.
  await Bun.sleep(200);
  expect((await proc.send({ type: "get_state" })).isStreaming).toBe(false);
}));

test("a preflight that never answers keeps the session quarantined instead of releasing it", () => fakePi(LATE_PREFLIGHT.replace("}, 150)", "}, 60_000)"), async (proc) => {
  const mind = { proc, needsRecovery: false };
  const timeout = await proc.send({ type: "prompt" }, 20).catch((e) => e);
  expect(timeout).toBeInstanceOf(PiTimeoutError);
  const { recoverPrompt: recover } = await import("../server/bots/runner");
  const recovering = recover({ ...mind, overdue: new Set([timeout.answered]) }, 50);
  await expect(recovering).rejects.toBeInstanceOf(PiTimeoutError);
}));

test("a steer Pi answers late is taken as delivered, not queued again to be read twice", async () => {
  const { steerSafely } = await import("../server/bots/runner");
  await fakePi(`
const out = (r) => console.log(JSON.stringify(r));
for await (const line of console) {
  const c = JSON.parse(line);
  if (c.type === 'steer') setTimeout(() => out({type:'response',id:c.id,command:'steer',success:true,data:{disposition:'queued'}}), 80);
  else out({type:'response',id:c.id,command:c.type,success:true,data:{}});
}
`, async (proc) => {
    const mind: Parameters<typeof steerSafely>[0] = { proc };
    let disposition: string | undefined = "unset";
    steerSafely(mind, { type: "steer", message: "late" }, (d) => (disposition = d), 20);
    await Promise.all(mind.pendingSteers!);
    expect(disposition).toBe("queued");
    // Pi may have queued it after the turn settled: the turn clears Pi's queue before it lets go.
    expect(mind.needsRecovery).toBe(true);
    expect(mind.overdue?.size).toBe(0);
  });
});

test("a steer Pi queues after the turn settled is cleared and gets a turn of its own", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const data = await mkdtemp("/tmp/openbots-steer-");
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      const minds = globalThis.openbotsMinds = new Map();
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
      const sessionPathFor = id => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', id, (globalThis.openbotsFocus?.get(id) ?? svc.directId(id))));
      const boss = svc.createBot({ name: 'Boss' });
      const prompts = [], commands = [], queue = [];
      const mind = { token: 'test', loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), close() {}, async send(cmd) {
        commands.push(cmd.type);
        if (cmd.type === 'prompt') prompts.push(cmd);
        if (cmd.type === 'steer') {
          // The run ends while an input handler still holds the steer, which Pi then queues.
          runner.onRecord(boss.bot.id, mind, { type: 'agent_settled' });
          await Bun.sleep(50);
          queue.push(cmd.message);
          commands.push('steer_accepted');
          return { disposition: 'queued' };
        }
        if (cmd.type === 'clear_queue') return { steering: queue.splice(0), followUp: [] };
        return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
      } } };
      Object.defineProperty(mind, 'sessionPath', { get: () => sessionPathFor(boss.bot.id) });
        minds.set(boss.bot.id, mind);
      svc.setHooks({ wake: runner.wake, stop: runner.stop });
      const until = async check => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); a.ok(check()); };
      const post = text => svc.postMessage(boss.conversationId, { id: crypto.randomUUID(), author: 'me', text, at: Date.now() });
      post('Start');
      await until(() => prompts.length === 1 && mind.steerable);
      post('Also this');
      await until(() => prompts.length === 2);
      a.ok(commands.indexOf('clear_queue') > commands.indexOf('steer_accepted'), commands.join());
      // Unread, so the bot answers it, and only once: the first turn never read it.
      a.ok(prompts[1].message.includes('] User: Also this'), prompts[1].message);
      a.equal(queue.length, 0);
      runner.onRecord(boss.bot.id, mind, { type: 'agent_settled' });
      process.exit(0);
    `], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENCHAT_DATA_DIR: data } });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: out + err }).toEqual({ code: 0, output: "" });
  } finally {
    await rm(data, { recursive: true, force: true });
  }
}, 15_000);
