// A bot's words that reached no one: what a step wrote beside its tool calls (a text block, or the
// progress note Claude 5.5 models return as a thinking block) when what it sent can't have been the
// reply. On 2026-11-20 Dr Eggbot wrote its whole explanation that way, sent a one-line aside and a
// question card, then "Sent the explanation above": the user saw none of it. Now the step's first
// tool result tells the bot, once a turn, and that step doesn't end the turn.
import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import openbots, { progressNote, stepIn, STUB_MAX, turnStarts, UNSAID_MIN, unsaidNote, unsaidWords } from "../server/bots/extension";

/** The incident's steps as Dr Eggbot's Pi session stored them: real signatures, real progress notes. */
const incident = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/botUnsaid/incident.json"), "utf8")) as Record<"aside" | "card" | "above" | "fixed", { role: string; model: string; content: any[] }>;

/** A signature whose clear header names its block, as the API's do ("thinking" or "narration"), then opaque bytes. */
function signature(kind: string): string {
  const head = `\x08\x04\x12\xae\x0f\n\x11\x08\x14\x18\x028\x01B${String.fromCharCode(kind.length)}${kind}\x12\x0c`;
  return btoa(head + "\xa6GQ\x8ba@\xed\xb6\xf2\xd4\xc5\xac\x1a\x0c".repeat(6));
}
const reasoning = (thinking: string) => ({ type: "thinking", thinking, thinkingSignature: signature("thinking") });
const narration = (thinking: string) => ({ type: "thinking", thinking, thinkingSignature: signature("narration") });
const said = (text: string) => ({ type: "text", text });
const call = (name: string, args: Record<string, unknown>) => ({ type: "toolCall", id: `t-${name}`, name, arguments: args });
const step = (...content: unknown[]) => ({ role: "assistant", content });

const EXPLANATION = "The dark theme's near-black layers look flat on your PC monitors, whose raised blacks wash out the small steps between them, so I'd widen the layer contrast, use solid borders instead of translucent white overlays, and set color-scheme dark, though that only narrows the gap rather than matching the Mac.";
const THOUGHT = "I'm looking at why the dark theme could look off: its near-black colors and low-alpha white overlays sit so close together that on panels with raised blacks they get crushed.";

test("a real progress note is told from real reasoning by its signature", () => {
  // Every step of the incident carries a reasoning block and then a progress note, both as thinking.
  for (const s of [incident.aside, incident.card, incident.above, incident.fixed]) {
    expect(s.model).toBe("claude-sonnet-5-5");
    const thinking = s.content.filter((b) => b.type === "thinking");
    expect(thinking.map(progressNote)).toEqual([false, true]);
    expect(thinking[1].thinking.length).toBeGreaterThan(UNSAID_MIN);
  }
  // The incident's explanation is the note, not the reasoning.
  expect(incident.above.content.find(progressNote).thinking).toMatch(/near-black layers look flat on your PC monitors/);
  // Made-up signatures and broken ones: only a header that says narration is one.
  expect(progressNote(narration("Checking the build."))).toBe(true);
  expect(progressNote(reasoning("Checking the build."))).toBe(false);
  expect(progressNote({ ...narration("x"), redacted: true })).toBe(false);
  expect(progressNote({ type: "thinking", thinking: "x" })).toBe(false);
  expect(progressNote({ type: "thinking", thinking: "x", thinkingSignature: "%%% not base64 %%%" })).toBe(false);
  expect(progressNote({ type: "text", text: "x", thinkingSignature: signature("narration") })).toBe(false);
});

test("the incident's steps are caught: a stub that ends the turn, a bare card, a message pointing above", () => {
  const note = (s: { content: any[] }) => s.content.find(progressNote).thinking.trim();
  expect(unsaidWords(incident.aside)).toBe(note(incident.aside));
  expect(unsaidWords(incident.card)).toBe(note(incident.card));
  expect(unsaidWords(incident.above)).toBe(note(incident.above));
  // The fix that went out ("I said I'd sent an explanation but I hadn't"): the message carries it all.
  expect(unsaidWords(incident.fixed)).toBeUndefined();
  // The same shape in text from any model: a stub plus "see above", with or without done.
  expect(unsaidWords(step(said(EXPLANATION), call("send_message", { text: "See above." })))).toBe(EXPLANATION);
  expect(unsaidWords(step(reasoning(THOUGHT), narration(EXPLANATION), call("send_message", { text: "Sent you the explanation above. Say start and I'll go.", done: true })))).toBe(EXPLANATION);
});

test("ordinary steps aren't flagged: a shorter verdict, a reaction, a plan beside a command", () => {
  // A bot drafts 160 characters, then sends a shorter verdict and ends its turn.
  const draft = "Reading #385 at 227ce17: the Threads tab now always shows, the empty state links to Advanced when coding agents are off, and the rename is complete. No blockers";
  expect(draft.length).toBe(160);
  const verdict = "Approved #385 at 227ce17: no blockers. The empty states read well and the rename is complete.";
  expect(verdict.length).toBeLessThan(draft.length);
  expect(unsaidWords(step(said(draft), call("send_message", { text: verdict, done: true })))).toBeUndefined();
  // Even a one-liner: what it says is the verdict, not a pointer to one.
  expect(unsaidWords(step(said(draft), call("send_message", { text: "Approved #385, no blockers.", done: true })))).toBeUndefined();

  // A bot decides tracer 2 already said it and only reacts: staying quiet isn't a lost reply.
  const react = "tracer 2 already said this in the group: the head moved and the lock logic needs a fresh look. Nothing to add from me, so I'll just react to show I saw it.";
  expect(react.length).toBeGreaterThan(UNSAID_MIN);
  expect(unsaidWords(step(said(react), call("react", { message: "42725bde", emoji: "👍", done: true })))).toBeUndefined();
  expect(unsaidWords(step(narration(react), call("react", { message: "42725bde", emoji: "👍", done: true })))).toBeUndefined();
  // Nor is [silent], or a memory saved on the way out.
  expect(unsaidWords(step(said(`${react} [silent]`), call("memory", { action: "write", text: "tracer 2 covers lock reviews.", done: true })))).toBeUndefined();

  // "On it" with the plan beside the command that starts the work: the turn goes on, and it will write again.
  const plan = "On it. First I'll pull the PR head and read the diff against main, then run typecheck and the bot tests, and if anything fails I'll trace it back before I report a verdict to Dr Eggbot here.";
  expect(plan.length).toBeGreaterThan(STUB_MAX * 1.5);
  expect(unsaidWords(step(said(plan), call("send_message", { text: "On it." }), call("bash", { command: "git fetch origin pull/385/head" })))).toBeUndefined();
  expect(unsaidWords(step(narration(plan), call("send_message", { text: "On it." }), call("bash", { command: "git fetch origin pull/385/head" })))).toBeUndefined();

  // Thinking aloud, reasoning however long, and a step that is only text (the runner posts that one).
  expect(unsaidWords(step(said("Docs only, no READMEs. Asking tracer to review."), call("send_message", { text: "See the PR above, @tracer.", done: true })))).toBeUndefined();
  expect(unsaidWords(step(reasoning(EXPLANATION + EXPLANATION), call("send_message", { text: "On it.", done: true })))).toBeUndefined();
  expect(unsaidWords(step(said(EXPLANATION)))).toBeUndefined();
  expect(unsaidWords({ role: "user", content: [said(EXPLANATION)] })).toBeUndefined();
});

test("the note never asks for a second copy of a message that went out", () => {
  const note = unsaidNote(EXPLANATION.length);
  expect(note).toMatch(/^Not delivered: the \d+ characters/);
  expect(note).toContain("If that was a reply you meant to send and haven't, send it now with send_message. Otherwise end your turn.");
  expect(note).not.toMatch(/in full|re-?send|again/i);
});

/** The extension against a bots service where every call goes through. */
async function withExtension(run: (x: { end: (message: unknown) => void; start: () => void; tool: (name: string) => any; sent: string[]; dir: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-unsaid-"));
  const socket = join(dir, "agent.sock");
  const sent: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      if (method === "send_message") sent.push(params.text);
      const result = method === "question" ? { id: "q1" } : method === "send_message" ? { id: `m${sent.length}`, conversation: "dd8e6bad" } : method === "context" ? { sections: {} } : { ok: true };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const before = process.env.OPENBOTS_SOCKET;
  process.env.OPENBOTS_SOCKET = socket;
  try {
    const hooks: Record<string, Function[]> = {};
    const tools = new Map<string, any>();
    openbots({ on: (name: string, h: Function) => (hooks[name] ??= []).push(h), registerTool: (t: any) => tools.set(t.name, t) });
    const end = (message: unknown) => { for (const h of hooks.message_end ?? []) h({ message }); };
    // A turn starts as Pi starts one: before_agent_start, which a steer doesn't fire.
    const start = () => { for (const h of hooks.before_agent_start ?? []) void h({ systemPromptOptions: { sections: {} } }); };
    start();
    await run({ end, start, tool: (name) => tools.get(name), sent, dir });
  } finally {
    if (before === undefined) delete process.env.OPENBOTS_SOCKET;
    else process.env.OPENBOTS_SOCKET = before;
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

test("the step's first result tells the bot, and that step doesn't end the turn", async () => {
  await withExtension(async ({ end, start, tool, sent, dir }) => {
    // The incident's aside: the message goes out, the bot reads that its explanation didn't, and the turn goes on.
    const stub = incident.aside.content.find((b) => b.type === "toolCall").arguments;
    end(incident.aside);
    const told = await tool("send_message").execute("1", stub);
    expect(sent).toEqual([stub.text]);
    expect(text(told)).toMatch(/^Sent as \[m1\] in conversation dd8e6bad\./);
    expect(text(told)).toContain(unsaidNote(incident.aside.content.find(progressNote).thinking.trim().length));
    expect(told.terminate).toBeUndefined();
    // A second call in that step was already told about: done ends it as ever.
    expect((await tool("send_message").execute("2", stub)).terminate).toBe(true);
    // The next step sends the words, and done ends the turn there.
    const full = { text: EXPLANATION, done: true };
    end(step(call("send_message", full)));
    const delivered = await tool("send_message").execute("3", full);
    expect(text(delivered)).not.toContain("Not delivered");
    expect(delivered.terminate).toBe(true);

    // A question card ends a turn by its own rule, but not a bare one whose explanation never reached the user.
    start();
    const card = incident.card.content.find((b) => b.type === "toolCall").arguments;
    end(incident.card);
    const asked = await tool("question").execute("4", card);
    expect(text(asked)).toContain("Not delivered");
    expect(asked.terminate).toBeUndefined();

    // A failed call carries the note too (it ends nothing anyway), and the note goes no further.
    start();
    process.env.OPENBOTS_SOCKET = join(dir, "gone.sock");
    end(incident.above);
    const failed = await tool("send_message").execute("5", { text: "Sent the explanation above.", done: true });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain("Not delivered");
    stepIn(step(call("send_message", stub)));
    expect(text(await tool("send_message").execute("6", stub))).not.toContain("Not delivered");
  });
});

test("a turn is told once: a bot that keeps writing beside short messages still ends it", async () => {
  await withExtension(async ({ end, start, tool }) => {
    const stub = { text: "Sent the explanation above.", done: true };
    const again = step(narration(EXPLANATION), call("send_message", stub));
    end(again);
    const first = await tool("send_message").execute("1", stub);
    expect(text(first)).toContain("Not delivered");
    expect(first.terminate).toBeUndefined();
    // It answers with the same shape: told once already, so this step ends the turn.
    for (const id of ["2", "3"]) {
      end(again);
      const next = await tool("send_message").execute(id, stub);
      expect(text(next)).not.toContain("Not delivered");
      expect(next.terminate).toBe(true);
    }
    // A new turn can be told again, as Pi starts it or as turnStarts says.
    start();
    end(again);
    expect(text(await tool("send_message").execute("4", stub))).toContain("Not delivered");
    turnStarts();
    end(again);
    expect(text(await tool("send_message").execute("5", stub))).toContain("Not delivered");
    // A steer into that turn starts nothing: the next step is still the same turn's, and ends it.
    end(step(narration(EXPLANATION), call("send_message", { text: "See above.", done: true })));
    expect((await tool("send_message").execute("6", { text: "See above.", done: true })).terminate).toBe(true);
  });
});
