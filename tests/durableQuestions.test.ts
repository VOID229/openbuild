import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { DurableRuntime } from "../server/durable/runtime";
import { DurableClient } from "../server/durable/remote";
import { serveWorker } from "../server/durable/worker";
import { fakeModels } from "./durable-fake";

function questionModels() {
  const fake = fakeModels();
  const base = fake.models.streamSimple.bind(fake.models);
  const results: string[] = [];
  fake.models.streamSimple = (model, input, options) => {
    const result = input.messages.find(m => m.role === "toolResult");
    if (result?.role === "toolResult") {
      results.push(result.content.filter(b => b.type === "text").map(b => b.text).join("\n"));
      return base(model, input, options);
    }
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [{ type: "toolCall", id: "native-question-1", name: "question_ask", arguments: { question: "Which approach?", options: [" Small ", "Large", "Small", "Other", "Something else"] } }],
      stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    queueMicrotask(() => stream.push({ type: "done", reason: "toolUse", message }));
    return stream;
  };
  return { ...fake, results };
}
const request = (model: string) => ({ threadId: "question-thread", cwd: tmpdir(), model, effort: "off" as const, message: "choose", prior: 0, stream: { id: "question-run" } });
async function until(fn: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!fn()) { if (Date.now() > deadline) throw new Error("Timed out"); await Bun.sleep(10); }
}

describe("Durable questions", () => {
  for (const [name, reply, expected] of [
    ["option", { value: "Small" }, "The user answered: Small"],
    ["free text", { value: "A different approach" }, "The user answered: A different approach"],
    ["cancel", { cancelled: true }, "The user dismissed the question without answering."],
  ] as const) test(name, async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-question-"));
    const fake = questionModels();
    const runtime = new DurableRuntime(directory, fake.models);
    try {
      const run = await runtime.startRun(request(fake.model));
      await until(() => run.events.some(e => e.t === "ask"));
      expect(run.events.find(e => e.t === "ask")).toMatchObject({ id: "native-question-1", title: "Which approach?", options: ["Small", "Large"], other: true });
      expect(await runtime.answer("wrong-thread", "native-question-1", reply)).toBe(false);
      expect(await runtime.answer("question-thread", "missing", reply)).toBe(false);
      expect(await runtime.answer("question-thread", "native-question-1", reply)).toBe(true);
      await until(() => run.ended);
      expect(fake.results).toEqual([expected]);
      expect(run.events.filter(e => e.t === "asked")).toHaveLength(1);
      expect(run.events.some(e => e.t === "tool" && e.name === "question_ask" && e.status === "done")).toBe(true);
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test("pending question survives Harness shutdown/reopen without duplicate cards", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-question-recover-"));
    const fake = questionModels();
    let runtime = new DurableRuntime(directory, fake.models);
    try {
      const run = await runtime.startRun(request(fake.model));
      await until(() => run.events.some(e => e.t === "ask"));
      await runtime.close();
      runtime = new DurableRuntime(directory, fake.models);
      await runtime.recover();
      const recovered = (await runtime.findRun(run.id))!;
      expect(recovered.ended).toBe(false);
      expect(await runtime.answer("question-thread", "native-question-1", { value: "after restart" })).toBe(true);
      await until(() => recovered.ended);
      expect(fake.results).toEqual(["The user answered: after restart"]);
      expect(recovered.events.filter(e => e.t === "ask")).toHaveLength(1);
      expect(recovered.events.filter(e => e.t === "asked")).toHaveLength(1);
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test("SIGKILL while waiting recovers the native question and accepts its answer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-question-kill-"));
    const marker = join(directory, "waiting");
    const code = `
      import { DurableRuntime } from './server/durable/runtime.ts';
      import { fakeModels } from './tests/durable-fake.ts';
      import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
      import { writeFileSync } from 'node:fs';
      const questionModels = ${questionModels.toString()};
      const fake = questionModels();
      const runtime = new DurableRuntime(${JSON.stringify(directory)}, fake.models);
      const run = await runtime.startRun({...${JSON.stringify(request("MODEL"))},model:fake.model});
      while (!run.events.some(e => e.t === 'ask')) await Bun.sleep(10);
      writeFileSync(${JSON.stringify(marker)}, 'ready');
      setInterval(() => {}, 1000);
    `;
    const child = Bun.spawn([process.execPath, "-e", code], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    let runtime: DurableRuntime | undefined;
    try {
      await until(() => existsSync(marker));
      child.kill("SIGKILL"); await child.exited;
      const fake = questionModels();
      runtime = new DurableRuntime(directory, fake.models);
      await runtime.recover();
      const run = (await runtime.findRun("question-run"))!;
      expect(run.ended).toBe(false);
      expect(await runtime.answer("question-thread", "native-question-1", { value: "survived crash" })).toBe(true);
      await until(() => run.ended);
      expect(fake.results).toEqual(["The user answered: survived crash"]);
      expect(run.events.filter(e => e.t === "ask")).toHaveLength(1);
      expect(run.events.filter(e => e.t === "asked")).toHaveLength(1);
    } finally {
      child.kill(); await child.exited;
      await runtime?.close(); rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reply persisted before tool result is replayed after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-question-answered-recover-"));
    const fake = questionModels();
    let runtime = new DurableRuntime(directory, fake.models);
    try {
      const run = await runtime.startRun(request(fake.model));
      await until(() => run.events.some(e => e.t === "ask"));
      await runtime.close();
      // Fault injection: worker died after the reply+asked projection fsync and before execute returns.
      const file = join(directory, "runs", readdirSync(join(directory, "runs"))[0]!);
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      manifest.questions["native-question-1"].answered = true;
      manifest.questions["native-question-1"].answer = "already persisted";
      manifest.events.push({ t: "asked", id: "native-question-1", answer: "already persisted" });
      writeFileSync(file, JSON.stringify(manifest));
      runtime = new DurableRuntime(directory, fake.models);
      await runtime.recover();
      const recovered = (await runtime.findRun(run.id))!;
      await until(() => recovered.ended);
      expect(fake.results).toEqual(["The user answered: already persisted"]);
      expect(recovered.events.filter(e => e.t === "ask")).toHaveLength(1);
      expect(recovered.events.filter(e => e.t === "asked")).toHaveLength(1);
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test("a failed reply fsync cannot release the live tool waiter", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-question-write-failure-"));
    const fake = questionModels();
    const runtime = new DurableRuntime(directory, fake.models);
    try {
      const run = await runtime.startRun(request(fake.model));
      await until(() => run.events.some(e => e.t === "ask"));
      const persist = (runtime as any).persist;
      (runtime as any).persist = () => { throw new Error("fsync failed"); };
      await expect(runtime.answer("question-thread", "native-question-1", { value: "must not escape" })).rejects.toThrow("fsync failed");
      await Bun.sleep(100);
      expect(fake.results).toEqual([]);
      expect(run.events.filter(e => e.t === "asked")).toHaveLength(0);
      (runtime as any).persist = persist;
      expect(await runtime.answer("question-thread", "native-question-1", { value: "committed" })).toBe(true);
      await until(() => run.ended);
      expect(fake.results).toEqual(["The user answered: committed"]);
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test("stopping a question dismisses its card and rejects late replies", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-question-stop-"));
    const fake = questionModels();
    const runtime = new DurableRuntime(directory, fake.models);
    try {
      const run = await runtime.startRun(request(fake.model));
      await until(() => run.events.some(e => e.t === "ask"));
      await runtime.stopRun(run.id);
      await until(() => run.ended);
      expect(run.events.filter(e => e.t === "asked")).toEqual([{ t: "asked", id: "native-question-1" }]);
      expect(await runtime.answer("question-thread", "native-question-1", { value: "too late" })).toBe(false);
      expect(run.events.at(-1)).toMatchObject({ t: "done", finish: "aborted" });
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test("answer forwards through DurableClient and worker", async () => {
    const directory = mkdtempSync(join(tmpdir(), "durable-question-worker-"));
    const socket = join(directory, "worker.sock");
    const fake = questionModels();
    const runtime = new DurableRuntime(directory, fake.models);
    const worker = serveWorker(runtime, socket);
    const client = new DurableClient(directory, socket);
    try {
      await worker.ready;
      const run = await client.startRun(request(fake.model));
      await until(() => run.events.some(e => e.t === "ask"));
      expect(await client.answerQuestion("question-thread", "native-question-1", { value: "via IPC" })).toBe(true);
      await until(() => run.ended);
      expect(fake.results).toEqual(["The user answered: via IPC"]);
    } finally { client.close(); worker.server.stop(true); await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
