// What a bot's turn no longer waits on or carries (docs/openbots-context-diet.md has the numbers):
// a paired device that doesn't answer in front of every turn, a minute of summarizing on the bot's
// own model, a model request that only says the turn is over, and tool results at full length.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import openbots, { heard, LAST, stepSaysDone, traceSummary, SUMMARY_SYSTEM, SUMMARY_WORDS, leastThinking, settled, shellText, soundSummary, summarize, summaryModel, summaryPrompt, summaryTranscript } from "../server/bots/extension";
import { COMPACT_AT, compactionPolicy } from "../server/bots/sessionPolicy";
import { BOT_TOOLS } from "../server/bots/toolPreload";
import { summarizeTurns, summaryRows, TurnMeter } from "../server/bots/turnMetrics";
import { piBin } from "../server/pi/install";
import { spawnScript } from "./spawnScript";

/** Runs a scenario against a data directory of its own, in a process of its own. */
async function run(script: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-bot-context-diet-"));
  try {
    const { code, stderr: err } = await spawnScript(script, { OPENCHAT_DATA_DIR: join(dir, "data"), PI_CODING_AGENT_DIR: join(dir, "pi"), PI_BIN: join(dir, "no-pi"), OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json"), ...env });
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ the machines note never holds a turn

test("a bot's context doesn't wait on a paired device that stopped answering", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    import { mock } from 'bun:test';
    const all = { files: true, terminal: true, browser: true, unisolated: true };
    // A laptop that answers at once, until it goes to sleep: then asking it takes seconds to give up.
    let asleep = false, hung = false, deaf = 0, asked = 0, active = 0;
    const signals = [];
    mock.module('./server/computers/index.ts', () => ({ capabilities: async () => ({ engines: [] }), engines: async () => [], procListeners: new Set() }));
    mock.module('./server/computers/api.ts', () => ({
      computerApi: () => ({ call: async () => ({}) }),
      computerTargets: async (opts = {}) => {
        asked++;
        active++;
        signals.push(opts.signal);
        const laptop = (status) => [{ device: 'local', name: 'Studio', status: 'ready', grants: all }, status === 'ready' ? { device: 'lap', name: 'Laptop', status, grants: all } : { device: 'lap', name: 'Laptop', status, message: 'no answer' }];
        try {
          // Takes the request and never answers: like the real one, it ends when the round's signal says so, with the laptop unreachable.
          if (hung) return await new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve(laptop('offline')), { once: true }));
          // Doesn't stop when told to (nothing real does this anymore): it comes back late, saying what was true when it was asked.
          if (deaf) return await Bun.sleep(deaf).then(() => laptop('offline'));
          if (asleep) await Bun.sleep(1200);
          return laptop(asleep ? 'offline' : 'ready');
        } finally {
          active--;
        }
      },
    }));
    const devices = await import('./server/devices.ts');
    devices.addDevice({ id: 'lap', name: 'Laptop', mode: 'lan', urls: ['http://x'], token: 't' });
    const svc = await import('./server/bots/service.ts');
    const m = await import('./server/bots/machines.ts');
    svc.setHooks({ wake() {}, stop() {} });
    const timed = async () => { const started = Date.now(); const note = await m.machinesNote(); return { note, ms: Date.now() - started }; };
    const READY = /- Laptop \\(machine id lap\\): files, terminal, browser; host \\(unisolated\\)\\./;

    // Nothing known yet: the first note asks, and says what the laptop answered.
    const first = await timed();
    a.match(first.note, READY);
    a.equal(asked, 1);
    // A moment later nothing is asked again.
    a.match((await timed()).note, READY);
    a.equal(asked, 1);

    // The laptop goes to sleep and what's known gets old: the note comes back at once, from what it last said...
    asleep = true;
    globalThis.openbotsMachines.at = Date.now() - 5 * 60_000;
    const stale = await timed();
    a.ok(stale.ms < 700, 'the note waited ' + stale.ms + ' ms on a device that does not answer');
    a.match(stale.note, READY);
    a.doesNotMatch(stale.note, /not checked yet/);
    a.equal(asked, 2);
    // ...the check carries on behind the turn, one at a time, and a turn that starts meanwhile doesn't wait for it either.
    const during = await timed();
    a.ok(during.ms < 700, 'a second turn waited ' + during.ms + ' ms');
    a.equal(asked, 2);
    // Once it has given up, the next note says the laptop can't be reached.
    await Bun.sleep(1400);
    const after = await timed();
    a.ok(after.ms < 200, 'a fresh answer was asked for again: ' + after.ms + ' ms');
    a.match(after.note, /- Laptop \\(machine id lap\\): unreachable right now/);
    a.equal(asked, 2);

    // How bots are kept apart there is the user's setting, read now, not what was answered then.
    asleep = false;
    globalThis.openbotsMachines.at = 0;
    a.match((await timed()).note, READY);
    m.setIsolation('lap', 'container');
    a.match(await m.machinesNote(), /- Laptop \\(machine id lap\\): files, terminal, browser; container\\./);
    // A device that takes the request and never answers. Each round's time runs out: its requests are told to stop,
    // and nothing of it is left running when the next one starts.
    const CONTAINED = /- Laptop \\(machine id lap\\): files, terminal, browser; container\\./;
    m.tuning.giveUpMs = 200;
    hung = true;
    const before = asked;
    for (let round = 1; round <= 3; round++) {
      globalThis.openbotsMachines.at = 0;
      const stuck = await timed();
      a.ok(stuck.ms < 700, 'the note waited ' + stuck.ms + ' ms on a round that never answers');
      a.equal(asked, before + round);
      a.equal(active, 1, 'one round out at a time');
      // While it's out, no second round is started beside it.
      await timed();
      a.equal(asked, before + round);
      await Bun.sleep(350);
      a.equal(active, 0, 'round ' + round + ' was still asking after its time ran out');
      a.equal(signals.at(-1).aborted, true);
    }
    a.equal(signals.slice(-3).every((signal) => signal instanceof AbortSignal && signal.aborted), true);
    // What a round that ran out of time says of a device that never answered: it can't be reached.
    a.match(await m.machinesNote(), /- Laptop \\(machine id lap\\): unreachable right now/);
    hung = false;
    globalThis.openbotsMachines.at = 0;
    a.match((await timed()).note, CONTAINED);
    a.equal(active, 0);

    // A round that doesn't stop when it's told to is let go of all the same, and what it says when it finally comes
    // back is thrown away once a newer round has answered: an old "unreachable" can't replace a newer "ready".
    m.tuning.giveUpMs = 150;
    deaf = 700;
    globalThis.openbotsMachines.at = 0;
    await timed();
    a.equal(active, 1);
    await Bun.sleep(250);
    a.equal(active, 1, 'the deaf round is still out, past its time');
    deaf = 0;
    globalThis.openbotsMachines.at = 0;
    a.match((await timed()).note, CONTAINED);
    const answeredAt = globalThis.openbotsMachines.at;
    // The old round comes back now, with the laptop unreachable as it was then.
    await Bun.sleep(700);
    a.equal(active, 0);
    a.equal(globalThis.openbotsMachines.list.find((t) => t.device === 'lap').status, 'ready');
    a.equal(globalThis.openbotsMachines.at, answeredAt);
    a.match(await m.machinesNote(), CONTAINED);
    // With no newer round, a late answer is the latest there is, and is kept.
    deaf = 300;
    globalThis.openbotsMachines.at = 0;
    await timed();
    await Bun.sleep(500);
    a.match(await m.machinesNote(), /- Laptop \\(machine id lap\\): unreachable right now/);
    deaf = 0;
    m.tuning.giveUpMs = 20000;
    globalThis.openbotsMachines.at = 0;
    a.match((await timed()).note, CONTAINED);

    // A device paired since the last answer is listed, as not asked yet.
    devices.addDevice({ id: 'tow', name: 'Tower', mode: 'lan', urls: ['http://y'], token: 't' });
    a.match(await m.machinesNote(), /- Tower \\(machine id tow\\): not checked yet; a call there finds out\\./);

    process.exit(0);
  `);
}, 30_000);

test("asking a paired device has a deadline at every step, and stopping a round ends its requests", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    // The real requests, to a stand-in for a paired device's server: it answers as that device, or takes the request and never answers.
    const all = { files: true, terminal: true, browser: true, unisolated: true };
    let mode = 'answer', open = 0, seen = 0;
    const device = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
      seen++;
      if (mode === 'answer') return Response.json({ grants: all }, { headers: { 'x-openbuild-server': 'lap' } });
      open++;
      req.signal.addEventListener('abort', () => open--, { once: true });
      return new Promise(() => {});
    } });
    const devices = await import('./server/devices.ts');
    devices.addDevice({ id: 'lap', name: 'Laptop', mode: 'lan', urls: ['http://127.0.0.1:' + device.port], token: 't' });
    const svc = await import('./server/bots/service.ts');
    const api = await import('./server/computers/api.ts');
    const m = await import('./server/bots/machines.ts');
    svc.setHooks({ wake() {}, stop() {} });
    const laptop = async (opts = {}) => { const started = Date.now(); const found = (await api.computerTargets({ engines: false, ...opts })).find((t) => t.device === 'lap'); return { ...found, ms: Date.now() - started }; };
    const closed = async () => { for (let i = 0; i < 40 && open; i++) await Bun.sleep(25); return open; };

    a.equal((await laptop()).status, 'ready');
    // It was just found answering, so the next thing asked of it is what it allows: it takes that request and never
    // answers. That one had no deadline of its own. It has now, and the request is ended, not left open.
    api.timing.identityMs = 300;
    mode = 'hang';
    const late = await laptop();
    a.equal(late.status, 'offline');
    a.ok(late.ms >= 250 && late.ms < 2000, 'asking what it allows took ' + late.ms + ' ms');
    a.equal(await closed(), 0, 'a request was left open');

    // A caller's signal ends a round at once, wherever it is: finding the device (it's asked afresh after a failure)...
    api.timing.identityMs = 60_000;
    let stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const finding = await laptop({ signal: stop.signal });
    a.equal(finding.status, 'offline');
    a.ok(finding.ms < 1500, 'stopping while finding it took ' + finding.ms + ' ms');
    a.equal(await closed(), 0);
    // ...or asking what it allows.
    mode = 'answer';
    a.equal((await laptop()).status, 'ready');
    mode = 'hang';
    stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const asking = await laptop({ signal: stop.signal });
    a.equal(asking.status, 'offline');
    a.ok(asking.ms < 1500, 'stopping while asking took ' + asking.ms + ' ms');
    a.equal(await closed(), 0);

    // The bots' note, through all of it: three rounds run out of time against a device that never answers, and none
    // of their requests is still open after; then the device answers, and an old round has nothing left to say.
    mode = 'answer';
    const READY = /- Laptop \\(machine id lap\\): files, terminal, browser; host \\(unisolated\\)\\./;
    a.match(await m.machinesNote(), READY);
    m.tuning.giveUpMs = 600;
    mode = 'hang';
    for (let round = 1; round <= 3; round++) {
      const before = seen;
      globalThis.openbotsMachines.at = 0;
      const started = Date.now();
      await m.machinesNote();
      a.ok(Date.now() - started < 500, 'the note waited on the round');
      // Well inside the round's time: its one request is out.
      await Bun.sleep(100);
      a.equal(open, 1, 'round ' + round + ' has one request out');
      a.equal(seen, before + 1);
      // Past it: ended, by the round, not by any deadline of the request's own (a minute, here).
      await Bun.sleep(500);
      a.equal(await closed(), 0, 'round ' + round + ' left a request open after its time ran out');
    }
    a.match(await m.machinesNote(), /- Laptop \\(machine id lap\\): unreachable right now/);
    mode = 'answer';
    globalThis.openbotsMachines.at = 0;
    // A stale note gets only a short grace to refresh, so the fresh round may land a note or two later.
    let note = await m.machinesNote();
    for (const until = Date.now() + 2000; !READY.test(note) && Date.now() < until; ) note = await Bun.sleep(25).then(() => m.machinesNote());
    a.match(note, READY);
    await Bun.sleep(400);
    a.match(await m.machinesNote(), READY);
    a.equal(open, 0);
    process.exit(0);
  `);
}, 30_000);

// ------------------------------------------------------------------ a long session is summarized quickly, and briefly

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const called = (name: string, args: Record<string, unknown>, said = "") => ({ role: "assistant", content: [...(said ? [{ type: "text", text: said }] : []), { type: "toolCall", id: "c", name, arguments: args }] });
const returned = (toolName: string, text: string, isError = false) => ({ role: "toolResult", toolName, isError, content: [{ type: "text", text }] });

test("the summarizer reads the session as a transcript: what was said in full, each call in a line, the two ends of each result", () => {
  const long = `START${"x".repeat(5000)}END`;
  const text = summaryTranscript([
    { role: "system", content: "", sections: { openbots: "You are Boss" } },
    user("Conversation 3fa91c22 (direct, “Boss”):\n[aaaa1111] Gal: ship it?\n\nThe time is Mon Nov 16 2026.\n\nReply with send_message, done true on your last call. Nothing to say: reply only [silent]."),
    user("[bbbb2222] Gal: and the tests?\n\nUse send_message to reply (one call per bubble, in this conversation unless you name another; done true on the last one ends the turn). If there's nothing to say, send nothing and end with the plain reply [silent]."),
    called("bash", { status: "Running the tests", command: "bun test" }),
    returned("bash", long),
    called("send_message", { text: "All green, shipping.", done: true }),
    returned("send_message", "Sent as [cccc3333] in conversation 3fa91c22."),
    returned("openbuild", "No such thread", true),
    { role: "compactionSummary", summary: "Now: earlier notes." },
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "…", mimeType: "image/png" }] },
  ]);
  // What arrived, without the line every prompt ends on (as it reads now, and as older sessions have it).
  expect(text).toContain("[Arrived]\nConversation 3fa91c22 (direct, “Boss”):\n[aaaa1111] Gal: ship it?\n\nThe time is Mon Nov 16 2026.");
  expect(text).toContain("[bbbb2222] Gal: and the tests?");
  expect(text).not.toMatch(/Reply with send_message|Use send_message to reply/);
  // A call is its name and arguments, without the status line meant for the user.
  expect(text).toContain("[Bot called bash]: command=bun test");
  expect(text).not.toContain("Running the tests");
  // A long result is its start and its end.
  expect(text).toMatch(/\[bash returned\]: STARTx+ \[…\d+ characters left out…\] x+END/);
  expect(text.length).toBeLessThan(2400);
  // What the bot wrote is said in full; that it was sent isn't news.
  expect(text).toContain("[Bot wrote]: All green, shipping.");
  expect(text).not.toContain("Sent as [cccc3333]");
  expect(text).toContain("[openbuild failed]: No such thread");
  expect(text).toContain("[Earlier notes]\nNow: earlier notes.");
  expect(text).toContain("look\n[image]");
  // The system prompt's own changes aren't history.
  expect(text).not.toContain("You are Boss");
  // More than the summarizer takes: the newest of it stays.
  const capped = summaryTranscript([user(`OLD ${"a".repeat(3000)}`), user("NEWEST LINE")], 500);
  expect(capped).toMatch(/^\[…the oldest \d+ characters of the transcript are left out…\]/);
  expect(capped).toContain("NEWEST LINE");
  expect(capped).not.toContain("OLD");
});

test("the summary is asked for in a few hundred words, on the bot's own model with as little thinking as it takes", async () => {
  expect(summaryPrompt(false, false)).toContain(`At most ${SUMMARY_WORDS} words`);
  expect(SUMMARY_WORDS).toBeLessThanOrEqual(800);
  expect(summaryPrompt(true, false)).toMatch(/<previous-notes> holds your notes[\s\S]*Never just append/);
  expect(summaryPrompt(false, false)).not.toContain("previous-notes");
  expect(summaryPrompt(false, true)).toContain("ending partway through the turn it is working on now");
  for (const heading of ["Now:", "Open:", "Facts:", "Earlier:"]) expect(summaryPrompt(false, false)).toContain(heading);

  // A model that can't answer without thinking is asked for its lowest level; one that can, for none.
  expect(leastThinking({ reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", high: "high" } })).toBe("low");
  expect(leastThinking({ reasoning: true, thinkingLevelMap: { low: "low" } })).toBeUndefined();
  expect(leastThinking({ reasoning: true })).toBeUndefined();
  expect(leastThinking({ reasoning: false, thinkingLevelMap: { off: null } })).toBeUndefined();

  const opus = { provider: "claude-code", id: "default", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low" } };
  const haiku = { provider: "claude-code", id: "claude-haiku-4-5-20251001", reasoning: true };
  // The bot's own model writes it, whatever else its provider has; a model named for it goes first.
  expect(summaryModel(opus, [opus, haiku], undefined)).toBe(opus);
  expect(summaryModel(opus, [opus, haiku], "claude-code/claude-haiku-4-5-20251001")).toBe(haiku);
  expect(summaryModel(opus, [opus, haiku], "nobody/none")).toBe(opus);

  const requests: { model: { id: string }; context: { systemPrompt: string; messages: { content: { text: string }[] }[] }; options: Record<string, unknown> }[] = [];
  const registry = (answers: Record<string, unknown>[]) => ({
    getAvailable: () => [opus, haiku],
    complete: async (model: { id: string }, context: never, options: Record<string, unknown>) => (requests.push({ model, context, options }), answers.shift()),
  });
  const notes = "Now: you're shipping the release.\nFacts:\n- Pull request #412 waits on Carla.";
  const answer = (text: string, extra: Record<string, unknown> = {}) => ({ stopReason: "stop", content: [{ type: "thinking", thinking: "…" }, { type: "text", text }], usage: { input: 9, output: 3 }, ...extra });
  const event = { preparation: { firstKeptEntryId: "kept1", tokensBefore: 81234, previousSummary: "Earlier: set up the repo.", messagesToSummarize: [user("[aaaa1111] Gal: ship it?"), called("bash", { command: "make release" })], turnPrefixMessages: [] } };

  const made = await summarize(event, { model: opus, modelRegistry: registry([answer(notes)]) });
  expect(made).toEqual({ compaction: { summary: notes, firstKeptEntryId: "kept1", tokensBefore: 81234, usage: { input: 9, output: 3 }, details: { by: "openbots", model: "claude-code/default" } } });
  expect(requests).toHaveLength(1);
  const sent = requests[0]!;
  expect(sent.model).toBe(opus);
  expect(sent.context.systemPrompt).toBe(SUMMARY_SYSTEM);
  const asked = sent.context.messages[0]!.content[0]!.text;
  expect(asked).toMatch(/^<transcript>\n\[Arrived\]\n\[aaaa1111\] Gal: ship it\?\n\n\[Bot called bash\]: command=make release\n<\/transcript>\n\n<previous-notes>\nEarlier: set up the repo\.\n<\/previous-notes>\n\nThe transcript above/);
  // No thinking beyond the least it takes, nothing written to the prompt cache, and room for the notes only.
  expect(sent.options).toMatchObject({ reasoning: "low", cacheRetention: "none", maxTokens: 4000 });

  // Words ahead of the first heading aren't notes: they're dropped.
  const prefaced = await summarize(event, { model: opus, modelRegistry: registry([answer(`Here are the notes.\n\n## Now\nShipping.`)]) });
  expect(prefaced.compaction.summary).toBe("## Now\nShipping.");

  // A model named for the job goes first; when it goes on with the transcript instead, the bot's own writes it.
  requests.length = 0;
  process.env.OPENBOTS_SUMMARY_MODEL = "claude-code/claude-haiku-4-5-20251001";
  try {
    const second = await summarize(event, { model: opus, modelRegistry: registry([answer('Let me check the folder first.\n<invoke name="bash">'), answer(notes)]) });
    expect(requests.map((r) => r.model.id)).toEqual(["claude-haiku-4-5-20251001", "default"]);
    expect(second.compaction.details.model).toBe("claude-code/default");
    expect(requests[0]!.options.reasoning).toBeUndefined();
  } finally {
    delete process.env.OPENBOTS_SUMMARY_MODEL;
  }

  // Nothing sound from anyone: it says why, and Pi's own summary takes over.
  expect(soundSummary(notes)).toBe(true);
  expect(soundSummary("**Now:** shipping")).toBe(true);
  expect(soundSummary("I'll look at the files first.")).toBe(false);
  expect(soundSummary('Now: <invoke name="bash">')).toBe(false);
  for (const bad of [answer("Sure! What would you like to do next?"), answer(notes, { stopReason: "length" }), answer("", { stopReason: "error", errorMessage: "overloaded" }), { stopReason: "stop", content: [{ type: "toolCall", name: "bash" }] }, answer("")]) {
    await expect(summarize(event, { model: opus, modelRegistry: registry([bad]) })).rejects.toThrow(/claude-code\/default (didn't write notes|ended with|called a tool|wrote nothing)/);
  }
  await expect(summarize({ preparation: { firstKeptEntryId: "k", messagesToSummarize: [] } }, { model: opus, modelRegistry: registry([]) })).rejects.toThrow("nothing to summarize");

  // A request that never ends, and takes no notice of being told to stop, isn't waited on past the limit...
  const deaf = { model: opus, modelRegistry: { getAvailable: () => [opus], complete: () => new Promise(() => {}) } };
  let began = Date.now();
  await expect(summarize(event, deaf, 150)).rejects.toThrow(/claude-code\/default took too long or was stopped/);
  expect(Date.now() - began).toBeLessThan(1500);
  // ...nor past Pi stopping the compaction (the turn was stopped).
  const stop = new AbortController();
  began = Date.now();
  const stopped = summarize({ ...event, signal: stop.signal }, deaf);
  setTimeout(() => stop.abort(), 50);
  await expect(stopped).rejects.toThrow(/took too long or was stopped/);
  expect(Date.now() - began).toBeLessThan(1500);
  // One that fails after it was given up on troubles nobody.
  const late = { model: opus, modelRegistry: { getAvailable: () => [opus], complete: () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 200)) } };
  await expect(summarize(event, late, 50)).rejects.toThrow(/took too long/);
  await Bun.sleep(250);

  // The extension answers Pi's session_before_compact with it, and with nothing when it fails or is switched off.
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  openbots({ on: (name: string, handler: never) => hooks.set(name, handler), registerTool() {} });
  const hook = hooks.get("session_before_compact")!;
  expect(await hook(event, { model: opus, modelRegistry: registry([answer(notes)]) })).toMatchObject({ compaction: { summary: notes } });
  expect(await hook(event, { model: opus, modelRegistry: registry([answer("nope")]) })).toBeUndefined();
  process.env.OPENBOTS_SUMMARY = "pi";
  try {
    requests.length = 0;
    expect(await hook(event, { model: opus, modelRegistry: registry([answer(notes)]) })).toBeUndefined();
    expect(requests).toHaveLength(0);
  } finally {
    delete process.env.OPENBOTS_SUMMARY;
  }
});

test("why a summary failed is written down when it can be, and a trace that can't be written never stops Pi's summary taking over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-diet-trace-"));
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  openbots({ on: (name: string, handler: never) => hooks.set(name, handler), registerTool() {} });
  const hook = hooks.get("session_before_compact")!;
  const opus = { provider: "claude-code", id: "default" };
  const event = { preparation: { firstKeptEntryId: "kept1", tokensBefore: 81234, messagesToSummarize: [user("[aaaa1111] Gal: ship it?")], turnPrefixMessages: [] } };
  // A model that goes on with the conversation, and a registry that throws outright: neither is a summary.
  const chatty = { model: opus, modelRegistry: { getAvailable: () => [opus], complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Sure! What next?" }] }) } };
  const broken = { model: opus, modelRegistry: { getAvailable: () => [opus], complete: async () => { throw new Error("socket hang up"); } } };
  const before = process.env.OPENBOTS_SUMMARY_TRACE;
  try {
    // A trace that can be written says why, a line each time, and nothing of the session.
    const file = join(dir, "trace.txt");
    process.env.OPENBOTS_SUMMARY_TRACE = file;
    expect(await hook(event, chatty)).toBeUndefined();
    expect(await hook(event, broken)).toBeUndefined();
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z claude-code\/default didn't write notes$/);
    expect(lines[1]).toMatch(/claude-code\/default socket hang up$/);
    expect(lines.join("\n")).not.toContain("ship it");

    // A folder that isn't there, a path that is a folder, a file that can't be written to, a folder that can't be entered:
    // the hook still answers undefined (Pi's own summary), and never rejects.
    const locked = join(dir, "locked.txt");
    writeFileSync(locked, "");
    chmodSync(locked, 0o400);
    const closed = join(dir, "closed");
    mkdirSync(closed);
    chmodSync(closed, 0o500);
    for (const path of ["/does-not-exist/trace.txt", dir, join(dir, "missing", "deeper", "trace.txt"), locked, join(closed, "trace.txt"), "\0bad"]) {
      process.env.OPENBOTS_SUMMARY_TRACE = path;
      await expect(hook(event, chatty)).resolves.toBeUndefined();
      await expect(hook(event, broken)).resolves.toBeUndefined();
      // The write itself never throws or rejects, whatever it's handed.
      await expect(traceSummary(new Error("why"), path)).resolves.toBeUndefined();
    }
    expect(existsSync("/does-not-exist")).toBe(false);
    // (Root writes where it likes, so only anyone else's locked file is sure to be untouched.)
    if (process.getuid?.() !== 0) expect(readFileSync(locked, "utf8")).toBe("");
    chmodSync(closed, 0o700);
    // It didn't quietly start writing somewhere else either.
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);

    // A summary that works is still used with a trace that can't be written, and with none set nothing is written.
    const notes = "Now: you're shipping the release.";
    const sound = { model: opus, modelRegistry: { getAvailable: () => [opus], complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: notes }], usage: {} }) } };
    process.env.OPENBOTS_SUMMARY_TRACE = "/does-not-exist/trace.txt";
    expect(await hook(event, sound)).toMatchObject({ compaction: { summary: notes } });
    delete process.env.OPENBOTS_SUMMARY_TRACE;
    expect(await hook(event, chatty)).toBeUndefined();
    await expect(traceSummary(new Error("why"), undefined)).resolves.toBeUndefined();
    await expect(traceSummary(undefined, file)).resolves.toBeUndefined();
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(3);
  } finally {
    if (before === undefined) delete process.env.OPENBOTS_SUMMARY_TRACE;
    else process.env.OPENBOTS_SUMMARY_TRACE = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session compacts at 80,000 tokens, not 128,000", () => {
  expect(COMPACT_AT).toBe(80_000);
  expect(compactionPolicy([{ provider: "p", id: "big", contextWindow: 1_000_000 }]).modelOverrides["p/big"]).toEqual({ reserveTokens: 920_000, keepRecentTokens: 8000 });
  // A small window still compacts at three quarters of itself.
  expect(compactionPolicy([{ provider: "p", id: "small", contextWindow: 64_000 }]).modelOverrides["p/small"]).toEqual({ reserveTokens: 16_000, keepRecentTokens: 4000 });
});

// ------------------------------------------------------------------ a turn ends on its last call

/** A stand-in for the bots service on a unix socket: answers each method as `answers` says, and keeps what it was sent. */
function fakeService(answers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-diet-socket-"));
  const got: { method: string; params: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    unix: join(dir, "bots.sock"),
    async fetch(req) {
      const { method, params } = (await req.json()) as { method: string; params: Record<string, unknown> };
      got.push({ method, params });
      try {
        return Response.json({ result: answers[method]!(params) });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 400 });
      }
    },
  });
  return { got, path: join(dir, "bots.sock"), stop: () => (server.stop(true), rmSync(dir, { recursive: true, force: true })) };
}
const stops: (() => void)[] = [];
afterAll(() => stops.forEach((stop) => stop()));

test("react, memory, todo and routine take done: the call that's a turn's last act ends it, with no request after", async () => {
  const service = fakeService({
    react: () => ({ ok: true }),
    memory: (p) => (p.text === "Likes tea" ? { id: "m1", kind: "profile", similar: [{ id: "m0", text: "Likes coffee" }], check: "These are about the same thing. Newer wins: forget any that this makes wrong." } : { id: "m2", kind: "journal" }),
    todo: () => "To-do list, 1/1 done:\n1. [abc123] [x] Ship",
    routine: (p) => {
      if (p.schedule === "never") throw new Error("That schedule isn't one I can read.");
      return { id: "r1", title: p.title, schedule: p.schedule, enabled: true };
    },
  });
  stops.push(service.stop);
  process.env.OPENBOTS_SOCKET = service.path;
  const tools = new Map<string, { parameters: { properties: Record<string, { description?: string }> }; execute: (id: string, params: Record<string, unknown>) => Promise<{ terminate?: boolean; isError?: boolean; details?: unknown }> }>();
  openbots({ on() {}, registerTool: (t: { name: string }) => tools.set(t.name, t as never) });

  // The four that a turn most often ends on besides a message say so the same way.
  for (const name of ["react", "memory", "todo", "routine"]) expect(tools.get(name)!.parameters.properties.done?.description).toBe(LAST);
  // A tool whose result the bot has to read before it can be finished takes none.
  for (const name of ["bash", "search", "openbuild", "use_app", "load_tools"]) expect(tools.get(name)!.parameters.properties.done).toBeUndefined();

  const react = tools.get("react")!;
  // Marked done and through: Pi is told to stop after this step. The service never sees the flag.
  expect((await react.execute("1", { message: "aaaa1111", emoji: "👍", done: true })).terminate).toBe(true);
  expect(service.got.at(-1)).toEqual({ method: "react", params: { message: "aaaa1111", emoji: "👍" } });
  // Not marked (a 👍 before getting on with the work): the turn goes on, as before.
  expect((await react.execute("1", { message: "aaaa1111", emoji: "👍" })).terminate).toBeUndefined();
  expect((await react.execute("1", { message: "aaaa1111", emoji: "👍", done: false })).terminate).toBeUndefined();

  expect((await tools.get("todo")!.execute("1", { action: "clear", done: true })).terminate).toBe(true);
  expect((await tools.get("routine")!.execute("1", { action: "add", title: "Standup", schedule: "Weekdays at 9:00", done: true })).terminate).toBe(true);
  expect(service.got.at(-1)!.params).toEqual({ action: "add", title: "Standup", schedule: "Weekdays at 9:00" });
  // A call that failed ends nothing: the bot reads the error.
  const refused = await tools.get("routine")!.execute("1", { action: "add", title: "x", schedule: "never", done: true });
  expect(refused.isError).toBe(true);
  expect(refused.terminate).toBeUndefined();

  const memory = tools.get("memory")!;
  expect((await memory.execute("1", { action: "write", text: "Ships on Fridays", done: true })).terminate).toBe(true);
  // A new fact much like an old one comes back with something to check: that turn isn't over.
  expect((await memory.execute("1", { action: "write", text: "Likes tea", done: true })).terminate).toBeUndefined();

  // A memory saved beside the last message, done on the message alone: the message speaks for the step, and the memory ends it too.
  const hooks = new Map<string, (event: unknown) => unknown>();
  openbots({ on: (name: string, handler: never) => hooks.set(name, handler), registerTool() {} });
  const assistant = (...calls: Record<string, unknown>[]) => hooks.get("message_end")!({ message: { role: "assistant", content: calls.map((args) => ({ type: "toolCall", name: "x", arguments: args })) } });
  assistant({ action: "write", text: "Ships on Fridays" }, { text: "Noted.", done: true });
  expect((await memory.execute("1", { action: "write", text: "Ships on Fridays" })).terminate).toBe(true);
  expect((await react.execute("1", { message: "aaaa1111", emoji: "👍" })).terminate).toBe(true);
  // One that has something for the bot to read still doesn't.
  expect((await memory.execute("1", { action: "write", text: "Likes tea" })).terminate).toBeUndefined();
  // The next step says nothing of the kind: its calls are read, as ever.
  assistant({ action: "write", text: "Ships on Fridays" });
  expect((await memory.execute("1", { action: "write", text: "Ships on Fridays" })).terminate).toBeUndefined();
  // Only a step of the model's sets it: a tool's result, or the user's message, doesn't.
  assistant({ text: "Done.", done: true });
  hooks.get("message_end")!({ message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] } });
  expect((await react.execute("1", { message: "aaaa1111", emoji: "👍" })).terminate).toBe(true);
  assistant();
  expect(stepSaysDone({ role: "user", content: [{ type: "toolCall", arguments: { done: true } }] })).toBe(false);

  // A question card ends the turn too, though its result comes with a note: the note says only to stop and wait.
  const question = tools.get("question")!;
  const cards = fakeService({ question: (p) => (p.close ? { note: "Closed: the user sees it can't be answered anymore." } : { id: "q1", note: "The user answers in the chat. Don't invent their answer; stop here and wait." }) });
  stops.push(cards.stop);
  process.env.OPENBOTS_SOCKET = cards.path;
  expect((await question.execute("1", { title: "Mornings or evenings?", options: ["Mornings", "Evenings"] })).terminate).toBe(true);
  // Closing one posts nothing and ends nothing.
  expect((await question.execute("1", { close: "q1", reason: "You said mornings" })).terminate).toBeUndefined();
  process.env.OPENBOTS_SOCKET = service.path;
  // A card asked beside a memory: the card speaks for the step. One closed beside it doesn't.
  hooks.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", name: "memory", arguments: { action: "write", text: "Ships on Fridays" } }, { type: "toolCall", name: "question", arguments: { title: "Mornings or evenings?" } }] } });
  expect((await memory.execute("1", { action: "write", text: "Ships on Fridays" })).terminate).toBe(true);
  hooks.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", name: "memory", arguments: { action: "write", text: "Ships on Fridays" } }, { type: "toolCall", name: "question", arguments: { close: "q1" } }] } });
  expect((await memory.execute("1", { action: "write", text: "Ships on Fridays" })).terminate).toBeUndefined();
  assistant();
  // A message that went out with a note about it (an @tag that reached nobody) is still read.
  expect(heard({ details: { id: "m1", conversation: "c1" } })).toBe(true);
  expect(heard({ details: { id: "m1", conversation: "c1", note: "@Tracer isn't a bot in this chat" } })).toBe(false);

  expect(settled({ details: { ok: true } })).toBe(true);
  expect(settled({ details: "To-do list" })).toBe(true);
  expect(settled({ details: null, isError: true })).toBe(false);
  expect(settled(undefined)).toBe(false);
});

// ------------------------------------------------------------------ tool results at the length a context needs

test("a shell command's result is what it printed, with only what isn't the usual said after it", () => {
  expect(shellText({ exitCode: 0, output: 'line "one"\nline two', truncated: false })).toBe('line "one"\nline two');
  expect(shellText({ exitCode: 2, output: "boom", truncated: false })).toBe("boom\n[exit code 2]");
  expect(shellText({ exitCode: null, output: "(no output)", truncated: true, note: "Something it started is still running.", ranOn: "Laptop" })).toBe("(no output)\n[exit code unknown]\n[It printed more than this: only the first 200,000 characters were kept.]\n[Something it started is still running.]\n[ran on Laptop]");
  // A call that became a background job says so in full, as does anything that isn't a command's result.
  expect(shellText({ job: 3, state: "running", note: "Still running" })).toBeUndefined();
  expect(shellText({ exitCode: 0, output: "x", job: 3 })).toBeUndefined();
  expect(shellText("text")).toBeUndefined();
  // It's a third shorter than the JSON it replaces for output with lines and quotes in it.
  const output = Array.from({ length: 40 }, (_, i) => `{"n": ${i}, "ok": true}`).join("\n");
  expect(shellText({ exitCode: 0, output, truncated: false })!.length).toBeLessThan(JSON.stringify({ exitCode: 0, output, truncated: false }, null, 2).length * 0.8);
});

test("a long output reaches the bot as its two ends, with the whole kept in a file in its home", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    import { mock } from 'bun:test';
    const files = new Map();
    let printed = '';
    let failWrites = false, hangWrites = false, slowEnsure = 0, writing = 0;
    mock.module('./server/computers/index.ts', () => ({ capabilities: async () => ({ engines: [] }), engines: async () => [], procListeners: new Set() }));
    mock.module('./server/computers/api.ts', () => ({
      computerApi: () => ({
        call: async (id, op, body, signal) => {
          // The bot's computer coming up: at once, or (slowEnsure) only after the limit for keeping an output has passed.
          if (op === 'ensure' && slowEnsure) await Bun.sleep(slowEnsure);
          if (op !== 'fs') return {};
          if (body.op === 'write') {
            // A machine that takes the file and never says it's written: the write goes on until it's told to stop.
            if (hangWrites) { writing++; await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true })); writing--; throw new Error('aborted'); }
            if (failWrites) throw new Error('disk full'); files.set(body.path, Buffer.from(body.data, 'base64').toString()); return {}; }
          if (body.op === 'read') return { data: Buffer.from(files.get(body.path) ?? '').toString('base64') };
          return {};
        },
        exec: async (id, body, onData) => (onData(Buffer.from(printed)), { exitCode: 0 }),
      }),
      computerTargets: async () => [],
    }));
    const svc = await import('./server/bots/service.ts');
    const agent = await import('./server/bots/agent.ts');
    svc.setHooks({ wake() {}, stop() {} });
    const bot = svc.createBot({ name: 'Scout' }).bot.id;
    const { SHELL_SHOWN, APP_SHOWN, READ_SHOWN, fitOutput, fitApp } = agent;
    const bash = (command) => agent.seams.handle(bot, 'bash', { command });

    // What fits comes back whole, and nothing is written anywhere.
    printed = 'ok\\n'.repeat(1000);
    a.equal((await bash('ls')).output, printed);
    a.equal(files.size, 0);

    // A build log of 60,000 characters: its start, its end, and where all of it is.
    printed = 'FIRST LINE\\n' + 'log line of the build\\n'.repeat(2800) + 'LAST LINE: 3 tests failed\\n';
    const long = await bash('make');
    a.ok(printed.length > 60000);
    a.ok(long.output.length < SHELL_SHOWN.head + SHELL_SHOWN.tail + 400, String(long.output.length));
    a.ok(long.output.startsWith('FIRST LINE\\n'));
    a.ok(long.output.endsWith('LAST LINE: 3 tests failed\\n'));
    a.match(long.output, /\\[… [\\d,]+ characters left out here\\. All [\\d,]+ characters are in ~\\/\\.outputs\\/bash-1\\.txt: grep it, or read the part you need \\(sed -n, or read with path \\.outputs\\/bash-1\\.txt, offset and limit\\)/);
    // Written from its home, which is where a host's files and a container's both start.
    a.equal(files.get('.outputs/bash-1.txt'), printed);
    a.equal(long.truncated, false);
    // The next long one gets a file of its own; the names go round, so they never pile up.
    await bash('make again');
    a.equal(files.get('.outputs/bash-2.txt'), printed);
    for (let i = 0; i < 25; i++) await bash('make ' + i);
    a.equal(files.size, 20);

    // The file can't be written: the two ends still come back, with how to get less.
    failWrites = true;
    const unsaved = await bash('make');
    a.match(unsaved.output, /characters left out here\\. Ask again for less/);
    a.doesNotMatch(unsaved.output, /\\.outputs/);
    failWrites = false;
    // A machine that takes the file and never says it's written doesn't hold the command's result either.
    agent.outputs.keepWaitMs = 150;
    hangWrites = true;
    let started = Date.now();
    const slow = await bash('make');
    a.ok(Date.now() - started < 1500, 'the result waited ' + (Date.now() - started) + ' ms on the kept file');
    a.match(slow.output, /characters left out here\\. Ask again for less/);
    a.ok(slow.output.startsWith('FIRST LINE\\n') && slow.output.endsWith('LAST LINE: 3 tests failed\\n'));
    started = Date.now();
    const slowApp = await fitApp(bot, { text: 'x'.repeat(40000), images: [] });
    a.ok(Date.now() - started < 1500);
    a.match(slowApp.text, /Ask again for less/);
    // Neither write is still going: at the limit it was ended, not left to pile up behind the next.
    a.equal(writing, 0);
    hangWrites = false;
    // The bot's computer takes longer to come up than keeping the answer may: the answer goes back without a file,
    // and when the computer is up nothing is written after all, so no file lands that nobody was told of.
    const kept = files.size;
    slowEnsure = 400;
    started = Date.now();
    const unkept = await fitApp(bot, { text: 'y'.repeat(40000), images: [] });
    a.ok(Date.now() - started < 350, 'the answer waited ' + (Date.now() - started) + ' ms on the computer starting');
    a.match(unkept.text, /Ask again for less/);
    await Bun.sleep(500);
    a.equal(files.size, kept, 'a file was written after the answer had gone back without it');
    slowEnsure = 0;
    agent.outputs.keepWaitMs = 5000;

    // An app's answer keeps more of its start than of its end; a short one is left alone.
    const short = { text: 'three issues', images: [] };
    a.equal(await fitApp(bot, short), short);
    const listing = { text: 'ISSUE 1\\n' + 'an issue with a long description\\n'.repeat(1500) + 'ISSUE LAST', images: [], isError: false };
    const fitted = await fitApp(bot, listing);
    a.ok(fitted.text.length < APP_SHOWN.head + APP_SHOWN.tail + 400);
    a.ok(fitted.text.startsWith('ISSUE 1\\n') && fitted.text.endsWith('ISSUE LAST'));
    // (The one that never got written took the first name.)
    a.match(fitted.text, /are in ~\\/\\.outputs\\/app-2\\.txt/);
    a.equal(files.get('.outputs/app-2.txt'), listing.text);
    // The bot reads the part it needs with the path the note gave it.
    a.match(await agent.seams.handle(bot, 'read', { path: '.outputs/app-2.txt', offset: 8, limit: 32 }), /^an issue with a long description\\n\\n\\[… [\\d,]+ more characters\\. Read on with offset 40/);
    a.deepEqual([fitted.images, fitted.isError], [[], false]);

    // A file read without a limit is its first part, and says how much is left and where to carry on.
    files.set('notes.txt', 'n'.repeat(READ_SHOWN + 5000));
    const part = await agent.seams.handle(bot, 'read', { path: 'notes.txt' });
    a.ok(part.startsWith('n'.repeat(READ_SHOWN)));
    a.match(part, /\\[… 5,000 more characters\\. Read on with offset 24000/);
    a.equal(await agent.seams.handle(bot, 'read', { path: 'notes.txt', offset: READ_SHOWN }), 'n'.repeat(5000));
    files.set('small.txt', 'all of it');
    a.equal(await agent.seams.handle(bot, 'read', { path: 'small.txt' }), 'all of it');

    // Just over isn't worth a note.
    const nearly = 'x'.repeat(SHELL_SHOWN.head + SHELL_SHOWN.tail + 500);
    a.equal(fitOutput(nearly, SHELL_SHOWN), nearly);
    process.exit(0);
  `);
});

// ------------------------------------------------------------------ a bot isn't sent what it just wrote

test("a memory or routine the bot adds itself doesn't send its section again; anything else does", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    const svc = await import('./server/bots/service.ts');
    const agent = await import('./server/bots/agent.ts');
    svc.setHooks({ wake() {}, stop() {} });
    svc.updateSettings({ onboarding: 'done', user: { name: 'Gal' } });
    const { bot, conversationId } = svc.createBot({ name: 'Boss' });
    const group = svc.createConversation({ kind: 'group', name: 'Team', botIds: [bot.id, svc.createBot({ name: 'Beta' }).bot.id] });
    svc.addMemory(bot.id, 'Likes tea', { kind: 'profile' });
    // The bot's turn is in its own chat; its Pi asks for its context at the start of each run.
    agent.setFocus(bot.id, conversationId);
    const context = async (extra = {}) => (await agent.seams.handle(bot.id, 'context', { tools: ['send_message'], ...extra })).sections;
    const first = await context({ fresh: true });
    a.match(first.openbots_memory, /Likes tea/);
    a.equal(first.openbots_routines, '');

    // It saves a memory and adds a routine: it has both already, as the calls that made them.
    agent.memory(bot.id, { action: 'write', text: 'Ships on Fridays' });
    agent.routine(bot.id, { action: 'add', title: 'Standup notes', schedule: 'Weekdays at 9:00', task: 'Post the notes' });
    agent.memory(bot.id, { action: 'write', text: 'Prefers short answers', kind: 'profile' });
    const second = await context();
    a.equal(second.openbots_memory, first.openbots_memory);
    a.equal(second.openbots_routines, first.openbots_routines);
    // Nothing is hidden from anyone else: the context as it stands has them.
    a.match(agent.contextFor(bot.id), /Ships on Fridays/);
    a.match(agent.contextFor(bot.id), /Prefers short answers/);
    a.match(agent.contextFor(bot.id), /Standup notes \\(Weekdays at 9:00\\)/);

    // Its Pi starts again, or summarizes the session: those calls may be gone, so everything is said.
    const fresh = await context({ fresh: true });
    a.match(fresh.openbots_memory, /Ships on Fridays/);
    a.match(fresh.openbots_memory, /Prefers short answers/);
    a.match(fresh.openbots_routines, /Standup notes/);
    a.deepEqual(await context(), fresh);

    // Its chats share one session: a memory it wrote in the group's turn is held back like one from its own chat.
    agent.memory(bot.id, { action: 'write', text: 'Own note one' });
    agent.setFocus(bot.id, group.id);
    agent.memory(bot.id, { action: 'write', text: 'Said in the group' });
    a.equal((await context()).openbots_memory, fresh.openbots_memory);
    agent.setFocus(bot.id, conversationId);
    a.equal((await context()).openbots_memory, fresh.openbots_memory);
    // One written outside its session isn't in it: the section goes again, whole.
    svc.addMemory(bot.id, 'Noted by its helper', { by: bot.id });
    const third = await context();
    a.match(third.openbots_memory, /Noted by its helper/);
    a.match(third.openbots_memory, /Said in the group/);
    a.match(third.openbots_memory, /Own note one/);

    // Forgetting or replacing one changes what the section says is true: sent at once.
    agent.memory(bot.id, { action: 'forget', text: 'Own note one' });
    const fourth = await context();
    a.doesNotMatch(fourth.openbots_memory, /Own note one/);
    agent.memory(bot.id, { action: 'write', text: 'Ships on Thursdays', replaces: 'Ships on Fridays' });
    const fifth = await context();
    a.match(fifth.openbots_memory, /Ships on Thursdays/);
    a.doesNotMatch(fifth.openbots_memory, /Ships on Fridays/);
    // So does the user editing the bot's memory in the app.
    svc.addMemory(bot.id, 'Added in the app');
    a.match((await context()).openbots_memory, /Added in the app/);

    // A routine it pauses is no longer what the section says: sent. One it adds after that isn't.
    const before = await context();
    agent.routine(bot.id, { action: 'pause', title: 'Standup notes' });
    const paused = await context();
    a.match(paused.openbots_routines, /Standup notes \\(Weekdays at 9:00\\) \\[paused\\]/);
    agent.routine(bot.id, { action: 'add', title: 'Check the build', schedule: 'in 2 hours', follow_up: true });
    a.equal((await context()).openbots_routines, paused.openbots_routines);
    a.equal((await context()).openbots_memory, before.openbots_memory);

    // A turn in the group is the same session: being there sends nothing again. A Pi that starts over gets it all.
    const held = await context();
    agent.setFocus(bot.id, group.id);
    const there = await context();
    a.deepEqual([there.openbots_routines, there.openbots_memory], [held.openbots_routines, held.openbots_memory]);
    a.doesNotMatch(there.openbots_routines, /Check the build/);
    const restarted = await context({ fresh: true });
    a.match(restarted.openbots_routines, /Check the build/);
    a.match(restarted.openbots_memory, /Ships on Thursdays/);

    // The extension says a Pi is fresh on its first run and on the one after a compaction, and not otherwise.
    const extension = (await import('./server/bots/extension.ts')).default;
    const hooks = {};
    extension({ on: (name, handler) => (hooks[name] = handler), registerTool() {}, getActiveTools: () => ['send_message'], setActiveTools() {} });
    const asked = [];
    const handle = agent.seams.handle;
    agent.seams.handle = (id, method, p, signal) => (method === 'context' && asked.push(p.fresh === true), handle(id, method, p, signal));
    agent.listen();
    process.env.OPENBOTS_SOCKET = agent.agentSocketPath();
    process.env.OPENBOTS_TOKEN = agent.mintToken(bot.id);
    const start = () => hooks.before_agent_start({ systemPromptOptions: { sections: {} } });
    await start(); await start();
    hooks.session_compact({}, {});
    await start(); await start();
    a.deepEqual(asked, [true, false, true, false]);
    process.exit(0);
  `);
});

test("only the add is held back: pausing, resuming, rewording or deleting what the bot itself added still reaches it", async () => {
  await run(`
    import { strict as a } from 'node:assert';
    const svc = await import('./server/bots/service.ts');
    const agent = await import('./server/bots/agent.ts');
    svc.setHooks({ wake() {}, stop() {} });
    svc.updateSettings({ onboarding: 'done', user: { name: 'Gal' } });
    const { bot, conversationId } = svc.createBot({ name: 'Boss' });
    agent.setFocus(bot.id, conversationId);
    const context = async (extra = {}) => (await agent.seams.handle(bot.id, 'context', { tools: ['send_message'], ...extra })).sections;
    // What the section really says right now, whatever any session was last sent.
    const real = () => agent.contextSections(bot.id);
    const routineId = (title) => svc.fullBot(bot.id).routines.find((r) => r.title === title).id;

    // --- routines
    const empty = await context({ fresh: true });
    a.equal(empty.openbots_routines, '');
    // The bot adds a routine: held back, it has the call.
    agent.routine(bot.id, { action: 'add', title: 'Standup notes', schedule: 'Weekdays at 9:00', task: 'Post the notes' });
    a.equal((await context()).openbots_routines, '');
    // It pauses that same routine: the section it holds says nothing of it, and the real one says [paused]. It's sent.
    agent.routine(bot.id, { action: 'pause', title: 'Standup notes' });
    a.match(real().openbots_routines, /Standup notes \\(Weekdays at 9:00\\) \\[paused\\]/);
    const paused = await context();
    a.equal(paused.openbots_routines, real().openbots_routines);
    // It turns it back on: sent again.
    agent.routine(bot.id, { action: 'resume', title: 'Standup notes' });
    const resumed = await context();
    a.doesNotMatch(resumed.openbots_routines, /\\[paused\\]/);
    a.equal(resumed.openbots_routines, real().openbots_routines);

    // Paused and resumed before its Pi asks again: it's as it was added, and there's nothing to correct.
    agent.routine(bot.id, { action: 'add', title: 'Check the build', schedule: 'Weekdays at 10:00' });
    agent.routine(bot.id, { action: 'pause', title: 'Check the build' });
    agent.routine(bot.id, { action: 'resume', title: 'Check the build' });
    a.equal((await context()).openbots_routines, resumed.openbots_routines);
    // The user rewords a routine the bot added, in the app: sent.
    svc.updateRoutine(bot.id, routineId('Check the build'), { title: 'Check the nightly build' });
    const reworded = await context();
    a.match(reworded.openbots_routines, /Check the nightly build/);
    a.equal(reworded.openbots_routines, real().openbots_routines);

    // Two it adds, one it removes: the section it gets has the one that's left and not the one that's gone.
    agent.routine(bot.id, { action: 'add', title: 'Water the plants', schedule: 'Fridays at 8:00' });
    agent.routine(bot.id, { action: 'add', title: 'Send the invoice', schedule: 'in 2 hours', follow_up: true });
    a.equal((await context()).openbots_routines, reworded.openbots_routines);
    agent.routine(bot.id, { action: 'remove', title: 'Send the invoice' });
    const removed = await context();
    a.match(removed.openbots_routines, /Water the plants/);
    a.doesNotMatch(removed.openbots_routines, /Send the invoice/);
    a.equal(removed.openbots_routines, real().openbots_routines);
    // One added and removed with nothing else new: what it holds is the truth again, so it's left as it is.
    agent.routine(bot.id, { action: 'add', title: 'One-off', schedule: 'in 3 hours', follow_up: true });
    agent.routine(bot.id, { action: 'remove', title: 'One-off' });
    a.equal((await context()).openbots_routines, real().openbots_routines);

    // --- memory
    svc.addMemory(bot.id, 'Likes tea', { kind: 'profile' });
    const start = await context({ fresh: true });
    agent.memory(bot.id, { action: 'write', text: 'Ships on Fridays' });
    agent.memory(bot.id, { action: 'write', text: 'Invoices go out on the 1st' });
    a.equal((await context()).openbots_memory, start.openbots_memory);
    // It forgets one of the two it just wrote: the section goes again, with the other and without that one.
    agent.memory(bot.id, { action: 'forget', text: 'Ships on Fridays' });
    const forgot = await context();
    a.match(forgot.openbots_memory, /Invoices go out on the 1st/);
    a.doesNotMatch(forgot.openbots_memory, /Ships on Fridays/);
    a.equal(forgot.openbots_memory, real().openbots_memory);

    // It writes one, then replaces it: the old wording is gone from what it's told, the new one is there.
    agent.memory(bot.id, { action: 'write', text: 'The review is on Thursday' });
    a.equal((await context()).openbots_memory, forgot.openbots_memory);
    agent.memory(bot.id, { action: 'write', text: 'The review is on Wednesday', replaces: 'The review is on Thursday' });
    const replaced = await context();
    a.match(replaced.openbots_memory, /The review is on Wednesday/);
    a.doesNotMatch(replaced.openbots_memory, /The review is on Thursday/);
    a.equal(replaced.openbots_memory, real().openbots_memory);

    // It writes one to its journal, then writes the same fact again as a profile fact: it moved, and it's told.
    agent.memory(bot.id, { action: 'write', text: 'Prefers short answers' });
    a.equal((await context()).openbots_memory, replaced.openbots_memory);
    agent.memory(bot.id, { action: 'write', text: 'Prefers short answers', kind: 'profile' });
    const moved = await context();
    a.match(moved.openbots_memory, /Your profile:[^]*Prefers short answers[^]*Your journal/);
    a.equal(moved.openbots_memory, real().openbots_memory);

    // The section counts the journal entries too old to list ("N older entries"), so one of those going changes it too.
    for (let i = 1; i <= 7; i++) svc.addMemory(bot.id, 'Old note ' + i);
    const counted = await context();
    a.match(counted.openbots_memory, /\\(\\d+ older entries: search finds them\\)/);
    a.doesNotMatch(counted.openbots_memory, /Old note 1\\b/);
    agent.memory(bot.id, { action: 'forget', text: 'Old note 1' });
    const fewer = await context();
    a.notEqual(fewer.openbots_memory, counted.openbots_memory);
    a.equal(fewer.openbots_memory, real().openbots_memory);
    // A note written outside this session, then enough of the session's own to push it off the list: it's still news.
    svc.addMemory(bot.id, 'Noted by its helper', { by: bot.id });
    for (let i = 1; i <= 6; i++) agent.memory(bot.id, { action: 'write', text: 'Own note ' + i });
    a.doesNotMatch(real().openbots_memory, /Noted by its helper/);
    const pushed = await context();
    a.notEqual(pushed.openbots_memory, fewer.openbots_memory);
    a.equal(pushed.openbots_memory, real().openbots_memory);
    const moved2 = pushed;

    // The user deletes, in the app, a memory the bot added in this session: sent.
    agent.memory(bot.id, { action: 'write', text: 'Parks at the back' });
    a.equal((await context()).openbots_memory, moved2.openbots_memory);
    svc.forgetMemory(bot.id, 'Parks at the back');
    agent.memory(bot.id, { action: 'write', text: 'Coffee machine is on the second floor' });
    const after = await context();
    a.doesNotMatch(after.openbots_memory, /Parks at the back/);
    a.match(after.openbots_memory, /Coffee machine is on the second floor/);
    a.equal(after.openbots_memory, real().openbots_memory);

    process.exit(0);
  `);
});

// ------------------------------------------------------------------ what a turn's line says of all this

test("a turn's metrics say how long it spent summarizing, and whether it ended on a call", () => {
  const T = 1_000_000;
  const meter = (calls: boolean[], compact?: [number, number]) => {
    const m = new TurnMeter({ bot: "b", trigger: "messages", waiting: true, since: T, tools: BOT_TOOLS }, T);
    m.prompt(T + 10);
    if (compact) {
      m.compaction(true, T + compact[0]);
      // Pi says it again while it retries: one summary, timed from its first start.
      m.compaction(true, T + compact[0] + 5);
      m.compaction(false, T + compact[1]);
    }
    for (const called of calls) m.request({ input: 100, output: 5 }, false, called);
    return m.finish(undefined, T + 30_000);
  };
  // A reaction that said done: one request, and the turn ended on it.
  const reacted = meter([true]);
  expect(reacted.endedOnCall).toBe(true);
  expect(reacted.compactions).toBeUndefined();
  // A message without done, then a request that said only [silent]; the session was summarized on the way in.
  const trailing = meter([true, false], [20, 18_020]);
  expect(trailing.endedOnCall).toBe(false);
  expect([trailing.compactions, trailing.compactMs]).toEqual([1, 18_000]);
  // An end that was never started counts nothing.
  const stray = new TurnMeter({ bot: "b", trigger: "note", waiting: false, since: T, tools: BOT_TOOLS }, T);
  stray.compaction(false, T + 5);
  expect(stray.finish(undefined, T + 10).compactions).toBeUndefined();

  const summary = summarizeTurns([reacted, trailing, meter([true, true])]);
  expect(summary.endedOnCallShare).toBe(0.667);
  expect(summary.compaction).toEqual({ turnShare: 0.333, ms: { n: 1, mean: 18_000, p50: 18_000, p90: 18_000 } });
  const rows = Object.fromEntries(summaryRows([summary]).map(([label, cell]) => [label!.trim(), cell]));
  expect(rows["Turns that ended on a call, no request after"]).toBe("66.7%");
  expect(rows["Turns that summarized the session first"]).toBe("33.3%");
  expect(rows["one summary: p50 / p90"]).toBe("18 s / 18 s");
  // Lines from before these fields say nothing either way, and aren't counted as turns that didn't.
  const { endedOnCall: _, ...older } = reacted;
  const mixed = summarizeTurns([older, trailing]);
  expect(mixed.endedOnCallShare).toBe(0);
  expect(summarizeTurns([older]).endedOnCallShare).toBeUndefined();
  expect(Object.fromEntries(summaryRows([summarizeTurns([older])]).map(([label, cell]) => [label!.trim(), cell]))["Turns that summarized the session first"]).toBe("–");
});

// ------------------------------------------------------------------ real Pi takes the extension's summary

const pi = piBin();

// Real Pi and a fake model (CI has no Pi: scripts/bot-compaction-bench.ts times the real thing): asked
// to compact a long session, Pi takes the summary the bots extension wrote, and its own when that fails.
test.skipIf(!pi)("Pi compacts a bot's session with the extension's summary, and with its own when the extension's isn't one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-diet-compact-"));
  try {
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "k" } }));
    const { code, stderr: err } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { madeUpSession } from './scripts/bot-compaction-bench.ts';
      import { SUMMARY_SYSTEM } from './server/bots/extension.ts';
      const sse = (delta, finish) => 'data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish ?? null }] }) + '\\n\\n';
      const say = (text) => sse({ role: 'assistant', content: text }) + sse({}, 'stop') + 'data: [DONE]\\n\\n';
      const NOTES = 'Now: you were checking the Northwind rebrand.\\nFacts:\\n- Pull request #412 waits on Carla.';
      const asked = [];
      let sound = true;
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
        const body = await req.json();
        const text = JSON.stringify(body.messages);
        const ours = text.includes(SUMMARY_SYSTEM.slice(0, 60));
        asked.push({ ours, text });
        // The extension's request gets notes, or (second session) something that isn't; Pi's own gets its own format.
        return new Response(say(ours ? (sound ? NOTES : 'Sure! What should I look at next?') : '## Goal\\nPi wrote this one.'), { headers: { 'content-type': 'text/event-stream' } });
      } });
      writeFileSync(process.env.PI_CODING_AGENT_DIR + '/models.json', JSON.stringify({ providers: { mock: { baseUrl: 'http://127.0.0.1:' + server.port + '/v1', api: 'openai-completions', models: [{ id: 'm' }] } } }));
      const svc = await import('./server/bots/service.ts');
      const { PiProcess } = await import('./server/pi/rpc.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { compactionPolicy } = await import('./server/bots/sessionPolicy.ts');
      svc.setHooks({ wake() {}, stop() {} });

      /** Starts a bot's Pi on a long made-up session, compacts it, and returns the session's compaction entry. */
      async function compact(name) {
        const work = join(${JSON.stringify(dir)}, name, 'work');
        const sessions = join(${JSON.stringify(dir)}, name, 'session');
        mkdirSync(join(work, '.pi'), { recursive: true });
        mkdirSync(sessions, { recursive: true });
        writeFileSync(join(work, '.pi', 'settings.json'), JSON.stringify({ compaction: compactionPolicy([]), steeringMode: 'all' }));
        const [first, ...rest] = madeUpSession(120_000, { provider: 'mock', id: 'm' }).split('\\n');
        const header = JSON.parse(first);
        const file = join(sessions, '2026-11-01T08-00-00-000Z_' + header.id + '.jsonl');
        writeFileSync(file, [JSON.stringify({ ...header, cwd: work }), ...rest].join('\\n'));
        const proc = new PiProcess(['--approve', '--session-dir', sessions, '--session-id', header.id, ...piFlags()], work, { OPENBOTS_SOCKET: join(work, 'no.sock'), OPENBOTS_TOKEN: 'none', OPENBOTS_BOT: 'bench', OPENBOTS_PRELOAD: 'bash' });
        try {
          await proc.send({ type: 'get_state' }, 60_000);
          await proc.send({ type: 'set_model', provider: 'mock', modelId: 'm' }, 20_000);
          await proc.send({ type: 'compact' }, 120_000);
        } finally {
          proc.close();
        }
        return readFileSync(file, 'utf8').split('\\n').filter(Boolean).map((line) => JSON.parse(line)).findLast((entry) => entry.type === 'compaction');
      }

      // The extension's notes are the session's summary, and say who wrote them.
      const first = await compact('one');
      a.equal(first.summary, NOTES);
      a.equal(first.fromHook, true);
      a.deepEqual(first.details, { by: 'openbots', model: 'mock/m' });
      a.ok(first.firstKeptEntryId, 'the newest messages stay as they are');
      // One request, the extension's: the session as a transcript, and what to write.
      a.equal(asked.length, 1);
      a.equal(asked[0].ours, true);
      a.match(asked[0].text, /<transcript>\\\\n\\[Arrived\\]\\\\nConversation 3fa91c22/);
      a.match(asked[0].text, /\\[Bot called bash\\]: command=grep/);
      a.match(asked[0].text, /\\[Bot wrote\\]: On /);
      a.match(asked[0].text, /At most \\d+ words in all/);
      // The line every prompt ends on isn't handed to the summarizer.
      a.doesNotMatch(asked[0].text, /Use send_message to reply/);

      // The model goes on with the conversation instead of summarizing it: Pi's own summary takes over.
      sound = false;
      asked.length = 0;
      const second = await compact('two');
      a.equal(second.summary.startsWith('## Goal\\nPi wrote this one.'), true, second.summary.slice(0, 80));
      a.ok(!second.fromHook);
      a.deepEqual(asked.map((r) => r.ours).slice(0, 2), [true, false]);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: join(dir, "data"), PI_CODING_AGENT_DIR: agent, PI_BIN: pi!, PI_OFFLINE: "1", OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json") });
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
