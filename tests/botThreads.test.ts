import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Run } from "../server/runs";

const dir = mkdtempSync(join(tmpdir(), "openbuild-bot-threads-"));
process.env.OPENCHAT_DATA_DIR = dir;

const repo = realpathSync(mkdtempSync(join(tmpdir(), "openbuild-bot-repo-")));
execSync("git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init", { cwd: repo });

const admitted: any[] = [];
const answers: any[] = [];
const steers: any[] = [];
const wakes: any[] = [];
const runs = new Map<string, Run>();
let snapshots: any[] = [];
let admit = async (req: any) => {
  admitted.push(req);
  const run = new Run();
  runs.set(req.stream.id, run);
  snapshots.push({ id: req.stream.id, threadId: req.threadId, kind: "run", status: "pending", events: [], startedAt: Date.now() });
  return run;
};
const models = [{ id: "acme/one", name: "One", reasoning: { efforts: ["low", "high"] }, speeds: [{ id: "fast" }] }];
const modes = { modes: [{ id: "safe", name: "Safe" }, { id: "yolo", name: "Yolo" }, { id: "banned", name: "Banned", allowed: false }], checkedAt: 0 };
let view: any;
const merged: any[] = [];

mock.module("../server/pi/turn", () => ({ admitTurn: (req: any) => admit(req), isPiChat: () => true, validImages: () => true }));
mock.module("../server/pi/remote", () => ({
  findRun: async (id: string) => runs.get(id),
  snapshots: async (threadId?: string) => snapshots.filter((s) => !threadId || s.threadId === threadId),
  answer: async (...args: any[]) => (answers.push(args), true),
  steer: async (...args: any[]) => (steers.push(args), { handled: true }),
  stopRun: async () => true,
}));
mock.module("../server/pi/routes", () => ({ modelListing: async () => ({ models, defaultModel: "acme/one" }) }));
mock.module("../server/pi/sessions", () => ({ listModels: async () => ({}), isThreadId: () => true }));
mock.module("../server/runtimes", () => ({ runtimes: () => ({ pi: { installed: true }, claude: { installed: true }, grok: { installed: true } }) }));
mock.module("../server/claude/install", () => ({ listModels: async () => ({ models: [{ id: "claude/one", name: "Claude One" }], defaultModel: "claude/one" }), listPermissions: async () => modes }));
mock.module("../server/pullRequestView", () => ({ view: async () => view, merge: async (...args: any[]) => void merged.push(args) }));
mock.module("../server/bots/runner", () => ({ wake: (id: string, item: any) => wakes.push({ id, ...item }) }));

const svc = await import("../server/bots/service");
const projects = await import("../server/projects");
const storage = await import("../server/storage");
const threads = await import("../server/bots/threads");
const { handle, answerRefusal, assertWithinDefaults, replyFor, resolvePermission, waitingAsks, guide } = threads;

const project = await projects.addProject(repo);
const { bot } = svc.createBot({ name: "Juniper" });
const grant = (patch: object = {}) => svc.updateBot(bot.id, { threads: { enabled: true, projects: [project.id], ...patch } });
const call = (action: string, p: object = {}) => handle(bot.id, { action, ...p }) as Promise<any>;
const settle = () => Bun.sleep(20);

beforeEach(() => {
  admitted.length = answers.length = steers.length = wakes.length = merged.length = 0;
  snapshots = [];
  grant();
  svc.updateSettings({ harnesses: {} });
});

afterAll(() => {
  for (const run of runs.values()) run.end();
  rmSync(dir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

const ask = (over: object = {}) => ({ t: "ask" as const, id: "a1", method: "select" as const, title: "Which?", options: ["Red", "Blue"], ...over });

test("a bot has no access until the user gives it some, and can't give itself any", async () => {
  svc.updateBot(bot.id, { threads: { enabled: false, projects: [] } });
  await expect(call("options")).rejects.toThrow(/hasn't given you access/);
  expect(guide({ threads: undefined })).toBe("");
  const { manage } = await import("../server/bots/agent");
  manage(bot.id, { action: "update", name: "Juniper", threads: { enabled: true, projects: [project.id] } });
  expect(svc.fullBot(bot.id)!.threads?.enabled).toBe(false);
});

test("a thread starts with the harness, model, effort, speed and branch asked for", async () => {
  const started = await call("start", { project: project.name, prompt: "Fix it", model: "acme/one", effort: "low", speed: "fast", title: "Fix it", branch_name: "fix-it" });
  expect(started).toMatchObject({ harness: "pi", model: "acme/one", effort: "low", speed: "fast", branch: "openbuild/fix-it" });
  expect(admitted[0]).toMatchObject({ runtime: "pi", model: "acme/one", effort: "low", speed: "fast", prior: 0 });
  expect(admitted[0].message).toContain("Fix it");
  const chat = storage.getChat(admitted[0].threadId) as any;
  expect(chat.workspace).toMatchObject({ projectId: project.id, worktree: true, branch: "openbuild/fix-it" });
  expect(chat.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
  expect(chat.messages[0].sentBy).toBe("Juniper");
  expect(chat.messages[0].sentByBot).toBe(bot.id);
  expect(chat.messages[1].stream.id).toBe(admitted[0].stream.id);
  // Bad picks are refused before anything is created.
  admitted.length = 0;
  await expect(call("start", { project: project.name, prompt: "x", effort: "turbo" })).rejects.toThrow(/efforts/);
  await expect(call("start", { project: project.name, prompt: "x", speed: "warp" })).rejects.toThrow(/speeds/);
  await expect(call("start", { project: "someone else's", prompt: "x" })).rejects.toThrow(/your projects/);
  expect(admitted).toEqual([]);
});

test("without the choice, a thread gets the user's default for that harness", async () => {
  svc.updateSettings({ harnesses: { permissions: { claude: "safe" } } });
  const started = await call("start", { project: project.name, prompt: "Go", harness: "claude", permission: "yolo" });
  expect(admitted[0].permission).toBe("safe");
  expect(started.permission).toBe("safe");
  expect(started.note).toContain("default");
});

test("with the choice, a bot's pick wins but must be a mode the harness offers", async () => {
  grant({ choosePermission: true });
  svc.updateSettings({ harnesses: { permissions: { claude: "safe" } } });
  await call("start", { project: project.name, prompt: "Go", harness: "claude", permission: "yolo" });
  expect(admitted[0].permission).toBe("yolo");
  await expect(call("start", { project: project.name, prompt: "Go", harness: "claude", permission: "banned" })).rejects.toThrow(/doesn't offer/);
  await expect(call("start", { project: project.name, prompt: "Go", harness: "claude", permission: "nope" })).rejects.toThrow(/doesn't offer/);
});

test("permission resolution never falls back past a mode that's gone", async () => {
  const list = async () => modes;
  const access = { enabled: true, projects: [] };
  expect(await resolvePermission("claude", undefined, access, undefined, list)).toBeUndefined();
  expect(await resolvePermission("pi", "yolo", access, { claude: "safe" }, list)).toBeUndefined();
  await expect(resolvePermission("claude", undefined, access, { claude: "gone" }, list)).rejects.toThrow(/Settings → Bots/);
});

test("the user can keep bots off a harness", async () => {
  svc.updateSettings({ harnesses: { blocked: ["pi"] } });
  await expect(call("start", { project: project.name, prompt: "Go" })).rejects.toThrow(/doesn't let bots/);
  expect((await call("options")).harnesses).not.toContain("pi");
  await expect(call("start", { project: project.name, prompt: "Go", harness: "durable" })).rejects.toThrow(/Durable/);
});

test("questions wake the bot once, and it can answer them", async () => {
  await call("start", { project: project.name, prompt: "Go" });
  const { threadId, stream } = admitted[0];
  const question = ask({ question: true });
  snapshots[0].events = [question];
  runs.get(stream.id)!.push(question);
  await settle();
  const note = wakes.find((w) => w.text.includes("Which?"));
  expect(note).toMatchObject({ id: bot.id, kind: "note" });
  expect(note.text).toContain("Red / Blue");
  expect(note.text).toContain("question a1");
  await call("answer", { thread: threadId.slice(0, 8), question: "a1", answer: "blue" });
  expect(answers[0]).toEqual([threadId, "a1", { value: "Blue" }]);
  // Nothing's waiting once it's been answered.
  snapshots[0].events = [question, { t: "asked", id: "a1", answer: "Blue" }];
  await expect(call("answer", { thread: threadId, question: "a1", answer: "Red" })).rejects.toThrow(/isn't waiting/);
  expect(wakes.filter((w) => w.text.includes("Which?")).length).toBe(1);
});

test("permission prompts stay the user's without the grant, whatever the bot claims", async () => {
  await call("start", { project: project.name, prompt: "Go" });
  const { threadId, stream } = admitted[0];
  const prompt = ask({ id: "p1", title: "Allow rm -rf?", options: ["Allow once", "Deny"] });
  snapshots[0].events = [prompt];
  runs.get(stream.id)!.push(prompt);
  await settle();
  const note = wakes.find((w) => w.text.includes("Allow rm"));
  expect(note.text).toContain("only the user");
  expect(note.text).not.toContain("question p1");
  await expect(call("answer", { thread: threadId, question: "p1", answer: "Allow once", kind: "question", question_kind: "question" })).rejects.toThrow(/permission prompt/);
  expect(answers).toEqual([]);
  grant({ approve: true });
  await call("answer", { thread: threadId, question: "p1", answer: "Allow once" });
  expect(answers[0][2]).toEqual({ value: "Allow once" });
});

test("secrets are only ever the user's", () => {
  expect(answerRefusal({ secret: true, question: true }, { approve: true })).toContain("secret");
  expect(answerRefusal({ question: true }, {})).toBeUndefined();
  expect(answerRefusal({}, {})).toContain("permission prompt");
  expect(answerRefusal({}, { approve: true })).toBeUndefined();
});

test("answers are checked against what the question takes", () => {
  expect(replyFor(ask({ method: "confirm", options: undefined }), "yes")).toEqual({ confirmed: true });
  expect(replyFor(ask({ method: "confirm", options: undefined }), "no")).toEqual({ confirmed: false });
  expect(() => replyFor(ask({ method: "confirm", options: undefined }), "maybe")).toThrow(/yes or no/);
  expect(() => replyFor(ask(), "Green")).toThrow(/Pick one/);
  expect(replyFor(ask({ other: true }), "Green")).toEqual({ value: "Green" });
  expect(replyFor(ask({ method: "input", options: undefined }), "anything")).toEqual({ value: "anything" });
  expect(() => replyFor(ask(), "  ")).toThrow(/Give an answer/);
  expect(waitingAsks([ask(), ask({ id: "a2" }), { t: "asked", id: "a1" }]).map((a) => a.id)).toEqual(["a2"]);
});

test("the bot hears when a turn ends, and the chat is brought up to date without a browser", async () => {
  await call("start", { project: project.name, prompt: "Go" });
  const { threadId, stream } = admitted[0];
  snapshots[0] = { ...snapshots[0], status: "done", endedAt: Date.now(), events: [{ t: "text", v: "All done" }, { t: "done", finish: "stop" }] };
  runs.get(stream.id)!.end();
  await settle();
  const chat = storage.getChat(threadId) as any;
  expect(chat.messages[1].status).toBe("done");
  expect(chat.messages[1].content).toBe("All done");
  expect(wakes.find((w) => w.text.includes("finished its turn")).text).toContain("All done");
  // Not followed any more, and a new turn carries on from the history.
  snapshots[0].status = "done";
  await call("send", { thread: threadId, text: "Next" });
  expect(admitted[1]).toMatchObject({ threadId, model: "acme/one", prior: 1 });
  expect(admitted[1].message).toContain("Next");
});

test("a message to a working thread is steered in", async () => {
  await call("start", { project: project.name, prompt: "Go" });
  const { threadId } = admitted[0];
  await call("send", { thread: threadId, text: "Also this" });
  expect(steers[0][0]).toBe(threadId);
  expect(steers[0][4]).toBe("Also this");
  expect(admitted.length).toBe(1);
});

test("a bot held to the defaults can't write into a thread with more power", async () => {
  const chat = { id: crypto.randomUUID(), title: "Mine", runtime: "claude", permission: "yolo", workspace: { projectId: project.id, projectName: project.name, cwd: repo }, createdAt: 1, updatedAt: 1, messages: [] };
  storage.putChat(chat as never);
  await expect(call("send", { thread: chat.id, text: "Do it" })).rejects.toThrow(/permissions you can't choose/);
  expect(() => assertWithinDefaults({ runtime: "claude", permission: "yolo" }, { enabled: true, projects: [] }, { claude: "yolo" })).not.toThrow();
  expect(() => assertWithinDefaults({ runtime: "cursor", cursorAllowAllTools: true }, { enabled: true, projects: [] }, undefined)).toThrow();
  expect(() => assertWithinDefaults({ runtime: "claude", permission: "yolo" }, { enabled: true, projects: [], choosePermission: true }, undefined)).not.toThrow();
});

test("threads outside its projects are out of reach", async () => {
  const other = { id: crypto.randomUUID(), title: "Other", workspace: { projectId: "elsewhere", projectName: "Elsewhere", cwd: repo }, createdAt: 1, updatedAt: 1, messages: [] };
  storage.putChat(other as never);
  await expect(call("read", { thread: other.id })).rejects.toThrow(/isn't in one of your projects/);
  await expect(call("close", { thread: other.id })).rejects.toThrow(/isn't in one of your projects/);
  const titles = (await call("list")).threads.map((t: any) => t.title);
  expect(titles).not.toContain("Other");
});

test("closing refuses a working thread, and leaves uncommitted work alone", async () => {
  await call("start", { project: project.name, prompt: "Go" });
  const { threadId, stream, cwd } = admitted[0];
  await expect(call("close", { thread: threadId })).rejects.toThrow(/still working/);
  snapshots[0].status = "done";
  await Bun.write(join(cwd, "wip.txt"), "unsaved");
  const closed = await call("close", { thread: threadId, remove_worktree: true });
  expect(closed.closed).toBe(true);
  expect(closed.note).toContain("uncommitted");
  expect(await Bun.file(join(cwd, "wip.txt")).text()).toBe("unsaved");
  expect((storage.getChat(threadId) as any).archived).toBe(true);
  runs.get(stream.id)!.end();
});

test("merging needs the grant and every check green", async () => {
  view = { number: 7, title: "T", url: "u", state: "open", base: "main", draft: false, mergeable: "MERGEABLE", mergeState: "CLEAN", checkList: [{ name: "ci", state: "failing" }], canWrite: true, methods: ["squash", "merge"], headSha: "abc" };
  await expect(call("merge", { project: project.name, number: 7 })).rejects.toThrow(/aren't allowed/);
  grant({ merge: true });
  await expect(call("merge", { project: project.name, number: 7 })).rejects.toThrow(/every check/);
  view.checkList = [{ name: "ci", state: "passing" }];
  view.mergeState = "BEHIND";
  await expect(call("merge", { project: project.name, number: 7 })).rejects.toThrow(/Behind/);
  view.mergeState = "CLEAN";
  await expect(call("merge", { project: project.name, number: 7, method: "rebase" })).rejects.toThrow(/merges with/);
  expect(merged).toEqual([]);
  await call("merge", { project: project.name, number: 7 });
  expect(merged[0]).toEqual([repo, 7, "squash", "abc", false]);
});
