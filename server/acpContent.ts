// What ACP agents' tool calls carry, as the thread UI shows it.
import { structuredPatch } from "diff";
import { isAbsolute } from "node:path";

export function clip(text: string, max: number) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n… ${text.length - max} characters not shown …\n\n${text.slice(-half)}`;
}

/** A unified diff of a change, as the thread UI shows edits. */
export function unified(path: string, oldText: string, newText: string): string | undefined {
  if (oldText === newText) return undefined;
  const p = structuredPatch(path, path, oldText, newText, "", "", { context: 3 });
  const lines = [`--- ${path}`, `+++ ${path}`];
  for (const h of p.hunks) lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines.filter((l) => !l.startsWith("\\")));
  return lines.join("\n");
}

/** Text of ACP tool call content blocks (and any diffs they carry). */
export function contentOf(content: unknown, cwd: string): { text: string; patch?: string } {
  if (!Array.isArray(content)) return { text: "" };
  let text = "";
  const patches: string[] = [];
  for (const c of content as any[]) {
    if (c?.type === "content" && c.content?.type === "text") text += c.content.text ?? "";
    else if (c?.type === "diff" && typeof c.newText === "string") {
      const path = typeof c.path === "string" ? (isAbsolute(c.path) && c.path.startsWith(cwd + "/") ? c.path.slice(cwd.length + 1) : c.path) : "file";
      const p = unified(path, c.oldText ?? "", c.newText);
      if (p) patches.push(p);
    }
  }
  return { text, patch: patches.length ? patches.join("\n") : undefined };
}
