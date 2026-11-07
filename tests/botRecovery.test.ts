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
    await barrier;
    active = false;
    return undefined as T;
  } } };
  let finished = false;
  const result = promptSafely(mind, { type: "prompt" }).catch(e => { finished = true; return e; });
  await Bun.sleep(5);
  expect(commands).toEqual(["prompt", "abort"]);
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
    if (c.type === "prompt" || ++aborts === 1) throw new PiTimeoutError("deadline");
    return undefined as T;
  } } };
  await expect(promptSafely(mind, { type: "prompt" })).rejects.toBeInstanceOf(PiTimeoutError);
  expect(mind.needsRecovery).toBe(true);
  await recoverPrompt(mind);
  expect(mind.needsRecovery).toBe(false);
  expect(commands).toEqual(["prompt", "abort", "abort"]);
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
  expect(commands).toEqual(["prompt", "abort"]);
});
