import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

// Pi re-sends a system prompt section into the conversation whenever its text changes. These check
// that a bot's context stays put between turns, and that what does change costs only its own section.
// Each script runs against its own data directory, in a process of its own.
async function run(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bot-context-"));
  try {
    const { code, stdout: out, stderr: err } = await spawnScript(script, { OPENCHAT_DATA_DIR: dir, PI_BIN: join(dir, "no-pi"), PI_CODING_AGENT_DIR: join(dir, "pi"), OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json") });
    if (code !== 0) console.error(out, err);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a bot's system prompt is the same turn after turn, and a new memory changes only its own section", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    import { mock } from 'bun:test';
    // The machines note asks this computer for its container engine, which takes as long as docker does to answer.
    mock.module('./server/computers/api.ts', () => ({ computerApi: () => ({ call: async () => ({}) }), computerTargets: async () => [{ device: 'local', name: 'Studio', status: 'ready', grants: { files: true, terminal: true, browser: true, unisolated: true }, engines: ['podman'] }] }));
    const svc = await import('./server/bots/service.ts');
    const agent = await import('./server/bots/agent.ts');
    const runner = await import('./server/bots/runner.ts');
    const extension = (await import('./server/bots/extension.ts')).default;
    svc.setHooks({ wake() {}, stop() {} });
    svc.updateSettings({ onboarding: 'done', user: { name: 'Gal' } });
    const boss = svc.createBot({ name: 'Boss' });
    svc.addMemory(boss.bot.id, 'Likes tea');

    let hook;
    extension({ on(name, h) { if (name === 'before_agent_start') hook = h; }, registerTool() {} });
    agent.listen();
    process.env.OPENBOTS_SOCKET = agent.agentSocketPath();
    process.env.OPENBOTS_TOKEN = agent.mintToken(boss.bot.id);
    const turn = async () => { const opts = { sections: {}, appendSystemPrompt: '' }; await hook({ systemPromptOptions: opts }); return opts; };
    // What Pi would send mid-conversation: every section whose text changed.
    const patch = (before, after) => Object.keys(after).filter((k) => before[k] !== after[k]);

    const first = await turn();
    a.deepEqual(Object.keys(first.sections), ['openbots', 'openbots_instructions', 'openbots_team', 'openbots_machines', 'openbots_routines', 'openbots_memory']);
    a.equal(first.appendSystemPrompt, '', 'nothing left in the addendum to re-send whole');
    a.match(first.sections.openbots, /You are Boss, one of the user's bots/);
    a.match(first.sections.openbots_memory, /Likes tea/);
    a.match(first.sections.openbots_machines, /You have a computer on each machine[\\s\\S]*Your computer is on this server/);
    a.doesNotMatch(JSON.stringify(first), /The time is/);

    // A later turn, with the clock moved on: nothing to re-send.
    await Bun.sleep(1100);
    a.deepEqual(patch(first.sections, (await turn()).sections), []);

    // The bot remembers something: only the memory goes again, not its instructions, team or machines.
    svc.addMemory(boss.bot.id, 'Has a cat called Miso');
    const after = await turn();
    a.deepEqual(patch(first.sections, after.sections), ['openbots_memory']);
    a.match(after.sections.openbots_memory, /Miso/);

    // contextFor is still the whole context as one text.
    a.equal(agent.contextFor(boss.bot.id), Object.values(agent.contextSections(boss.bot.id)).filter(Boolean).join('\\n\\n'));

    // A Pi without sections gets it all as one addendum, still with no clock, and only once.
    const legacy = { appendSystemPrompt: 'Be brief.' };
    await hook(legacy);
    a.match(legacy.appendSystemPrompt, /^Be brief\\.\\n\\nYou are Boss[\\s\\S]*Your computer is on this server[\\s\\S]*Miso/);
    a.doesNotMatch(legacy.appendSystemPrompt, /The time is/);
    const once = legacy.appendSystemPrompt;
    await hook(legacy);
    a.equal(legacy.appendSystemPrompt, once);

    // The time rides with each prompt instead.
    const prompt = runner.render([{ kind: 'messages', conversationId: boss.conversationId }], boss.bot.id);
    a.match(prompt, /The time is .*\\d{2}:\\d{2}:\\d{2}.*\\.\\n\\nUse send_message/);
    process.exit(0);
  `);
}, 30_000);

test("the team section is a short roster, with teammates' instructions and the chat list behind manage_bot", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    const svc = await import('./server/bots/service.ts');
    const agent = await import('./server/bots/agent.ts');
    const db = await import('./server/bots/db.ts');
    svc.setHooks({ wake() {}, stop() {} });
    svc.updateSettings({ onboarding: 'done', user: { name: 'Gal' } });
    const tail = ' Check the calendar every morning and flag clashes early, and keep a running list of open loops.'.repeat(8);
    const boss = svc.createBot({ name: 'Boss' }).bot;
    const planner = svc.createBot({ name: 'Planner', instructions: 'You plan the user\\'s days and weeks, and nothing gets booked without a check with them first, ever, whatever the time.' + tail }).bot;
    const scout = svc.createBot({ name: 'Scout', instructions: 'Research prices.' + tail }).bot;
    const quiet = svc.createBot({ name: 'Quiet' }).bot;
    svc.createConversation({ kind: 'group', name: 'Weekend trip', botIds: [boss.id, planner.id, scout.id] });
    svc.createConversation({ kind: 'group', name: 'Studio admin', botIds: [boss.id, scout.id] });

    const team = agent.contextSections(boss.id).openbots_team;
    a.doesNotMatch(team, /calendar every morning/, 'no full teammate instructions');
    a.doesNotMatch(team, /Weekend trip|Studio admin|Conversations you're in/, 'no dumped conversation list');
    a.match(team, /You're in 3 chats; manage_bot conversations lists them/);
    a.match(team, /manage_bot team/);
    const roster = team.split('\\n').filter((l) => l.startsWith('- '));
    a.equal(roster.length, 3);
    for (const line of roster) a.ok(line.split(': ').slice(1).join(': ').length <= agent.ROLE_MAX, line);
    a.match(team, new RegExp('- Planner \\\\(' + planner.id.slice(0, 8) + '\\\\): You plan the user.{10,}…$', 'm'));
    a.match(team, /- Scout \\(\\w{8}\\): Research prices\\.$/m);
    a.match(team, /- Quiet \\(\\w{8}\\): no instructions yet$/m);
    a.match(agent.contextSections(scout.id).openbots_team, /- Boss \\(\\w{8}\\), primary: /);

    // The details are a tool call away, for every bot, and still read-only for the others.
    for (const asker of [boss.id, scout.id]) {
      const all = agent.manage(asker, { action: 'team' });
      a.equal(all.find((b) => b.name === 'Planner').instructions, db.getBot(planner.id).instructions);
      a.ok(!all.some((b) => b.id === asker.slice(0, 8)), 'the others, not yourself');
    }
    a.deepEqual(agent.manage(scout.id, { action: 'team', bot: 'Planner' }).map((b) => b.name), ['Planner']);
    a.equal(agent.manage(scout.id, { action: 'team', bot: 'Boss' })[0].primary, true);
    const listed = agent.manage(scout.id, { action: 'conversations' });
    a.match(listed, /^Conversations you're in:\\n/);
    for (const title of ['Weekend trip', 'Studio admin', 'Scout']) a.ok(listed.includes('“' + title + '”'), title);
    a.doesNotMatch(agent.manage(planner.id, { action: 'conversations' }), /Studio admin/);
    a.throws(() => agent.manage(scout.id, { action: 'update', bot: 'Planner', instructions: 'x' }), /only change yourself/);
    a.equal(db.getBot(planner.id).instructions.startsWith('You plan'), true);
    process.exit(0);
  `);
}, 30_000);

test("a bot's Pi gets OpenBots' own short system prompt instead of Pi's coding-assistant one", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    const { BOT_SYSTEM_PROMPT, piFlags, friendFlags } = await import('./server/bots/extensions.ts');
    for (const flags of [piFlags(), friendFlags(false)]) {
      // Any value stops Pi reading SYSTEM.md and APPEND_SYSTEM.md; a non-empty one also replaces its default preamble.
      a.equal(flags[flags.indexOf('--system-prompt') + 1], BOT_SYSTEM_PROMPT);
      a.equal(flags[flags.indexOf('--append-system-prompt') + 1], '');
    }
    a.match(BOT_SYSTEM_PROMPT, /OpenBots/);
    a.doesNotMatch(BOT_SYSTEM_PROMPT, /coding assistant|inside pi/);
    a.ok(BOT_SYSTEM_PROMPT.length < 400);
    process.exit(0);
  `);
}, 30_000);

test("other extensions' tool guidelines survive the bot's own system prompt, and none means no section", async () => {
  const { toolRules } = await import("../server/bots/extension");
  // Pi's default rules section listed these; with OpenBots' preamble they come back on their own.
  expect(toolRules({ selectedTools: ["bash", "theirs", "hidden"], hiddenTools: ["hidden"], toolGuidelines: { theirs: ["Use theirs for X", " Use theirs for X "], hidden: ["Secret"] }, promptGuidelines: ["Be kind"] })).toEqual({ openbots_tool_rules: "- Use theirs for X\n- Be kind" });
  // OpenBots' own tools register none, so the usual prompt gains no section.
  expect(toolRules({ selectedTools: ["bash", "send_message"], toolGuidelines: {} })).toEqual({});
  expect(toolRules({})).toEqual({});
});

// Every bot sends its always-on prompt with each turn, so it must stay well under main's old 18,634 chars.
const ALWAYS_ON_MAX_CHARS = 18_634 * 0.6;

test("the size report shows the always-on prompt text smaller than on main", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "scripts", "bot-prompt-size.ts")], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) console.error(err);
  expect(code).toBe(0);
  const report = JSON.parse(out);
  expect(report.before.total).toBe(18634);
  expect(report.after.total).toBeLessThan(ALWAYS_ON_MAX_CHARS);
  expect(report.after.context).toBeLessThan(report.before.context);
  expect(report.after.apps).toBeLessThan(report.before.apps / 2);
  expect(report.after.approxTokens).toBe(Math.round(report.after.total / 4.28));
}, 30_000);

test("the size report's memory mode shows a many-memory bot's per-turn memory context well under main's", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "scripts", "bot-prompt-size.ts"), "--memory"], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) console.error(err);
  expect(code).toBe(0);
  const report = JSON.parse(out);
  expect(report.sample).toEqual({ memories: 120, profile: 12, journal: 108 });
  // origin/main 5356490: the newest 40 of the 120, and none of the lasting facts among them.
  expect(report.before).toEqual({ chars: 5035, approxTokens: 1176, lines: 41 });
  // Now: all 12 lasting facts and the latest 5 entries, each under a heading.
  expect(report.after.lines).toBe(12 + 5 + 2);
  expect(report.after.chars).toBeLessThan(report.before.chars / 2);
  expect(report.after.approxTokens).toBe(Math.round(report.after.chars / 4.28));
}, 30_000);

test("the context audit counts clock-only system patches and compaction usage apart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bot-context-audit-"));
  try {
    const rules = "Rules. ".repeat(400);
    const addendum = (time: string, memory = "- tea") => `<addendum>\nYou are Boss.\n\n${rules}\n\nThings you remember:\n${memory}\n\nThe time is ${time}.\n</addendum>`;
    const usage = (input: number, cacheRead: number, cacheWrite = 0) => ({ input, output: 5, cacheRead, cacheWrite });
    const at = (n: number) => new Date(Date.UTC(2026, 10, 9, 1, n)).toISOString();
    const entries = [
      { type: "message", timestamp: at(0), message: { role: "system", content: "", sections: { preamble: "Pi", addendum: addendum("01:00:00") } } },
      { type: "message", timestamp: at(0), message: { role: "user", content: "hi" } },
      { type: "message", timestamp: at(0), message: { role: "assistant", provider: "a", usage: usage(3000, 0) } },
      // Turn two: only the clock moved, so the whole addendum is avoidable.
      { type: "message", timestamp: at(1), message: { role: "system", content: "", sections: { addendum: addendum("01:01:00") } } },
      { type: "message", timestamp: at(1), message: { role: "user", content: "again" } },
      { type: "message", timestamp: at(1), message: { role: "assistant", provider: "a", usage: usage(800, 3000) } },
      { type: "message", timestamp: at(1), message: { role: "assistant", provider: "a", usage: usage(10, 3800) } },
      // Turn three: a real memory change is not counted as avoidable.
      { type: "message", timestamp: at(2), message: { role: "system", content: "", sections: { addendum: addendum("01:02:00", "- tea\n- cats") } } },
      { type: "message", timestamp: at(2), message: { role: "assistant", provider: "b", stopReason: "error", usage: usage(0, 0) } },
      { type: "message", timestamp: at(2), message: { role: "assistant", provider: "a", usage: usage(9000, 0) } },
      { type: "compaction", timestamp: at(3), tokensBefore: 9000, usage: usage(40, 0, 1200) },
    ];
    await writeFile(join(dir, "session.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n"));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "scripts", "bot-context-audit.ts"), dir], { stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    const report = JSON.parse(out);
    const patchTokens = Buffer.byteLength(addendum("01:01:00")) / 4.28;
    expect(report).toMatchObject({ files: 1, calls: 5, input: 12810, cacheRead: 6800, cacheWrite: 0, systemPatches: 2, clockOnlyPatches: 1, errorCalls: 1, providerSwitches: 2 });
    // Paid fresh by turn two's first call, then read from cache by its second call and by turn three.
    expect(report.avoidableUncachedOrWrite).toBe(Math.round(patchTokens));
    expect(report.avoidableCacheRead).toBe(Math.round(patchTokens * 2));
    // Turn three re-sent its unchanged rules along with the new memory: what sections save.
    expect(report.sectionedCacheRead).toBe(0);
    expect(report.sectionedUncachedOrWrite).toBeGreaterThanOrEqual(Math.floor(rules.length / 4.28));
    expect(report.sectionedUncachedOrWrite).toBeLessThan((rules.length + 40) / 4.28);
    expect(report).toMatchObject({ compactions: 1, compactionInput: 40, compactionCacheWrite: 1200, compactionOutput: 5 });
    expect(out).not.toContain("Rules.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
