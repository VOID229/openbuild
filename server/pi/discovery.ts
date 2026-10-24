// Read Pi's persisted transcripts without opening/migrating them or starting an agent.
import { realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, resolve, sep } from "node:path";
import type { AskPart, Chat, Message, ToolPart } from "../../src/lib/types";
import { scratchDir } from "../projects";
import * as storage from "../storage";
import { TOOL as QUESTION_TOOL, cleanOptions } from "./extensions/question-ask";
import { agentDir } from "./install";
import { isSessionLive, isThreadId } from "./sessions";
import { addUsage, emptyUsage } from "./usage";
import { EXTERNAL_VIA } from "../../shared/replies";

// A turn that stopped mid-way (tools pending, or the model's next step not written yet) is still
// running if the transcript changed this recently. Pi only writes whole messages, so a long tool
// call goes quiet; past this, the process is taken to be gone and the reply reads as stopped.
const LIVE_MS = 10 * 60 * 1000;
// Sessions another agent spawned name themselves first thing (pi subagents, trace children).
const CHILD_NAME = /^(subagent|trace): /;

const textOf = (content: any): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : "";

// Pi appends its own notes about attached images to the prompt ("[Image: original 2048x1298, displayed
// at …]", "[Image converted from …]"). They're for the model, not the bubble.
const IMAGE_NOTE = /^\[Image(?::| converted| omitted)[^\n]*\]$/gm;
const promptText = (content: any): string => {
  const text = textOf(content);
  return Array.isArray(content) && content.some((b: any) => b.type === "image") ? text.replace(IMAGE_NOTE, "").trim() : text;
};

/** Raw active branch, including pre-compaction history (not the shortened model context). */
export function projectSession(source: string, file: string, modified: number): Chat | undefined {
  const records: any[] = [];
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* A writer may not have finished its last line. */ }
  }
  const header = records[0];
  if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") return;
  const entries = records.slice(1);
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
  const branch: any[] = [];
  let leaf = entries.at(-1);
  const seen = new Set<string>();
  if (header.version === 1 || !leaf?.id) branch.push(...entries);
  else {
    while (leaf && !seen.has(leaf.id)) {
      seen.add(leaf.id);
      branch.push(leaf);
      leaf = byId.get(leaf.parentId);
    }
    branch.reverse();
  }
  const createdAt = Date.parse(header.timestamp) || modified;
  // OpenBuild runs a scratch thread's commands from the home folder (shell.ts); show them as typed.
  const scratch = header.cwd.startsWith(scratchRoot() + sep);
  const messages: Message[] = [];
  const tools = new Map<string, ToolPart>();
  const asks = new Map<string, AskPart>();
  let reply: Message | undefined;
  // Text parts mark where Pi wrote, among the tools it ran. A paragraph break between two of its
  // assistant messages extends the text part that ended the first one; it never becomes a part of
  // its own, or the run of tools after it would read as a second "Ran N commands" row.
  const addText = (text: string) => {
    if (!text) return;
    const parts = reply!.parts!;
    const last = parts.at(-1);
    if (last?.type === "text") last.text += text;
    else if (text.trim()) parts.push({ type: "text", text });
  };
  for (const entry of branch) {
    const m = entry.type === "message" ? entry.message : undefined;
    if (!m) continue;
    const at = Number(m.timestamp) || Date.parse(entry.timestamp) || createdAt;
    if (m.role === "user") {
      reply = undefined;
      const attachments = Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "image").map((b: any, i: number) => ({
        id: `${entry.id}-image-${i}`, name: "Image", mime: b.mimeType, dataUrl: `data:${b.mimeType};base64,${b.data}`, size: Math.floor(b.data.length * 3 / 4),
      })) : [];
      messages.push({ id: entry.id || `user-${messages.length}`, role: "user", content: promptText(m.content), createdAt: at, ...(attachments.length ? { attachments } : {}) });
    } else if (m.role === "assistant") {
      if (!reply) {
        reply = { id: entry.id || `reply-${messages.length}`, role: "assistant", content: "", parts: [], status: "done", createdAt: at, usage: emptyUsage() };
        messages.push(reply);
      }
      if (m.model && m.provider) reply.model = { plan: "pi", id: `${m.provider}/${m.model}`, name: m.model };
      if (reply.content && textOf(m.content)) {
        reply.content += "\n\n";
        addText("\n\n");
      }
      for (const block of Array.isArray(m.content) ? m.content : [{ type: "text", text: textOf(m.content) }]) {
        if (block.type === "text") {
          reply.content += block.text;
          addText(block.text);
        } else if (block.type === "thinking" && block.thinking) reply.parts!.push({ type: "thought", text: block.thinking });
        else if (block.type === "toolCall" && block.name === QUESTION_TOOL) {
          // A question_ask call reads as its question card.
          const ask: AskPart = { type: "ask", id: block.id, method: "select", title: String(block.arguments?.question ?? ""), options: cleanOptions(block.arguments?.options), other: true };
          asks.set(ask.id, ask);
          reply.parts!.push(ask);
        } else if (block.type === "toolCall") {
          const tool: ToolPart = { type: "tool", id: block.id, name: block.name, args: block.arguments, status: "running" };
          tools.set(tool.id, tool);
          reply.parts!.push(tool);
        }
      }
      addUsage(reply.usage!, m.usage);
      reply.status = m.stopReason === "error" ? "error" : m.stopReason === "aborted" ? "stopped" : "done";
      reply.error = m.errorMessage;
    } else if (m.role === "bashExecution") {
      // A command the user ran ("!" or "!!"): its own message, between replies.
      reply = undefined;
      const command = String(m.command ?? "");
      const typed = scratch ? command.replace(/^cd ~ && /, "") : command;
      messages.push({
        id: entry.id || `shell-${messages.length}`, role: "shell", content: typed, createdAt: at,
        shell: {
          command: typed, hidden: m.excludeFromContext || undefined, status: m.cancelled ? "stopped" : "done", output: String(m.output ?? ""),
          exitCode: typeof m.exitCode === "number" ? m.exitCode : undefined, fullOutputPath: m.truncated ? m.fullOutputPath : undefined,
        },
      });
    } else if (m.role === "toolResult") {
      const ask = asks.get(m.toolCallId);
      if (ask) ask.answer = m.isError ? "" : String(m.details?.answer ?? "");
      const tool = tools.get(m.toolCallId);
      if (tool) { tool.status = m.isError ? "error" : "done"; tool.output = textOf(m.content).slice(0, 12000); }
    }
  }
  // The last turn hasn't ended: Pi is still on it in some other process, or that process died.
  const tail = branch.findLast((e) => e.type === "message" && e.message?.role !== "system")?.message;
  if (reply && messages.at(-1) === reply && (tail?.role === "toolResult" || tail?.stopReason === "toolUse")) {
    if (isLive(modified)) Object.assign(reply, { status: "streaming", stream: { id: "", via: EXTERNAL_VIA } });
    else reply.status = "stopped";
  }
  // Never answered (the reply was stopped): nothing is waiting for it anymore.
  for (const ask of asks.values()) ask.answer ??= "";
  const names = entries.filter((e) => e.type === "session_info" && typeof e.name === "string").map((e) => e.name as string);
  const subagent = CHILD_NAME.test(names[0] ?? "");
  const name = subagent ? names.at(-1)!.replace(CHILD_NAME, "") : names.at(-1);
  const id = isThreadId(header.id) ? header.id : `pi-${createHash("sha256").update(file).digest("hex").slice(0, 32)}`;
  return {
    id, title: name || messages.find((m) => m.role === "user")?.content.slice(0, 100) || "Pi session",
    // Without a Pi session name the title is only the prompt's opening: not a name yet.
    ...(name ? { titleSource: "auto" as const } : {}), createdAt, updatedAt: modified, messages, ...(subagent ? { subagent } : {}),
    workspace: { cwd: header.cwd, projectId: "", projectName: basename(header.cwd) || header.cwd },
  };
}

const isLive = (modified: number) => Date.now() - modified < LIVE_MS;

/** Where scratch threads work, as their cwd is recorded (resolved). */
function scratchRoot() {
  try {
    return realpathSync(scratchDir());
  } catch {
    return scratchDir();
  }
}

async function filesIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(entries.map((e) => e.isDirectory() ? filesIn(join(dir, e.name)) : Promise.resolve(e.isFile() && e.name.endsWith(".jsonl") ? [join(dir, e.name)] : [])));
    return nested.flat();
  } catch { return []; }
}

const fingerprints = new Map<string, string>();
let running: Promise<void> | undefined;

/** Shared by all browsers; unchanged files cost a stat, not a transcript read. */
export function discoverSessions(): Promise<void> {
  return running ??= discover().finally(() => { running = undefined; });
}
async function discover() {
  const mappings = new Map<string, string>();
  for (const [key, value] of storage.listValues("pi-session:")) {
    try { mappings.set(resolve(JSON.parse(value).file), key.slice("pi-session:".length)); } catch {}
  }
  const roots = new Set([join(agentDir(), "sessions")]);
  if (process.env.PI_CODING_AGENT_SESSION_DIR) roots.add(resolve(process.env.PI_CODING_AGENT_SESSION_DIR));
  try {
    const settings = JSON.parse(await readFile(join(agentDir(), "settings.json"), "utf8"));
    if (typeof settings.sessionDir === "string") roots.add(resolve(settings.sessionDir.replace(/^~(?=\/)/, process.env.HOME || "~")));
  } catch {}
  const paths = new Set([...(await Promise.all([...roots].map(filesIn))).flat(), ...mappings.keys()]);
  // Bound concurrent reads for large session archives.
  const files = [...paths];
  for (let i = 0; i < files.length; i += 8) await Promise.all(files.slice(i, i + 8).map(async (file) => {
    try {
      const info = await stat(file);
      // Includes liveness so a run that went quiet is read again once it's taken to be over.
      const fingerprint = `${info.mtimeMs}:${info.size}:${isLive(info.mtimeMs)}`;
      if (fingerprints.get(file) === fingerprint) return;
      const knownId = mappings.get(resolve(file));
      // Never replace the richer UI events of a process owned by OpenBuild.
      if (knownId && isSessionLive(knownId)) { fingerprints.set(file, fingerprint); return; }
      const projected = projectSession(await readFile(file, "utf8"), file, info.mtimeMs);
      if (!projected) return;
      const id = knownId || projected.id;
      // Reads above yield to requests; re-check ownership and metadata immediately before writing.
      if (isSessionLive(id)) { fingerprints.set(file, fingerprint); return; }
      const old = storage.getChat(id) as Chat | undefined;
      // Metadata (pins, archive, titles) belongs to OpenBuild, history belongs to Pi. A title OpenBuild
      // generated stays unless Pi named the session since; one the user typed always stays.
      const keepTitle = old?.titleSource === "user" || (old?.titleSource === "auto" && !projected.titleSource);
      const chat = { ...old, ...projected, id, updatedAt: Math.max(old?.updatedAt || 0, projected.updatedAt),
        ...(keepTitle ? { title: old.title, titleSource: old.titleSource } : {}),
        workspace: old?.workspace || projected.workspace,
      };
      if (storage.putChat(chat)) storage.setValue(`pi-session:${id}`, JSON.stringify({ file, cwd: projected.workspace!.cwd }));
      fingerprints.set(file, fingerprint);
    } catch { /* A session can disappear or be replaced while scanning. Retry next time. */ }
  }));
}
