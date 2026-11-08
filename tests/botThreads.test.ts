import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountCacheKey } from "../server/runtimeAccounts";
import { Run } from "../server/runs";

const dir = mkdtempSync(join(tmpdir(), "openbuild-bot-threads-"));
process.env.OPENCHAT_DATA_DIR = dir;

const repo = realpathSync(mkdtempSync(join(tmpdir(), "openbuild-bot-repo-")));
execSync("git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init", { cwd: repo });

let discovered: any[] = [];
mock.module("../server/claude/accounts", () => ({ detectAccounts: () => discovered }));
// Codex discovery scans the home directory; keep it off the real one.
const codexHome = mkdtempSync(join(tmpdir(), "openbuild-bot-codex-home-"));
const { codexAccounts } = await import("../server/codex/accounts");
mock.module("../server/codex/accounts", () => ({ codexAccounts: (saved: unknown) => codexAccounts(saved, codexHome) }));

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
/** Held open to keep a Claude model listing in flight. */
let claudeListing: Promise<unknown> = Promise.resolve();
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
mock.module("../server/runtimes", () => ({ runtimes: () => ({ pi: { installed: true }, claude: { installed: true }, codex: { installed: true }, cursor: { installed: true }, grok: { installed: true } }) }));
mock.module("../server/claude/install", () => ({ listModels: async () => (await claudeListing, { models: [{ id: "claude/one", name: "Claude One" }, { id: "claude/two", name: "Claude Two", reasoning: { efforts: ["low", "high"] }, speeds: [{ id: "fast" }] }], defaultModel: "claude/one" }), listPermissions: async () => modes }));
for (const runtime of ["codex", "cursor"]) {
  mock.module(`../server/${runtime}/install`, () => ({
    listModels: async () => ({ models: [{ id: `${runtime}/one`, name: accountCacheKey() || "main" }], defaultModel: `${runtime}/one` }),
    listPermissions: async () => ({ modes: [{ id: accountCacheKey(), name: "Account mode" }], checkedAt: 0 }),
    daemonStatus: async () => ({ installed: true, status: "running", checkedAt: 0 }),
  }));
}
mock.module("../server/pullRequestView", () => ({ view: async () => view, merge: async (...args: any[]) => void merged.push(args) }));
mock.module("../server/bots/runner", () => ({ wake: (id: string, item: any) => wakes.push({ id, ...item }) }));

const svc = await import("../server/bots/service");
const projects = await import("../server/projects");
const storage = await import("../server/storage");
const threads = await import("../server/bots/threads");
const { serverId } = await import("../server/devices");
const { coversProject } = await import("../shared/bots");
const { handle, answerRefusal, assertWithinDefaults, replyFor, resolvePermission, waitingAsks, guide } = threads;

const project = await projects.addProject(repo);
const { bot } = svc.createBot({ name: "Juniper" });
const grant = (patch: object = {}) => svc.updateBot(bot.id, { threads: { enabled: true, projects: [project.id], ...patch } });
const call = (action: string, p: object = {}) => handle(bot.id, { action, ...p }) as Promise<any>;
const settle = () => Bun.sleep(20);

beforeEach(() => {
  admitted.length = answers.length = steers.length = wakes.length = merged.length = 0;
  snapshots = [];
  discovered = [];
  storage.setValue("client-state", "{}");
  grant();
  svc.updateSettings({ harnesses: {} });
});

afterAll(() => {
  for (const run of runs.values()) run.end();
  rmSync(dir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
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
  const activity = svc.conversationView(svc.directId(bot.id)!)!.messages.findLast((m) => m.event?.text === "Started a thread");
  expect(activity?.event).toMatchObject({ kind: "thread", threadId: chat.id, detail: "Fix it · pi" });
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

test("remote control is off unless asked, and only Claude Code takes it per thread", async () => {
  await call("start", { project: project.name, prompt: "Go", harness: "claude" });
  expect(admitted[0].remoteControl).toBeUndefined();
  expect((storage.getChat(admitted[0].threadId) as any).remoteControl).toBeUndefined();
  const started = await call("start", { project: project.name, prompt: "Go", harness: "claude", remote_control: true });
  expect(started.remote_control).toContain("claude.ai/code");
  expect(admitted[1].remoteControl).toBe(true);
  const chat = storage.getChat(admitted[1].threadId) as any;
  expect(chat.remoteControl).toBe(true);
  expect((await call("read", { thread: started.thread })).remote_control).toBe(true);
  // Kept on the thread: a follow-up still asks for it.
  await call("send", { thread: started.thread, text: "More" });
  expect(admitted.at(-1)).toMatchObject({ threadId: chat.id, remoteControl: true });
  // Codex pairs a machine daemon and Cursor its account: refused with the reason, never dropped.
  admitted.length = 0;
  await expect(call("start", { project: project.name, prompt: "Go", harness: "codex", remote_control: true })).rejects.toThrow(/codex remote-control start/);
  await expect(call("start", { project: project.name, prompt: "Go", harness: "cursor", remote_control: true })).rejects.toThrow(/Cursor account and team settings/);
  await expect(call("start", { project: project.name, prompt: "Go", remote_control: true })).rejects.toThrow(/no Remote Control/);
  await expect(call("start", { project: project.name, prompt: "Go", harness: "claude", remote_control: "yes" })).rejects.toThrow(/true or false/);
  expect(admitted).toEqual([]);
  expect((await call("options", { harness: "claude" })).remote_control).toMatchObject({ per_thread: true });
  expect((await call("options", { harness: "codex" })).remote_control).toMatchObject({ per_thread: false, openbuild_threads: expect.stringContaining("disabled"), machine_daemon_process: { status: "running" }, machine_remote_control: expect.stringContaining("Unknown") });
  expect((await call("options", { harness: "cursor" })).remote_control).toMatchObject({ per_thread: false });
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
  const activity = svc.conversationView(svc.directId(bot.id)!)!.messages.at(-1);
  expect(activity?.event).toMatchObject({ kind: "thread", text: "Wrote a prompt in", threadId });
});

test("a message to a working thread is steered in", async () => {
  await call("start", { project: project.name, prompt: "Go" });
  const { threadId } = admitted[0];
  await call("send", { thread: threadId, text: "Also this" });
  expect(steers[0][0]).toBe(threadId);
  expect(steers[0][4]).toBe("Also this");
  expect(admitted.length).toBe(1);
  expect(svc.conversationView(svc.directId(bot.id)!)!.messages.at(-1)?.event).toMatchObject({ text: "Wrote a prompt in", threadId });
  // Saved on the reply, so the steer shows who sent it.
  const reply = (storage.getChat(threadId) as any).messages.at(-1);
  expect(reply.steerSenders[steers[0][1]]).toEqual({ sentBy: "Juniper", sentByBot: bot.id });
});

test("a bot held to the defaults can't write into a thread with more power", async () => {
  grant({ others: true });
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

test("a grant covers all projects, the chosen ones, or all but the excluded ones", async () => {
  const projectIds = async () => (await call("options")).projects.map((p: any) => p.id);
  grant({ scope: "all", projects: [] });
  expect(await projectIds()).toEqual([project.id]);
  grant({ scope: "exclude", projects: [], excluded: ["elsewhere"] });
  expect(await projectIds()).toEqual([project.id]);
  grant({ scope: "exclude", projects: [project.id], excluded: [project.id] });
  expect(await projectIds()).toEqual([]);
  await expect(call("start", { project: project.name, prompt: "Go" })).rejects.toThrow(/you haven't been given any/);
  grant({ scope: "choose", projects: [], excluded: [project.id] });
  expect(await projectIds()).toEqual([]);
  // A grant saved before scopes, or with one that's not recognised, only has what it lists.
  grant({ scope: "everything", projects: [] });
  expect(svc.fullBot(bot.id)!.threads?.scope).toBe("choose");
  expect(coversProject({ projects: [project.id] }, project.id)).toBe(true);
  expect(coversProject({ projects: [] }, project.id)).toBe(false);
  expect(coversProject({ scope: "all", projects: [] }, undefined)).toBe(false);
});

test("all projects doesn't reach threads outside OpenBuild's projects", async () => {
  const removed = { id: crypto.randomUUID(), title: "Removed", workspace: { projectId: "removed", projectName: "Removed", cwd: repo }, createdAt: 1, updatedAt: 1, messages: [] };
  storage.putChat(removed as never);
  grant({ scope: "all", projects: [] });
  await expect(call("read", { thread: removed.id })).rejects.toThrow(/isn't in one of your projects/);
  expect((await call("list")).threads.map((t: any) => t.title)).not.toContain("Removed");
});

test("closing refuses a working thread, and leaves uncommitted work alone", async () => {
  await call("start", { project: project.name, prompt: "Go" });
  const { threadId, stream, cwd } = admitted[0];
  await expect(call("close", { thread: threadId })).rejects.toThrow(/still working/);
  snapshots[0].status = "done";
  await Bun.write(join(cwd, "wip.txt"), "unsaved");
  const stale = { ...(storage.getChat(threadId) as any), archived: false, done: true, woke: true };
  const closed = await call("close", { thread: threadId, remove_worktree: true });
  expect(closed.closed).toBe(true);
  expect(closed.note).toContain("uncommitted");
  // The activity links to the thread it closed.
  expect(svc.conversationView(svc.directId(bot.id)!)!.messages.findLast((m) => m.event?.text === "Closed a thread")?.event?.threadId).toBe(threadId);
  expect(await Bun.file(join(cwd, "wip.txt")).text()).toBe("unsaved");
  const saved = storage.getChat(threadId) as any;
  expect(saved.archived).toBe(true);
  expect(saved.autoClosedAt).toBeGreaterThan(0);
  const { keepPullRequestFields } = await import("../server/pullRequests");
  const persisted = keepPullRequestFields(stale, saved);
  expect(persisted).toMatchObject({ archived: true, done: false, woke: false, autoClosedAt: saved.autoClosedAt });
  storage.putChat(persisted as never);
  expect((storage.getChat(threadId) as any).archived).toBe(true);
  expect(keepPullRequestFields({ ...stale, autoCloseOptOut: true }, saved).archived).toBe(false);
  runs.get(stream.id)!.end();
});

test("merging needs the grant and every check green", async () => {
  view = { number: 7, title: "T", url: "u", state: "open", base: "main", draft: false, mergeable: "MERGEABLE", mergeState: "CLEAN", checkList: [{ name: "ci", state: "failing" }], canWrite: true, methods: ["squash", "merge"], headSha: "abc" };
  await expect(call("merge", { project: project.name, number: 7 })).rejects.toThrow(/aren't allowed/);
  grant({ merge: true, others: true });
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

test("threads it didn't start are only its to control with the grant", async () => {
  const theirs = { id: crypto.randomUUID(), title: "Theirs", workspace: { projectId: project.id, projectName: project.name, cwd: repo }, createdAt: 1, updatedAt: 1, messages: [{ id: "u", role: "user", content: "Hi", createdAt: 1 }, { id: "a", role: "assistant", content: "Hello", createdAt: 1, model: { plan: "pi", id: "acme/one", name: "One" } }] };
  storage.putChat(theirs as never);
  await call("start", { project: project.name, prompt: "Go" });
  const mine = admitted[0].threadId;
  snapshots[0].status = "done";
  // It still sees them, and knows which are its own.
  const listed = (await call("list")).threads;
  expect(listed.find((t: any) => t.title === "Theirs").yours).toBe(false);
  expect(listed.find((t: any) => t.thread === mine.slice(0, 8)).yours).toBe(true);
  expect((await call("read", { thread: theirs.id })).yours).toBe(false);
  for (const action of ["send", "stop", "close"]) await expect(call(action, { thread: theirs.id, text: "Hey" })).rejects.toThrow(/didn't start that thread/);
  await expect(call("answer", { thread: theirs.id, question: "a1", answer: "Red" })).rejects.toThrow(/didn't start that thread/);
  expect(guide(svc.fullBot(bot.id)!)).toContain("only control the ones you started");
  await call("send", { thread: mine, text: "More" });

  view = { number: 9, title: "T", url: "u", state: "open", base: "main", draft: false, mergeable: "MERGEABLE", mergeState: "CLEAN", checkList: [{ name: "ci", state: "passing" }], canWrite: true, methods: ["squash"], headSha: "def" };
  storage.putChat({ ...(storage.getChat(theirs.id) as any), workspace: { ...theirs.workspace, worktree: true }, pullRequest: { number: 9 } } as never);
  grant({ merge: true });
  await expect(call("merge", { thread: theirs.id })).rejects.toThrow(/didn't start that thread/);
  await expect(call("merge", { project: project.name, number: 9 })).rejects.toThrow(/didn't open #9/);
  expect(merged).toEqual([]);

  grant({ merge: true, others: true });
  expect((await call("options")).you_may.control_threads_you_didnt_start).toBe(true);
  expect(guide(svc.fullBot(bot.id)!)).toContain("including ones the user or other bots started");
  await call("send", { thread: theirs.id, text: "Hey" });
  expect(admitted.at(-1).threadId).toBe(theirs.id);
  expect((storage.getChat(theirs.id) as any).messages.at(-2).sentByBot).toBe(bot.id);
  await call("merge", { project: project.name, number: 9 });
  expect(merged[0]).toEqual([repo, 9, "squash", "def", false]);
  // Named by number, the merge still links to the thread the pull request came from, and to the pull request itself.
  const mergedEvent = svc.conversationView(svc.directId(bot.id)!)!.messages.findLast((m) => m.event?.text === "Merged a pull request")?.event;
  expect(mergedEvent?.threadId).toBe(theirs.id);
  expect(mergedEvent?.pullUrl).toBe("u");
});

test("saved local accounts are discoverable, selectable and preserved on continuation", async () => {
  const account = { id: "login-2", name: "claude2", runtime: "claude", configDir: "/tmp/bot-claude2" };
  storage.setValue("client-state", JSON.stringify({ state: { settings: { runtimeAccounts: [account, { ...account, id: "remote", name: "remote", deviceId: "other" }] } } }));
  expect((await call("options")).accounts).toEqual([{ id: "login-2", name: "claude2", harness: "claude" }]);
  expect((await call("options", { harness: "claude2" })).models[0].id).toBe("claude/one");
  const started = await call("start", { project: project.name, prompt: "Go", harness: "login-2", mode: "local" });
  expect(started.account).toBe(account.id);
  expect(admitted[0]).toMatchObject({ runtime: "claude", runtimeAccount: account, model: "claude/one" });
  expect((storage.getChat(admitted[0].threadId) as any).runtimeAccount).toEqual(account);
  expect((await call("read", { thread: started.thread })).account).toBe(account.id);
  snapshots = [];
  await call("send", { thread: started.thread, text: "Continue" });
  expect(admitted[1].runtimeAccount).toEqual(account);
  await expect(call("options", { harness: "remote" })).rejects.toThrow(/Unknown harness/);
  svc.updateSettings({ harnesses: { blocked: ["claude"] } });
  expect((await call("options")).accounts).toEqual([]);
  await expect(call("start", { project: project.name, prompt: "Go", harness: "claude2" })).rejects.toThrow(/doesn't let bots/);
});


for (const deviceId of [undefined, "", "self"]) {
  test(`Add runtime account on ${deviceId ?? "legacy local"} is usable by name and id`, async () => {
    const account = { id: "added-login", name: "Claude2", runtime: "claude", configDir: "/tmp/bot-added-claude", deviceId: deviceId === "self" ? serverId() : deviceId };
    storage.setValue("client-state", JSON.stringify({ state: { settings: { runtimeAccounts: [account, { ...account, id: "remote-login", deviceId: "other" }] } } }));
    expect((await call("options")).accounts).toEqual([{ id: account.id, name: "Claude2", harness: "claude" }]);
    expect((await call("options", { harness: "claude2" })).models[0].id).toBe("claude/one");
    await expect(call("options", { harness: "remote-login" })).rejects.toThrow(/Unknown harness/);
    for (const harness of ["claude2", account.id]) {
      const started = await call("start", { project: project.name, prompt: "Go", harness, mode: "local" });
      expect(started.account).toBe(account.id);
      expect(admitted.at(-1).runtimeAccount).toEqual(account);
      snapshots = [];
      await call("send", { thread: started.thread, text: "Continue" });
      expect(admitted.at(-1).runtimeAccount).toEqual(account);
    }
    svc.updateSettings({ harnesses: { blocked: ["claude"] } });
    expect((await call("options")).accounts).toEqual([]);
    await expect(call("options", { harness: "claude2" })).rejects.toThrow(/doesn't let bots/);
  });
}


for (const runtime of ["codex", "cursor"]) {
  test(`${runtime} models and permissions use the selected login`, async () => {
    const account = { id: `${runtime}-extra`, name: `${runtime}2`, runtime, configDir: `/tmp/bot-${runtime}2` };
    storage.setValue("client-state", JSON.stringify({ state: { settings: { runtimeAccounts: [account] } } }));
    grant({ choosePermission: true });
    const options = await call("options", { harness: account.name });
    expect(options.models[0].name).toBe(account.configDir);
    expect(options.permissions.modes[0].id).toBe(account.configDir);
    // Codex accounts take the id the model picker lists them under.
    const listed = runtime === "codex" ? { ...account, id: "codex2" } : account;
    await call("start", { project: project.name, prompt: "Go", harness: listed.id, permission: account.configDir, mode: "local" });
    expect(admitted[0]).toMatchObject({ runtime, runtimeAccount: listed, permission: account.configDir });
    expect(accountCacheKey()).toBe("");
  });
}


test("a saved Codex login under the older numeric home spelling runs from the signed-in sibling", async () => {
  const sibling = join(codexHome, ".codex-2");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "auth.json"), "{}");
  try {
    const account = { id: "old-uuid", name: "codex2", runtime: "codex", configDir: "~/.codex2" };
    storage.setValue("client-state", JSON.stringify({ state: { settings: { runtimeAccounts: [account] } } }));
    expect((await call("options")).accounts).toEqual([{ id: "codex2", name: "codex2", harness: "codex" }]);
    expect((await call("options", { harness: "codex2" })).models[0].name).toBe(sibling);
    await call("start", { project: project.name, prompt: "Go", harness: "codex2", mode: "local" });
    expect(admitted[0]).toMatchObject({ runtime: "codex", runtimeAccount: { id: "codex2", configDir: sibling } });
  } finally { rmSync(sibling, { recursive: true, force: true }); }
});

test("UI-discovered Claude login is usable and saved configuration wins", async () => {
  const account = { id: "claude2", name: "claude2", runtime: "claude", configDir: "/tmp/bot-discovered-claude" };
  discovered = [account];
  expect((await call("options")).accounts).toEqual([{ id: account.id, name: account.name, harness: "claude" }]);
  expect((await call("options", { harness: "claude2" })).models[0].id).toBe("claude/one");
  const started = await call("start", { project: project.name, prompt: "Go", harness: "claude2", mode: "local" });
  expect(admitted[0].runtimeAccount).toEqual(account);
  // Saved under the id the UI lists for the account, so the composer keeps it; sent as the runtime's own.
  expect((storage.getChat(admitted[0].threadId) as any).messages.at(-1).model).toMatchObject({ plan: "claude", id: "claude2/one" });
  expect(admitted[0].model).toBe("claude/one");
  snapshots = [];
  await call("send", { thread: started.thread, text: "Continue" });
  expect(admitted[1]).toMatchObject({ runtimeAccount: account, model: "claude/one" });
  expect((storage.getChat(admitted[1].threadId) as any).messages.at(-1).model).toMatchObject({ id: "claude2/one" });
  const saved = { ...account, id: "saved-id", name: "Work", launchArgs: "--verbose" };
  storage.setValue("client-state", JSON.stringify({ state: { settings: { runtimeAccounts: [saved] } } }));
  expect((await call("options")).accounts).toEqual([{ id: saved.id, name: saved.name, harness: "claude" }]);
  await call("start", { project: project.name, prompt: "Go", harness: saved.id, mode: "local" });
  expect(admitted.at(-1).runtimeAccount).toEqual(saved);
  svc.updateSettings({ harnesses: { blocked: ["claude"] } });
  expect((await call("options")).accounts).toEqual([]);
  await expect(call("options", { harness: saved.id })).rejects.toThrow(/doesn't let bots/);
});


/** A finished turn, so the next send starts a new one. */
const finish = () => {
  for (const snapshot of snapshots) snapshot.status = "done";
};

test("send changes model, effort and permission for the next turn, and keeps the thread", async () => {
  grant({ choosePermission: true });
  const started = await call("start", { project: project.name, prompt: "Go", harness: "claude", permission: "safe" });
  const { threadId, cwd } = admitted[0];
  finish();
  const before = storage.getChat(threadId) as any;
  const sent = await call("send", { thread: started.thread, text: "Harder", model: "claude/two", effort: "high", speed: "fast", permission: "yolo" });
  expect(sent).toMatchObject({ sent: true, harness: "claude", model: "claude/two", effort: "high", speed: "fast", permission: "yolo", changed: ["model", "effort", "speed", "permission"] });
  // The next turn on the same thread carries them; the harness applies them to its warm session.
  expect(admitted[1]).toMatchObject({ threadId, cwd, runtime: "claude", model: "claude/two", effort: "high", speed: "fast", permission: "yolo", prior: 1 });
  const chat = storage.getChat(threadId) as any;
  expect(chat).toMatchObject({ id: threadId, permission: "yolo", workspace: before.workspace });
  expect(chat.messages.slice(0, 2).map((m: any) => m.id)).toEqual(before.messages.map((m: any) => m.id));
  expect(chat.messages.at(-1).model).toMatchObject({ plan: "claude", id: "claude/two", effort: "high", speed: "fast" });
  expect(await call("read", { thread: started.thread })).toMatchObject({ model: "claude/two", effort: "high", speed: "fast", permission: "yolo", working: true });
  // Nothing global moves.
  expect(svc.getSettings().harnesses?.permissions).toEqual({});
  expect(JSON.parse(storage.getValue("client-state")!)).toEqual({});
});

test("what send leaves out stays as the thread had it", async () => {
  grant({ choosePermission: true });
  const started = await call("start", { project: project.name, prompt: "Go", harness: "claude", model: "claude/two", effort: "low", speed: "fast", permission: "safe" });
  finish();
  const effortOnly = await call("send", { thread: started.thread, text: "More", effort: "high" });
  expect(effortOnly).toMatchObject({ model: "claude/two", effort: "high", speed: "fast", permission: "safe", changed: ["effort"] });
  expect(admitted[1]).toMatchObject({ model: "claude/two", effort: "high", speed: "fast", permission: "safe" });
  finish();
  const plain = await call("send", { thread: started.thread, text: "Again" });
  expect(plain.changed).toBeUndefined();
  expect(admitted[2]).toMatchObject({ model: "claude/two", effort: "high", speed: "fast", permission: "safe" });
  finish();
  // A model that doesn't take the old effort or speed falls back, and says so.
  const switched = await call("send", { thread: started.thread, text: "Simpler", model: "claude/one" });
  expect(switched).toMatchObject({ model: "claude/one", permission: "safe" });
  expect(switched.speed).toBeUndefined();
  expect(switched.note).toContain("standard speed");
  expect(admitted[3].speed).toBeUndefined();
  finish();
  await call("send", { thread: started.thread, text: "Plain", model: "claude/two", speed: "standard" });
  expect(admitted[4].speed).toBeUndefined();
});

test("send refuses another harness's model or harness, and saves nothing", async () => {
  grant({ choosePermission: true });
  const started = await call("start", { project: project.name, prompt: "Go" });
  const { threadId } = admitted[0];
  finish();
  const before = JSON.stringify(storage.getChat(threadId));
  await expect(call("send", { thread: started.thread, text: "x", model: "claude/one" })).rejects.toThrow(/pi has no model "claude\/one"/);
  await expect(call("send", { thread: started.thread, text: "x", harness: "claude" })).rejects.toThrow(/send keeps it there/);
  await expect(call("send", { thread: started.thread, text: "x", permission: "yolo" })).rejects.toThrow(/no permission modes/);
  await expect(call("send", { thread: started.thread, text: "x", effort: "max" })).rejects.toThrow(/efforts/);
  expect(admitted.length).toBe(1);
  expect(JSON.stringify(storage.getChat(threadId))).toBe(before);
  // Naming its own harness is fine.
  await call("send", { thread: started.thread, text: "x", harness: "pi" });
  expect(admitted.length).toBe(2);
});

test("an invalid combination writes nothing, even with valid parts", async () => {
  grant({ choosePermission: true });
  const started = await call("start", { project: project.name, prompt: "Go", harness: "claude", permission: "safe" });
  const { threadId } = admitted[0];
  finish();
  const before = JSON.stringify(storage.getChat(threadId));
  await expect(call("send", { thread: started.thread, text: "x", model: "claude/two", effort: "high", permission: "banned" })).rejects.toThrow(/doesn't offer/);
  await expect(call("send", { thread: started.thread, text: "x", model: "claude/two", effort: "max", permission: "yolo" })).rejects.toThrow(/efforts/);
  await expect(call("send", { thread: started.thread, text: "x", model: "claude/two", speed: "warp" })).rejects.toThrow(/speeds/);
  await expect(call("send", { thread: started.thread, text: "x", model: "nope", permission: "yolo" })).rejects.toThrow(/no model/);
  expect(admitted.length).toBe(1);
  expect(JSON.stringify(storage.getChat(threadId))).toBe(before);
  // If the harness won't take the turn, the thread keeps the mode it had.
  admit = async () => {
    throw Object.assign(new Error("worker gone"), { status: 503 });
  };
  try {
    await expect(call("send", { thread: started.thread, text: "x", permission: "yolo" })).rejects.toThrow(/worker gone/);
  } finally {
    admit = async (req: any) => {
      admitted.push(req);
      const run = new Run();
      runs.set(req.stream.id, run);
      snapshots.push({ id: req.stream.id, threadId: req.threadId, kind: "run", status: "pending", events: [], startedAt: Date.now() });
      return run;
    };
  }
  expect((storage.getChat(threadId) as any).permission).toBe("safe");
});

test("settings don't change under a running turn", async () => {
  grant({ choosePermission: true });
  const started = await call("start", { project: project.name, prompt: "Go", harness: "claude", permission: "safe" });
  const { threadId } = admitted[0];
  const before = JSON.stringify(storage.getChat(threadId));
  for (const over of [{ model: "claude/two" }, { effort: "high" }, { permission: "yolo" }, { speed: "fast" }]) {
    await expect(call("send", { thread: started.thread, text: "Now", ...over })).rejects.toThrow(/still working/);
  }
  expect(steers).toEqual([]);
  expect(admitted.length).toBe(1);
  expect(JSON.stringify(storage.getChat(threadId))).toBe(before);
  // Without them, it's steered in as before.
  await call("send", { thread: started.thread, text: "Also" });
  expect(steers.length).toBe(1);
});

test("a bot held to the defaults can't change a thread's permission mode", async () => {
  svc.updateSettings({ harnesses: { permissions: { claude: "safe" } } });
  const started = await call("start", { project: project.name, prompt: "Go", harness: "claude" });
  const { threadId } = admitted[0];
  finish();
  const before = JSON.stringify(storage.getChat(threadId));
  await expect(call("send", { thread: started.thread, text: "x", permission: "yolo", model: "claude/two" })).rejects.toThrow(/can't choose permissions/);
  expect(admitted.length).toBe(1);
  expect(JSON.stringify(storage.getChat(threadId))).toBe(before);
  // Its current mode, or other settings, are fine.
  const sent = await call("send", { thread: started.thread, text: "x", permission: "safe", model: "claude/two" });
  expect(sent).toMatchObject({ model: "claude/two", permission: "safe" });
  // Claude Two doesn't take the medium effort it ran at, so it says what it uses instead.
  expect(sent.changed).toEqual(["model", "effort"]);
  expect(sent.note).toContain("doesn't take effort medium");
  expect(admitted[1].permission).toBe("safe");
});

test("account threads take their models by either id, and keep the account", async () => {
  const account = { id: "login-3", name: "claude3", runtime: "claude", configDir: "/tmp/bot-claude3" };
  storage.setValue("client-state", JSON.stringify({ state: { settings: { runtimeAccounts: [account] } } }));
  const started = await call("start", { project: project.name, prompt: "Go", harness: account.id, mode: "local" });
  finish();
  expect((await call("read", { thread: started.thread })).model).toBe("claude/one");
  await call("send", { thread: started.thread, text: "x", model: "login-3/two", harness: "claude3" });
  expect(admitted[1]).toMatchObject({ runtimeAccount: account, model: "claude/two" });
  expect((storage.getChat(admitted[1].threadId) as any).messages.at(-1).model.id).toBe("login-3/two");
  finish();
  await expect(call("send", { thread: started.thread, text: "x", harness: "claude" })).rejects.toThrow(/claude3 account/);
});

/** Holds Claude's model listing until the returned function is called. */
function holdListing() {
  let release!: () => void;
  claudeListing = new Promise<void>((resolve) => (release = resolve));
  return () => {
    release();
    claudeListing = Promise.resolve();
  };
}

test("a turn started while send checks its settings is refused without touching the thread", async () => {
  grant({ choosePermission: true });
  const started = await call("start", { project: project.name, prompt: "Go", harness: "claude", permission: "safe" });
  const { threadId } = admitted[0];
  finish();
  const release = holdListing();
  const slow = call("send", { thread: started.thread, text: "Switch", model: "claude/two", permission: "yolo" });
  slow.catch(() => {});
  await settle();
  // Another send takes the idle thread while the model is still being looked up.
  await call("send", { thread: started.thread, text: "Quick" });
  expect(admitted.length).toBe(2);
  const after = JSON.stringify(storage.getChat(threadId));
  release();
  const err = await slow.then(() => undefined, (e) => e);
  expect(err?.message).toMatch(/started another turn/);
  expect(err?.status).toBe(409);
  expect(admitted.length).toBe(2);
  // No failed reply, no new mode: just the other send's turn.
  const chat = storage.getChat(threadId) as any;
  expect(JSON.stringify(chat)).toBe(after);
  expect(chat.messages.some((m: any) => m.status === "error")).toBe(false);
  expect(chat.permission).toBe("safe");
});

test("a turn the worker started elsewhere during the check is refused too", async () => {
  grant({ choosePermission: true });
  const started = await call("start", { project: project.name, prompt: "Go", harness: "claude" });
  const { threadId } = admitted[0];
  finish();
  // Reading brings the finished turn into the saved thread, as send's own refresh would.
  await call("read", { thread: started.thread });
  const before = JSON.stringify(storage.getChat(threadId));
  const release = holdListing();
  const slow = call("send", { thread: started.thread, text: "Switch", model: "claude/two" });
  slow.catch(() => {});
  await settle();
  // Started from the app: the worker has the run, this server's copy of the thread doesn't yet.
  snapshots.push({ id: crypto.randomUUID(), threadId, kind: "run", status: "pending", events: [], startedAt: Date.now() });
  release();
  await expect(slow).rejects.toThrow(/started another turn/);
  expect(admitted.length).toBe(1);
  expect(JSON.stringify(storage.getChat(threadId))).toBe(before);
});

test("the primary adds a project and starts a thread in it; other bots and stray paths are refused", async () => {
  expect(svc.fullBot(bot.id)!.primary).toBe(true);
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "openbuild-bot-added-")));
  execSync("git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init", { cwd: folder });
  const fresh = join(realpathSync(tmpdir()), `openbuild-bot-new-${crypto.randomUUID().slice(0, 8)}`);
  const events: any[] = [];
  const off = svc.subscribe((e) => events.push(e));
  try {
    // Chosen projects only: the one it adds becomes its own, so it can start a thread there straight away.
    const added = await call("add_project", { path: folder, name: "Added" });
    expect(added.project).toMatchObject({ name: "Added", path: folder, git: true });
    expect(added.note).toBeUndefined();
    expect(projects.findProject(added.project.id)?.path).toBe(folder);
    expect(svc.fullBot(bot.id)!.threads?.projects).toEqual([project.id, added.project.id]);
    expect(events.some((e) => e.t === "projects")).toBe(true);
    expect(svc.conversationView(svc.directId(bot.id)!)!.messages.at(-1)?.event).toMatchObject({ kind: "thread", text: "Added a project", detail: "Added" });
    expect((await call("options")).projects.map((p: any) => p.name)).toContain("Added");
    await call("start", { project: "Added", prompt: "Look around", title: "Look" });
    expect((storage.getChat(admitted[0].threadId) as any).workspace.projectId).toBe(added.project.id);

    // A new, empty folder, with create.
    await expect(call("add_project", { path: fresh })).rejects.toThrow(/No folder/);
    expect((await call("add_project", { path: fresh, create: true })).project.git).toBe(false);

    // A project the user kept from it stays kept, even when it names the folder again.
    grant();
    const again = await call("add_project", { path: folder });
    expect(again.note).toMatch(/hasn't given you it/);
    expect(svc.fullBot(bot.id)!.threads?.projects).toEqual([project.id]);

    // Not a drive, a home folder, a relative path or OpenBuild's own data.
    const before = projects.listProjects().length;
    for (const path of ["/", "~", "relative/app", join(dir, "worktrees")]) await expect(call("add_project", { path, create: true })).rejects.toThrow();
    await expect(call("add_project", {})).rejects.toThrow(/Say where/);
    expect(projects.listProjects().length).toBe(before);

    // Primary only, and only with OpenBuild access.
    const other = svc.createBot({ name: "Helper" }).bot;
    svc.updateBot(other.id, { threads: { enabled: true, scope: "all", projects: [] } });
    await expect(handle(other.id, { action: "add_project", path: folder })).rejects.toThrow(/Only the primary/);
    svc.updateBot(bot.id, { threads: { enabled: false, projects: [] } });
    await expect(call("add_project", { path: folder })).rejects.toThrow(/hasn't given you access/);
    await svc.deleteBot(other.id);
    expect(guide({ threads: { enabled: true, scope: "all", projects: [] }, primary: true })).toContain("add_project");
    expect(guide({ threads: { enabled: true, scope: "all", projects: [] } })).not.toContain("add_project");
  } finally {
    off();
    for (const p of projects.listProjects()) if (p.id !== project.id) projects.removeProject(p.id);
    rmSync(folder, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});
