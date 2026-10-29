import { expect, test } from "bun:test";
import { toolEvent } from "../server/opencode-agent/tools";

test("OpenCode edit metadata.files retains real native patches and projects common args", () => {
  const patch = "Index: smoke.txt\n===\n--- smoke.txt\n+++ smoke.txt\n@@ -1 +1 @@\n-hello\n+goodbye\n";
  const event = toolEvent("edit", { name: "edit", input: { filePath: "smoke.txt", oldString: "hello", newString: "goodbye" } }, "done", { metadata: { files: [{ file: "smoke.txt", patch, status: "modified", additions: 1, deletions: 1 }] } });
  expect(event).toMatchObject({ name: "edit", patch, args: { path: "smoke.txt", oldText: "hello", newText: "goodbye", opencode: { metadata: { files: [{ patch }] } } } });
  expect(toolEvent("fallback", { name: "edit", input: { filePath: "smoke.txt", oldString: "hello", newString: "goodbye" } }, "done", {}).patch).toContain("-hello\n+goodbye");
});

test("OpenCode fetch and failures use common UI categories without losing native evidence", () => {
  expect(toolEvent("fetch", { name: "webfetch", input: { url: "https://example.com" } }, "done", {}).name).toBe("fetch");
  expect(toolEvent("failed", { name: "shell", input: { command: "exit 7" } }, "error", { error: { type: "shell", message: "exit code 7" } })).toMatchObject({ name: "bash", status: "error", output: "exit code 7", args: { command: "exit 7", opencode: { event: { error: { type: "shell" } } } } });
});
