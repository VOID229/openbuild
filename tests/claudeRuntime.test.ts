import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiChatRequest, StreamEvent } from "../shared/types";
import { FAKE_CLAUDE } from "./claudeFixture";

const directory = mkdtempSync(join(tmpdir(), "ob-claude-unit-"));
const fake = join(directory, "claude");
writeFileSync(fake, `#!${process.execPath}\n` + FAKE_CLAUDE); chmodSync(fake, 0o700);
const work = join(directory, "work"); mkdirSync(work);
const vars = { CLAUDE_BIN: fake, CLAUDE_CONFIG_DIR: join(directory, "config"), OPENCHAT_DATA_DIR: join(directory, "data"), FAKE_PROTOCOL: join(directory, "protocol"), FAKE_EFFECTS: join(directory, "effects") };
const original = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
Object.assign(process.env, vars);
// Imported after the environment points storage and the CLI at the fixture.
const { forgetModels, listModels, listPermissions, status, toModel } = await import("../server/claude/install");
const { answer, hasAsk, release, runTurn, steer, canSteer } = await import("../server/claude/sessions");
const { doneEvent, startEvent } = await import("../server/claude/tools");
afterAll(() => { forgetModels(); for (const [k, v] of Object.entries(original)) if (v === undefined) delete process.env[k]; else process.env[k] = v; rmSync(directory, { recursive: true, force: true }); });

const request = (message: string, prior = 0, threadId = `claude-${crypto.randomUUID()}`): PiChatRequest => ({ runtime: "claude", threadId, cwd: work, model: "claude/opus", effort: "high", prior, message });
async function collect(req: PiChatRequest, onEvent?: (e: StreamEvent) => void, signal = new AbortController().signal): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const reader = runTurn(req, signal).getReader(), decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) { const e = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); events.push(e); onEvent?.(e); }
  }
  return events;
}
const text = (events: StreamEvent[]) => events.filter((e): e is Extract<StreamEvent, { t: "text" }> => e.t === "text").map((e) => e.v).join("");
const protocol = () => readFileSync(vars.FAKE_PROTOCOL, "utf8");

test("Claude Code lists its models with efforts, thinking off and fast mode from the SDK", async () => {
  expect(await status()).toMatchObject({ installed: true, connected: ["claude"], version: "2.1.311", account: { subscription: "Claude Pro" } });
  const { models, defaultModel } = await listModels(true);
  expect(defaultModel).toBe("claude/default");
  const opus = models.find((m) => m.id === "claude/opus")!;
  expect(opus.reasoning.efforts).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  expect(opus.speeds?.map((s) => s.id)).toEqual(["fast"]);
  expect(models.find((m) => m.id === "claude/haiku")!.speeds).toBeUndefined();
  expect(toModel({ value: "x", displayName: "X" }).reasoning).toEqual({ efforts: [], mode: "none", toggle: false });
});

test("permission modes come from Claude's own settings layers, including managed bans", async () => {
  mkdirSync(join(work, ".claude"), { recursive: true });
  writeFileSync(join(work, ".claude/settings.json"), JSON.stringify({ permissions: { defaultMode: "acceptEdits", disableBypassPermissionsMode: "disable" } }));
  const p = await listPermissions(work, true);
  expect(p.defaultMode).toBe("acceptEdits");
  expect(p.modes.map((m) => m.id)).toEqual(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);
  expect(p.modes.find((m) => m.id === "bypassPermissions")!.allowed).toBe(false);
  rmSync(join(work, ".claude"), { recursive: true });
  expect((await listPermissions(work, true)).defaultMode).toBe("default");
});

test("a turn applies model, effort, fast mode and permission mode, then resumes with only the new message", async () => {
  const req = { ...request("hello"), speed: "fast", permission: "plan" };
  const first = await collect(req);
  expect(first.find((e) => e.t === "error")).toBeUndefined();
  expect(text(first)).toBe("reply 1 to hello");
  expect(first.find((e) => e.t === "done")).toMatchObject({ finish: "stop", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, contextWindow: 200000 } });
  expect(protocol()).toContain("control set_model opus");
  expect(protocol()).toContain('control apply_flag_settings {"effortLevel":"high","fastMode":true}');
  expect(protocol()).toContain("control set_permission_mode plan");
  expect(protocol()).toContain("turn hello model=opus effort=high fast=true mode=plan");
  // Standard speed clears fast mode explicitly (null), and the default mode is restored.
  const second = await collect({ ...req, speed: undefined, permission: undefined, message: "again", prior: 1 });
  expect(text(second)).toBe("reply 2 to again");
  expect(protocol()).toContain('control apply_flag_settings {"effortLevel":"high","fastMode":null}');
  expect(protocol()).toContain("turn again model=opus effort=high fast=false mode=default");
  // A fresh process (after the worker released it) resumes the saved session.
  release(req.threadId);
  const third = await collect({ ...req, speed: undefined, permission: undefined, message: "third", prior: 2 });
  expect(text(third)).toBe("reply 3 to third");
  expect(protocol().match(/^start resume/m)).toBeTruthy();
  expect(readFileSync(vars.FAKE_EFFECTS, "utf8")).toBe("hello\nagain\nthird\n");
  release(req.threadId);
});

test("history guards and request validation", async () => {
  const req = request("one");
  await collect(req);
  expect((await collect({ ...req, prior: 5 })).find((e) => e.t === "error")).toMatchObject({ message: expect.stringContaining("history mismatch") });
  expect((await collect({ ...req, prior: 1, forkFrom: "x" })).find((e) => e.t === "error")).toMatchObject({ message: expect.stringContaining("forked") });
  expect((await collect({ ...req, prior: 1, cwd: directory })).find((e) => e.t === "error")).toMatchObject({ message: expect.stringContaining("workspace mismatch") });
  expect((await collect({ ...req, prior: 1, speed: "turbo" })).find((e) => e.t === "error")).toMatchObject({ message: expect.stringContaining("no speed") });
  expect((await collect({ ...req, prior: 1, permission: "yolo" })).find((e) => e.t === "error")).toMatchObject({ message: expect.stringContaining("no permission mode") });
  expect((await collect({ ...req, prior: 1, model: "claude/haiku", speed: "fast" })).find((e) => e.t === "error")).toMatchObject({ message: expect.stringContaining("fast mode isn't available") });
  // Retrying the first message starts a clean session rather than replaying onto the old one.
  release(req.threadId);
  const retry = await collect({ ...req, message: "one again", prior: 0 });
  expect(text(retry)).toBe("reply 1 to one again");
  release(req.threadId);
});

test("tool permission prompts reach the user; 'for this session' never writes settings files", async () => {
  writeFileSync(join(work, "a.txt"), "one\n");
  const req = request("edit it");
  const events = await collect(req, (e) => { if (e.t === "ask") setTimeout(() => answer(req.threadId, e.id, { value: "Allow for this session" }), 10); });
  const ask = events.find((e): e is Extract<StreamEvent, { t: "ask" }> => e.t === "ask")!;
  expect(ask.title).toBe("Claude wants to edit a.txt");
  expect(ask.options).toEqual(["Allow once", "Allow for this session", "Deny"]);
  expect(protocol()).toContain("decision allow session");
  const tools = events.filter((e): e is Extract<StreamEvent, { t: "tool" }> => e.t === "tool");
  expect(tools[0]).toMatchObject({ id: "tool-edit", name: "edit", status: "running", args: { path: join(work, "a.txt") } });
  expect(tools.at(-1)).toMatchObject({ id: "tool-edit", name: "edit", status: "done" });
  expect(tools.at(-1)!.patch).toContain("@@ -1,1 +1,1 @@\n-one\n+two");
  expect(text(events)).toBe("edited");

  const denied = request("edit again");
  const out = await collect(denied, (e) => { if (e.t === "ask") setTimeout(() => answer(denied.threadId, e.id, { value: "Deny" }), 10); });
  expect(out.filter((e) => e.t === "tool").at(-1)).toMatchObject({ status: "error" });
  expect(text(out)).toBe("not edited");
  release(req.threadId); release(denied.threadId);
});

test("native questions use cards, sequential answers and custom input even in bypass mode", async () => {
  for (const permission of ["default", "bypassPermissions"]) {
    const req = { ...request("question choices"), permission };
    let n = 0;
    const events = await collect(req, e => {
      if (e.t !== "ask") return;
      expect(hasAsk(req.threadId, e.id)).toBe(true);
      expect(e.other).toBe(true);
      expect(e.options).toEqual(n === 0 ? ["Small", "Full"] : ["Unit", "Integration"]);
      expect(answer(req.threadId, e.id, { value: n++ === 0 ? "My own approach" : "Unit, Integration" })).toBe(true);
      expect(answer(req.threadId, e.id, { value: "duplicate" })).toBe(false);
    });
    expect(n).toBe(2);
    expect(events.filter(e => e.t === "asked")).toHaveLength(2);
    expect(events.some(e => e.t === "tool")).toBe(false);
    expect(text(events)).toBe('answered {"Which approach?":"My own approach","Which checks?":"Unit, Integration"}');
    expect(events.some(e => e.t === "error")).toBe(false);
    release(req.threadId);
  }
  expect(protocol()).toContain("question-instructions When you need a decision");
  expect(protocol()).toContain("use the native AskUserQuestion tool instead of asking in prose");
  expect(protocol()).toContain("mode=bypassPermissions");
});

test("dismissed or malformed native questions never supply fabricated answers", async () => {
  const req = request("question cancel");
  const events = await collect(req, e => { if (e.t === "ask") answer(req.threadId, e.id, { cancelled: true }); });
  expect(events.filter(e => e.t === "ask")).toHaveLength(1);
  expect(text(events)).toBe("question dismissed");
  expect(events.find(e => e.t === "asked")).toBeDefined();
  expect((events.find(e => e.t === "asked") as any).answer).toBeUndefined();
  release(req.threadId);
  const malformed = request("question malformed");
  const invalid = await collect(malformed);
  expect(invalid.some(e => e.t === "ask")).toBe(false);
  expect(text(invalid)).toBe("question dismissed");
  expect(protocol()).toContain("Invalid AskUserQuestion input; no answer was collected.");
  release(malformed.threadId);
});

test("native dontAsk policy is preserved rather than overriding it for questions", async () => {
  const req = { ...request("question denied by native policy"), permission: "dontAsk" };
  const events = await collect(req);
  expect(events.some(e => e.t === "ask")).toBe(false);
  expect(text(events)).toBe("question dismissed");
  release(req.threadId);
});

test("aborting a native question clears the pending card without answering it", async () => {
  const req = request("question abort"), stop = new AbortController();
  let id = "";
  const events = await collect(req, e => { if (e.t === "ask") { id = e.id; stop.abort(); } }, stop.signal);
  expect(id).not.toBe("");
  expect(hasAsk(req.threadId, id)).toBe(false);
  expect(answer(req.threadId, id, { value: "late" })).toBe(false);
  expect(events.some(e => e.t === "asked")).toBe(true);
  release(req.threadId);
});

test("tool rows: native names and inputs map onto OpenBuild's tool UI", () => {
  expect(startEvent("1", "Bash", { command: "ls" })).toMatchObject({ name: "bash", args: { command: "ls" } });
  expect(startEvent("2", "Read", { file_path: "/a" })).toMatchObject({ name: "read", args: { path: "/a" } });
  expect(startEvent("3", "Grep", { pattern: "x" })).toMatchObject({ name: "grep", args: { pattern: "x" } });
  expect(startEvent("4", "Glob", { pattern: "*.ts" })).toMatchObject({ name: "find" });
  expect(startEvent("5", "WebFetch", { url: "https://x" })).toMatchObject({ name: "fetch", args: { url: "https://x" } });
  expect(startEvent("6", "Task", { description: "look", prompt: "around" })).toMatchObject({ name: "agent", args: { task: "look: around" } });
  expect(startEvent("7", "mcp__github__get_issue", {}).name).toBe("github_get_issue");
  const todo = startEvent("8", "TodoWrite", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] });
  expect(todo).toMatchObject({ name: "todo", output: "[x] a\n[ ] b" });
  const bash = doneEvent(startEvent("9", "Bash", { command: "x" }), "Bash", { content: "ignored", is_error: true }, { stdout: "out", stderr: "err" }, 12);
  expect(bash).toMatchObject({ status: "error", output: "out\nerr", ms: 12 });
  const write = doneEvent(startEvent("10", "Write", { file_path: "/n", content: "hi" }), "Write", { content: "ok" }, { filePath: "/n", structuredPatch: [] });
  expect(write.patch).toBeUndefined(); // The UI shows a new file's content as added lines.
});

test("stop interrupts the running turn and the thread continues afterwards", async () => {
  const req = request("slow and stop");
  const controller = new AbortController();
  const events = await collect(req, (e) => { if (e.t === "text") controller.abort(); }, controller.signal);
  expect(events.find((e) => e.t === "done")).toMatchObject({ finish: "aborted" });
  expect(protocol()).toContain("control interrupt");
  const next = await collect({ ...req, message: "after stop", prior: 1 });
  expect(text(next)).toBe("reply 2 to after stop");
  release(req.threadId);
});

test("editing an earlier message forks Claude's session at that point instead of replaying", async () => {
  const req = request("first");
  await collect(req);
  await collect({ ...req, message: "second", prior: 1 });
  await collect({ ...req, message: "third", prior: 2 });
  const before = readFileSync(vars.FAKE_PROTOCOL, "utf8").length;
  const edited = await collect({ ...req, message: "second, edited", prior: 1 });
  expect(edited.find((e) => e.t === "error")).toBeUndefined();
  const log = readFileSync(vars.FAKE_PROTOCOL, "utf8").slice(before);
  expect(log).toMatch(/^start fork .*--resume-session-at/m);
  // The forked transcript has the first exchange only (plus the edit), not "second" or "third".
  expect(text(edited)).toBe("reply 2 to second, edited");
  const after = await collect({ ...req, message: "fourth", prior: 2 });
  expect(text(after)).toBe("reply 3 to fourth");
  release(req.threadId);
});

 test("native steering carries images, records messages once, resumes and rewinds after steers", async () => {
  const req = request("slow steering");
  const releaseFile = join(directory, "steer-release");
  process.env.FAKE_RELEASE = releaseFile;
  process.env.FAKE_TOOL_EFFECTS = join(directory, "steer-tool");
  const events: StreamEvent[] = [];
  const running = collect(req, e => events.push(e));
  for (let i = 0; i < 300 && !events.some(e => e.t === "text"); i++) await Bun.sleep(10);
  expect(canSteer(req.threadId)).toBe(true);
  expect(await steer(req.threadId, "s1", "change direction", [{data:"aGVsbG8=",mimeType:"image/png"}])).toEqual({handled:false});
  await steer(req.threadId, "s2", "also this");
  for (let i = 0; i < 300 && events.filter(e => e.t === "steer").length < 2; i++) await Bun.sleep(10);
  expect(events.filter(e => e.t === "steer")).toEqual([{t:"steer",id:"s1",text:"change direction"},{t:"steer",id:"s2",text:"also this"}]);
  writeFileSync(releaseFile, "go");
  expect((await running).some(e => e.t === "error")).toBe(false);
  expect(canSteer(req.threadId)).toBe(false);
  await expect(steer(req.threadId,"late","late")).rejects.toThrow("isn't working");
  release(req.threadId);
  const next = await collect({...req, message:"after steers", prior:3});
  expect(text(next)).toBe("reply 4 to after steers");
  expect(next.some(e => e.t === "error")).toBe(false);
  release(req.threadId);
  delete process.env.FAKE_RELEASE; delete process.env.FAKE_TOOL_EFFECTS;
 });
