import type { StreamEvent } from "../../shared/types";
export type ToolEvent = Extract<StreamEvent, { t: "tool" }>;
/** Keep the complete native payload in args.codex: UI summaries must not discard evidence. */
export function toolEvent(item: any, done: boolean, output?: string): ToolEvent | undefined {
  if (["userMessage", "agentMessage", "reasoning", "hookPrompt"].includes(item.type)) return;
  let name = item.tool ?? item.name ?? item.type ?? "tool";
  let args: Record<string, unknown> = { codex: item };
  let patch: string | undefined;
  if (item.type === "commandExecution") {
    const a = item.commandActions?.length === 1 ? item.commandActions[0] : undefined;
    name = a?.type === "read" ? "read" : a?.type === "search" ? "grep" : a?.type === "listFiles" ? "glob" : "bash";
    args = { ...args, command: item.command, cwd: item.cwd, ...(a ? { path: a.path, pattern: a.query } : {}) };
    output = item.aggregatedOutput ?? output;
  } else if (item.type === "fileChange") {
    name = item.changes?.length && item.changes.every((c: any) => c.kind?.type === "add") ? "write" : "edit";
    args = { ...args, path: item.changes?.[0]?.path, changes: item.changes };
    patch = (item.changes ?? []).map((c: any) => `--- ${c.path}\n+++ ${c.kind?.move_path ?? c.path}\n${c.diff}`).join("\n");
  } else if (item.type === "plan") { name = "todo"; output = item.text; }
  else if (item.type === "imageView") { name = "read"; args.path = item.path; }
  else if (item.type === "webSearch") { name = "web_search"; args.query = item.query ?? item.action?.query; output ??= JSON.stringify(item); }
  else {
    const aliases: Record<string, string> = { read_file: "read", write_file: "write", edit_file: "edit", apply_patch: "edit", exec_command: "bash", shell: "bash", grep_files: "grep", glob_files: "glob", update_plan: "todo" };
    name = aliases[name] ?? name;
    if (item.arguments && typeof item.arguments === "object") args = { ...args, ...item.arguments, codex: item };
    output ??= JSON.stringify(item.result ?? item.contentItems ?? item.output ?? item.error ?? item);
  }
  return { t: "tool", id: item.id, name, args, status: item.status === "failed" || item.status === "declined" || item.success === false || item.error ? "error" : done ? "done" : "running", output, patch, ms: item.durationMs ?? undefined };
}
