import type { StreamEvent } from "../../shared/types";
export type ToolEvent = Extract<StreamEvent, { t: "tool" }>;
export interface NativeTool { name: string; input?: any; metadata?: any; native?: any }
/** Native evidence is retained even when projected to a common OpenBuild tool. */
export function toolEvent(id: string, tool: NativeTool, status: ToolEvent["status"], data: any): ToolEvent {
  const aliases: Record<string, string> = { shell: "bash", read_file: "read", write_file: "write", edit_file: "edit", apply_patch: "edit", list: "glob", todowrite: "todo", webfetch: "fetch", websearch: "web_search" };
  const name = aliases[tool.name] ?? tool.name;
  const input = tool.input && typeof tool.input === "object" ? tool.input : {};
  const metadata = { ...tool.metadata, ...data.metadata };
  const args: Record<string, unknown> = { ...input, path: input.path ?? input.filePath ?? input.file_path, command: input.command, oldText: input.oldText ?? input.oldString, newText: input.newText ?? input.newString, opencode: { name: tool.name, input: tool.input, metadata, event: data } };
  const output = data.error?.message ?? (Array.isArray(data.content) ? data.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : metadata.output);
  let patch = metadata.diff ?? metadata.patch ?? metadata.files?.map((f: any) => f.patch).filter(Boolean).join("\n");
  if (!patch && name === "edit" && typeof args.oldText === "string" && typeof args.newText === "string") {
    const path = String(args.path ?? "file");
    patch = `--- ${path}\n+++ ${path}\n@@ -1,${args.oldText.split("\n").length} +1,${args.newText.split("\n").length} @@\n${args.oldText.split("\n").map((s) => `-${s}`).join("\n")}\n${args.newText.split("\n").map((s) => `+${s}`).join("\n")}`;
  }
  return { t: "tool", id, name, args, status, output: typeof output === "string" ? output : undefined, patch: typeof patch === "string" && patch ? patch : undefined };
}
