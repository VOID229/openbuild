import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pi re-sends a system prompt section into the conversation whenever its text changes. These check
// that a bot's context stays put between turns, and that what does change costs only its own section.
// Each script runs against its own data directory, in a process of its own.
async function run(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bot-context-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, OPENCHAT_DATA_DIR: dir, PI_BIN: join(dir, "no-pi"), PI_CODING_AGENT_DIR: join(dir, "pi") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
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
    a.match(first.sections.openbots_machines, /You have a computer on each machine[\\s\\S]*Machines you can reach/);
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
    a.match(legacy.appendSystemPrompt, /^Be brief\\.\\n\\nYou are Boss[\\s\\S]*Machines you can reach[\\s\\S]*Miso/);
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
