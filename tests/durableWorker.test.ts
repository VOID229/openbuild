import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableClient } from "../server/durable/remote";
import { workerSocket } from "../server/durable/worker";
import type { PiChatRequest } from "../shared/types";

const directory = mkdtempSync(join(tmpdir(), "durable-worker-"));
const socket = join(directory, "worker-test.sock");
const marker = join(directory, "model-entered");
const worker = Bun.spawn(
  [
    process.execPath,
    "-e",
    `
    import { serveWorker } from ${JSON.stringify(join(import.meta.dir, "..", "server", "durable", "worker.ts"))};
    import { DurableRuntime } from ${JSON.stringify(join(import.meta.dir, "..", "server", "durable", "runtime.ts"))};
    import { fakeModels } from ${JSON.stringify(join(import.meta.dir, "durable-fake.ts"))};
    const fake = fakeModels({ delayMs: 1200, marker: ${JSON.stringify(marker)} });
    const runtime = new DurableRuntime(${JSON.stringify(directory)}, fake.models);
    serveWorker(runtime, ${JSON.stringify(socket)});
    `,
  ],
  { stdout: "pipe", stderr: "pipe" },
);
afterAll(() => {
  worker.kill();
  rmSync(directory, { recursive: true, force: true });
});

/** Wait for the test's worker to be up, so the client doesn't start one of its own first. */
const waitForWorker = async () => {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    try {
      const res = await fetch("http://durable/health", { unix: socket, signal: AbortSignal.timeout(500) } as RequestInit);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(25);
  }
  throw new Error("the test worker didn't start");
};

const until = async (fn: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};
const request = (id: string, threadId: string): PiChatRequest => ({
  threadId,
  cwd: tmpdir(),
  model: "openai/gpt-4o",
  effort: "off",
  message: "hi",
  prior: 0,
  stream: { id },
});

// The fake model's name is provider/model-id from the catalog; ask the worker to choose it by using
// the same model the fake picked.
const modelName = (await (async () => {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const m = builtinModels().getModels().find((m) => m.type === "chat")!;
  return `${m.provider}/${m.id}`;
})())!;

test("a Durable turn keeps running in the worker while no server is attached", async () => {
  await waitForWorker();
  const first = new DurableClient(directory, socket);
  const req = request("worker-run-1", "worker-thread-one");
  req.model = modelName;
  const run = await first.startRun(req);
  await until(() => existsSync(marker) || run.ended);
  expect(run.ended).toBe(false);
  // The server goes away mid-turn: only its connection to the worker is lost.
  first.close();

  // A restarted server attaches to the same worker, which has finished the turn in the meantime.
  const second = new DurableClient(directory, socket);
  await second.recover();
  const attached = await second.findRun("worker-run-1");
  expect(attached).toBeDefined();
  await until(() => attached!.ended);
  const texts = attached!.events.filter((e) => e.t === "text");
  // Replayed from the manifest: the answer exactly once, not re-requested.
  expect(texts).toEqual([{ t: "text", v: "offline answer" }]);
  expect(attached!.events.at(-1)).toMatchObject({ t: "done" });
  second.close();
}, 30_000);

test("the worker rejects a second turn on the same thread with a busy 409", async () => {
  await waitForWorker();
  const client = new DurableClient(directory, socket);
  const req = request("worker-run-busy", "worker-thread-two");
  req.model = modelName;
  const run = await client.startRun(req);
  await until(() => existsSync(marker));
  const error = await client.startRun({ ...req, prior: 1, stream: { id: "worker-run-busy-2" } }).catch((e) => e);
  expect(error).toMatchObject({ status: 409, code: "busy" });
  await client.stopRun(run.id);
  await until(() => run.ended);
  client.close();
}, 30_000);

test("the worker socket is not world readable", async () => {
  expect(workerSocket(directory).startsWith("/tmp")).toBe(true);
  const { statSync } = await import("node:fs");
  expect(statSync(socket).mode & 0o077).toBe(0);
}, 10_000);

test("the worker is started detached and a new server process reuses it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "durable-detach-"));
  const script = `
    const { DurableClient } = await import(${JSON.stringify(join(import.meta.dir, "..", "server", "durable", "remote.ts"))});
    const client = new DurableClient(${JSON.stringify(dir)});
    await client.recover();
    console.log("attached");
  `;
  const first = Bun.spawn([process.execPath, "-e", script], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const [codeA, errA] = await Promise.all([first.exited, new Response(first.stderr).text()]);
  expect(errA).toBe("");
  expect(codeA).toBe(0);
  const state = JSON.parse(readFileSync(join(dir, "worker.json"), "utf8")) as { pid: number; socket: string };
  // The server process that started it is gone; the worker isn't.
  expect(() => process.kill(state.pid, 0)).not.toThrow();

  const second = Bun.spawn([process.execPath, "-e", script], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const [codeB, errB] = await Promise.all([second.exited, new Response(second.stderr).text()]);
  expect(errB).toBe("");
  expect(codeB).toBe(0);
  // Same worker: a second one would have replaced worker.json with a different pid.
  expect((JSON.parse(readFileSync(join(dir, "worker.json"), "utf8")) as { pid: number }).pid).toBe(state.pid);
  process.kill(state.pid, "SIGTERM");
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

test("steering forwards through the worker and survives server reattachment", async () => {
  await waitForWorker();
  const first = new DurableClient(directory, socket);
  const req = {...request("worker-steer", "worker-steering-thread"),model:modelName};
  const run = await first.startRun(req);
  await first.steer(req.threadId,"s1","change direction",[{data:"aGk=",mimeType:"image/png"}]);
  first.close();
  const second = new DurableClient(directory, socket);
  try {
    const attached = (await second.findRun(run.id))!;
    await until(()=>attached.ended);
    expect(attached.events.filter(e=>e.t==="steer")).toEqual([{t:"steer",id:"s1",text:"change direction"}]);
    const next = await second.startRun({...req,prior:2,message:"next",stream:{id:"worker-after-steer"}});
    await until(()=>next.ended);
    expect(next.events.some(e=>e.t==="error")).toBe(false);
  } finally {second.close();}
},30000);
