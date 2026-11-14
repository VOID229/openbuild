import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
/** When set, the harness can't take a steer now, with this reason. */
let steerFails = "";
/** How many more steers the harness turns away as not ready yet, as one does while its turn starts. */
let steerNotYet = 0;
/** What the harness says it did with a steer: true is a Pi extension taking it as input. */
let steerHandled = false;
/**
 * What each harness's adapter (server/<harness>/sessions.ts) answers a steer it can't take: while its
 * turn is starting, and for images where it steers text only (marked unsupported, as the adapters do).
 */
const HARNESS_STEERS: Record<string, { notYet: string; textOnly?: string }> = {
  pi: { notYet: "Pi hasn't started on this reply yet. Try again in a moment." },
  claude: { notYet: "Claude Code isn't working on this thread" },
  codex: { notYet: "Codex hasn't started on this reply yet. Try again in a moment." },
  opencode: { notYet: "OpenCode isn't working on this thread" },
  grok: { notYet: "Grok isn't working on this thread" },
  cursor: { notYet: "Cursor isn't working on this thread", textOnly: "Cursor steering takes text only: its image attachments are not supported by this adapter" },
  fx: { notYet: "fx isn't working on this thread", textOnly: "fx ACP steering supports text only; send images as a queued follow-up" },
  hermes: { notYet: "Hermes isn't working on this thread", textOnly: "Hermes steering requires text; queue images as a follow-up" },
};
const HARNESSES = Object.keys(HARNESS_STEERS);
const { unsupportedSteer } = await import("../server/steerErrors");
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
  // Most harnesses answer a steer they took with handled: false; only a Pi extension says true.
  steer: async (...args: any[]) => {
    const [threadId, , , images] = args;
    const harness = HARNESS_STEERS[(storage.getChat(threadId) as any)?.runtime ?? "pi"]!;
    if (steerFails) throw new Error(steerFails);
    if (images?.length && harness.textOnly) throw unsupportedSteer(new Error(harness.textOnly));
    if (steerNotYet > 0) {
      steerNotYet--;
      throw new Error(harness.notYet);
    }
    steers.push(args);
    return { handled: steerHandled };
  },
  stopRun: async () => true,
}));
mock.module("../server/pi/routes", () => ({ modelListing: async () => ({ models, defaultModel: "acme/one" }) }));
mock.module("../server/pi/sessions", () => ({ listModels: async () => ({}), isThreadId: () => true }));
mock.module("../server/runtimes", () => ({ runtimes: () => Object.fromEntries(HARNESSES.map((h) => [h, { installed: true }])) }));
for (const runtime of ["opencode-agent", "grok", "hermes", "fx"]) {
  const id = runtime === "opencode-agent" ? "opencode" : runtime;
  mock.module(`../server/${runtime}/install`, () => ({ listModels: async () => ({ models: [{ id: `${id}/one`, name: `${id} One` }], defaultModel: `${id}/one` }) }));
}
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
const db = await import("../server/bots/db");
const { serverId } = await import("../server/devices");
const { coversProject } = await import("../shared/bots");
const { handle, answerRefusal, assertWithinDefaults, replyFor, resolvePermission, waitingAsks, guide, brief } = threads;

const project = await projects.addProject(repo);
const { bot } = svc.createBot({ name: "Juniper" });
const grant = (patch: object = {}) => svc.updateBot(bot.id, { threads: { enabled: true, projects: [project.id], ...patch } });
const call = (action: string, p: object = {}) => handle(bot.id, { action, ...p }) as Promise<any>;
const settle = () => Bun.sleep(20);

beforeEach(() => {
  admitted.length = answers.length = steers.length = wakes.length = merged.length = 0;
  snapshots = [];
  discovered = [];
  steerFails = "";
  steerNotYet = 0;
  steerHandled = false;
  // A harness that can't take a steer yet is retried for a while; not for long here.
  Object.assign(threads.steerRetry, { ms: 60, every: 10 });
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
  expect(brief({ threads: undefined })).toBe("");
  const { manage } = await import("../server/bots/agent");
  manage(bot.id, { action: "update", name: "Juniper", threads: { enabled: true, projects: [project.id] } });
  expect(svc.fullBot(bot.id)!.threads?.enabled).toBe(false);
});

test("a thread started while a bot works in a group is recorded as that group's", async () => {
  const { bot: other } = svc.createBot({ name: "Sorrel" });
  const group = svc.createConversation({ kind: "group", name: "Crew", botIds: [bot.id, other.id] });
  const { setFocus } = await import("../server/bots/agent");
  setFocus(bot.id, group.id);
  try {
    await call("start", { project: project.name, prompt: "Tidy up" });
  } finally {
    setFocus(bot.id, undefined);
  }
  const chat = storage.getChat(admitted[0].threadId) as any;
  expect(chat.startedBy).toEqual({ bot: bot.id, conversation: group.id });
  expect(svc.conversationView(group.id)!.messages.findLast((m) => m.event?.text === "Started a thread")?.event?.threadId).toBe(chat.id);
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
  // Which bot started it and from where, for that conversation's Threads tab.
  expect(chat.startedBy).toEqual({ bot: bot.id, conversation: svc.directId(bot.id) });
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

test("a worktree thread starts from the branch's remote branch unless told not to, and the local branch never moves", async () => {
  const git = (cwd: string, args: string) => execSync(`git -c user.name=t -c user.email=t@t ${args}`, { cwd, stdio: "pipe" }).toString().trim();
  const origin = realpathSync(mkdtempSync(join(tmpdir(), "openbuild-bot-origin-")));
  const local = git(repo, "rev-parse main");
  try {
    git(origin, "init -q --bare -b main");
    git(repo, `remote add origin ${origin}`);
    git(repo, "push -q origin main");
    // Someone else pushes to main: origin is a commit ahead of the project's main.
    const other = join(origin, "clone");
    git(origin, `clone -q ${origin} ${other}`);
    git(other, "commit -q --allow-empty -m ahead");
    git(other, "push -q origin HEAD:main");
    const ahead = git(other, "rev-parse HEAD");

    const fromRemote = await call("start", { project: project.name, prompt: "Go", branch: "main" });
    expect(fromRemote.from).toBe("origin/main");
    expect(git((storage.getChat(admitted[0].threadId) as any).workspace.cwd, "rev-parse HEAD")).toBe(ahead);
    const fromLocal = await call("start", { project: project.name, prompt: "Go", branch: "main", remote: false });
    expect(fromLocal.from).toBe("main");
    expect(git((storage.getChat(admitted[1].threadId) as any).workspace.cwd, "rev-parse HEAD")).toBe(local);
    expect(git(repo, "rev-parse main")).toBe(local);
  } finally {
    execSync("git remote remove origin", { cwd: repo, stdio: "ignore" });
    rmSync(origin, { recursive: true, force: true });
  }
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
  expect((await call("options", { harness: "codex" })).remote_control).toMatchObject({ per_thread: false, openbuild_threads: expect.stringContaining("disabled"), machine_daemon_process: { status: "running" }, machine_remote_control: expect.stringContaining("remoteControl") });
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

/** Start a thread and have it ask these; returns what the bot follows. */
async function asking(...asks: ReturnType<typeof ask>[]) {
  await call("start", { project: project.name, prompt: "Go" });
  const { threadId, stream } = admitted.at(-1);
  const snapshot = snapshots.at(-1);
  const run = runs.get(stream.id)!;
  for (const question of asks) {
    snapshot.events.push(question);
    run.push(question);
  }
  await settle();
  /** The thread stops waiting on a question, as its worker reports it. */
  const asked = (id: string, answer?: string) => {
    const event = { t: "asked" as const, id, ...(answer !== undefined ? { answer } : {}) };
    snapshot.events.push(event);
    run.push(event);
  };
  return { threadId, run, snapshot, asked };
}
const answered = () => wakes.filter((w) => w.text.includes("isn't waiting on"));
const batch = (quiet: number, max = 1000) => Object.assign(threads.answerBatch, { quiet, max });

test("the bot hears what the user answered in the thread: the option, the words, or yes and no", async () => {
  batch(10);
  const { threadId, asked } = await asking(ask({ question: true, other: true }), ask({ id: "a2", title: "Name?", method: "input", options: undefined, question: true }), ask({ id: "a3", title: "Sure?", method: "confirm", options: undefined, question: true }));
  asked("a1", "Blue");
  await Bun.sleep(60);
  expect(answered()).toHaveLength(1);
  expect(answered()[0]).toMatchObject({ id: bot.id, kind: "note", conversationId: svc.directId(bot.id) });
  expect(answered()[0].text).toContain(`[${threadId.slice(0, 8)}]`);
  expect(answered()[0].text).toContain("“Which?” (question a1): the user answered it in the thread, choosing “Blue”.");
  expect(answered()[0].text).toContain("Don't answer it or ask the user about it again.");
  asked("a2", "Ada Lovelace");
  await Bun.sleep(60);
  expect(answered()[1].text).toContain("“Name?” (question a2): the user answered it in the thread, typing “Ada Lovelace”.");
  asked("a3", "No");
  await Bun.sleep(60);
  expect(answered()[2].text).toContain("“Sure?” (question a3): the user answered it in the thread: “No”.");
  expect(answered()).toHaveLength(3);
  // The bot can't answer what's settled.
  await expect(call("answer", { thread: threadId, question: "a1", answer: "Red" })).rejects.toThrow(/isn't waiting/);
});

test("answers given close together make one note, and a new question or the turn's end takes the rest along", async () => {
  batch(40);
  const { asked, run, snapshot } = await asking(ask({ question: true }), ask({ id: "a2", title: "Size?", options: ["S", "L"], other: true, question: true }), ask({ id: "a3", title: "Why?", method: "input", options: undefined, question: true }));
  asked("a1", "Red");
  await Bun.sleep(10);
  asked("a2", "Medium, please");
  await Bun.sleep(100);
  expect(answered()).toHaveLength(1);
  expect(answered()[0].text).toContain("isn't waiting on these anymore:\n- “Which?” (question a1): the user answered it in the thread, choosing “Red”.\n- “Size?” (question a2): the user answered it in the thread, typing “Medium, please”.\nDon't answer them");
  // An answer just before the next question comes with it, ahead of it.
  batch(5000, 5000);
  asked("a3", "Because");
  const next = ask({ id: "a4", title: "Colour?", question: true });
  snapshot.events.push(next);
  run.push(next);
  await settle();
  const note = wakes.find((w) => w.text.includes("Colour?"))!;
  expect(note.text.indexOf("typing “Because”")).toBeGreaterThan(-1);
  expect(note.text.indexOf("typing “Because”")).toBeLessThan(note.text.indexOf("is waiting on: Colour?"));
  // And one the turn ends on comes with its end, as does a question it stopped waiting on unanswered.
  asked("a4");
  snapshot.status = "done";
  run.end();
  await settle();
  const end = wakes.at(-1)!;
  expect(end.text).toContain("“Colour?” (question a4): it stopped waiting on it without an answer.");
  expect(end.text).toContain("finished its turn");
  expect(wakes.filter((w) => w.text.includes("Because"))).toHaveLength(1);
});

test("the bot's own answer isn't told back to it; another bot's is", async () => {
  batch(10);
  const { threadId, asked } = await asking(ask({ question: true }), ask({ id: "a2", title: "Size?", options: ["S", "L"], question: true }));
  await call("answer", { thread: threadId, question: "a1", answer: "red" });
  asked("a1", "Red");
  await Bun.sleep(60);
  expect(answered()).toEqual([]);
  const { bot: tracer } = svc.createBot({ name: "Tracer Bot" });
  svc.updateBot(tracer.id, { threads: { enabled: true, projects: [project.id], others: true } });
  await handle(tracer.id, { action: "answer", thread: threadId, question: "a2", answer: "L" });
  asked("a2", "L");
  await Bun.sleep(60);
  expect(answered()).toHaveLength(1);
  expect(answered()[0].id).toBe(bot.id);
  expect(answered()[0].text).toContain("“Size?” (question a2): Tracer answered it with openbuild, choosing “L”.");
  expect(wakes.some((w) => w.id === tracer.id && w.text.includes("isn't waiting"))).toBe(false);
});

test("a secret answer isn't repeated to the bot", async () => {
  batch(10);
  const { asked } = await asking(ask({ id: "k1", title: "API key?", method: "input", options: undefined, secret: true, question: true }));
  asked("k1", "sk-very-secret");
  await Bun.sleep(60);
  expect(answered()[0].text).toContain("“API key?” (question k1): the user answered it in the thread. It was secret, so it isn't shown here.");
  expect(JSON.stringify(wakes)).not.toContain("sk-very-secret");
});

test("a question card passing a thread's question on closes with the answer given in the thread", async () => {
  batch(10);
  const agent = await import("../server/bots/agent");
  const conversation = svc.directId(bot.id)!;
  const { threadId, asked } = await asking(ask({ question: true, other: true }), ask({ id: "a2", title: "Size?", options: ["S", "L"], other: true, question: true }), ask({ id: "a3", title: "Ok?", question: true }), ask({ id: "a4", title: "Mine?", question: true }));
  const card = async (question: string, options = ["Red", "Blue"]) => (await agent.askUser(bot.id, { title: "From the thread", options, thread: threadId.slice(0, 8), thread_question: question, conversation })) as { id: string; note: string };
  const cardOf = (id: string) => svc.conversationView(conversation)!.messages.find((m) => m.id === id)!.question!;
  const one = await card("a1");
  expect(one.note).toContain("If they answer in the thread instead, the card closes");
  expect(cardOf(one.id).thread).toEqual({ id: threadId, ask: "a1" });
  const two = await card("a2", ["S", "L"]);
  const three = await card("a3");
  const four = await card("a4");
  // An option the card offers shows picked; anything else shows as the words.
  asked("a1", "Blue");
  asked("a2", "Medium");
  await Bun.sleep(60);
  expect(cardOf(one.id)).toMatchObject({ answer: "B", closed: "answered" });
  expect(cardOf(two.id)).toMatchObject({ answer: "Medium", closed: "answered" });
  expect(answered()).toHaveLength(1);
  expect(answered()[0].text).toContain(`“Which?” (question a1): the user answered it in the thread, choosing “Blue”. Your question card [${one.id.slice(0, 8)}] for it is closed, showing that answer.`);
  expect(answered()[0].text).toContain(`Your question card [${two.id.slice(0, 8)}] for it is closed, showing that answer.`);
  // A closed card can't be answered in the chat.
  expect(() => svc.answerQuestion(conversation, one.id, "A")).toThrow(/settled in its thread/);
  // One the thread stops waiting on unanswered closes without an answer.
  asked("a3");
  await Bun.sleep(60);
  expect(cardOf(three.id).answer).toBeUndefined();
  expect(cardOf(three.id).closed).toBe("gone");
  expect(answered()[1].text).toContain(`it stopped waiting on it without an answer. Your question card [${three.id.slice(0, 8)}] for it is closed.`);
  // The bot answering itself closes its card too, but isn't told.
  await call("answer", { thread: threadId, question: "a4", answer: "Red" });
  asked("a4", "Red");
  await Bun.sleep(60);
  expect(cardOf(four.id)).toMatchObject({ answer: "A", closed: "answered" });
  expect(answered()).toHaveLength(2);
  // No card is posted for a question that's already settled.
  await expect(card("a1")).rejects.toThrow(/isn't waiting anymore/);
});

test("following a run again after a restart doesn't repeat answers the bot has heard about", async () => {
  batch(10);
  const db = await import("../server/bots/db");
  const { threadId } = await asking();
  // Read again from the start: a1 was told and settled before the restart, a2 only told.
  const run = new Run();
  runs.set("replayed", run);
  for (const event of [ask({ question: true }), { t: "asked" as const, id: "a1", answer: "Blue" }, ask({ id: "a2", title: "Size?", options: ["S", "L"], question: true }), { t: "asked" as const, id: "a2", answer: "L" }]) run.push(event);
  db.setValue("thread-watches", [{ runId: "replayed", threadId, botId: bot.id, conversationId: svc.directId(bot.id), told: ["a1", "a2"], settled: ["a1"] }]);
  threads.resumeWatches();
  await Bun.sleep(60);
  expect(answered()).toHaveLength(1);
  expect(answered()[0].text).toContain("“Size?” (question a2): the user answered it in the thread, choosing “L”.");
  expect(answered()[0].text).not.toContain("Which?");
  run.end();
  await settle();
  expect(wakes.filter((w) => w.text.includes("Size?"))).toHaveLength(1);
});

test("a card the user answered in the chat isn't closed over when the bot passes it on", async () => {
  batch(10);
  const agent = await import("../server/bots/agent");
  const conversation = svc.directId(bot.id)!;
  const { threadId, asked } = await asking(ask({ question: true }));
  const { id } = (await agent.askUser(bot.id, { title: "From the thread", options: ["Red", "Blue"], thread: threadId, thread_question: "a1", conversation })) as { id: string };
  svc.answerQuestion(conversation, id, "A");
  await call("answer", { thread: threadId, question: "a1", answer: "Red" });
  asked("a1", "Red");
  await Bun.sleep(60);
  const q = svc.conversationView(conversation)!.messages.find((m) => m.id === id)!.question!;
  expect(q.answer).toBe("A");
  expect(q.closed).toBeUndefined();
  expect(answered()).toEqual([]);
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

test("its status names a thread it waits on by its few words for what it does, or by the whole title", async () => {
  // A bot of its own, so other tests' threads aren't among what it waits on.
  const { bot: waiter } = svc.createBot({ name: "Wren" });
  svc.updateBot(waiter.id, { threads: { enabled: true, projects: [project.id] } });
  const as = (action: string, p: object) => handle(waiter.id, { action, ...p }) as Promise<any>;
  const title = "Tell the primary bot when a bot is deleted";
  const tool = (await import("../server/bots/extension")).default;
  const tools: any[] = [];
  tool({ on() {}, registerTool(t: any) { tools.push(t); } } as any);
  const openbuild = tools.find((t) => t.name === "openbuild");
  expect(openbuild.parameters.properties.about.description).toContain("Waiting on <about>");
  expect(openbuild.description).toContain("branch_name, about)");

  // Without its words, the whole title: no "dele…".
  await as("start", { project: project.name, prompt: "Notify the primary", title });
  const first = admitted.at(-1).threadId;
  expect(threads.threadWait(waiter.id)?.activity).toBe(`Waiting on ${title}`);

  // With them, from the moment it starts.
  await as("start", { project: project.name, prompt: "Notify the primary", title, about: "Waiting on the bot-deleted notice." });
  const second = admitted.at(-1).threadId;
  db.setValue("thread-watches", (db.getValue<any[]>("thread-watches") ?? []).filter((w) => w.threadId !== first));
  expect(threads.threadWait(waiter.id)?.activity).toBe("Waiting on the bot-deleted notice");

  // A later send can rename it, and one that says nothing keeps what it had.
  await as("send", { thread: second, text: "Also log it", about: "the deletion notice and log" });
  expect(threads.threadWait(waiter.id)?.activity).toBe("Waiting on the deletion notice and log");
  await as("send", { thread: second, text: "And test it" });
  expect(threads.threadWait(waiter.id)?.activity).toBe("Waiting on the deletion notice and log");
  // The first thread gets its words when a send gives them.
  await as("send", { thread: first, text: "Go on", about: "the first try" });
  expect(threads.threadWait(waiter.id)?.activity).toBe("Waiting on 2 threads");
  db.setValue("thread-watches", (db.getValue<any[]>("thread-watches") ?? []).filter((w) => w.threadId !== second));
  expect(threads.threadWait(waiter.id)?.activity).toBe("Waiting on the first try");
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
  // The full guidance comes with options; the context keeps only the essentials and the pointer.
  expect((await call("options")).guide).toBe(guide(svc.fullBot(bot.id)!));
  expect(brief(svc.fullBot(bot.id)!)).toContain("Start with action options");
  expect(brief(svc.fullBot(bot.id)!)).toContain("waits forever");
  expect(brief(svc.fullBot(bot.id)!).length).toBeLessThan(guide(svc.fullBot(bot.id)!).length / 2);
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

/** End the thread's running turn the way the worker would, and let the bot's follower see it. */
async function endTurn(threadId: string, how: "done" | "aborted" | "error" = "done") {
  const snapshot = snapshots.find((s) => s.threadId === threadId && s.status === "pending");
  Object.assign(snapshot, { status: how === "aborted" ? "aborted" : "done", endedAt: Date.now(), events: [...snapshot.events, { t: "text", v: "Done" }, ...(how === "error" ? [{ t: "error", message: "boom" }] : []), { t: "done", finish: how === "aborted" ? "aborted" : "stop" }] });
  runs.get(snapshot.id)!.end();
  await settle();
}

test("settings under a running turn are queued for its next one, and checked at once", async () => {
  grant({ choosePermission: true });
  const started = await call("start", { project: project.name, prompt: "Go", harness: "claude", permission: "safe" });
  const { threadId } = admitted[0];
  const before = JSON.stringify(storage.getChat(threadId));
  // A bad pick is refused now, not when the turn ends.
  await expect(call("send", { thread: started.thread, text: "Now", model: "nope" })).rejects.toThrow(/no model "nope"/);
  const sent = await call("send", { thread: started.thread, text: "Harder", model: "claude/two", effort: "high", permission: "yolo" });
  expect(sent).toMatchObject({ sent: false, queued: true, position: 1 });
  expect(sent.note).toMatch(/can only change for its next turn/);
  expect(steers).toEqual([]);
  expect(admitted.length).toBe(1);
  // The thread itself is untouched until the turn ends.
  expect(JSON.stringify(storage.getChat(threadId))).toBe(before);
  expect((await call("read", { thread: started.thread })).queued).toBe(1);

  await endTurn(threadId);
  expect(admitted.length).toBe(2);
  expect(admitted[1]).toMatchObject({ threadId, model: "claude/two", effort: "high", permission: "yolo" });
  expect(admitted[1].message).toContain("Harder");
  const note = wakes.find((w) => w.text.includes("finished its turn")).text;
  expect(note).toContain("Your queued message went in as its next turn");
  expect((await call("read", { thread: started.thread })).queued).toBeUndefined();
});

test("a steer the harness took is a steer, whatever it says about extensions", async () => {
  // Regression: handled: false is how harnesses report an ordinary steer, and was refused as busy.
  await call("start", { project: project.name, prompt: "Go" });
  const sent = await call("send", { thread: admitted[0].threadId, text: "Also" });
  expect(sent).toMatchObject({ sent: true, steered: true });
  expect(steers.length).toBe(1);
  expect(admitted.length).toBe(1);
});

/** The agent reads a steer: its turn logs it, as the harness reports it. */
function readSteer(threadId: string, steerId: string, text = "") {
  snapshots.find((s) => s.threadId === threadId && s.status === "pending")!.events.push({ t: "steer", id: steerId, text });
}

test("what a harness won't take is queued, and sent as the next turn, one a turn, in order", async () => {
  await call("start", { project: project.name, prompt: "Go" });
  const { threadId } = admitted[0];
  steerFails = "Pi hasn't started on this reply yet.";
  const first = await call("send", { thread: threadId, text: "First" });
  // Tried for a while, as the user would press Steer again, then said plainly.
  expect(first).toMatchObject({ sent: false, steered: false, queued: true, position: 1 });
  expect(first.cannot_steer).toBeUndefined();
  expect(first.reason).toMatch(/pi didn't take it into the running turn within/);
  expect(first.note).toMatch(/^Not steered: .*Pi hasn't started on this reply yet\./);
  expect(svc.conversationView(svc.directId(bot.id)!)!.messages.at(-1)?.event).toMatchObject({ text: "Queued a prompt for", threadId });
  // Settings always wait for the next turn, behind it.
  const second = await call("send", { thread: threadId, text: "Second", effort: "high" });
  expect(second).toMatchObject({ queued: true, position: 2 });
  // A plain message still steers now, as the user's Steer does with anything in the queue.
  steerFails = "";
  const third = await call("send", { thread: threadId, text: "Third" });
  expect(third).toMatchObject({ sent: true, steered: true });
  readSteer(threadId, steers[0][1], "Third");

  await endTurn(threadId);
  expect(admitted.length).toBe(2);
  expect(admitted[1].message).toContain("First");
  expect(admitted[1].message).not.toContain("Second");
  expect(wakes.at(-1).text).toMatch(/1 more wait/);
  const chat = storage.getChat(threadId) as any;
  expect(chat.messages.filter((m: any) => m.role === "user").map((m: any) => m.content)).toEqual(["Go", "First"]);
  // A queued message is the bot's, as its first was.
  expect(chat.messages.at(-2)).toMatchObject({ content: "First", sentBy: "Juniper", sentByBot: bot.id });

  await endTurn(threadId);
  expect(admitted.length).toBe(3);
  expect(admitted[2]).toMatchObject({ effort: "high" });
  expect(admitted[2].message).toContain("Second");
  await endTurn(threadId);
  expect(admitted.length).toBe(3);
});

test("a steer a Pi extension took as input isn't waited on or sent again", async () => {
  await call("start", { project: project.name, prompt: "Go" });
  const { threadId } = admitted[0];
  steerHandled = true;
  expect(await call("send", { thread: threadId, text: "/plan" })).toMatchObject({ sent: true, steered: true });
  expect((await call("read", { thread: threadId })).steering).toBeUndefined();
  await endTurn(threadId);
  expect(admitted.length).toBe(1);
});

test("a turn that ends while the harness can't take the steer yet gets it as its next turn", async () => {
  await call("start", { project: project.name, prompt: "Go" });
  const { threadId } = admitted[0];
  Object.assign(threads.steerRetry, { ms: 5000 });
  steerNotYet = 1_000;
  const sending = call("send", { thread: threadId, text: "Late" });
  await settle();
  await endTurn(threadId);
  const sent = await sending;
  expect(sent).toMatchObject({ steered: false, queued: true });
  expect(sent.reason).toMatch(/its turn ended before pi took the message/);
  // Nothing was left to send it, so send did.
  expect(admitted.length).toBe(2);
  expect(admitted[1].message).toContain("Late");
});

/** An image message in the bot's own conversation, for image_messages. */
function imageMessage() {
  const id = crypto.randomUUID();
  svc.postMessage(svc.directId(bot.id)!, { id, author: "me", at: Date.now(), text: "Screenshot", images: ["data:image/png;base64,aGVsbG8="] });
  return id;
}

for (const harness of HARNESSES) {
  const textOnly = !!HARNESS_STEERS[harness]!.textOnly;

  test(`${harness}: send steers a working thread as the user's Steer does`, async () => {
    const profile = { name: "Gal", bio: "Likes short answers", location: "", language: "" };
    storage.setValue("client-state", JSON.stringify({ state: { settings: { profile } } }));
    await call("start", { project: project.name, prompt: "Go", harness });
    const { threadId } = admitted[0];
    expect(admitted[0].runtime).toBe(harness);
    // Right after a turn starts its harness can't take a steer yet; send waits for it rather than queue.
    steerNotYet = 2;
    const sent = await call("send", { thread: threadId, text: "Also check the tests" });
    expect(sent).toMatchObject({ sent: true, steered: true });
    expect(sent.queued).toBeUndefined();
    // What the composer's Steer sends: the profile-wrapped prompt, and what the user sees as display.
    const { withProfileContext } = await import("../src/lib/profile");
    expect(steers.length).toBe(1);
    const [steeredThread, steerId, message, images, display, sender] = steers[0];
    expect(steeredThread).toBe(threadId);
    expect(message).toBe(withProfileContext("Also check the tests", profile));
    expect(images).toBeUndefined();
    expect(display).toBe("Also check the tests");
    // Its steer event names the bot, so the thread labels it as it's read, not after a reload.
    expect(sender).toEqual({ sentBy: "Juniper", sentByBot: bot.id });
    const reply = (storage.getChat(threadId) as any).messages.at(-1);
    expect(reply.steerSenders[steerId]).toEqual({ sentBy: "Juniper", sentByBot: bot.id });
    expect(svc.conversationView(svc.directId(bot.id)!)!.messages.at(-1)?.event).toMatchObject({ text: "Wrote a prompt in", threadId });

    // Shown as steering until the agent reads it; once read, the turn's end doesn't send it again.
    expect((await call("read", { thread: threadId })).steering).toBe(1);
    readSteer(threadId, steerId, "Also check the tests");
    expect((await call("read", { thread: threadId })).steering).toBeUndefined();
    await endTurn(threadId);
    expect(admitted.length).toBe(1);
    expect(wakes.at(-1).text).toContain("finished its turn");
    expect(wakes.at(-1).text).not.toContain("steered into");
  });

  test(`${harness}: a steer the agent hadn't read when the turn finished goes in as its next turn`, async () => {
    await call("start", { project: project.name, prompt: "Go", harness });
    const { threadId } = admitted[0];
    expect(await call("send", { thread: threadId, text: "One more thing" })).toMatchObject({ steered: true });
    await endTurn(threadId);
    expect(admitted.length).toBe(2);
    expect(admitted[1]).toMatchObject({ threadId, runtime: harness });
    expect(admitted[1].message).toContain("One more thing");
    const note = wakes.at(-1).text;
    expect(note).toContain("finished its turn");
    expect(note).toContain("hadn't been read by its agent when that turn ended, so it went in as its next turn");
    // Labeled as the bot's, as the steer would have been.
    expect((storage.getChat(threadId) as any).messages.at(-2)).toMatchObject({ role: "user", content: "One more thing", sentBy: "Juniper", sentByBot: bot.id });
    // The next turn ends with nothing left over.
    await endTurn(threadId);
    expect(admitted.length).toBe(2);
  });

  test(`${harness}: ${textOnly ? "images can't be steered, and send says so" : "images are steered with the message"}`, async () => {
    await call("start", { project: project.name, prompt: "Go", harness });
    const { threadId } = admitted[0];
    const sent = await call("send", { thread: threadId, text: "Look at this", image_messages: [imageMessage()] });
    if (!textOnly) {
      expect(sent).toMatchObject({ sent: true, steered: true });
      expect(steers[0][3]).toEqual([{ mimeType: "image/png", data: "aGVsbG8=" }]);
      // Saved on the reply, as the composer saves a steer's files.
      expect((storage.getChat(threadId) as any).messages.at(-1).steerFiles[steers[0][1]][0]).toMatchObject({ mime: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" });
      return;
    }
    // Not tried again and again, and not quietly queued: the result says it can't, and why.
    expect(sent).toMatchObject({ sent: false, steered: false, cannot_steer: true, queued: true, position: 1 });
    expect(sent.reason).toBe(`${harness} can't steer this message into a running turn: ${HARNESS_STEERS[harness]!.textOnly}`);
    expect(sent.note).toMatch(/^Not steered: /);
    expect(sent.note).toContain("without image_messages");
    expect(steers).toEqual([]);
    // Its words alone steer.
    expect(await call("send", { thread: threadId, text: "Look at the header" })).toMatchObject({ steered: true });
    readSteer(threadId, steers[0][1]);
    await endTurn(threadId);
    expect(admitted[1].message).toContain("Look at this");
    expect(admitted[1].images).toEqual([{ mimeType: "image/png", data: "aGVsbG8=" }]);
  });
}

for (const how of ["aborted", "error"] as const) {
  test(`an unread steer isn't sent after a turn that ${how === "aborted" ? "was stopped" : "failed"}, and the bot hears so`, async () => {
    await call("start", { project: project.name, prompt: "Go" });
    const { threadId } = admitted[0];
    await call("send", { thread: threadId, text: "Unread" });
    await endTurn(threadId, how);
    expect(admitted.length).toBe(1);
    const note = wakes.at(-1).text;
    expect(note).toContain(`hadn't been read by its agent when the thread ${how === "aborted" ? "was stopped" : "failed"}, so it wasn't sent`);
    expect(note).toContain("Unread");
    expect((await call("read", { thread: threadId })).queued).toBeUndefined();
  });
}

for (const how of ["aborted", "error"] as const) {
  test(`a queued message isn't sent after a turn that ${how === "aborted" ? "was stopped" : "failed"}, and the bot hears so`, async () => {
    await call("start", { project: project.name, prompt: "Go" });
    const { threadId } = admitted[0];
    steerFails = "This reply is stopping.";
    await call("send", { thread: threadId, text: "Later" });
    await endTurn(threadId, how);
    expect(admitted.length).toBe(1);
    const note = wakes.at(-1).text;
    expect(note).toContain(`wasn't sent, because the thread ${how === "aborted" ? "was stopped" : "failed"}`);
    expect(note).toContain("Later");
    expect((await call("read", { thread: threadId })).queued).toBeUndefined();
  });
}

test("a queued message waits for a turn someone else started first", async () => {
  await call("start", { project: project.name, prompt: "Go" });
  const { threadId } = admitted[0];
  steerFails = "Pi isn't working on this thread anymore.";
  await call("send", { thread: threadId, text: "Mine" });
  // The user's own queue starts a turn from the app before the bot's follower drains.
  const theirs = crypto.randomUUID();
  runs.set(theirs, new Run());
  snapshots.push({ id: theirs, threadId, kind: "run", status: "pending", events: [], startedAt: Date.now() });
  await endTurn(threadId);
  expect(admitted.length).toBe(1);
  expect((await call("read", { thread: threadId })).queued).toBe(1);
  // Its turn over, the bot's message goes in.
  await endTurn(threadId);
  expect(admitted.length).toBe(2);
  expect(admitted[1].message).toContain("Mine");
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

test("add_project checks where a path really lands: links, linked parents and the repository top can't reach OpenBuild's data", async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "openbuild-bot-links-")));
  const inData = join(dir, "inside-repo");
  mkdirSync(join(inData, "sub"), { recursive: true });
  execSync("git init -q -b main", { cwd: inData });
  try {
    // A link to the data folder itself, one to a folder in a repository there (which would be promoted to
    // the repository's top), and a linked parent a new folder or a clone would be made under.
    symlinkSync(dir, join(outside, "data"));
    symlinkSync(join(inData, "sub"), join(outside, "sub"));
    symlinkSync(join(outside, "nowhere"), join(outside, "broken"));
    const before = projects.listProjects().map((p) => p.id);
    const grants = svc.fullBot(bot.id)!.threads;
    const cases: [object, RegExp][] = [
      [{ path: join(outside, "data") }, /OpenBuild's own data folder/],
      [{ path: join(outside, "sub") }, /OpenBuild's own data folder/],
      [{ path: join(outside, "data", "made"), create: true }, /OpenBuild's own data folder/],
      [{ path: join(outside, "data", "cloned"), url: "https://example.invalid/repo.git" }, /OpenBuild's own data folder/],
      [{ path: join(outside, "broken", "app"), create: true }, /isn't there/],
    ];
    for (const [params, error] of cases) await expect(call("add_project", params)).rejects.toThrow(error);
    // Nothing saved, granted or made.
    expect(projects.listProjects().map((p) => p.id)).toEqual(before);
    expect(svc.fullBot(bot.id)!.threads).toEqual(grants);
    expect(existsSync(join(dir, "made"))).toBe(false);
    expect(existsSync(join(dir, "cloned"))).toBe(false);
    expect(existsSync(join(outside, "nowhere"))).toBe(false);
    // The same guard lets an ordinary linked project through, saved at its real root.
    const real = realpathSync(mkdtempSync(join(tmpdir(), "openbuild-bot-real-")));
    symlinkSync(real, join(outside, "real"));
    try {
      expect((await call("add_project", { path: join(outside, "real") })).project.path).toBe(real);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  } finally {
    for (const p of projects.listProjects()) if (p.id !== project.id) projects.removeProject(p.id);
    grant();
    rmSync(outside, { recursive: true, force: true });
    rmSync(inData, { recursive: true, force: true });
  }
});

const { threadContext, ago } = threads;
const reply = (usage?: object, over: object = {}) => ({ id: crypto.randomUUID(), role: "assistant" as const, content: "ok", createdAt: 0, status: "done" as const, model: { plan: "pi" as const, id: "acme/one" }, ...(usage ? { usage } : {}), ...over });
const asked = { id: "u", role: "user" as const, content: "Go", createdAt: 0 };

test("a thread's context is what its harness measured, and unknown otherwise", () => {
  const ctx = (messages: any[], runtime: any = "pi") => threadContext({ runtime, messages: [asked, ...messages] });
  expect(ctx([reply({ contextTokens: 91_000, contextWindow: 200_000 })])).toEqual({ used_tokens: 91_000, window_tokens: 200_000, percent: 46, free_tokens: 109_000 });
  // The numbers, and no verdict: the bot weighs them against the task.
  expect(Object.keys(ctx([reply({ contextTokens: 172_000, contextWindow: 200_000 })])).sort()).toEqual(["free_tokens", "percent", "used_tokens", "window_tokens"]);
  expect(ctx([reply({ contextTokens: 250_000, contextWindow: 200_000 })])).toMatchObject({ percent: 100, free_tokens: 0 });
  // The latest measurement wins, and a reply still streaming without one doesn't hide it.
  expect(ctx([reply({ contextTokens: 10_000, contextWindow: 200_000 }), reply({ contextTokens: 50_000, contextWindow: 200_000 }), reply(undefined, { status: "streaming" })]).used_tokens).toBe(50_000);
  // A stopped Claude reply has no window of its own: the same model's earlier one had it.
  expect(ctx([reply({ contextTokens: 10_000, contextWindow: 200_000 }), reply({ contextTokens: 30_000 }, { status: "stopped" })], "claude")).toMatchObject({ used_tokens: 30_000, window_tokens: 200_000, percent: 15 });
  // No window at all: the tokens, and no percentage made up from a nominal limit.
  const noWindow = ctx([reply({ contextTokens: 30_000 })], "codex");
  expect(noWindow).toMatchObject({ used_tokens: 30_000 });
  expect(noWindow.percent).toBeUndefined();
  expect(noWindow.unknown).toMatch(/window size/);
  // Just compacted: Pi knows the window but not what's in it.
  const compacted = ctx([reply({ contextTokens: 190_000, contextWindow: 200_000 }), reply({ contextWindow: 200_000 })]);
  expect(compacted).toMatchObject({ window_tokens: 200_000 });
  expect(compacted.used_tokens).toBeUndefined();
  expect(compacted.unknown).toMatch(/compacted/);
  // Another model's numbers aren't this model's context.
  expect(ctx([reply({ contextTokens: 190_000, contextWindow: 200_000 }), reply(undefined, { model: { plan: "pi", id: "acme/two" } })]).unknown).toMatch(/model changed/);
  expect(ctx([reply(undefined, { status: "error" })]).unknown).toMatch(/didn't measure/);
  // Harnesses that only count tokens spent, and threads with no reply yet.
  expect(ctx([reply({ input: 5000, output: 200 })], "cursor")).toEqual({ unknown: "cursor doesn't report how full its context is." });
  expect(ctx([reply(undefined, { status: "streaming" })]).unknown).toMatch(/No reply has measured it yet/);
  expect(ctx([]).unknown).toMatch(/No reply has measured it yet/);
});

test("list, read and send show what a bot weighs before reusing a thread", async () => {
  const started = await call("start", { project: project.name, prompt: "Go", title: "Measured", branch_name: "measured" });
  const { threadId, stream } = admitted[0];
  const listed = async () => (await call("list")).threads.find((t: any) => t.thread === started.thread);
  expect((await call("read", { thread: threadId })).context).toEqual({ unknown: "No reply has measured it yet." });
  expect((await listed()).context).toEqual({ unknown: "No reply has measured it yet." });
  snapshots[0] = { ...snapshots[0], status: "done", endedAt: Date.now(), events: [{ t: "text", v: "Done" }, { t: "done", finish: "stop", usage: { contextTokens: 50_000, contextWindow: 200_000 } }] };
  runs.get(stream.id)!.end();
  await settle();
  // A pull request that merged three days ago, on a thread last active then.
  const then = Date.now() - 3 * 24 * 60 * 60_000;
  snapshots[0].endedAt = then;
  storage.putChat({ ...(storage.getChat(threadId) as any), updatedAt: then, pullRequest: { number: 7, url: "https://example.invalid/pull/7", state: "merged", checks: "passing", checkedAt: then } });
  const facts = { title: "Measured", branch: "openbuild/measured", last_active: "3 days ago", context: { used_tokens: 50_000, window_tokens: 200_000, percent: 25, free_tokens: 150_000 } };
  expect(await call("read", { thread: threadId })).toMatchObject({ ...facts, pull_request: { number: 7, state: "merged" } });
  // send says where the thread stood, whatever its fill, so the next choice starts from facts.
  const sent = await call("send", { thread: threadId, text: "More" });
  expect(sent.sent).toBe(true);
  expect(sent.thread).toEqual({ thread: started.thread, ...facts, pull_request: { number: 7, state: "merged", checks: "passing" } });
  // list carries the same, with the thread active again.
  expect(await listed()).toMatchObject({ ...facts, last_active: "just now", pull_request: { number: 7, state: "merged", checks: "passing" } });
  // Steered into the working thread, the same.
  const steered = await call("send", { thread: threadId, text: "One more" });
  expect(steered.steered).toBe(true);
  expect(steered.thread).toMatchObject({ thread: started.thread, title: "Measured", context: facts.context });
});

test("send shows the context even when nothing measured it", async () => {
  const started = await call("start", { project: project.name, prompt: "Go", harness: "cursor" });
  finish();
  const sent = await call("send", { thread: started.thread, text: "More" });
  expect(sent.thread.context).toEqual({ unknown: "cursor doesn't report how full its context is." });
  expect(sent.thread.pull_request).toBeUndefined();
});

test("how recent a thread is reads as a person would say it", () => {
  const now = 1_000_000_000_000;
  const minute = 60_000;
  expect([0, 59_000, minute, 5 * minute, 60 * minute, 23 * 60 * minute, 24 * 60 * minute, 9 * 24 * 60 * minute].map((d) => ago(now - d, now))).toEqual(["just now", "just now", "1 minute ago", "5 minutes ago", "1 hour ago", "23 hours ago", "1 day ago", "9 days ago"]);
  expect(ago(now + minute, now)).toBe("just now");
});

test("the guide and the tool's description give a way to judge, with numbers as rough guides", async () => {
  const text = guide(svc.fullBot(bot.id)!);
  const source = await Bun.file(join(import.meta.dir, "../server/bots/extension.ts")).text();
  const description = source.split("\n").find((line) => line.includes("Run coding agents in the user's OpenBuild"))!;
  for (const words of [text, description]) {
    // What to weigh: relatedness, size against room, help or distraction, and a finished pull request.
    for (const factor of [/how related/i, /same files or feature/, /follow-up on its pull request/, /how big/i, /room left/, /distract/, /merged or closed/, /rough guides/, /unknown/]) expect(words).toMatch(factor);
    // Where to look.
    for (const field of ["title", "branch", "pull_request", "last_active", "context", "free_tokens", "send result"]) expect(words).toContain(field);
    // No hard cut-offs.
    expect(words).not.toMatch(/\d+% or more|under \d+%/i);
  }
  expect(text).toContain("decide for that task");
});

test("a bot the user deletes leaves its open threads, what they wait on and its unsent messages to the primary", async () => {
  expect(svc.fullBot(bot.id)!.primary).toBe(true);
  const { bot: helper } = svc.createBot({ name: "Sorrel" });
  svc.updateBot(helper.id, { threads: { enabled: true, projects: [project.id] } });
  const as = (action: string, p: object = {}) => handle(helper.id, { action, ...p }) as Promise<any>;
  // Working, and waiting on a question; with a message queued behind its turn.
  await as("start", { project: project.name, prompt: "Fix the login", title: "Fix login" });
  const working = admitted[0].threadId;
  snapshots[0].events.push(ask({ id: "q1", title: "Which branch?" }));
  expect((await as("send", { thread: working, text: "Then run the tests", effort: "high" })).queued).toBe(true);
  // Idle, with a pull request.
  await as("start", { project: project.name, prompt: "Write docs", title: "Docs" });
  const idle = admitted[1].threadId;
  snapshots[1].status = "done";
  storage.putChat({ ...(storage.getChat(idle) as any), pullRequest: { number: 12, url: "https://example.com/pull/12", state: "open" } } as never);
  // Closed: nothing left to pick up.
  await as("start", { project: project.name, prompt: "Old work", title: "Old" });
  const closed = admitted[2].threadId;
  snapshots[2].status = "done";
  storage.putChat({ ...(storage.getChat(closed) as any), archived: true } as never);
  // Someone else's thread it isn't following.
  const theirs = { id: crypto.randomUUID(), title: "Theirs", workspace: { projectId: project.id, projectName: project.name, cwd: repo }, createdAt: 1, updatedAt: 1, messages: [] };
  storage.putChat(theirs as never);

  const left = await threads.leftBy(helper.id);
  const short = (id: string) => id.slice(0, 8);
  expect(left.threads.sort()).toEqual([
    `- “Docs” [${short(idle)}] in ${project.name}: started by it; idle; pull request #12 is open: https://example.com/pull/12.`,
    `- “Fix login” [${short(working)}] in ${project.name}: started by it; working, waiting on a question; a message it queued for the thread won't be sent.`,
  ]);
  expect(left.questions).toEqual([`- Thread “Fix login” [${short(working)}] is waiting on “Which branch?” (question q1). Answer it with openbuild action answer, or ask the user.`]);

  // Deleted by the user: the primary is woken with them.
  const told: any[] = [];
  svc.setHooks({ wake: (id, w) => told.push({ id, ...w }), stop() {}, leftThreads: threads.leftBy });
  try {
    await svc.deleteBot(helper.id, { by: "me" });
  } finally {
    svc.setHooks({ wake() {}, stop() {} });
  }
  expect(told).toHaveLength(1);
  expect(told[0]).toMatchObject({ id: bot.id, kind: "note", conversationId: svc.directId(bot.id) });
  expect(told[0].text).toContain(`Open coding threads it started or was following, still in OpenBuild (openbuild action read, by the thread id in brackets, if you have the project):\n`);
  for (const line of [...left.threads, ...left.questions]) expect(told[0].text).toContain(line);
  expect(told[0].text).not.toContain(short(closed));
  expect(told[0].text).not.toContain(short(theirs.id));
});
