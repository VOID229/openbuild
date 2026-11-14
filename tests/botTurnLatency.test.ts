// What kept a bot's turn slow, and must not come back (scripts/bot-turn-timeline.ts measures the
// real thing): a second Pi started only to list models before the bot's own, container engines
// probed in front of the first model request, a reply held back as if it were being typed, a model
// request spent on loading the shell, and one more after the last message only to end the turn.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { breakdown, describe as describeTurn, type Turn } from "../scripts/bot-turn-timeline";
import openbots, { DONE, ending, posted, sentBrief } from "../server/bots/extension";
import { declarationSizes, PRELOAD_BUDGET_CHARS, preloadWithStarter, STARTER_TOOLS } from "../server/bots/toolPreload";
import { spawnScript } from "./spawnScript";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const times = (n: number) => Array.from({ length: n }, (_, i) => NOW - i * 3_600_000);

// ------------------------------------------------------------------ the shell is there from the start

test("every bot's Pi starts with the shell, and its usual tools fill what's left of the budget", () => {
  const sizes = declarationSizes();
  expect(STARTER_TOOLS).toEqual(["bash"]);
  // A new bot, and one whose tools aren't a habit yet.
  expect(preloadWithStarter(undefined, NOW)).toEqual(["bash"]);
  expect(preloadWithStarter({ todo: times(1) }, NOW)).toEqual(["bash"]);
  // Its usual tools come after, most used first; the shell isn't listed twice.
  expect(preloadWithStarter({ bash: times(5), use_app: times(9), routine: times(2) }, NOW)).toEqual(["bash", "use_app", "routine"]);
  // The starter counts toward the budget: a tool that only fit without it waits to be loaded.
  const tight = sizes.bash! + sizes.routine! + 10;
  expect(preloadWithStarter({ routine: times(3), todo: times(2) }, NOW, sizes, tight)).toEqual(["bash", "routine"]);
  const all = preloadWithStarter(Object.fromEntries(Object.keys(sizes).map((name) => [name, times(4)])), NOW);
  expect(all.reduce((n, name) => n + sizes[name]!, 0)).toBeLessThanOrEqual(PRELOAD_BUDGET_CHARS);
  // The shell costs under 300 tokens a request, at the repo's 4.28 characters a token.
  expect(sizes.bash! / 4.28).toBeLessThan(300);
});

// ------------------------------------------------------------------ a turn ends on its last message

/** The extension's tools as Pi would hold them, calling `service` instead of the bots socket. */
function extensionTools() {
  const tools = new Map<string, { parameters: { properties: Record<string, unknown> }; description: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ terminate?: boolean; details?: unknown; isError?: boolean }> }>();
  openbots({ on() {}, registerTool: (t: { name: string }) => tools.set(t.name, t as never) });
  return tools;
}

test("send_message's done ends the turn only when the message went out; a question always does", async () => {
  const sent = { content: [], details: { id: "m1", conversation: "c1" } };
  const held = { content: [], details: { sent: false, note: "Not sent yet" } };
  expect(posted(sent)).toBe(true);
  expect(posted(held)).toBe(false);
  expect(posted({ details: null })).toBe(false);
  const tool = (result: { details?: unknown; terminate?: boolean }, ends: (p: Record<string, unknown>) => boolean) => ending({ name: "t", execute: async (_id: string, _params: Record<string, unknown>) => result }, ends);
  const done = (p: Record<string, unknown>) => p.done === true;
  // Marked done and posted: Pi is told to stop after this step.
  expect(await tool(sent, done).execute("1", { text: "All set.", done: true })).toEqual({ ...sent, terminate: true });
  // Not marked, or marked but held back because something new arrived: the model is asked again, as before.
  expect(await tool(sent, done).execute("1", { text: "On it." })).toEqual(sent);
  expect(await tool(sent, done).execute("1", { text: "On it.", done: false })).toEqual(sent);
  expect(await tool(held, done).execute("1", { text: "All set.", done: true })).toEqual(held);
  // A failed call is never the end of anything.
  expect(await tool({ details: null }, () => true).execute("1", {})).toEqual({ details: null });

  // The real tools: send_message declares done, and says when not to use it; question needs no flag.
  const tools = extensionTools();
  const send = tools.get("send_message")!;
  expect(Object.keys(send.parameters.properties)).toContain("done");
  expect((send.parameters.properties.done as { description: string }).description).toBe(DONE);
  expect(DONE).toMatch(/only on the last message/);
  expect(DONE).toMatch(/Leave it out/);
  expect(Object.keys(tools.get("question")!.parameters.properties)).not.toContain("done");
  // No bots service behind the socket: the call fails, and a failure ends nothing.
  process.env.OPENBOTS_SOCKET = join(tmpdir(), `openbuild-no-such-socket-${process.pid}`);
  const failed = await send.execute("1", { text: "hi", done: true });
  expect(failed.isError).toBe(true);
  expect(failed.terminate).toBeUndefined();
});

test("what every request carries is said once: a short status rule per tool, and a sent message's short id", () => {
  const tools = extensionTools();
  // The status line's rule is in the bot's prompt; each tool that takes one repeats only what the call needs.
  const withStatus = [...tools.values()].filter((t) => "status" in t.parameters.properties);
  expect(withStatus.length).toBeGreaterThan(10);
  for (const t of withStatus) {
    const rule = (t.parameters.properties.status as { description: string }).description;
    expect(rule).toMatch(/^Required, and written first/);
    expect(rule.length).toBeLessThan(240);
  }
  // A sent message comes back as the id later references use, not as JSON around the whole one.
  expect(sentBrief({ id: "2874dff8-e549-45d9-ac3b-614739a3bc01", conversation: "f865f9a5" })).toBe("Sent as [2874dff8] in conversation f865f9a5.");
  // One that was held back keeps everything it was told.
  expect(sentBrief({ sent: false, new: "[abc] Sam: wait", note: "Not sent yet" })).toBeUndefined();
  expect(sentBrief(undefined)).toBeUndefined();
});

// ------------------------------------------------------------------ the service: replies, the note, windows

test("the first bubble of a reply isn't held; the machines note asks no container engine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-turn-latency-"));
  try {
    // Engines that say when they were asked: `podman info` took two seconds in front of a turn.
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const name of ["podman", "docker"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$ENGINE_LOG"\nexit 1\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const { code, stderr: err } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import { existsSync, readFileSync } from 'node:fs';
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const agent = await import('./server/bots/agent.ts');
      const runner = await import('./server/bots/runner.ts');
      const machines = await import('./server/bots/machines.ts');
      svc.setHooks({ wake() {}, stop() {} });
      svc.updateSettings({ onboarding: 'done' });
      const { bot, conversationId } = svc.createBot({ name: 'Alpha' });
      const here = conversationId.slice(0, 8);

      // A bubble waits only on the one before it.
      const T = 1_000_000;
      a.equal(agent.bubbleHold('hello there', undefined, T), 0);
      a.equal(agent.bubbleHold('hello there', T, T), agent.typingTime('hello there'));
      a.equal(agent.bubbleHold('hello there', T - 300, T), agent.typingTime('hello there') - 300);
      a.equal(agent.bubbleHold('hello there', T - 60_000, T), 0);

      // The chat shows it typing, as it does from the moment the model starts writing the call.
      svc.setTyping(conversationId, bot.id, true);
      const first = 'A first bubble that would have taken someone the better part of two seconds to type out.';
      a.ok(agent.typingTime(first) > 1500);
      let started = Date.now();
      const one = await agent.sendMessage(bot.id, { text: first, conversation: here });
      const firstMs = Date.now() - started;
      a.ok(one.id, JSON.stringify(one));
      a.ok(firstMs < 700, 'the first bubble was held ' + firstMs + ' ms');
      // One written right behind it still lands a moment later, not in the same instant.
      const second = 'And one right behind it.';
      started = Date.now();
      await agent.sendMessage(bot.id, { text: second, conversation: here });
      const secondMs = Date.now() - started;
      a.ok(secondMs >= agent.typingTime(second) - 400, 'the second bubble landed after ' + secondMs + ' ms');
      a.deepEqual(db.messages(conversationId, 5).filter((r) => r.message.author === bot.id).map((r) => r.message.text), [first, second]);

      // The bots' context lists this server without asking podman or docker anything...
      const asked = () => (existsSync(process.env.ENGINE_LOG) ? readFileSync(process.env.ENGINE_LOG, 'utf8') : '');
      const note = await machines.machinesNote();
      a.match(note, /\\(this server, used when you don't name one\\): files, terminal, browser; host \\(unisolated\\)\\./);
      a.equal(asked(), '');
      a.equal((await machines.machines({ engines: false }))[0].engines, undefined);
      a.equal(asked(), '');
      // ...and Settings, which shows the engines, still does.
      a.deepEqual((await machines.machines())[0].engines, []);
      a.match(asked(), /podman info/);

      // A bot's context carries the guide to a tool only once it has the tool: before that, a line saying it's there.
      const context = async (tools) => (await agent.seams.handle(bot.id, 'context', tools ? { tools } : {})).sections;
      const core = ['send_message', 'react', 'question', 'memory', 'search', 'load_tools', 'bash'];
      const HOW_APPS = /Before a tool's first use, look it up with apps/;
      a.match((await context()).openbots_machines, HOW_APPS, 'a Pi that names no tools gets everything, as before');
      a.doesNotMatch((await context(core)).openbots_machines, HOW_APPS);
      a.match((await context(core)).openbots_machines, /No apps are connected yet/);
      a.match((await context([...core, 'use_app'])).openbots_machines, HOW_APPS);
      a.match((await context([...core, 'apps'])).openbots_machines, HOW_APPS);
      // Web search with a provider set up: which providers, in a line; each one's guide comes with the tool.
      a.match((await context(core)).openbots_machines, /Web search isn't set up/);
      svc.updateSettings({ searxng: ['http://127.0.0.1:9/'] });
      const lean = (await context(core)).openbots_machines;
      const full = (await context([...core, 'bot_web_search'])).openbots_machines;
      a.match(lean, /You can search the web with bot_web_search \\(searxng\\)/);
      a.doesNotMatch(lean, /Your providers:/);
      a.match(full, /Your providers:\\n- searxng: /);
      a.match(full, /never make up a URL/);
      a.ok(full.length - lean.length > 800, 'the guide is ' + (full.length - lean.length) + ' characters');
      // Loading the tool hands the guide over, with the result of load_tools.
      a.equal(await agent.seams.handle(bot.id, 'tool_notes', { names: ['bash', 'todo'] }), '');
      a.match(await agent.seams.handle(bot.id, 'tool_notes', { names: ['bot_web_search'] }), /Your providers:\\n- searxng: /);
      a.match(await agent.seams.handle(bot.id, 'tool_notes', { names: ['apps'] }), HOW_APPS);
      // One machine: no word on choosing between several.
      a.doesNotMatch(lean, /Machines you can reach/);
      a.match(lean, /Your computer is on this server/);
      // The rules for polls go to a bot that's in a group, where polls are.
      a.doesNotMatch(agent.contextFor(bot.id), /poll asks everyone/);
      svc.createConversation({ kind: 'group', name: 'Team', botIds: [bot.id, svc.createBot({ name: 'Beta' }).bot.id] });
      a.match(agent.contextFor(bot.id), /In a group, poll asks everyone/);

      // Context windows are kept between Pi starts: learnt ones are added, and none is forgotten.
      a.deepEqual(runner.knownWindows(), []);
      const big = { provider: 'p', id: 'big', contextWindow: 1_000_000 };
      const learnt = runner.mergeWindows([], [big, { provider: 'p', id: 'unsized' }, { provider: 'p', id: 'zero', contextWindow: 0 }, { id: 'nobody', contextWindow: 5 }]);
      a.deepEqual(learnt, [big]);
      a.deepEqual(runner.mergeWindows(learnt, [{ provider: 'a', id: 'small', contextWindow: 200_000 }]), [{ provider: 'a', id: 'small', contextWindow: 200_000 }, big]);
      a.deepEqual(runner.mergeWindows(learnt, [{ ...big, contextWindow: 400_000 }]), [{ ...big, contextWindow: 400_000 }]);

      // A bot starts with the shell; a chat that can only chat starts with nothing.
      a.deepEqual(runner.preloadFor(bot.id), ['bash']);
      a.deepEqual(runner.preloadFor(bot.id, 'friend:nobody'), []);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: join(dir, "data"), PI_CODING_AGENT_DIR: join(dir, "pi"), PI_BIN: join(dir, "no-pi"), ENGINE_LOG: join(dir, "engines.log"), PATH: `${bin}:${process.env.PATH ?? ""}`, OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json") });
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

// ------------------------------------------------------------------ the runner: one Pi, no probe

/** A stand-in for `pi --mode rpc`: it answers the runner's commands, replies "pong from pi" to a prompt, and logs each launch and prompt. */
const FAKE_PI = `
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.PI_LAUNCH_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  const ok = (data) => out({ type: "response", id: cmd.id, command: cmd.type, success: true, data });
  if (cmd.type === "get_state") return ok({ model: { provider: "mock", id: "big" } });
  if (cmd.type === "get_available_thinking_levels") return ok({ levels: [] });
  if (cmd.type === "get_available_models") return ok({ models: [{ provider: "mock", id: "big", contextWindow: 1000000 }] });
  if (cmd.type === "clear_queue") return ok({ steering: [], followUp: [] });
  if (cmd.type !== "prompt") return ok({});
  appendFileSync(process.env.PI_PROMPT_LOG, JSON.stringify(cmd.message) + "\\n");
  ok({});
  out({ type: "agent_start" });
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "pong from pi" } });
  // A session already past the size at which stale compaction settings are worth a restart.
  out({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: Number(process.env.PI_PROMPT_TOKENS), output: 2, cacheRead: 0, cacheWrite: 0 }, content: [{ type: "text", text: "pong from pi" }] } });
  out({ type: "agent_settled" });
});
`;

test("a turn starts one Pi, never one to list models first, and the next Pi gets the windows it learnt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-turn-latency-pi-"));
  try {
    writeFileSync(join(dir, "pi.cjs"), FAKE_PI);
    writeFileSync(join(dir, "pi"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, "pi.cjs"))} "$@"\n`);
    chmodSync(join(dir, "pi"), 0o755);
    const { code, stderr: err } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import { readFileSync } from 'node:fs';
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const { COMPACT_AT } = await import('./server/bots/sessionPolicy.ts');
      svc.setHooks({ wake: runner.wake, stop: runner.stop, pendingAssignments: runner.pendingAssignments, unseen: runner.unseen, userWoke: runner.userWoke, halt: runner.halt, background: runner.background });
      svc.updateSettings({ onboarding: 'done', defaultModel: 'mock/big' });
      const { bot, conversationId } = svc.createBot({ name: 'Alpha' });
      const until = async (check, what) => { for (let i = 0; i < 1500 && !check(); i++) await Bun.sleep(10); a.ok(check(), what); };
      const launches = () => readFileSync(process.env.PI_LAUNCH_LOG, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
      const settings = () => JSON.parse(readFileSync(process.env.OPENCHAT_DATA_DIR + '/bots/minds/' + bot.id + '/.pi/settings.json', 'utf8'));
      const replies = () => db.messages(conversationId, 20).filter((r) => r.message.author === bot.id && !r.message.event).length;
      const ask = async (text, n) => {
        svc.postMessage(conversationId, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text });
        await until(() => replies() === n && !runner.busy(bot.id), 'no reply to ' + text);
      };

      // The first turn on an installation: no model's window is known, and nothing waits to find out.
      await ask('hello', 1);
      a.equal(launches().length, 1, JSON.stringify(launches()));
      a.ok(!launches().some((args) => args.includes('--no-session')), 'a Pi was started only to list models');
      a.ok(launches()[0].includes('--session-dir'));
      a.deepEqual(settings().compaction.modelOverrides, {});
      a.equal(settings().steeringMode, 'all');
      // After the turn the bot's own Pi was asked, and the answer is kept.
      await until(() => runner.knownWindows().length === 1, 'the windows were never learnt');
      a.deepEqual(runner.knownWindows(), [{ provider: 'mock', id: 'big', contextWindow: 1000000 }]);

      // Its session is past half the compaction point on settings from before the window was known:
      // it starts over between turns, on the right ones.
      await ask('again', 2);
      a.equal(launches().length, 2, JSON.stringify(launches()));
      a.deepEqual(settings().compaction.modelOverrides['mock/big'], { reserveTokens: 1000000 - COMPACT_AT, keepRecentTokens: 8000 });
      // Now its settings are current, and it stays.
      await ask('and again', 3);
      a.equal(launches().length, 2);
      a.ok(!launches().some((args) => args.includes('--no-session')));
      runner.stop(bot.id);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: join(dir, "data"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_BIN: join(dir, "pi"), PI_LAUNCH_LOG: join(dir, "launches.jsonl"), PI_PROMPT_LOG: join(dir, "prompts.jsonl"), PI_PROMPT_TOKENS: "70000", OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json") });
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("a small session keeps its Pi when the windows are learnt: its next start has them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-turn-latency-small-"));
  try {
    writeFileSync(join(dir, "pi.cjs"), FAKE_PI);
    writeFileSync(join(dir, "pi"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, "pi.cjs"))} "$@"\n`);
    chmodSync(join(dir, "pi"), 0o755);
    const { code, stderr: err } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import { readFileSync } from 'node:fs';
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      svc.setHooks({ wake: runner.wake, stop: runner.stop, pendingAssignments: runner.pendingAssignments, unseen: runner.unseen, userWoke: runner.userWoke, halt: runner.halt, background: runner.background });
      svc.updateSettings({ onboarding: 'done', defaultModel: 'mock/big' });
      const { bot, conversationId } = svc.createBot({ name: 'Alpha' });
      const until = async (check, what) => { for (let i = 0; i < 1500 && !check(); i++) await Bun.sleep(10); a.ok(check(), what); };
      const launches = () => readFileSync(process.env.PI_LAUNCH_LOG, 'utf8').split('\\n').filter(Boolean).length;
      const replies = () => db.messages(conversationId, 20).filter((r) => r.message.author === bot.id && !r.message.event).length;
      const ask = async (text, n) => {
        svc.postMessage(conversationId, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text });
        await until(() => replies() === n && !runner.busy(bot.id), 'no reply to ' + text);
      };
      await ask('hello', 1);
      await until(() => runner.knownWindows().length === 1, 'the windows were never learnt');
      await ask('again', 2);
      a.equal(launches(), 1);

      // What it said itself is in its session already: the next prompt shows it the user's new message, not its own words back.
      const prompts = readFileSync(process.env.PI_PROMPT_LOG, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
      a.equal(prompts.length, 2);
      a.match(prompts[0], /\\] User: hello/);
      a.match(prompts[1], /\\] User: again/);
      a.doesNotMatch(prompts[1], /pong from pi/);
      a.doesNotMatch(prompts[1], /already seen/);
      // And the turn can end on its last message: the prompt says how.
      a.match(prompts[1], /Use send_message to reply \\(one call per bubble, in this conversation unless you name another; done true on the last one ends the turn\\)/);
      // A reaction on it is news: the line comes back, with the reaction.
      const mine = db.messages(conversationId, 20).find((r) => r.message.author === bot.id && !r.message.event);
      svc.toggleReaction(conversationId, mine.message.id, '👍', 'me');
      await until(() => prompts.length < readFileSync(process.env.PI_PROMPT_LOG, 'utf8').split('\\n').filter(Boolean).length && !runner.busy(bot.id), 'the reaction woke nobody');
      const third = JSON.parse(readFileSync(process.env.PI_PROMPT_LOG, 'utf8').split('\\n').filter(Boolean).at(-1));
      a.match(third, /pong from pi\\n  reactions: #1 👍 from User/);
      runner.stop(bot.id);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: join(dir, "data"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_BIN: join(dir, "pi"), PI_LAUNCH_LOG: join(dir, "launches.jsonl"), PI_PROMPT_LOG: join(dir, "prompts.jsonl"), PI_PROMPT_TOKENS: "9000", OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json") });
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

// ------------------------------------------------------------------ the timeline script's arithmetic

test("a timeline's buckets add up to the turn, and name where each request's time went", () => {
  const request = (start: number, end: number, tools: string[], bridge?: Partial<NonNullable<Turn["requests"][number]["bridge"]>>): Turn["requests"][number] => ({
    gapMs: 100, firstTokenMs: 1_000, totalMs: end - start, start, end, input: 100, cacheRead: 8_000, cacheWrite: 200, output: 50, stop: tools.length ? "toolUse" : "stop", tools,
    ...(bridge ? { bridge: { continuation: false, standby: false, ...bridge } } : {}),
  });
  const turn: Turn = {
    label: "cold", routeMs: 20, wakeMs: 10, spawns: [{ what: "pi (bot)", at: 20, ms: 9_000 }], setup: [{ name: "get_state (pi#1)", at: 30, ms: 1_200 }], promptSentMs: 1_300, contextMs: 40, agentStartMs: 1_350,
    requests: [
      request(1_300, 4_300, ["bash"], { spawnMs: 300, apiCallMs: 1_000, headersMs: 1_500, firstBytesMs: 1_500, apiMs: 2_000 }),
      request(4_500, 7_000, ["send_message"], { standby: true, apiCallMs: 150, headersMs: 1_800, firstBytesMs: 1_800, apiMs: 2_300 }),
    ],
    calls: [{ tool: "bash", start: 4_300, ms: 200, handlerMs: 190 }, { tool: "send_message", start: 7_000, ms: 30, handlerMs: 25 }],
    claude: [], firstStatusMs: 10, firstReplyMs: 7_030, lastReplyMs: 7_030, settledMs: 7_040, doneMs: 7_050, replies: 1, marks: [],
  };
  const parts = breakdown(turn);
  expect(parts).toMatchObject({ beforePromptMs: 1_300, modelMs: 5_500, requests: 2, toolsMs: 230, sendMessageMs: 30, bridgeStartMs: 1_150, apiMs: 4_300, doneMs: 7_050 });
  expect(parts.beforePromptMs + parts.modelMs + parts.toolsMs + parts.otherMs + parts.afterMs).toBe(turn.doneMs);
  const text = describeTurn(turn);
  expect(text).toContain("model request 1: first token after 1.00s, done after 3.00s; prompt 8300 tok (8000 cached, 200 written), output 50 tok → bash [bridge: new claude, started after 0.30s, API called after 1.00s");
  expect(text).toContain("[bridge: standby claude, API called after 0.15s");
  expect(text).toContain("tool bash: 0.20s in Pi, 0.19s in the handler");
  expect(text).toContain("last reply in the chat (1 in all)");
  // Without the bridge's trace (another provider) the request stands on Pi's own times.
  expect(breakdown({ ...turn, requests: turn.requests.map(({ bridge: _, ...r }) => r) }).bridgeStartMs).toBeUndefined();
});
