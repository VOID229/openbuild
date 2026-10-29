// Claude Code's tool calls as OpenBuild's tool rows (the names ToolCalls.tsx draws: read, bash, edit,
// write, grep, find, web_search, fetch, todo, agent…). The native input and structured result stay
// under args.claude so nothing the CLI reported is lost.
import type { StreamEvent } from "../../shared/types";
export type ToolEvent = Extract<StreamEvent, { t: "tool" }>;

const NAMES: Record<string, string> = {
  Bash: "bash", BashOutput: "bash", Read: "read", Edit: "edit", MultiEdit: "edit", Write: "write", NotebookEdit: "edit",
  Grep: "grep", Glob: "find", LS: "ls", WebSearch: "web_search", WebFetch: "fetch", TodoWrite: "todo",
  Task: "agent", Agent: "agent", ExitPlanMode: "plan", AskUserQuestion: "question",
};
export const toolName = (native: string) => NAMES[native] ?? (native.startsWith("mcp__") ? native.slice(5).replace(/__/g, "_") : native);

/** OpenBuild's args for a native input: the UI reads path/command/pattern/query/url/prompt. */
export function toolArgs(native: string, input: any): Record<string, unknown> {
  const i = input && typeof input === "object" ? input : {};
  const args: Record<string, unknown> = { ...i, claude: { tool: native, input: i } };
  if (i.file_path !== undefined) args.path = i.file_path;
  if (i.notebook_path !== undefined) args.path = i.notebook_path;
  if (native === "Glob" || native === "Grep") { if (i.path === undefined) delete args.path; }
  if (native === "Task" || native === "Agent") args.task = i.description ? `${i.description}${i.prompt ? `: ${i.prompt}` : ""}` : i.prompt;
  return args;
}

/** A unified diff from Claude's structuredPatch hunks. */
export function hunksPatch(path: string, hunks: any[] | undefined): string | undefined {
  if (!Array.isArray(hunks) || !hunks.length) return;
  return `--- ${path}\n+++ ${path}\n` + hunks.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${(h.lines ?? []).join("\n")}`).join("\n");
}

/** The diff an edit will make, before its result arrives (old/new strings as a hunk). */
export function proposedPatch(native: string, input: any): string | undefined {
  const path = input?.file_path ?? input?.notebook_path ?? "";
  const lines = (s: unknown) => (typeof s === "string" ? s.replace(/\n$/, "").split("\n") : []);
  const hunk = (o: unknown, n: unknown) => [...lines(o).map((l) => `-${l}`), ...lines(n).map((l) => `+${l}`)].join("\n");
  if (native === "Edit") return `--- ${path}\n+++ ${path}\n@@\n${hunk(input.old_string, input.new_string)}`;
  if (native === "MultiEdit" && Array.isArray(input?.edits)) return `--- ${path}\n+++ ${path}\n` + input.edits.map((e: any) => `@@\n${hunk(e.old_string, e.new_string)}`).join("\n");
  return;
}

/** A tool_result block's content as text. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content.map((c: any) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : JSON.stringify(c))).join("\n");
}

/** A todo list as the checkbox lines the todo row shows. */
const todos = (list: any[]) => list.map((t) => `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]"} ${t.content ?? t.activeForm ?? ""}`).join("\n");

export function startEvent(id: string, native: string, input: any, extra?: Record<string, unknown>): ToolEvent {
  const name = toolName(native);
  const e: ToolEvent = { t: "tool", id, name, args: { ...toolArgs(native, input), ...extra }, status: "running" };
  if (native === "TodoWrite" && Array.isArray(input?.todos)) e.output = todos(input.todos);
  if (native === "ExitPlanMode" && typeof input?.plan === "string") e.output = input.plan;
  const patch = proposedPatch(native, input);
  if (patch) e.patch = patch;
  return e;
}

/** A finished call: its output, the real diff Claude applied, and whether it failed. */
export function doneEvent(start: ToolEvent, native: string, block: any, structured: any, ms?: number): ToolEvent {
  const error = block?.is_error === true;
  let output = resultText(block?.content);
  let patch = start.patch;
  const s = structured && typeof structured === "object" ? structured : undefined;
  if (s) {
    if ((native === "Edit" || native === "MultiEdit" || native === "Write") && Array.isArray(s.structuredPatch)) patch = hunksPatch(s.filePath ?? String(start.args?.path ?? ""), s.structuredPatch) ?? (native === "Write" ? undefined : patch);
    if (native === "Bash" && (typeof s.stdout === "string" || typeof s.stderr === "string")) output = [s.stdout, s.stderr].filter((x) => x && String(x).trim()).join("\n") || output;
    if (native === "TodoWrite" && Array.isArray(s.newTodos)) output = todos(s.newTodos);
  }
  if (native === "TodoWrite" && !error) output = start.output ?? output;
  return { ...start, args: { ...start.args, claude: { ...(start.args?.claude as object), result: s ?? block?.content } }, status: error ? "error" : "done", output, ...(patch ? { patch } : {}), ...(ms !== undefined ? { ms } : {}) };
}
