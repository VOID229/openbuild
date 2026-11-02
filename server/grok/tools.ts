// Grok's tools as the tool names and results the thread UI knows. A call's `tool_call` carries what
// the model sent; its `tool_call_update`s repeat that normalized (with a `variant`), then the result.
import type { StreamEvent } from "../../shared/types";
import { contentOf } from "../acpContent";

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
type Mapped = { name: string; args: Record<string, unknown> };

/** Grok's own name for the tool in an update; `title` is display text once the call is under way. */
export const toolName = (u: any): string | undefined => str(u?._meta?.["x.ai/tool"]?.name);
const toolKind = (u: any): string | undefined => str(u?._meta?.["x.ai/tool"]?.kind) ?? str(u?.kind);

/** Shown some other way: `plan` updates draw the todo list, question cards the questions. */
export const isHidden = (name: string | undefined) => name === "todo_write" || name === "ask_user_question";

export function mapTool(name: string | undefined, kind: string | undefined, input: Record<string, unknown> = {}): Mapped {
  const { variant: _variant, ...rest } = input;
  const path = str(input.target_file) ?? str(input.file_path) ?? str(input.path) ?? str(input.target_directory);
  switch (name) {
    case "run_terminal_command":
    case "bash":
      return { name: "bash", args: { command: str(input.command) ?? "" } };
    case "read_file":
      return { name: "read", args: { path, ...(input.offset != null ? { offset: input.offset } : {}), ...(input.limit != null ? { limit: input.limit } : {}) } };
    // A search_replace with nothing to find creates the file.
    case "search_replace":
      return input.old_string === "" ? { name: "write", args: { path, content: input.new_string } } : { name: "edit", args: { ...rest, path } };
    case "write_file":
    case "create_file":
      return { name: "write", args: { path, content: input.content } };
    case "grep":
    case "grep_search":
      return { name: "grep", args: { pattern: input.pattern, path } };
    case "glob":
    case "glob_search":
    case "file_search":
      return { name: "find", args: { pattern: input.pattern, path } };
    case "list_dir":
      return { name: "ls", args: { path: path ?? "." } };
    case "web_search":
      return { name: "web_search", args: { query: input.query } };
    case "web_fetch":
      return { name: "fetch", args: { url: input.url } };
  }
  if (!name) {
    if (kind === "execute") return { name: "bash", args: { command: str(input.command) ?? "" } };
    if (kind === "read") return { name: "read", args: { path } };
    if (kind === "edit") return { name: "edit", args: { ...rest, path } };
    if (kind === "search") return { name: "grep", args: { pattern: input.pattern, path } };
    if (kind === "fetch") return { name: "fetch", args: { url: input.url } };
  }
  return { name: name ?? kind ?? "tool", args: rest };
}

export const mapUpdate = (u: any, fallback?: string) => mapTool(toolName(u) ?? fallback, toolKind(u), u?.rawInput ?? {});

/** A tool call in a few words, for a permission question. */
export function describeCall(call: any): string {
  const { name, args } = mapUpdate(call);
  if (name === "bash") return `run \`${String(args.command ?? "").split("\n")[0]!.slice(0, 120)}\``;
  if (name === "edit") return `edit ${args.path ?? "a file"}`;
  if (name === "write") return `write ${args.path ?? "a file"}`;
  if (name === "read") return `read ${args.path ?? "a file"}`;
  return str(call?.title)?.toLowerCase() ?? `use ${name.replace(/_/g, " ")}`;
}

/** Why a finished command counts as failed: Grok reports a nonzero exit as "completed". */
function shellFailure(r: any): string | undefined {
  if (r?.timed_out) return "timed out";
  if (r?.signal) return `killed by ${r.signal}`;
  if (typeof r?.exit_code === "number" && r.exit_code !== 0) return `exit code ${r.exit_code}`;
}

type Result = Pick<Extract<StreamEvent, { t: "tool" }>, "output" | "patch" | "status">;

/** A finished call's result. `name` is the mapped tool; output comes from `content` or `rawOutput`. */
export function resultOf(name: string, u: any, cwd: string, streamed: string): Result {
  const raw = u.rawOutput ?? {};
  const { text, patch } = contentOf(u.content, cwd);
  const failed = u.status === "failed";
  if (name === "bash") {
    const failure = failed ? undefined : shellFailure(raw);
    const output = [(text || streamed).replace(/\n$/, ""), failure && `[${failure}]`].filter(Boolean).join("\n");
    return { status: failed || failure ? "error" : "done", output };
  }
  if (failed) return { status: "error", output: text || str(raw.message) || "" };
  let output = text;
  if (name === "read") output = str(raw.FileContent?.raw_output) ?? text;
  else if (name === "ls") output = str(raw.Content?.content) ?? text;
  else if (name === "grep" && Array.isArray(raw.file_matches)) {
    output = raw.file_matches.flatMap((f: any) => (f?.matches ?? []).map((m: any) => `${f.path}:${m.line_number}:${m.content}`)).join("\n") || text;
  } else if (name === "edit" || name === "write") output = str(raw.EditsApplied?.tool_output_for_prompt_concise) ?? "";
  return { status: "done", output, ...(patch ? { patch } : {}) };
}

export const planLines = (entries: any[]) =>
  entries.map((e) => `${e?.status === "completed" ? "[x]" : e?.status === "in_progress" ? "[~]" : "[ ]"} ${e?.content}`).join("\n");
