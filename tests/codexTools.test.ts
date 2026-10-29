import { expect, test } from "bun:test";
import { toolEvent } from "../server/codex/tools";

test("Codex native command actions normalize without dropping raw metadata or long output", () => {
  const output = "x".repeat(100000);
  for (const [type, name] of [["read", "read"], ["search", "grep"], ["listFiles", "glob"], ["unknown", "bash"]]) {
    const item = { type: "commandExecution", id: "command", command: "native", commandActions: [{ type, path: "path", query: "query" }], exitCode: 0, aggregatedOutput: output, status: "completed", processId: "pty", durationMs: 42 };
    expect(toolEvent(item, true)).toMatchObject({ name, args: { codex: item, path: "path", command: "native" }, status: "done", output, ms: 42 });
  }
});

test("Codex file changes retain every full diff and native metadata", () => {
  const changes = [{ path: "a", kind: { type: "add" }, diff: "+new\n" }, { path: "b", kind: { type: "update", move_path: "c" }, diff: "-old\n+new\n" }];
  const e = toolEvent({ id: "patch", type: "fileChange", changes, status: "completed" }, true)!;
  expect(e.name).toBe("edit"); expect(e.args?.changes).toEqual(changes); expect(e.patch).toContain("--- a\n+++ a\n+new"); expect(e.patch).toContain("--- b\n+++ c\n-old\n+new");
  expect(toolEvent({ id: "new", type: "fileChange", changes: [changes[0]], status: "completed" }, true)?.name).toBe("write");
});

test("Every Codex native tool variant has a visible fallback; tool args cannot replace raw evidence", () => {
  for (const type of ["dynamicToolCall", "mcpToolCall", "collabAgentToolCall", "subAgentActivity", "imageGeneration", "futureNativeTool"]) {
    const item = { type, id: "id", tool: "unknown_tool", arguments: { codex: "untrusted argument", extra: "kept" }, result: { content: [{ text: "output" }] } };
    const e = toolEvent(item, true)!;
    expect(e).toMatchObject({ name: "unknown_tool", status: "done", args: { codex: item, extra: "kept" } }); expect(e.output).toContain("output");
  }
  expect(toolEvent({ type: "webSearch", id: "web", query: "native query", action: null }, true)?.args?.query).toBe("native query");
  expect(toolEvent({ type: "plan", id: "plan", text: "plan" }, true)?.name).toBe("todo");
  expect(toolEvent({ type: "agentMessage", id: "agent", text: "reply" }, true)).toBeUndefined();
});
