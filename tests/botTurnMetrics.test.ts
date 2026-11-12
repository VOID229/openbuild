import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWhen } from "../scripts/bot-turn-metrics";
import { declaredSizes, readSession, report } from "../scripts/bot-tool-loads";
import { CORE_TOOLS } from "../server/bots/extension";
import { declarationSizes } from "../server/bots/toolPreload";
import { filterTurns, formatTable, parseTurns, percentile, spread, summarizeTurns, summaryRows, TurnMeter, unloadedResult, type TurnRecord } from "../server/bots/turnMetrics";
import { unexpectedStderr } from "./botStderr";
import { spawnScript } from "./spawnScript";

const T0 = Date.UTC(2026, 10, 12, 10);

test("a turn is measured from the user's message: requests, waits, tokens and tool loads", () => {
  // The message arrived 400 ms before the bot was free to take it.
  const meter = new TurnMeter({ bot: "bot-1", trigger: "messages", waiting: true, since: T0 }, T0 + 400);
  meter.pi(true, 2);
  meter.status(T0 + 410);
  meter.status(T0 + 9000);
  meter.prompt(T0 + 1500);
  meter.prompt(T0 + 7000);
  // The primary model failed; the fallback loaded a tool, called it, and answered.
  meter.request({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, true);
  meter.request({ input: 200, output: 20, cacheRead: 9000, cacheWrite: 300 }, false);
  meter.tool("load_tools", { names: ["bash", "use_app"] }, T0 + 3000);
  meter.request({ input: 50, output: 30, cacheRead: 9500, cacheWrite: 600 }, false);
  meter.tool("bash", { command: "secret command", status: "Looking for the secret" }, T0 + 4000);
  meter.unloaded();
  meter.tool("their_own_tool", {}, T0 + 4500);
  meter.request({ input: 40, output: 60, cacheRead: 10100, cacheWrite: 100 }, false);
  meter.tool("send_message", { text: "private words" }, T0 + 6000);
  meter.reply(T0 + 6500);
  meter.reply(T0 + 8000);
  meter.request(undefined, false);
  expect(meter.tools()).toEqual(["bash"]);
  const record = meter.finish(undefined, T0 + 7000);
  expect(record).toEqual({
    bot: "bot-1", turn: record.turn, at: T0 + 7000, source: "assistant-message-usage", measured: true, excludesCompactionUsage: true,
    v: 2, trigger: "messages", waiting: true, outcome: "replied", piStarted: true, preloaded: 2,
    calls: 5, failedCalls: 1, input: 290, output: 110, cacheRead: 28600, cacheWrite: 1000,
    queuedMs: 400, promptMs: 1500, statusMs: 410, toolMs: 3000, replyMs: 6500, doneMs: 7000,
    firstTool: "load_tools", toolCalls: 4, loads: 1, loaded: 2, unloadedCalls: 1, tools: ["bash"],
  });
  expect(record.turn).toMatch(/^[0-9a-f-]{36}$/);
  // Numbers and OpenBots' own tool names: nothing the bot or the user wrote, and no tool of theirs by name.
  const line = JSON.stringify(record);
  for (const leaked of ["secret", "private", "their_own_tool", "Looking"]) expect(line).not.toContain(leaked);
});

test("how a turn ended is told from what happened, unless the runner says", () => {
  const start = () => new TurnMeter({ bot: "b", trigger: "heartbeat", friend: true, waiting: false, since: T0 + 50 }, T0);
  // Nothing was shown to the model: there was nothing to say.
  const skipped = start().finish(undefined, T0 + 5);
  expect([skipped.outcome, skipped.calls, skipped.measured, skipped.friend, skipped.queuedMs, skipped.promptMs, skipped.replyMs, skipped.tools]).toEqual(["skipped", 0, false, true, 0, undefined, undefined, undefined]);
  const silent = start();
  silent.prompt(T0 + 10);
  expect(silent.finish(undefined, T0 + 20).outcome).toBe("silent");
  const replied = start();
  replied.prompt(T0 + 10);
  replied.reply(T0 + 15);
  expect(replied.finish(undefined, T0 + 20).outcome).toBe("replied");
  expect(replied.finish("stopped", T0 + 20).outcome).toBe("stopped");
  expect(start().finish("error", T0 + 20).outcome).toBe("error");
  // A tool of the user's own is counted, never named.
  const other = start();
  other.tool("mcp__their__thing", {}, T0 + 1);
  other.tool("load_tools", { names: "bash" }, T0 + 2);
  const out = other.finish(undefined, T0 + 3);
  expect([out.firstTool, out.toolCalls, out.loads, out.loaded, out.tools]).toEqual(["other", 2, 1, 1, undefined]);
});

test("a call to a tool that wasn't loaded is told from any other failed call", () => {
  const result = (toolName: string, text: string, isError = true) => ({ role: "toolResult", toolName, isError, content: [{ type: "text", text }] });
  expect(unloadedResult(result("todo", "Tool todo not found"))).toBe(true);
  expect(unloadedResult(result("todo", "todo wasn't loaded, so that call didn't run. It's loaded now: call it again."))).toBe(true);
  expect(unloadedResult(result("todo", "Error: no such item"))).toBe(false);
  expect(unloadedResult(result("todo", "Tool todo not found", false))).toBe(false);
  // Not one of ours to load.
  expect(unloadedResult(result("made_up", "Tool made_up not found"))).toBe(false);
  expect(unloadedResult(result("send_message", "Tool send_message not found"))).toBe(false);
  expect(unloadedResult({ role: "assistant", content: [] })).toBe(false);
  expect(unloadedResult(undefined)).toBe(false);
});

const turn = (over: Partial<TurnRecord>): TurnRecord => ({ bot: "aaaa-1", turn: crypto.randomUUID(), at: T0, source: "assistant-message-usage", measured: true, excludesCompactionUsage: true, v: 2, trigger: "messages", waiting: true, outcome: "replied", calls: 2, failedCalls: 0, input: 100, cacheRead: 800, cacheWrite: 100, output: 50, toolCalls: 1, loads: 0, loaded: 0, unloadedCalls: 0, piStarted: false, preloaded: 0, queuedMs: 10, promptMs: 30, statusMs: 10, toolMs: 1000, replyMs: 2000, doneMs: 3000, ...over });

test("turns are summarized: requests per turn, the user's waits, tokens and loads", () => {
  expect(percentile([], 50)).toBe(0);
  expect(percentile([5, 1, 3], 50)).toBe(3);
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  expect(percentile([7], 90)).toBe(7);
  expect(spread([1, 2, 3, 10])).toEqual({ n: 4, mean: 4, p50: 2, p90: 10 });
  const records: TurnRecord[] = [
    turn({ at: T0 + 1, calls: 4, loads: 1, loaded: 2, unloadedCalls: 1, piStarted: true, tools: ["bash", "use_app"], replyMs: 6000, toolMs: 3000, input: 1000, cacheRead: 7000, cacheWrite: 2000 }),
    turn({ at: T0 + 2, tools: ["bash"], preloaded: 2 }),
    turn({ at: T0 + 3, calls: 3, failedCalls: 1, replyMs: undefined, toolMs: undefined, outcome: "silent" }),
    // Nobody was waiting: counted, but not among the user's waits.
    turn({ at: T0 + 4, waiting: false, trigger: "heartbeat", calls: 1, replyMs: 99_000, doneMs: 99_000 }),
    // Never reached the model: not a turn to measure speed by.
    turn({ at: T0 + 5, calls: 0, measured: false, outcome: "skipped", input: undefined, cacheRead: undefined, cacheWrite: undefined, output: undefined }),
    // A line from before the timings existed: requests and tokens only.
    { bot: "bbbb-2", turn: "old", at: T0 - 1000, source: "assistant-message-usage", measured: true, excludesCompactionUsage: true, calls: 5, input: 500, cacheRead: 4000, cacheWrite: 500, output: 100 },
  ];
  const s = summarizeTurns(records);
  expect([s.records, s.turns, s.detailed, s.from, s.to]).toEqual([6, 5, 4, T0 - 1000, T0 + 4]);
  expect(s.requestsPerTurn).toEqual({ n: 5, mean: 3, p50: 3, p90: 5 });
  // Of the ten requests with details, one failed and two went on loading.
  expect(s.failedRequestShare).toBe(0.1);
  expect(s.loads).toEqual({ turnsLoadingShare: 0.25, loadsPerTurn: 0.25, unloadedCallsPerTurn: 0.25, requestShare: 0.2, preloadedPerTurn: 0.5 });
  expect(s.piStartedShare).toBe(0.25);
  expect(s.waiting.turns).toBe(3);
  expect(s.waiting.replyMs).toEqual({ n: 2, mean: 4000, p50: 2000, p90: 6000 });
  expect(s.waiting.toolMs).toEqual({ n: 2, mean: 2000, p50: 1000, p90: 3000 });
  expect(s.waiting.doneMs).toEqual({ n: 3, mean: 3000, p50: 3000, p90: 3000 });
  expect(s.tokens.total).toEqual({ input: 1800, cacheRead: 13400, cacheWrite: 2800, output: 300 });
  expect(s.tokens.promptPerRequest).toBe(1200);
  expect(s.tokens.cachedShare).toBe(0.744);
  expect(s.tokens.promptPerTurn).toEqual({ n: 5, mean: 3600, p50: 1000, p90: 10000 });
  expect(s.outcomes).toEqual({ replied: 3, silent: 1, skipped: 1 });
  expect(s.tools).toEqual({ bash: 0.5, use_app: 0.25 });
  // An empty file is a summary of nothing, not a crash.
  const none = summarizeTurns([]);
  expect([none.turns, none.requestsPerTurn.mean, none.tokens.cachedShare, none.loads, none.from]).toEqual([0, 0, 0, {}, undefined]);

  // By bot and by time, and before and after a moment side by side.
  expect(filterTurns(records, { bot: "bbbb" }).map((r) => r.turn)).toEqual(["old"]);
  expect(filterTurns(records, { since: T0 + 2, until: T0 + 4 })).toHaveLength(2);
  const table = formatTable(["", "Before", "After"], summaryRows([summarizeTurns(filterTurns(records, { until: T0 + 2 })), summarizeTurns(filterTurns(records, { since: T0 + 2 }))]));
  const row = (label: string) => table.split("\n").find((line) => line.startsWith(label))!.slice(label.length).trim().split(/\s{2,}/);
  expect(row("Model requests per turn: mean / p50 / p90")).toEqual(["4.5 / 4 / 5", "2 / 2 / 3"]);
  expect(row("Turns that loaded a tool first")).toEqual(["100.0%", "0.0%"]);
  expect(row("  message → first reply: p50 / p90")).toEqual(["6.0 s / 6.0 s", "2.0 s / 2.0 s"]);
  expect(row("Turns (that reached the model)")).toEqual(["2 (1 with timings)", "3"]);
});

test("the turn log is read a line at a time, whatever state it's in", () => {
  const text = [JSON.stringify(turn({ at: 5 })), "", "{\"bot\":\"x\",\"at\":", "null", "[]", JSON.stringify({ at: 1 }), JSON.stringify(turn({ at: 6 }))].join("\n");
  expect(parseTurns(text).map((r) => r.at)).toEqual([5, 6]);
  expect(parseTurns("")).toEqual([]);
  const now = Date.UTC(2026, 10, 12);
  expect(parseWhen("24h", now)).toBe(now - 86_400_000);
  expect(parseWhen("30m", now)).toBe(now - 1_800_000);
  expect(parseWhen("7d", now)).toBe(now - 7 * 86_400_000);
  expect(parseWhen("2026-11-12T10:00Z", now)).toBe(T0);
  expect(() => parseWhen("yesterday-ish", now)).toThrow("Can't read");
});

test("the summary script reads a turn log and prints the table, or JSON, before and after a moment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-turn-metrics-"));
  try {
    const file = join(dir, "usage.jsonl");
    writeFileSync(file, [turn({ at: T0, calls: 4, loads: 1 }), turn({ at: T0 + 10_000, calls: 2 }), turn({ at: T0 + 20_000, calls: 2, bot: "cccc-3" })].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const script = join(import.meta.dir, "..", "scripts", "bot-turn-metrics.ts");
    const run = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, script, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENCHAT_DATA_DIR: dir } });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, out, err };
    };
    const json = await run(file, "--json", "--split", new Date(T0 + 5000).toISOString());
    expect(json.err).toBe("");
    const { before, after } = JSON.parse(json.out);
    expect([before.turns, before.requestsPerTurn.mean, before.loads.turnsLoadingShare]).toEqual([1, 4, 1]);
    expect([after.turns, after.requestsPerTurn.mean, after.loads.turnsLoadingShare]).toEqual([2, 2, 0]);
    const one = await run(file, "--bot", "cccc", "--json");
    expect(JSON.parse(one.out).turns).toBe(1);
    const table = await run(file, "--since", new Date(T0 + 5000).toISOString());
    expect(table.code).toBe(0);
    expect(table.out).toContain("Model requests per turn: mean / p50 / p90");
    expect(table.out).toContain("message → first reply: p50 / p90");
    // With no path it reads the data directory's own log, and says so when there isn't one.
    const missing = await run();
    expect(missing.code).toBe(1);
    expect(missing.err).toContain(join(dir, "bots", "usage.jsonl"));
    const bad = await run(file, "--since", "whenever");
    expect([bad.code, bad.err.trim()]).toEqual([1, "Can't read \"whenever\" as a time. Use an ISO date like 2026-11-12T10:00Z, or 24h, 30m, 7d."]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

// A recorded session, as Pi writes it: loadouts on system messages, usage on assistant messages.
test("recorded sessions show what loading cost, and a replay what sticky, preloaded tools would have", () => {
  const sizes = declarationSizes();
  const { core, all } = declaredSizes();
  expect(all).toBeGreaterThan(core * 4);
  let clock = T0;
  const entry = (message: Record<string, unknown>) => JSON.stringify({ type: "message", timestamp: new Date((clock += 1000)).toISOString(), message });
  const system = (added: string[], removed: string[] = []) => entry({ role: "system", content: "", ...(added.length ? { toolsAdded: added.map((name) => ({ name })) } : {}), ...(removed.length ? { toolsRemoved: removed.map((name) => ({ name })) } : {}) });
  const assistant = (calls: string[], stop = calls.length ? "toolUse" : "stop", usage = { input: 100, cacheRead: 800, cacheWrite: 100 }) => entry({ role: "assistant", stopReason: stop, usage, content: calls.map((name) => ({ type: "toolCall", name })) });
  const result = (toolName: string, error?: string) => entry({ role: "toolResult", toolName, ...(error ? { isError: true, content: [{ type: "text", text: error }] } : {}) });
  const user = () => entry({ role: "user", content: "hi" });
  // Three turns that each need bash. A restart dropped it after the first, so the second loads it again,
  // and the third calls it unloaded after another restart.
  const text = [
    system([...CORE_TOOLS]), user(),
    assistant(["load_tools"]), result("load_tools"), system(["bash"]), assistant(["bash"]), result("bash"), assistant([]),
    system([], ["bash"]), user(),
    assistant(["load_tools"], "toolUse", { input: 1000, cacheRead: 0, cacheWrite: 0 }), result("load_tools"), system(["bash"]), assistant(["bash"]), result("bash"), assistant([]),
    system([], ["bash"]), user(),
    assistant(["bash"], "toolUse", { input: 700, cacheRead: 0, cacheWrite: 300 }), result("bash", "bash wasn't loaded, so that call didn't run. It's loaded now: call it again."), system(["bash"]), assistant(["bash", "send_message"]), result("bash"), assistant([]),
  ].join("\n");
  const session = readSession(text, sizes, core)!;
  expect(session.turns.map((t) => [t.requests.length, t.requests.filter((r) => r.wasted).length, [...t.used]])).toEqual([[3, 1, ["bash"]], [3, 1, ["bash"]], [3, 1, ["bash"]]]);
  expect([session.drops, session.dropped, session.uncachedAfterDrop]).toEqual([2, 1 + 1, 1000 + 1000]);
  // A request declares the core, and bash once it's loaded.
  expect(session.turns[0]!.requests.map((r) => r.declared)).toEqual([core, core + sizes.bash!, core + sizes.bash!]);
  // Sessions from before the catalog have nothing to load.
  expect(readSession([system(["bash", "send_message"]), user(), assistant([])].join("\n"), sizes, core)).toBeUndefined();

  const out = report([{ ...session, bot: "b" }], sizes, core, all);
  expect([out.sessions, out.bots, out.turns, out.requests]).toEqual([1, 1, 3, 9]);
  expect(out.recorded).toMatchObject({ loadRequests: 3, loadRequestShare: 0.333, turnsLoading: 3, turnsLoadingShare: 1, promptTokensOnLoads: 3000, toolDrops: 2, toolsDropped: 2, uncachedTokensAfterDrops: 2000 });
  // Replayed: the session loads bash once and keeps it.
  expect(out.replayed).toMatchObject({ loadRequests: 1, turnsLoading: 1, turnsLoadingShare: 0.333, promptTokensOnLoads: 1000, toolDrops: 0, preloadedPerSession: 0 });
  expect(out.replayed.loadRequestShare).toBe(Number((1 / 7).toFixed(3)));
  expect(out.replayed.declaredTokensPerRequest).toBeGreaterThan(out.recorded.declaredTokensPerRequest);
  expect(out.replayed.declaredTokensPerRequest).toBeLessThan(out.allToolsTokensPerRequest / 2);

  // A second session of the same bot, later: bash was used in two turns, so it's there from the start.
  clock += 3_600_000;
  const later = readSession([system([...CORE_TOOLS]), user(), assistant(["load_tools"]), result("load_tools"), system(["bash"]), assistant(["bash"]), result("bash"), assistant([])].join("\n"), sizes, core)!;
  const both = report([{ ...session, bot: "b" }, { ...later, bot: "b" }], sizes, core, all);
  expect([both.recorded.loadRequests, both.replayed.loadRequests, both.replayed.preloadedPerSession]).toEqual([4, 1, 0.5]);
  // Another bot's session doesn't share that history.
  const other = report([{ ...session, bot: "b" }, { ...later, bot: "c" }], sizes, core, all);
  expect(other.replayed.loadRequests).toBe(2);
});

// The real service and runner on a data dir of their own, with a stand-in for the bot's Pi: the runner
// writes one record per turn, and what the bot's turns used becomes what its next Pi starts with.
test("the runner logs each turn's metrics and learns the bot's usual tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-turn-metrics-run-"));
  try {
    const { code, stderr: err } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import { readFileSync, statSync } from 'node:fs';
      const minds = globalThis.openbotsMinds = new Map();
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      const agent = await import('./server/bots/agent.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
      svc.setHooks({ wake: runner.wake, stop: runner.stop, pendingAssignments: runner.pendingAssignments, unseen: runner.unseen, userWoke: runner.userWoke, halt: runner.halt, background: runner.background });
      svc.updateSettings({ onboarding: 'done' });
      const { bot, conversationId } = svc.createBot({ name: 'Alpha' });
      const prompts = [];
      const mind = { token: 't', loaded: JSON.stringify(piFlags()), busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), ended: Promise.resolve(), close() { this.exited = true; }, async send(cmd) {
        if (cmd.type === 'clear_queue') return { steering: [], followUp: [] };
        if (cmd.type === 'prompt') prompts.push({ finish(text = '') { mind.draft = text; mind.onSettled?.(); } });
        return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
      } } };
      Object.defineProperty(mind, 'sessionPath', { get: () => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', bot.id, conversationId)) });
      minds.set(bot.id, mind);
      const until = async (check) => { for (let i = 0; i < 600 && !check(); i++) await Bun.sleep(5); a.ok(check(), String(check)); };
      const record = (r) => runner.onRecord(bot.id, mind, r);
      const model = (stopReason, usage) => record({ type: 'message_end', message: { role: 'assistant', stopReason, usage, content: [] } });
      const tool = async (name, args, result = {}) => { record({ type: 'tool_execution_start', toolName: name, args }); await Bun.sleep(15); record({ type: 'tool_execution_end', toolName: name, result }); };
      const send = async (text) => tool('send_message', { text }, { details: await agent.sendMessage(bot.id, { text }) });
      const log = process.env.OPENCHAT_DATA_DIR + '/bots/usage.jsonl';
      const turns = () => readFileSync(log, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
      const turnOver = async (n) => { await until(() => !runner.busy(bot.id)); await until(() => turns().length === n); return turns().at(-1); };
      const ask = async (text) => { const before = prompts.length; svc.postMessage(conversationId, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text }); await until(() => prompts.length === before + 1); await Bun.sleep(20); return prompts.at(-1); };

      // The user asks: the primary model fails, the next loads a tool, runs it, and answers.
      let prompt = await ask('please run it');
      model('error', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      model('toolUse', { input: 200, output: 20, cacheRead: 9000, cacheWrite: 300 });
      await tool('load_tools', { names: ['bash'] });
      model('toolUse', { input: 50, output: 30, cacheRead: 9500, cacheWrite: 600 });
      await tool('bash', { command: 'ls ~/private', status: 'Looking in the private folder' });
      // A call to a tool that isn't loaded fails once: Pi reports the result the extension rewrote.
      record({ type: 'message_end', message: { role: 'toolResult', toolName: 'todo', isError: true, content: [{ type: 'text', text: "todo wasn't loaded, so that call didn't run. It's loaded now: call it again." }] } });
      model('toolUse', { input: 40, output: 60, cacheRead: 10100, cacheWrite: 100 });
      await send('All done, nothing private here.');
      model('stop', { input: 10, output: 5, cacheRead: 10300, cacheWrite: 50 });
      prompt.finish();
      const first = await turnOver(1);
      a.deepEqual(
        [first.v, first.bot, first.trigger, first.waiting, first.outcome, first.calls, first.failedCalls, first.measured, first.piStarted, first.preloaded],
        [2, bot.id, 'messages', true, 'replied', 5, 1, true, false, 0]);
      a.deepEqual([first.input, first.output, first.cacheRead, first.cacheWrite], [300, 115, 38900, 1050]);
      a.deepEqual([first.toolCalls, first.loads, first.loaded, first.unloadedCalls, first.firstTool, first.tools], [3, 1, 1, 1, 'load_tools', ['bash']]);
      for (const key of ['queuedMs', 'promptMs', 'statusMs', 'toolMs', 'replyMs', 'doneMs']) a.ok(Number.isFinite(first[key]) && first[key] >= 0, key + ': ' + first[key]);
      // The chat showed it at work before its first tool call; its message came after that, and then the turn ended.
      a.ok(first.statusMs <= first.toolMs && first.toolMs < first.replyMs && first.replyMs <= first.doneMs, JSON.stringify(first));
      a.ok(first.queuedMs <= first.promptMs && first.promptMs <= first.toolMs, JSON.stringify(first));
      a.equal(new Set(turns().map((t) => t.turn)).size, 1);
      // Nothing the bot or the user wrote: no words, no arguments, no status line, no conversation.
      const line = readFileSync(log, 'utf8');
      for (const text of ['private', 'please', 'Looking', 'All done', conversationId]) a.ok(!line.includes(text), text);
      a.equal(statSync(log).mode & 0o777, 0o600);
      // One turn with bash isn't a habit yet.
      a.deepEqual(Object.keys(db.toolUsage(bot.id)), ['bash']);
      a.deepEqual(runner.preloadFor(bot.id), []);

      // Again, with bash and use_app: bash is one of its usual tools now, and its next Pi starts with it.
      prompt = await ask('and again');
      model('toolUse', { input: 20, output: 20, cacheRead: 11000, cacheWrite: 30 });
      await tool('bash', { command: 'ls' });
      await tool('use_app', { app: 'github', tool: 'list' });
      model('stop', { input: 10, output: 5, cacheRead: 11200, cacheWrite: 50 });
      prompt.finish('Here you go.');
      const second = await turnOver(2);
      a.deepEqual([second.calls, second.failedCalls, second.loads, second.unloadedCalls, second.firstTool, second.tools, second.outcome], [2, 0, 0, 0, 'bash', ['bash', 'use_app'], 'replied']);
      // It answered in plain text at the end of the turn: that's when the user first heard from it.
      a.ok(second.replyMs >= second.toolMs && second.replyMs <= second.doneMs, JSON.stringify(second));
      a.deepEqual(Object.fromEntries(Object.entries(db.toolUsage(bot.id)).map(([name, times]) => [name, times.length])), { bash: 2, use_app: 1 });
      a.deepEqual(runner.preloadFor(bot.id), ['bash']);
      // A chat shared with a friend the owner allows no tools gets none of them.
      a.deepEqual(runner.preloadFor(bot.id, 'friend:nobody'), []);

      // A note nobody is waiting on, answered with nothing: a turn, but not one of the user's waits.
      const before = prompts.length;
      runner.wake(bot.id, { kind: 'note', conversationId, text: 'A thread finished.' });
      await until(() => prompts.length === before + 1);
      model('stop', { input: 5, output: 2, cacheRead: 11300, cacheWrite: 10 });
      prompts.at(-1).finish('[silent]');
      const third = await turnOver(3);
      a.deepEqual([third.trigger, third.waiting, third.outcome, third.calls, third.toolCalls, third.replyMs, third.tools], ['note', false, 'silent', 1, 0, undefined, undefined]);
      // A turn that used no catalog tool leaves the bot's habits as they were.
      a.deepEqual(runner.preloadFor(bot.id), ['bash']);

      // The summary of the log: three turns, eight requests, one of them failed and two spent on loading.
      const { parseTurns, summarizeTurns } = await import('./server/bots/turnMetrics.ts');
      const summary = summarizeTurns(parseTurns(readFileSync(log, 'utf8')));
      a.deepEqual([summary.turns, summary.detailed, summary.waiting.turns, summary.requestsPerTurn.mean, summary.failedRequestShare, summary.loads.requestShare], [3, 3, 2, 2.67, 0.125, 0.25]);
      a.deepEqual(summary.outcomes, { replied: 2, silent: 1 });

      // Deleting a bot takes its habits with it.
      const beta = svc.createBot({ name: 'Beta' }).bot;
      db.setToolUsage(beta.id, { bash: [Date.now()] });
      a.deepEqual(Object.keys(db.toolUsage(beta.id)), ['bash']);
      await svc.deleteBot(beta.id);
      a.equal(db.toolUsage(beta.id), undefined);
      a.deepEqual(runner.preloadFor(bot.id), ['bash']);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir });
    expect(unexpectedStderr(err)).toBe("");
    expect(code).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
