import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Effort } from "../shared/types";
import { getValue } from "../server/storage";
import { listModels, forgetModels, parseModels, status } from "../server/grok/install";
import { answer, canSteer, release, runTurn, steer } from "../server/grok/sessions";
import { describeCall, mapTool } from "../server/grok/tools";
import { FAKE_GROK } from "./grokFixture";

const dir = mkdtempSync(join(tmpdir(), "ob-grok-"));
const effects = join(dir, "effects");
const newLog = join(dir, "new");
const original = { ...process.env };
const threads: string[] = [];
beforeAll(() => {
  const bin = join(dir, "grok");
  writeFileSync(bin, `#!${process.execPath}\n` + FAKE_GROK);
  chmodSync(bin, 0o700);
  Object.assign(process.env, { GROK_BIN: bin, FAKE_EFFECTS: effects, FAKE_NEW_LOG: newLog });
});
afterAll(() => {
  for (const id of threads) release(id);
  process.env = original;
  rmSync(dir, { recursive: true, force: true });
});
const request = (message: string, threadId: string = crypto.randomUUID(), prior = 0, effort: Effort = "high") => {
  threads.push(threadId);
  return { threadId, cwd: dir, model: "grok/fake-1", effort, prior, message };
};
type Event = Record<string, any>;
function start(req: ReturnType<typeof request>, signal = new AbortController().signal) {
  const events: Event[] = [];
  const done = (async () => {
    let buffer = "";
    for await (const chunk of runTurn(req, signal)) {
      buffer += new TextDecoder().decode(chunk);
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) { if (buffer.slice(0, i)) events.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); }
    }
    return events;
  })();
  return { events, done };
}
async function until(check: () => boolean) { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); expect(check()).toBe(true); }
const lastTool = (events: Event[], id: string) => events.filter((e) => e.t === "tool" && e.id === id).at(-1);
const effectLines = () => (existsSync(effects) ? readFileSync(effects, "utf8") : "");
const text = (events: Event[]) => events.filter((e) => e.t === "text").map((e) => e.v).join("");

test("lists the account's models and sign-in without creating a session", async () => {
  expect(parseModels("You are logged in with grok.com.\n\nAvailable models:\n  * a (default)\n  - b\n")).toEqual({ ids: ["a", "b"], defaultId: "a", account: "grok.com" });
  rmSync(newLog, { force: true });
  forgetModels();
  const { models, defaultModel } = await listModels(true);
  expect(defaultModel).toBe("grok/fake-1");
  expect(models.map((m) => [m.id, m.name, m.reasoning.efforts, m.contextLimit, m.billing])).toEqual([
    ["grok/fake-1", "Fake One", ["low", "high"], 500000, "plan"],
    ["grok/fake-fast", "Fake Fast", [], 256000, "plan"],
  ]);
  expect(existsSync(newLog)).toBe(false);
  expect(await status()).toMatchObject({ installed: true, version: "grok 1.0.70 (fake) [stable]", connected: ["grok.com"] });
});

test("draws each tool the way the thread UI knows, from Grok's own events", async () => {
  const { done } = start(request("tools"));
  const events = await done;
  expect(events.at(-1)).toEqual({ t: "end" });
  expect(events.find((e) => e.t === "reasoning")?.v).toBe("hmm");
  expect(text(events)).toBe("Starting.\n\nFinished.");
  expect(lastTool(events, "sh")).toMatchObject({ name: "bash", status: "done", output: "1\n2", args: { command: "seq 2" } });
  // Grok's description of a call isn't its output.
  expect(events.filter((e) => e.id === "sh").some((e) => e.output === "Count")).toBe(false);
  // Grok calls a failed command "completed".
  expect(lastTool(events, "bad")).toMatchObject({ status: "error", output: "nope\n[exit code 1]" });
  expect(lastTool(events, "new")).toMatchObject({ name: "write", status: "done", output: "The file has been created.", args: { path: join(dir, "a.txt"), content: "hi" } });
  expect(lastTool(events, "new")!.patch).toContain("+hi");
  expect(lastTool(events, "ed")).toMatchObject({ name: "edit", status: "done" });
  expect(lastTool(events, "ed")!.patch).toContain("-hi\n+hello");
  expect(lastTool(events, "rd")).toMatchObject({ name: "read", output: "hello", args: { path: "a.txt" } });
  expect(lastTool(events, "miss")).toMatchObject({ name: "read", status: "error", output: "Error: gone does not exist." });
  expect(lastTool(events, "ls")).toMatchObject({ name: "ls", output: "- ./\n  - a.txt", args: { path: "." } });
  expect(lastTool(events, "gr")).toMatchObject({ name: "grep", output: "a.txt:1:hello", args: { pattern: "hello" } });
  // The plan update draws todos, not the tool that wrote them.
  expect(events.some((e) => e.id === "td")).toBe(false);
  expect(events.find((e) => e.name === "todo")).toMatchObject({ status: "done", output: "[x] First\n[ ] Second" });
  const finished = events.find((e) => e.t === "done");
  expect(finished).toMatchObject({ finish: "stop", usage: { input: 40, output: 10, cacheRead: 60, cacheWrite: 0, contextTokens: 1234, contextWindow: 500000, cost: 0.001 } });
  expect(events.some((e) => e.t === "usage" && e.usage.contextTokens === 1234)).toBe(true);
});

test("a thread keeps one Grok session across processes, and applies model and effort", async () => {
  const threadId = crypto.randomUUID();
  rmSync(newLog, { force: true });
  expect(text(await start(request("one", threadId)).done)).toBe(`reply to one model=fake-1 effort=high`);
  expect(JSON.parse(getValue(`grok-session:${threadId}`)!)).toMatchObject({ id: "fake-session", turns: 1 });
  release(threadId);
  const second = { ...request("two", threadId, 1, "low"), model: "grok/fake-fast" };
  expect(text(await start(second).done)).toBe("reply to two model=fake-fast effort=low");
  expect(JSON.parse(getValue(`grok-session:${threadId}`)!).turns).toBe(2);
  expect(readFileSync(newLog, "utf8")).toBe("new\n");
  // A session that can't be picked back up is reported, not silently replaced by an empty one.
  release(threadId);
  process.env.FAKE_NO_RESUME = "1";
  try {
    const failed = await start(request("three", threadId, 2)).done;
    expect(failed.find((e) => e.t === "error")?.message).toContain("couldn't resume");
    expect(readFileSync(newLog, "utf8")).toBe("new\n");
    expect(JSON.parse(getValue(`grok-session:${threadId}`)!).turns).toBe(2);
  } finally { delete process.env.FAKE_NO_RESUME; release(threadId); }
});

test("steers with Grok's interject method and counts the message once", async () => {
  const req = request("hold");
  const { events, done } = start(req);
  await until(() => canSteer(req.threadId) && text(events).includes("Started-"));
  await steer(req.threadId, "steer-1", "also this", [{ data: "aA==", mimeType: "image/png" }]);
  // Repeating a steer doesn't send it twice; reusing its id for something else is refused.
  await steer(req.threadId, "steer-1", "also this");
  await expect(steer(req.threadId, "steer-1", "different")).rejects.toThrow("reused");
  await expect(steer(req.threadId, "empty", " ")).rejects.toThrow("nonempty");
  await done;
  expect(events.filter((e) => e.t === "steer")).toEqual([{ t: "steer", id: "steer-1", text: "also this" }]);
  expect(text(events)).toBe("Started-\n\nsteered");
  expect(effectLines().split(`interject={"text":"also this","images":1}`).length).toBe(2);
  expect(JSON.parse(getValue(`grok-session:${req.threadId}`)!).turns).toBe(2);
  expect(canSteer(req.threadId)).toBe(false);
  await expect(steer(req.threadId, "after", "too late")).rejects.toThrow("isn't working");
  await expect(steer(crypto.randomUUID(), "x", "y")).rejects.toThrow("isn't working");
});

test("stays attached when a late steer becomes a turn of its own", async () => {
  const req = request("lateSteer");
  const { events, done } = start(req);
  await until(() => canSteer(req.threadId) && text(events).includes("main"));
  await steer(req.threadId, "late-1", "one more");
  await done;
  expect(text(events)).toContain("late reply");
  expect(events.find((e) => e.t === "steer")?.id).toBe("late-1");
  expect(events.findIndex((e) => e.v === "late reply")).toBeLessThan(events.findIndex((e) => e.t === "done"));
  expect(events.find((e) => e.t === "done")).toMatchObject({ finish: "stop", usage: { output: 15 } });
});

test("permission requests become question cards, and a refusal explains the stopped reply", async () => {
  const allow = request("permission");
  const a = start(allow);
  await until(() => a.events.some((e) => e.t === "ask"));
  const card = a.events.find((e) => e.t === "ask")!;
  expect(card).toMatchObject({ method: "select", title: "Allow Grok to edit a.txt?", options: ["Yes", "No"] });
  expect(answer(allow.threadId, card.id, { value: "Yes" })).toBe(true);
  expect(answer(allow.threadId, card.id, { value: "Yes" })).toBe(false);
  await a.done;
  expect(a.events.find((e) => e.t === "asked")).toEqual({ t: "asked", id: card.id, answer: "Yes" });
  expect(effectLines()).toContain(`permission={"outcome":{"outcome":"selected","optionId":"allow-once"}}`);
  expect(text(a.events)).toBe("edited");

  const deny = request("permission");
  const d = start(deny);
  await until(() => d.events.some((e) => e.t === "ask"));
  answer(deny.threadId, d.events.find((e) => e.t === "ask")!.id, { value: "No" });
  await d.done;
  expect(d.events.find((e) => e.t === "notice")?.message).toContain("declined");
  expect(d.events.find((e) => e.t === "done")?.finish).toBe("aborted");
});

test("ask_user_question asks in turn and answers keyed by the question", async () => {
  const req = request("question");
  const { events, done } = start(req);
  await until(() => events.filter((e) => e.t === "ask").length === 1);
  const first = events.find((e) => e.t === "ask")!;
  expect(first).toMatchObject({ method: "select", title: "Which colour?", options: ["Red", "Blue"], other: true });
  answer(req.threadId, first.id, { value: "Blue" });
  await until(() => events.filter((e) => e.t === "ask").length === 2);
  const second = events.filter((e) => e.t === "ask")[1]!;
  expect(second).toMatchObject({ method: "input", title: "Why?" });
  answer(req.threadId, second.id, { value: "Nice" });
  await done;
  expect(effectLines()).toContain(`answers={"outcome":"accepted","answers":{"Which colour?":"Blue","Why?":"Nice"}}`);
  // The card already shows the question, so there's no tool row for it.
  expect(events.some((e) => e.id === "q")).toBe(false);

  const dismissed = request("question");
  const d = start(dismissed);
  await until(() => d.events.some((e) => e.t === "ask"));
  answer(dismissed.threadId, d.events.find((e) => e.t === "ask")!.id, { cancelled: true });
  await d.done;
  expect(effectLines()).toContain(`answers={"outcome":"cancelled"}`);
});

test("stopping cancels the native turn and leaves the session usable", async () => {
  const req = request("hold");
  const stop = new AbortController();
  const { events, done } = start(req, stop.signal);
  await until(() => canSteer(req.threadId) && text(events).includes("Started-"));
  stop.abort();
  await done;
  expect(events.find((e) => e.t === "done")?.finish).toBe("aborted");
  expect(events.some((e) => e.t === "notice")).toBe(false);
  const next = await start(request("after stop", req.threadId, 1)).done;
  expect(text(next)).toContain("after stop");
});

test("requests this client doesn't know are refused, never authorized", async () => {
  await start(request("unknownRequest")).done;
  expect(effectLines()).toContain("refused=-32601");
});

test("permission wording names what the tool would do", () => {
  expect(describeCall({ rawInput: { variant: "Bash", command: "ls -la\nrm x" }, _meta: { "x.ai/tool": { name: "run_terminal_command" } } })).toBe("run `ls -la`");
  expect(mapTool("some_mcp_tool", "other", { variant: "X", a: 1 })).toEqual({ name: "some_mcp_tool", args: { a: 1 } });
  expect(mapTool(undefined, "execute", { command: "x" })).toEqual({ name: "bash", args: { command: "x" } });
});
