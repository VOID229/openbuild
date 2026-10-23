import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import questionAsk, { cleanOptions, letter } from "../server/pi/extensions/question-ask";

test("question_ask options drop blanks, duplicates and a hand-made Other", () => {
  expect(cleanOptions([" Postgres ", "SQLite", "Postgres", "", "Other", "C) Something else", "None of the above"])).toEqual(["Postgres", "SQLite"]);
  expect(cleanOptions(undefined)).toEqual([]);
  expect([0, 1, 25, 26].map(letter)).toEqual(["A", "B", "Z", "27"]);
});

/** The extension against a stand-in for Pi's API, answering its dialog with `answer`. */
async function run(params: { question: string; options?: string[] }, answer: string | undefined) {
  let tool: any;
  const handlers = new Map<string, (event: any) => void>();
  let active = ["read", "ask", "question_ask"];
  questionAsk({
    registerTool: (t: any) => (tool = t),
    on: (event: string, fn: any) => handlers.set(event, fn),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => (active = names),
  });
  handlers.get("session_start")!({});
  const prompt = { appendSystemPrompt: "Be brief.\n\nWhen you need a decision or clarification to proceed, call the ask tool instead of asking in prose." };
  handlers.get("before_agent_start")!({ systemPromptOptions: prompt });
  const asked: unknown[] = [];
  const ctx = { hasUI: true, ui: { select: async (...args: unknown[]) => (asked.push(args.slice(0, 2)), answer) } };
  const result = await tool.execute("call-1", params, new AbortController().signal, undefined, ctx);
  return { result, asked, active, prompt: prompt.appendSystemPrompt };
}

test("question_ask asks once and reports a choice, the user's own words, or a dismissal", async () => {
  const chose = await run({ question: "Which database?", options: ["Postgres", "SQLite", "Other"] }, "SQLite");
  expect(chose.asked).toEqual([["Which database?", ["Postgres", "SQLite"]]]);
  expect(chose.result.content[0].text).toBe("User selected B. SQLite");
  expect(chose.result.details).toMatchObject({ answer: "SQLite", letter: "B" });

  const own = await run({ question: "Which database?", options: ["Postgres"] }, "DuckDB");
  expect(own.result.content[0].text).toBe("User answered in their own words: DuckDB");
  expect(own.result.details).toMatchObject({ answer: "DuckDB", custom: true });

  const dismissed = await run({ question: "Which database?" }, undefined);
  expect(dismissed.result.details.answer).toBeNull();
  expect(dismissed.result.isError).toBeUndefined();
});

test("question_ask replaces the terminal-only ask tool and its prompt note", async () => {
  const { active, prompt } = await run({ question: "Go?" }, "Yes");
  expect(active).toEqual(["read", "question_ask"]);
  expect(prompt).not.toContain("call the ask tool");
  expect(prompt).toStartWith("Be brief.");
  expect(prompt).toContain("call question_ask");
});

// In its own process, like the discovery test, so it never opens the user's real database.
test("a question_ask call in a Pi transcript reads as an answered question", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-question-"));
  const script = `
    import { strict as assert } from "node:assert";
    const { projectSession } = await import("./server/pi/discovery.ts");
    const header = { type: "session", version: 3, id: "question-session-1", cwd: "/tmp", timestamp: "2025-01-01T00:00:00Z" };
    const entry = (id, parentId, role, content, extra = {}) => ({ type: "message", id, parentId, timestamp: "2025-01-01T00:01:00Z", message: { role, content, ...extra } });
    const lines = [
      header,
      entry("u1", null, "user", "Set up storage"),
      entry("a1", "u1", "assistant", [{ type: "toolCall", id: "q1", name: "question_ask", arguments: { question: "Which database?", options: ["Postgres", "SQLite"] } }], { stopReason: "toolUse" }),
      entry("r1", "a1", "toolResult", [{ type: "text", text: "User selected A. Postgres" }], { toolCallId: "q1", details: { answer: "Postgres" } }),
      entry("a2", "r1", "assistant", [{ type: "toolCall", id: "q2", name: "question_ask", arguments: { question: "Port?" } }], { stopReason: "aborted" }),
    ];
    const chat = projectSession(lines.map((l) => JSON.stringify(l)).join("\\n"), "/tmp/q.jsonl", 0);
    const parts = chat.messages[1].parts;
    assert.deepEqual(parts[0], { type: "ask", id: "q1", method: "select", title: "Which database?", options: ["Postgres", "SQLite"], other: true, answer: "Postgres" });
    assert.equal(parts[1].answer, "");
    assert(!parts.some((p) => p.type === "tool"));
    process.exit(0);
  `;
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, OPENCHAT_DATA_DIR: join(dir, "data"), PI_CODING_AGENT_DIR: join(dir, "agent") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
