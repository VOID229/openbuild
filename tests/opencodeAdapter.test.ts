import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiChatRequest } from "../shared/types";
import { Connection, closeWorkerConnection, serverEnvironment } from "../server/opencode-agent/connection";
import { listModels, forgetModels, status } from "../server/opencode-agent/install";
// Storage is imported only inside an isolated test subprocess, never in the caller's home DB.
if (!process.env.OB_OPENCODE_ADAPTER_TEST_CHILD) {
  test("OpenCode adapter protocol suite (isolated storage)", async () => {
    const data = mkdtempSync(join(tmpdir(), "ob-opencode-test-data-"));
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], { env: { ...process.env, OPENCHAT_DATA_DIR: data, OB_OPENCODE_ADAPTER_TEST_CHILD: "1" }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(out + err);
      expect(code).toBe(0);
    } finally { rmSync(data, { recursive: true, force: true }); }
  }, 30_000);
} else {
const { runTurn, answer, hasAsk, release, restartIdle, questionPrompt } = await import("../server/opencode-agent/sessions");
const cwd = mkdtempSync(join(tmpdir(), "ob-opencode-adapter-"));
const original = { url: process.env.OPENCODE_SERVER_URL, password: process.env.OPENCODE_SERVER_PASSWORD };
const sessions = new Map<string, { id: string; location: { directory: string }; messages: any[] }>();
const calls: { path: string; method: string; body: any }[] = [];
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const model = { id: "model/with/slash", providerID: "native-brand", name: "Native model", enabled: true, capabilities: { input: ["text", "image"], tools: true }, variants: [{ id: "high" }, { id: "native-special" }], limit: { context: 100000, output: 8000 } };
const json = (v: any) => Response.json(v);
const emit = (type: string, data: any) => { for (const s of streams) { try { s.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data, created: Date.now() })}\r\n\r\n`)); } catch { streams.delete(s); } } };
let behavior: (id: string, text: string) => void;
let invalidVersion = false;
let active = false;
let losePromptReply = false;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const url = new URL(req.url), path = url.pathname;
  expect(req.headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:fixture-password").toString("base64")}`);
  const raw = req.method === "POST" ? await req.text() : "";
  const body = raw ? JSON.parse(raw) : undefined;
  calls.push({ path, method: req.method, body });
  if (path === "/api/info") return json({ version: invalidVersion ? "1.9.0" : "2.0.32", pid: 1, urls: [], paths: { tmp: cwd } });
  if (path === "/api/model") return json({ data: [model] });
  if (path === "/api/model/default") return json({ data: model });
  if (path === "/api/session/active") return json({ data: active ? Object.fromEntries([...sessions.keys()].map(id => [id, { type: "running" }])) : {} });
  if (path === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.add(controller); controller.enqueue(new TextEncoder().encode(": connected\r\n\r\n")); }, cancel() {} }), { headers: { "Content-Type": "text/event-stream" } });
  if (path === "/api/session" && req.method === "POST") { const id = `ses_${crypto.randomUUID()}`; const s = { id, location: body.location, messages: [] }; sessions.set(id, s); return json({ data: s }); }
  const m = /^\/api\/session\/([^/]+)(.*)$/.exec(path);
  if (!m) return new Response("missing", { status: 404 });
  const s = sessions.get(m[1]!); if (!s) return new Response("missing", { status: 404 });
  if (!m[2]) return json({ data: s });
  if (m[2] === "/message") return json({ data: s.messages, cursor: {} });
  if (m[2] === "/prompt") { s.messages.push({ type: "user", id: crypto.randomUUID(), text: body.text }); setTimeout(() => behavior(s.id, body.text), 5); if (losePromptReply) { await Bun.sleep(30); return new Response("Gateway lost the reply", { status: 502 }); } return json({ data: { id: s.messages.at(-1).id } }); }
  if (m[2] === "/interrupt") { setTimeout(() => emit("session.execution.interrupted", { sessionID: s.id }), 5); return json({ data: {} }); }
  if (m[2].includes("/permission/")) { setTimeout(() => emit("session.execution.succeeded", { sessionID: s.id }), 5); return json({ data: {} }); }
  if (m[2].includes("/form/") && req.method === "POST") { setTimeout(() => emit("session.execution.succeeded", { sessionID: s.id }), 5); return json({ data: {} }); }
  if (m[2].includes("/form/") && req.method === "DELETE") { setTimeout(() => emit("session.execution.succeeded", { sessionID: s.id }), 5); return json({ data: {} }); }
  return json({ data: {} });
} });
process.env.OPENCODE_SERVER_URL = server.url.toString(); process.env.OPENCODE_SERVER_PASSWORD = "fixture-password";
function finish(id: string) { emit("session.execution.succeeded", { sessionID: id }); }
function req(message = "hello", threadId = crypto.randomUUID(), prior = 0): PiChatRequest { return { threadId, cwd, model: "opencode/native-brand/model/with/slash", message, prior, effort: "high" }; }
async function collect(request: PiChatRequest, signal = new AbortController().signal): Promise<any[]> { return (await new Response(runTurn(request, signal)).text()).trim().split("\n").map(line => JSON.parse(line)); }
async function waitFor(predicate: () => boolean) { for (let i = 0; i < 300 && !predicate(); i++) await Bun.sleep(5); expect(predicate()).toBe(true); }
async function withAsk(request: PiChatRequest, reply: (event: any) => void) {
  const events: any[] = []; const reader = runTurn(request, new AbortController().signal).getReader();
  while (true) { const next = await reader.read(); if (next.done) break; for (const line of new TextDecoder().decode(next.value).trim().split("\n")) { const event = JSON.parse(line); events.push(event); if (event.t === "ask") reply(event); } }
  return events;
}
beforeEach(async () => {
  await closeWorkerConnection(); forgetModels(); active = false; invalidVersion = false; losePromptReply = false; calls.length = 0;
  for (const s of streams) { try { s.close(); } catch {} } streams.clear();
  behavior = id => { emit("session.text.delta", { sessionID: id, assistantMessageID: "a", ordinal: 0, delta: "hello" }); emit("session.text.ended", { sessionID: id, assistantMessageID: "a", ordinal: 0, text: "hello world" }); finish(id); };
});
afterAll(async () => { await closeWorkerConnection(); server.stop(true); if (original.url === undefined) delete process.env.OPENCODE_SERVER_URL; else process.env.OPENCODE_SERVER_URL = original.url; if (original.password === undefined) delete process.env.OPENCODE_SERVER_PASSWORD; else process.env.OPENCODE_SERVER_PASSWORD = original.password; rmSync(cwd, { recursive: true, force: true }); });

test("v2 discovery uses enabled native models, native brand and only advertised efforts; rejects v1", async () => {
  const listing = await listModels(true);
  expect(listing.models[0]).toMatchObject({ id: "opencode/native-brand/model/with/slash", provider: "native-brand", reasoning: { efforts: ["high"], toggle: false } });
  expect(listing.defaultModel).toBe(listing.models[0]!.id);
  expect((await status()).version).toBe("2.0.32");
  invalidVersion = true;
  await expect(new Connection(server.url.toString().replace(/\/$/, ""), "fixture-password").verify()).rejects.toThrow("v1");
  expect(serverEnvironment("random").OPENCODE_SERVER_PASSWORD).toBeUndefined();
  expect(serverEnvironment("random").OPENCODE_PASSWORD).toBe("random");
});

test("native mapping resumes without replay, applies model per later turn, images use data URI and ended does not duplicate deltas", async () => {
  const request = req(); const events = await collect({ ...request, images: [{ mimeType: "image/png", data: "aGVsbG8=" }] });
  expect(events.filter(e => e.t === "text").map(e => e.v).join("")).toBe("hello world");
  expect(events.at(-1)).toEqual({ t: "end" });
  expect(calls.find(c => c.path.endsWith("/prompt"))!.body.files).toEqual([{ uri: "data:image/png;base64,aGVsbG8=" }]);
  expect(calls.find(c => c.path === "/api/session")!.body).toEqual({ location: { directory: cwd }, model: { providerID: "native-brand", id: "model/with/slash", variant: "high" } });
  release(request.threadId); restartIdle();
  const later = await collect({ ...request, prior: 1, message: "new message" });
  expect(later.some(e => e.t === "done")).toBe(true);
  expect(calls.filter(c => c.path.endsWith("/prompt")).map(c => c.body.text)).toEqual([questionPrompt("hello"), questionPrompt("new message")]);
  expect(calls.some(c => c.path.endsWith("/model"))).toBe(true);
  const mismatch = await collect({ ...request, prior: 0 }); expect(mismatch.find(e => e.t === "error").message).toContain("history mismatch");
  expect((await collect({ ...req(), forkFrom: request.threadId })).find(e => e.t === "error").message).toContain("fork");
});

test("each native prompt carries question guidance without changing the submitted request", async () => {
  const request = req("Please clarify before proceeding");
  await collect(request);
  await collect({ ...request, prior: 1, message: "Continue" });
  const prompts = calls.filter(c => c.path.endsWith("/prompt"));
  for (const prompt of prompts) {
    expect(prompt.body.text).toContain("use the native question tool (which creates a form) instead of asking in prose");
    expect(prompt.body.text).toContain("custom answers enabled");
    expect(prompt.body.text).toContain("never invent the user's answer");
    expect(prompt.body.text.match(/<openbuild-question-instructions>/g)).toHaveLength(1);
  }
  expect(prompts[0]!.body.text).toEndWith("\n\n" + request.message);
  expect(request.message).toBe("Please clarify before proceeding");
});

test("a confirmed native terminal settles history even when its prompt HTTP reply is lost", async () => {
  const request = req(); losePromptReply = true;
  const events = await collect(request);
  expect(events.some(e => e.t === "error")).toBe(false);
  expect(events.find(e => e.t === "done").finish).toBe("stop");
  losePromptReply = false;
  const next = await collect({ ...request, prior: 1, message: "continue once" });
  expect(next.some(e => e.t === "error")).toBe(false);
  expect(calls.filter(c => c.path.endsWith("/prompt")).map(c => c.body.text)).toEqual([questionPrompt("hello"), questionPrompt("continue once")]);
});

test("tools retain native args/metadata, reasoning and usage accumulate; child completion never terminates root", async () => {
  behavior = id => {
    emit("session.created", { sessionID: "child", parentID: id });
    for (const sid of [id, "child"]) {
      emit("session.tool.input.started", { sessionID: sid, id: "same", name: "shell" });
      emit("session.tool.called", { sessionID: sid, id: "same", input: { command: "echo test", native: 7 } });
      emit("session.tool.progress", { sessionID: sid, id: "same", metadata: { extra: "evidence" } });
      emit("session.tool.success", { sessionID: sid, id: "same", content: [{ type: "text", text: "output" }], metadata: { exit: 0 } });
    }
    finish("child");
    emit("session.reasoning.delta", { sessionID: id, assistantMessageID: "a", ordinal: 1, delta: "think" });
    emit("session.reasoning.ended", { sessionID: id, assistantMessageID: "a", ordinal: 1, text: "think" });
    for (let i = 0; i < 2; i++) emit("session.step.ended", { sessionID: id, tokens: { input: 10, output: 3, reasoning: 2, cache: { read: 4, write: 1 } }, cost: .01 });
    setTimeout(() => { emit("session.text.ended", { sessionID: id, assistantMessageID: "a", ordinal: 2, text: "root finished" }); finish(id); }, 15);
  };
  const events = await collect(req());
  expect(events.filter(e => e.t === "reasoning").map(e => e.v).join("")).toBe("think");
  expect(events.find(e => e.t === "tool" && e.id === "same" && e.status === "done")).toMatchObject({ name: "bash", output: "output", args: { command: "echo test", opencode: { metadata: { extra: "evidence", exit: 0 }, input: { native: 7 } } } });
  expect(events.some(e => e.t === "tool" && e.id === "child:same")).toBe(true);
  expect(events.find(e => e.t === "text").v).toBe("root finished");
  expect(events.find(e => e.t === "done").usage).toMatchObject({ input: 20, output: 10, cacheRead: 8, cacheWrite: 2, cost: .02 });
});

test("permissions never autoapprove; explicit allow once or cancellation replies exactly once", async () => {
  behavior = id => emit("permission.asked", { id: "permission", sessionID: id, action: "shell", resources: ["echo safe"] });
  for (const allow of [true, false]) {
    const request = req();
    const events = await withAsk(request, event => {
      expect(hasAsk(request.threadId, event.id)).toBe(true);
      expect(calls.some(c => c.path.includes("/permission/"))).toBe(!allow);
      expect(answer(request.threadId, event.id, allow ? { value: "Allow once" } : { cancelled: true })).toBe(true);
      expect(answer(request.threadId, event.id, { confirmed: true })).toBe(false);
    });
    expect(events.some(e => e.t === "asked")).toBe(true);
  }
  expect(calls.filter(c => c.path.includes("/permission/")).map(c => c.body)).toEqual([{ decision: "once" }, { decision: "reject" }]);
});

test("simple forms ask sequentially with typed values, unsupported forms cancel visibly", async () => {
  behavior = id => emit("form.created", { form: { id: "form", sessionID: id, title: "Questions", fields: [{ key: "choice", type: "string", options: [{ label: "Display", value: "native-value" }] }, { key: "count", type: "integer" }, { key: "enabled", type: "boolean" }] } });
  const request = req(); let n = 0;
  await withAsk(request, event => { answer(request.threadId, event.id, { value: ["Display", "3", "Yes"][n++] }); });
  expect(n).toBe(3);
  expect(calls.find(c => c.path.endsWith("/form/form/reply"))!.body).toEqual({ answer: { choice: "native-value", count: 3, enabled: true } });
  behavior = id => emit("form.created", { form: { id: "complex", sessionID: id, fields: [{ key: "many", type: "multiselect" }] } });
  const events = await collect(req());
  expect(events.find(e => e.t === "error").message).toContain("unsupported complex form");
  expect(calls.some(c => c.method === "DELETE" && c.path.endsWith("/form/complex"))).toBe(true);
});

test("native forms preserve custom free text, deduplicate creation and cancel without answers", async () => {
  behavior = id => {
    const form = { id: "custom", sessionID: id, fields: [{ key: "approach", type: "string", custom: true, options: [{ label: "Small", value: "small" }, { label: "Full", value: "full" }] }, { key: "details", type: "string" }] };
    emit("form.created", { form }); emit("form.created", { form });
  };
  const request = req(); let n = 0;
  const events = await withAsk(request, event => {
    if (n === 0) expect(event.other).toBe(true);
    else expect(event.method).toBe("input");
    expect(answer(request.threadId, event.id, { value: n++ === 0 ? "Custom approach" : "Free text" })).toBe(true);
    expect(answer(request.threadId, event.id, { value: "duplicate" })).toBe(false);
  });
  expect(n).toBe(2);
  expect(events.filter(e => e.t === "asked")).toHaveLength(2);
  expect(calls.filter(c => c.path.endsWith("/form/custom/reply")).map(c => c.body)).toEqual([{ answer: { approach: "Custom approach", details: "Free text" } }]);
  calls.length = 0;
  const cancelled = req();
  await withAsk(cancelled, event => { answer(cancelled.threadId, event.id, { cancelled: true }); });
  expect(calls.filter(c => c.path.endsWith("/form/custom")).map(c => c.method)).toEqual(["DELETE"]);
  expect(calls.some(c => c.path.endsWith("/form/custom/reply"))).toBe(false);
});

test("abort sends one native interrupt and closes; SSE loss fails visibly without resend", async () => {
  behavior = () => {};
  const request = req(); const abort = new AbortController(); const pending = collect(request, abort.signal);
  await waitFor(() => calls.some(c => c.path.endsWith("/prompt"))); abort.abort();
  const stopped = await pending;
  expect(stopped.find(e => e.t === "done").finish).toBe("aborted");
  expect(calls.filter(c => c.path.endsWith("/interrupt"))).toHaveLength(1);
  const next = req(); const disconnected = collect(next);
  await waitFor(() => calls.filter(c => c.path.endsWith("/prompt")).length === 2);
  for (const stream of streams) { try { stream.close(); } catch {} }
  const lost = await disconnected; expect(lost.find(e => e.t === "error").message).toContain("stream ended");
  const retry = await collect({ ...next, prior: 1, message: "do not replay" });
  expect(retry.find(e => e.t === "error").message).toContain("ambiguous");
  expect(calls.filter(c => c.path.endsWith("/prompt"))).toHaveLength(2);
});

test("definitive native failure permits a later new prompt; cancelling a form sends DELETE", async () => {
  const request = req();
  behavior = id => emit("session.execution.failed", { sessionID: id, error: { type: "provider", message: "native failure" } });
  expect((await collect(request)).find(e => e.t === "error").message).toBe("native failure");
  behavior = id => finish(id);
  expect((await collect({ ...request, prior: 1, message: "next new prompt" })).some(e => e.t === "done")).toBe(true);
  behavior = id => emit("form.created", { form: { id: "cancel-me", sessionID: id, fields: [{ key: "name", type: "string" }] } });
  const formRequest = req();
  await withAsk(formRequest, event => answer(formRequest.threadId, event.id, { cancelled: true }));
  expect(calls.some(c => c.method === "DELETE" && c.path.endsWith("/form/cancel-me"))).toBe(true);
});

test("external history edits, active sessions and unsupported native variants are rejected before prompt", async () => {
  const request = req(); await collect(request);
  active = true;
  expect((await collect({ ...request, prior: 1 })).find(e => e.t === "error").message).toContain("already running");
  active = false; [...sessions.values()].at(-1)!.messages.push({ type: "user", text: "external" });
  expect((await collect({ ...request, prior: 1 })).find(e => e.t === "error").message).toContain("native history mismatch");
  expect((await collect({ ...req(), effort: "max" })).find(e => e.t === "error").message).toContain("does not offer variant");
  expect(calls.filter(c => c.path.endsWith("/prompt"))).toHaveLength(1);
});
}
