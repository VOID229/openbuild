import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiChatRequest, StreamEvent } from "../shared/types";
import { CursorProtocol, toolEvent } from "../server/cursor/protocol";
import { forgetModels, listModels, listPermissions, modelSlug, parseHelp, parseModels, permissionModes, status } from "../server/cursor/install";
import { answer, hasAsk, runTurn, sessionPath, steer, canSteer } from "../server/cursor/sessions";
import { FAKE_CURSOR } from "./cursorFixture";
const directory = mkdtempSync(join(tmpdir(), "ob-cursor-unit-"));
const fake = join(directory, "cursor");
writeFileSync(fake, `#!${process.execPath}\n` + FAKE_CURSOR); chmodSync(fake, 0o700);
const vars = { CURSOR_BIN: fake, CURSOR_CONFIG_DIR: join(directory, "config"), FAKE_PROTOCOL: join(directory, "protocol"), FAKE_EFFECTS: join(directory, "effects"), FAKE_TOOL_EFFECTS: join(directory, "tool-effects"), FAKE_RELEASE: join(directory, "release") };
const original = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
Object.assign(process.env, vars);
afterAll(() => { forgetModels(); for (const [k, v] of Object.entries(original)) if (v === undefined) delete process.env[k]; else process.env[k] = v; rmSync(directory, { recursive: true, force: true }); });
const request = (message: string, prior = 0): PiChatRequest => ({ runtime: "cursor", threadId: `cursor-${crypto.randomUUID()}`, cwd: directory, model: "cursor/fake", effort: "high", prior, message });
const collect = async (req: PiChatRequest, signal = new AbortController().signal) => (await new Response(runTurn(req, signal)).text()).trim().split("\n").map(s => JSON.parse(s));
const calls = () => readFileSync(vars.FAKE_PROTOCOL, "utf8").trim().split("\n").map(s => JSON.parse(s));
test("Cursor uses only observed effort variants and validates model, effort and speed", async () => {
  expect(await status()).toMatchObject({ installed: true, connected: ["cursor"] });
  const models = await listModels(true);
  expect(models.models.find(m => m.id === "cursor/fake")!.reasoning.efforts).toEqual(["low", "high"]);
  expect(models.models.find(m => m.id === "cursor/fake")!.name).toBe("Fake");
  expect(models.models.find(m => m.id === "cursor/auto")!.reasoning.efforts).toEqual([]);
  expect(models.models.find(m => m.id === "cursor/fake-fast")!.reasoning.efforts).toEqual(["high"]);
  expect(await modelSlug("cursor/fake", "low")).toBe("fake-low");
  expect(await modelSlug("cursor/auto", "off")).toBe("auto");
  await expect(modelSlug("cursor/fake", "max")).rejects.toThrow("does not support");
  await expect(modelSlug("cursor/missing", "high")).rejects.toThrow("unavailable");
  expect((await collect({ ...request("no speed"), speed: "fast" })).find(e => e.t === "error").message).toContain("speed overrides");
  expect(() => parseModels("No models available for this account")).toThrow("no recognizable models");
});
test("Cursor protocol does not duplicate result text and preserves structured tool results", () => {
  const events: StreamEvent[] = [], p = new CursorProtocol(e => events.push(e));
  p.accept({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } });
  p.accept({ type: "thinking", subtype: "delta", text: "reason" });
  p.accept({ type: "tool_call", subtype: "completed", call_id: "read", tool_call: { readToolCall: { args: { path: "a" }, result: { success: { content: "file data", totalLines: 4 } } } } });
  p.accept({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
  p.accept({ type: "result", subtype: "success", result: "hellodone", usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 2 } });
  expect(events.filter(e => e.t === "text").map(e => e.v).join("")).toBe("hello\n\ndone");
  expect(events.find(e => e.t === "tool")).toMatchObject({ name: "read", args: { path: "a", cursor: { toolCall: { readToolCall: { result: { success: { totalLines: 4 } } } } } }, output: "file data" });
  expect(toolEvent({ type: "tool_call", subtype: "completed", call_id: "shell", tool_call: { shellToolCall: { args: { command: "false" }, result: { failure: { stdout: "out", stderr: "err", exitCode: 1 } } } } })).toMatchObject({ name: "bash", status: "error", output: "outerr" });
  expect(toolEvent({ subtype: "completed", call_id: "mcp", tool_call: { mcpToolCall: { args: { toolName: "test" }, result: { success: { structuredContent: { answer: 42 } } } } } })!.output).toContain('"answer": 42');
  expect(() => p.accept({ type: "system", session_id: "a" })).not.toThrow();
  expect(() => p.accept({ type: "system", session_id: "b" })).toThrow("changed session");
});
test("Cursor resumes only new input, guards prior/fork/cwd/native edits and reports malformed streams", async () => {
  const req = request("first");
  const first = await collect(req);
  expect(first.find(e => e.t === "error")).toBeUndefined();
  expect(first.filter(e => e.t === "text").map(e => e.v).join("")).toBe("Started-\n\nfinished offline");
  expect(first.find(e => e.t === "usage").usage).toMatchObject({ input: 3, output: 4, cacheRead: 2, cacheWrite: 1 });
  expect((await collect({ ...req, message: "next", prior: 1 })).some(e => e.t === "text" && e.v === "resumed saved thread")).toBe(true);
  const previous = calls().filter(c => c.prompt === "first" || c.prompt === "next");
  expect(previous).toHaveLength(2); expect(previous[0].id).toBe(previous[1].id); expect(previous[1].previous).toBe("first\n");
  expect((await collect(req)).find(e => e.t === "error").message).toContain("history mismatch");
  expect((await collect({ ...req, prior: 2, forkFrom: "old" })).find(e => e.t === "error").message).toContain("forking");
  expect((await collect({ ...req, prior: 2, cwd: "/tmp" })).find(e => e.t === "error").message).toContain("workspace mismatch");
  writeFileSync(sessionPath(directory, previous[0].id), "external changes");
  expect((await collect({ ...req, prior: 2 })).find(e => e.t === "error").message).toContain("changed externally");
  const bad = request("bad stream");
  expect((await collect(bad)).find(e => e.t === "error").message).toContain("Invalid Cursor stream");
  expect((await collect({ ...bad, prior: 1 })).find(e => e.t === "error").message).toContain("uncertain");
});
const HELP = `Usage: agent [options] [command] [prompt...]

Options:
  -p, --print                  Print responses to console (for scripts or
                               non-interactive use). (default: false)
  --mode <mode>                Start in the given execution mode. plan:
                               read-only/planning (analyze, propose plans, no
                               edits). ask: Q&A style for explanations and
                               questions (read-only). (choices: "plan", "ask")
  -f, --force                  Force allow commands unless explicitly denied
                               (default: false)
  --auto-review                Use Auto-review (Smart Auto): a server classifier
                               auto-runs safe tool calls and prompts for the
                               rest (default: false)
  -h, --help                   Display help for command

Commands:
  login                        Authenticate with Cursor.
`;
test("Cursor permission modes come from the installed CLI's own help", async () => {
  const modes = permissionModes(parseHelp(HELP));
  expect(modes.map(m => m.id)).toEqual(["default", "mode:plan", "mode:ask", "auto-review", "force"]);
  expect(modes.find(m => m.id === "mode:plan")!.description).toBe("read-only/planning (analyze, propose plans, no edits)");
  expect(modes.find(m => m.id === "force")!.description).toBe("Force allow commands unless explicitly denied");
  // An older CLI without these flags offers only its configured allowlist.
  expect(permissionModes(parseHelp("Options:\n  -p, --print  Print\n")).map(m => m.id)).toEqual(["default"]);
  expect((await listPermissions(true)).modes.map(m => m.id)).toEqual(["default", "mode:plan", "force"]);
});
test("Cursor sends a picked mode's own flags and rejects modes the CLI doesn't offer", async () => {
  const req = request("mode default");
  await collect(req);
  await collect({ ...req, prior: 1, message: "mode plan", permission: "mode:plan" });
  const bad = await collect({ ...req, prior: 2, message: "mode bogus", permission: "auto-review" });
  expect(bad.find(e => e.t === "error").message).toContain("doesn't offer");
  expect(calls().find(c => c.prompt === "mode default").mode).toBeUndefined();
  expect(calls().find(c => c.prompt === "mode plan").mode).toBe("plan");
  expect(calls().some(c => c.prompt === "mode bogus")).toBe(false);
});
test("Cursor allows all tools only for an explicit per-turn opt-in", async () => {
  const req = request("permissions default");
  expect((await collect(req)).some(e => e.t === "done")).toBe(true);
  expect(calls().find(c => c.prompt === "permissions default").force).toBe(false);
  expect((await collect({ ...req, prior: 1, message: "permissions allowed", cursorAllowAllTools: true })).some(e => e.t === "done")).toBe(true);
  expect(calls().find(c => c.prompt === "permissions allowed").force).toBe(true);
  expect((await collect({ ...req, prior: 2, message: "permissions reset", cursorAllowAllTools: false })).some(e => e.t === "done")).toBe(true);
  expect(calls().find(c => c.prompt === "permissions reset").force).toBe(false);
});
test("Cursor fake CLI loads a per-turn plugin and receives an answer via real MCP", async () => {
  const req = request("ask bridge"), events: StreamEvent[] = [];
  const stream = runTurn(req, new AbortController().signal);
  const done = (async () => {
    const decoder = new TextDecoder(); let buffer = "";
    for await (const bytes of stream) {
      buffer += decoder.decode(bytes, { stream: true }); let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) { events.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
    }
  })();
  for (let i = 0; i < 200 && !events.some(e => e.t === "ask"); i++) await Bun.sleep(5);
  const ask = events.find(e => e.t === "ask")!;
  expect(ask).toMatchObject({ title: "Which approach?", options: ["A", "B"], other: true });
  expect(hasAsk(req.threadId, ask.id)).toBe(true);
  expect(answer("wrong-thread", ask.id, { value: "no" })).toBe(false);
  expect(answer(req.threadId, ask.id, { value: "Custom" })).toBe(true);
  await done;
  expect(events.some(e => e.t === "text" && e.v.includes('"answer":"Custom"'))).toBe(true);
  expect(events.some(e => e.t === "error")).toBe(false);
  const call = calls().find(c => c.prompt === "ask bridge");
  expect(call.rawPrompt.endsWith(req.message)).toBe(true);
  expect(call.force).toBe(false);
  expect(existsSync(call.pluginDir)).toBe(false);
  expect(hasAsk(req.threadId, ask.id)).toBe(false);
});
test("Cursor cancellation dismisses an unanswered MCP question and removes its plugin", async () => {
  const req = request("ask bridge"), abort = new AbortController();
  let askId = "";
  const done = (async () => {
    const decoder = new TextDecoder(); let buffer = "";
    const events: StreamEvent[] = [];
    for await (const bytes of runTurn(req, abort.signal)) {
      buffer += decoder.decode(bytes, { stream: true }); let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const event = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); events.push(event);
        if (event.t === "ask") { askId = event.id; abort.abort(); }
      }
    }
    return events;
  })();
  const events = await done;
  expect(askId).not.toBe("");
  expect(events.some(e => e.t === "asked" && e.id === askId)).toBe(true);
  expect(events.some(e => e.t === "done" && e.finish === "aborted")).toBe(true);
  expect(hasAsk(req.threadId, askId)).toBe(false);
  expect(answer(req.threadId, askId, { value: "late" })).toBe(false);
  const call = calls().filter(c => c.prompt === "ask bridge").at(-1);
  expect(existsSync(call.pluginDir)).toBe(false);
});
test("Cursor graceful cancellation checkpoints without replay", async () => {
  const req = request("wait"), abort = new AbortController();
  const promise = collect(req, abort.signal);
  for (let i = 0; i < 200; i++) { if (calls().some(c => c.prompt === "wait")) break; await Bun.sleep(10); }
  await Bun.sleep(25); abort.abort();
  expect((await promise).find(e => e.t === "done").finish).toBe("aborted");
  expect((await collect({ ...req, prior: 1, message: "after cancel" })).some(e => e.t === "done")).toBe(true);
});

test("Cursor injects queued steering through a native tool hook and resumes with correct history", async () => {
  rmSync(vars.FAKE_RELEASE, {force:true});
  const req = request("steering work");
  const running = collect(req);
  for (let i = 0; i < 300 && !canSteer(req.threadId); i++) await Bun.sleep(10);
  expect(canSteer(req.threadId)).toBe(true);
  await expect(steer(req.threadId,"image","image",[{data:"aA==",mimeType:"image/png"}])).rejects.toThrow("image attachments");
  await steer(req.threadId,"s1","new direction");
  await steer(req.threadId,"s2","also this");
  writeFileSync(vars.FAKE_RELEASE, "go");
  const events = await running;
  expect(events.filter(e => e.t === "steer")).toEqual([{t:"steer",id:"s1",text:"new direction"},{t:"steer",id:"s2",text:"also this"}]);
  expect(events.filter(e => e.t === "text").map(e => e.v).join("")).toContain("new direction");
  expect(canSteer(req.threadId)).toBe(false);
  expect((await collect({...req, prior:3, message:"after steering"})).some(e => e.t === "error")).toBe(false);
});

test("Cursor hook delivery waits for the root and never continues an aborted turn", async () => {
  const {createQuestions} = await import("../server/cursor/questions");
  const events: StreamEvent[] = [];
  const bridge = createQuestions(e => events.push(e));
  try {
    const hooks = JSON.parse(readFileSync(join(bridge.pluginDir,"hooks","hooks.json"),"utf8"));
    async function hook(name: string, input: unknown) {
      const child = Bun.spawn(["sh","-c",hooks.hooks[name][0].command],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
      child.stdin.write(JSON.stringify(input)); child.stdin.end();
      const output = JSON.parse(await new Response(child.stdout).text());
      expect(await child.exited).toBe(0);
      return output;
    }
    bridge.steer("pending","follow up");
    expect(await hook("postToolUse",{subagent_id:"child"})).toEqual({});
    expect(await hook("stop",{status:"aborted"})).toEqual({});
    expect(events).toEqual([]);
    expect(await hook("stop",{status:"completed"})).toEqual({followup_message:"follow up"});
    expect(await hook("postToolUse",{})).toEqual({});
    expect(events).toEqual([{t:"steer",id:"pending",text:"follow up"}]);
    bridge.steer("failed-tool","try another approach");
    expect(await hook("postToolUseFailure",{})).toEqual({additional_context:"try another approach"});
    bridge.steer("cancelled","do not deliver"); bridge.stopSteering();
    expect(await hook("stop",{status:"completed"})).toEqual({});
  } finally {bridge.close();}
});
