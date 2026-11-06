import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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
mock.module("../server/runtimes", () => ({ runtimes: () => ({ pi: { installed: true }, claude: { installed: true }, codex: { installed: true }, cursor: { installed: true }, grok: { installed: true } }) }));
mock.module("../server/claude/install", () => ({ listModels: async () => ({ models: [{ id: "claude/one", name: "Claude One" }], defaultModel: "claude/one" }), listPermissions: async () => modes }));
for (const runtime of ["codex", "cursor"]) {
  mock.module(`../server/${runtime}/install`, () => ({
    listModels: async () => ({ models: [{ id: `${runtime}/one`, name: accountCacheKey() || "main" }], defaultModel: `${runtime}/one` }),
    listPermissions: async () => ({ modes: [{ id: accountCacheKey(), name: "Account mode" }], checkedAt: 0 }),
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
  expect(activity?.event).toMatchObject({ kind: "thread", text: "Wrote a prompt", threadId });
});

test("a message to a working thread is steered in", async () => {
  await call("start", { project: project.name, prompt: "Go" });
  const { threadId } = admitted[0];
  await call("send", { thread: threadId, text: "Also this" });
  expect(steers[0][0]).toBe(threadId);
  expect(steers[0][4]).toBe("Also this");
  expect(admitted.length).toBe(1);
  expect(svc.conversationView(svc.directId(bot.id)!)!.messages.at(-1)?.event).toMatchObject({ text: "Wrote a prompt", threadId });
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
    await call("start", { project: project.name, prompt: "Go", harness: account.id, permission: account.configDir, mode: "local" });
    expect(admitted[0]).toMatchObject({ runtime, runtimeAccount: account, permission: account.configDir });
    expect(accountCacheKey()).toBe("");
  });
}


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
