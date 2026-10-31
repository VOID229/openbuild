// One-off completions (thread titles, commit messages) on any runtime: no tools where the runtime
// can turn them off, nothing saved, and an empty folder to run in, so no project instructions apply
// and no run turns up in the sidebar as a thread.
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Effort, TextRuntime } from "../shared/types";
import { claudeBin, claudeEnv } from "./claude/install";
import { codexBin, codexEnv } from "./codex/install";
import { cursorBin, cursorEnv, modelSlug } from "./cursor/install";
import { sessionPath as cursorSession } from "./cursor/sessions";
import { fxBin, fxEnv } from "./fx/install";
import { complete as opencodeComplete } from "./opencode-agent/sessions";
import { complete as piComplete } from "./pi/sessions";

export interface CompleteRequest {
  runtime: TextRuntime;
  /** The id in the runtime's model list. */
  model: string;
  effort?: Effort;
  system: string;
  prompt: string;
  images?: { data: string; mimeType: string }[];
}

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export const claudeArgs = (r: CompleteRequest) => [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands",
  "--model", r.model.replace(/^claude\//, ""), "--system-prompt", r.system, ...(r.effort && r.effort !== "off" ? ["--effort", r.effort] : []),
];

/** One user message on Claude's stream-json input, the only way its print mode takes images. */
export const claudeInput = (r: CompleteRequest) => JSON.stringify({
  type: "user",
  message: { role: "user", content: [...(r.images ?? []).map((i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.data } })), { type: "text", text: r.prompt }] },
}) + "\n";

/** The answer in Claude's stream-json output. */
export function claudeResult(out: string): string {
  const line = out.trim().split("\n").findLast((l) => l.startsWith("{") && l.includes('"type":"result"'));
  const result = line ? JSON.parse(line) : undefined;
  if (!result || result.is_error) throw new Error(result?.result || "Claude Code returned no result");
  return String(result.result ?? "");
}

export const codexArgs = (r: CompleteRequest, files: string[]) => [
  "exec", "--ephemeral", "--skip-git-repo-check", "--ignore-rules", "--sandbox", "read-only", "--color", "never", "--model", r.model.replace(/^codex\//, ""),
  "-c", `developer_instructions=${JSON.stringify(r.system)}`, "-c", "mcp_servers={}",
  ...(r.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(r.effort === "off" ? "none" : r.effort)}`] : []),
  ...files.flatMap((f) => ["--image", f]), "--", r.prompt,
];

export const fxArgs = (r: CompleteRequest, files: string[]) => [
  "ask", "--no-save", "--no-color", "--model", r.model.replace(/^fx\//, ""), "--system", r.system,
  ...(r.effort && r.effort !== "off" ? ["--effort", r.effort] : []), ...files.flatMap((f) => ["--image", f]), "--", r.prompt,
];

/** Cursor has no system prompt flag, and ask mode is its read-only one. */
export const cursorArgs = (r: CompleteRequest, slug: string, cwd: string) =>
  ["--print", "--output-format", "text", "--trust", "--workspace", cwd, "--mode", "ask", "--model", slug, "--", `${r.system}\n\n${r.prompt}`];

async function run(command: string[], cwd: string, env: Record<string, string>, signal: AbortSignal, input?: string) {
  const proc = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: input === undefined ? "ignore" : new TextEncoder().encode(input) });
  const kill = () => proc.kill();
  signal.addEventListener("abort", kill, { once: true });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  signal.removeEventListener("abort", kill);
  if (code !== 0) throw new Error(err.trim().split("\n").pop() || out.trim().split("\n").pop() || `${command[0]} exited with code ${code}`);
  return out.trim();
}

const installed = (bin: string | undefined, name: string) => {
  if (!bin) throw new Error(`${name} isn't installed.`);
  return bin;
};

export async function complete(r: CompleteRequest, signal: AbortSignal): Promise<string> {
  if (r.runtime === "pi") return piComplete(r.model, r.system, r.prompt, signal, r.images);
  const cwd = await mkdtemp(join(realpathSync(tmpdir()), "openbuild-complete-"));
  try {
    if (r.runtime === "opencode") return await opencodeComplete({ ...r, cwd }, signal);
    if (r.runtime === "claude") return claudeResult(await run([installed(claudeBin(), "Claude Code"), ...claudeArgs(r)], cwd, claudeEnv(), signal, claudeInput(r)));
    if (r.runtime === "cursor") return await run([installed(cursorBin(), "Cursor"), ...cursorArgs(r, await modelSlug(r.model, r.effort), cwd)], cwd, cursorEnv(), signal);
    const images = r.images ?? [];
    const files = images.map((image, i) => join(cwd, `image-${i}.${EXTENSIONS[image.mimeType] ?? "png"}`));
    await Promise.all(images.map((image, i) => Bun.write(files[i]!, Buffer.from(image.data, "base64"))));
    if (r.runtime === "codex") return await run([installed(codexBin(), "Codex"), ...codexArgs(r, files)], cwd, codexEnv(), signal);
    return await run([installed(fxBin(), "fx"), ...fxArgs(r, files)], cwd, fxEnv(), signal);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    // Cursor can't run without saving a chat, and the sidebar imports its chats.
    if (r.runtime === "cursor") await rm(dirname(dirname(cursorSession(cwd, "x"))), { recursive: true, force: true });
  }
}
