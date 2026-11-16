// What a bot's turn no longer waits on or carries (docs/openbots-context-diet.md has the numbers):
// a paired device that doesn't answer in front of every turn, a minute of summarizing on the bot's
// own model, a model request that only says the turn is over, and tool results at full length.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import openbots, { heard, LAST, stepSaysDone, SUMMARY_SYSTEM, SUMMARY_WORDS, leastThinking, settled, shellText, soundSummary, summarize, summaryModel, summaryPrompt, summaryTranscript } from "../server/bots/extension";
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
    let asleep = false, asked = 0;
    mock.module('./server/computers/index.ts', () => ({ capabilities: async () => ({ engines: [] }), engines: async () => [], procListeners: new Set() }));
    mock.module('./server/computers/api.ts', () => ({
      computerApi: () => ({ call: async () => ({}) }),
      computerTargets: async () => {
        asked++;
        if (asleep) await Bun.sleep(1200);
        return [{ device: 'local', name: 'Studio', status: 'ready', grants: all }, asleep ? { device: 'lap', name: 'Laptop', status: 'offline', message: 'no answer' } : { device: 'lap', name: 'Laptop', status: 'ready', grants: all }];
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
    // A device paired since the last answer is listed, as not asked yet.
    devices.addDevice({ id: 'tow', name: 'Tower', mode: 'lan', urls: ['http://y'], token: 't' });
    a.match(await m.machinesNote(), /- Tower \\(machine id tow\\): not checked yet; a call there finds out\\./);

    process.exit(0);
  `);
});

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
    let failWrites = false;
    mock.module('./server/computers/index.ts', () => ({ capabilities: async () => ({ engines: [] }), engines: async () => [], procListeners: new Set() }));
    mock.module('./server/computers/api.ts', () => ({
      computerApi: () => ({
        call: async (id, op, body) => {
          if (op !== 'fs') return {};
          if (body.op === 'write') { if (failWrites) throw new Error('disk full'); files.set(body.path, Buffer.from(body.data, 'base64').toString()); return {}; }
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
    a.match(long.output, /\\[… [\\d,]+ characters left out here\\. All [\\d,]+ characters are in ~\\/\\.outputs\\/bash-1\\.txt: grep it, or read the part you need/);
    a.equal(files.get('~/.outputs/bash-1.txt'), printed);
    a.equal(long.truncated, false);
    // The next long one gets a file of its own; the names go round, so they never pile up.
    await bash('make again');
    a.equal(files.get('~/.outputs/bash-2.txt'), printed);
    for (let i = 0; i < 25; i++) await bash('make ' + i);
    a.equal(files.size, 20);

    // The file can't be written: the two ends still come back, with how to get less.
    failWrites = true;
    const unsaved = await bash('make');
    a.match(unsaved.output, /characters left out here\\. Ask again for less/);
    a.doesNotMatch(unsaved.output, /\\.outputs/);
    failWrites = false;

    // An app's answer keeps more of its start than of its end; a short one is left alone.
    const short = { text: 'three issues', images: [] };
    a.equal(await fitApp(bot, short), short);
    const listing = { text: 'ISSUE 1\\n' + 'an issue with a long description\\n'.repeat(1500) + 'ISSUE LAST', images: [], isError: false };
    const fitted = await fitApp(bot, listing);
    a.ok(fitted.text.length < APP_SHOWN.head + APP_SHOWN.tail + 400);
    a.ok(fitted.text.startsWith('ISSUE 1\\n') && fitted.text.endsWith('ISSUE LAST'));
    a.match(fitted.text, /are in ~\\/\\.outputs\\/app-1\\.txt/);
    a.equal(files.get('~/.outputs/app-1.txt'), listing.text);
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

    // A memory it wrote in another chat's turn isn't in this session: the section goes again, whole.
    agent.memory(bot.id, { action: 'write', text: 'Own note one' });
    agent.setFocus(bot.id, group.id);
    agent.memory(bot.id, { action: 'write', text: 'Said in the group' });
    agent.setFocus(bot.id, conversationId);
    const third = await context();
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

    // Each chat's session keeps its own: the group's has seen none of this, and gets it as it stands.
    agent.setFocus(bot.id, group.id);
    const there = await context({ fresh: true });
    a.match(there.openbots_routines, /Check the build/);
    a.match(there.openbots_memory, /Ships on Thursdays/);

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
