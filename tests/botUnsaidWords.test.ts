// A bot's words that reached no one: what a step wrote beside its tool calls (a text block, or the
// progress note Claude 5.5 models return as a thinking block) when what it sent said less. On
// 2026-11-20 Dr Eggbot wrote its whole explanation that way, sent a one-line aside and a question card,
// then "Sent the explanation above": the user saw none of it. Now the step's first tool result tells
// the bot, and that step doesn't end the turn, so it sends the words.
import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import openbots, { progressNote, stepIn, UNSAID_MIN, unsaidNote, unsaidWords } from "../server/bots/extension";

/** A signature whose clear header names its block, as the API's do ("thinking" or "narration"), then opaque bytes. */
function signature(kind: string): string {
  const head = `\x08\x04\x12\xae\x0f\n\x11\x08\x14\x18\x028\x01B${String.fromCharCode(kind.length)}${kind}\x12\x0c`;
  return btoa(head + "\xa6GQ\x8ba@\xed\xb6\xf2\xd4\xc5\xac\x1a\x0c".repeat(6));
}
const reasoning = (thinking: string) => ({ type: "thinking", thinking, thinkingSignature: signature("thinking") });
const narration = (thinking: string) => ({ type: "thinking", thinking, thinkingSignature: signature("narration") });
const call = (name: string, args: Record<string, unknown>) => ({ type: "toolCall", id: `t-${name}`, name, arguments: args });
const step = (...content: unknown[]) => ({ role: "assistant", content });

// The incident's three steps, as Dr Eggbot's session has them (claude-code, claude-sonnet-5-5).
const EXPLANATION = "The dark theme's near-black layers look flat on your PC monitors, whose raised blacks wash out the small steps between them, so I'd widen the layer contrast, use solid borders instead of translucent white overlays, and set color-scheme dark, though that only narrows the gap rather than matching the Mac.";
const THOUGHT = "I'm looking at why the dark theme could look off: its near-black colors and low-alpha white overlays sit so close together that on panels with raised blacks they get crushed.";

test("a progress note is told from reasoning by its signature, never by its words", () => {
  expect(progressNote(narration("Checking the build."))).toBe(true);
  expect(progressNote(reasoning("Checking the build."))).toBe(false);
  // Redacted, unsigned, broken or not thinking at all: not one.
  expect(progressNote({ ...narration("x"), redacted: true })).toBe(false);
  expect(progressNote({ type: "thinking", thinking: "x" })).toBe(false);
  expect(progressNote({ type: "thinking", thinking: "x", thinkingSignature: "%%% not base64 %%%" })).toBe(false);
  expect(progressNote({ type: "text", text: "x", thinkingSignature: signature("narration") })).toBe(false);
});

test("a step's words that its message didn't carry are caught: the incident's three steps", () => {
  // The aside, the question card, and the message that said the explanation was already sent.
  const aside = step(reasoning(THOUGHT), narration(EXPLANATION), call("send_message", { text: "(Applies to OpenBuild and KodBot both; I'd do it in OpenBuild first and port it.)", done: true }));
  const card = step(reasoning(THOUGHT), narration(EXPLANATION), call("question", { title: "Want me to start the dark theme contrast work?", options: ["Yes, OpenBuild first, then port to KodBot", "Not now"], done: true }));
  const above = step(reasoning(THOUGHT), narration(EXPLANATION), call("send_message", { text: "Sent the explanation above. Reply \"start\" or send the photo and I'll go.", done: true }));
  for (const s of [aside, card, above]) expect(unsaidWords(s)).toBe(EXPLANATION);
  // Text blocks from any model count the same: text before a call is never posted.
  expect(unsaidWords(step({ type: "text", text: EXPLANATION }, call("send_message", { text: "See above." })))).toBe(EXPLANATION);
  // A turn ending on a call that isn't a message, with the answer written beside it.
  expect(unsaidWords(step(narration(EXPLANATION), call("memory", { action: "write", text: "Outis's monitors lift blacks.", done: true })))).toBe(EXPLANATION);
});

test("words a message did carry, short asides, reasoning and work in progress aren't flagged", () => {
  // The fix that went out: the explanation in the message itself, its note only a summary of it.
  const full = `You're right, I'm sorry. Here it is. ${EXPLANATION} A screenshot from the PC monitor would help as a reference.`;
  expect(unsaidWords(step(narration(EXPLANATION), call("send_message", { text: full, done: true })))).toBeUndefined();
  // A model that drafts its message in text and then sends it, a little reworded.
  const draft = `Short version: ${EXPLANATION}`;
  expect(unsaidWords(step({ type: "text", text: draft }, call("send_message", { text: draft.replace("Short version: ", "").replace("I'd", "I would") })))).toBeUndefined();
  // Thinking aloud before a message: too short to be a reply.
  const aside = "Docs only, no READMEs. Asking tracer to review.";
  expect(aside.length).toBeLessThan(UNSAID_MIN);
  expect(unsaidWords(step({ type: "text", text: aside }, call("send_message", { text: "@tracer please review #383." })))).toBeUndefined();
  // Reasoning, however long, is the model's own.
  expect(unsaidWords(step(reasoning(EXPLANATION + EXPLANATION), call("send_message", { text: "On it." })))).toBeUndefined();
  // A note before work that goes on: the turn isn't over, and the status line shows the step.
  expect(unsaidWords(step(narration(EXPLANATION), call("bash", { command: "ls" })))).toBeUndefined();
  // [silent] is never words for anyone, and a step with no call is the runner's (it posts the reply).
  expect(unsaidWords(step({ type: "text", text: "[silent] ".repeat(30) }, call("react", { message: "m", emoji: "👍", done: true })))).toBeUndefined();
  expect(unsaidWords(step({ type: "text", text: EXPLANATION }))).toBeUndefined();
  expect(unsaidWords({ role: "user", content: [{ type: "text", text: EXPLANATION }] })).toBeUndefined();
});

test("the step's first result tells the bot, once, and that step doesn't end the turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-unsaid-"));
  const socket = join(dir, "agent.sock");
  const sent: string[] = [];
  // The bots service: every message goes out.
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      if (method === "send_message") sent.push(params.text);
      const result = method === "question" ? { id: "q1" } : method === "send_message" ? { id: `m${sent.length}`, conversation: "dd8e6bad" } : { ok: true };
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
    const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

    // The aside step: the message goes out, the bot reads that its explanation didn't, and the turn goes on.
    const stub = { text: "(Applies to OpenBuild and KodBot both.)", done: true };
    end(step(reasoning(THOUGHT), narration(EXPLANATION), call("send_message", stub)));
    const told = await tools.get("send_message").execute("1", stub);
    expect(sent).toEqual([stub.text]);
    expect(text(told)).toContain(unsaidNote(EXPLANATION.length));
    expect(text(told)).toMatch(/^Sent as \[m1\] in conversation dd8e6bad\./);
    expect(told.terminate).toBeUndefined();
    // A second call in that step was already told about: done ends it as ever.
    expect((await tools.get("send_message").execute("2", stub)).terminate).toBe(true);

    // The next step sends the words: it says nothing more, and done ends the turn there.
    const full = { text: EXPLANATION, done: true };
    end(step(call("send_message", full)));
    const delivered = await tools.get("send_message").execute("3", full);
    expect(text(delivered)).not.toContain("Not delivered");
    expect(delivered.terminate).toBe(true);

    // A question card ends a turn by its own rule, but not one whose words never reached the user.
    const card = { title: "Want me to start?", options: ["Yes", "Not now"] };
    end(step(narration(EXPLANATION), call("question", card)));
    const asked = await tools.get("question").execute("4", card);
    expect(text(asked)).toContain("Not delivered");
    expect(asked.terminate).toBeUndefined();
    end(step(call("question", card)));
    expect((await tools.get("question").execute("5", card)).terminate).toBe(true);

    // Nor does a memory saved with done on a step whose answer was written beside it.
    const memo = { action: "write", text: "Outis's monitors lift blacks.", done: true };
    end(step(narration(EXPLANATION), call("memory", memo)));
    const saved = await tools.get("memory").execute("6", memo);
    expect(text(saved)).toContain("Not delivered");
    expect(saved.terminate).toBeUndefined();

    // A failed call still carries the note (it ends nothing anyway), and the note goes no further.
    process.env.OPENBOTS_SOCKET = join(dir, "gone.sock");
    end(step(narration(EXPLANATION), call("send_message", stub)));
    const failed = await tools.get("send_message").execute("7", stub);
    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain("Not delivered");
    stepIn(step(call("send_message", stub)));
    expect(text(await tools.get("send_message").execute("8", stub))).not.toContain("Not delivered");
  } finally {
    if (before === undefined) delete process.env.OPENBOTS_SOCKET;
    else process.env.OPENBOTS_SOCKET = before;
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
