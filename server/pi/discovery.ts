// Read Pi's persisted transcripts without opening/migrating them or starting an agent.
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import type { Chat, Message, ToolPart } from "../../src/lib/types";
import * as storage from "../storage";
import { agentDir } from "./install";
import { isSessionLive, isThreadId } from "./sessions";

const textOf = (content: any): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : "";

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
  const messages: Message[] = [];
  const tools = new Map<string, ToolPart>();
  let reply: Message | undefined;
  for (const entry of branch) {
    const m = entry.type === "message" ? entry.message : undefined;
    if (!m) continue;
    const at = Number(m.timestamp) || Date.parse(entry.timestamp) || createdAt;
    if (m.role === "user") {
      reply = undefined;
      const attachments = Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "image").map((b: any, i: number) => ({
        id: `${entry.id}-image-${i}`, name: "Image", mime: b.mimeType, dataUrl: `data:${b.mimeType};base64,${b.data}`, size: Math.floor(b.data.length * 3 / 4),
      })) : [];
      messages.push({ id: entry.id || `user-${messages.length}`, role: "user", content: textOf(m.content), createdAt: at, ...(attachments.length ? { attachments } : {}) });
    } else if (m.role === "assistant") {
      if (!reply) {
        reply = { id: entry.id || `reply-${messages.length}`, role: "assistant", content: "", parts: [], status: "done", createdAt: at, usage: { input: 0, output: 0, cost: 0 } };
        messages.push(reply);
      }
      if (m.model && m.provider) reply.model = { plan: "pi", id: `${m.provider}/${m.model}`, name: m.model };
      if (reply.content && textOf(m.content)) {
        reply.content += "\n\n";
        reply.parts!.push({ type: "text", text: "\n\n" });
      }
      for (const block of Array.isArray(m.content) ? m.content : [{ type: "text", text: textOf(m.content) }]) {
        if (block.type === "text") {
          reply.content += block.text;
          reply.parts!.push({ type: "text", text: block.text });
        } else if (block.type === "thinking" && block.thinking) reply.parts!.push({ type: "thought", text: block.thinking });
        else if (block.type === "toolCall") {
          const tool: ToolPart = { type: "tool", id: block.id, name: block.name, args: block.arguments, status: "running" };
          tools.set(tool.id, tool);
          reply.parts!.push(tool);
        }
      }
      reply.usage!.input! += m.usage?.input || 0;
      reply.usage!.output! += m.usage?.output || 0;
      reply.usage!.cost! += m.usage?.cost?.total || 0;
      reply.status = m.stopReason === "error" ? "error" : m.stopReason === "aborted" ? "stopped" : "done";
      reply.error = m.errorMessage;
    } else if (m.role === "toolResult") {
      const tool = tools.get(m.toolCallId);
      if (tool) { tool.status = m.isError ? "error" : "done"; tool.output = textOf(m.content).slice(0, 12000); }
    }
  }
  const name = entries.filter((e) => e.type === "session_info" && typeof e.name === "string").at(-1)?.name;
  const id = isThreadId(header.id) ? header.id : `pi-${createHash("sha256").update(file).digest("hex").slice(0, 32)}`;
  return {
    id, title: name || messages.find((m) => m.role === "user")?.content.slice(0, 100) || "Pi session",
    titleSource: "auto", createdAt, updatedAt: modified, messages,
    workspace: { cwd: header.cwd, projectId: "", projectName: basename(header.cwd) || header.cwd },
  };
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
      const fingerprint = `${info.mtimeMs}:${info.size}`;
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
      // Metadata (pins, archive, custom titles) belongs to OpenBuild, history belongs to Pi.
      const chat = { ...old, ...projected, id, updatedAt: Math.max(old?.updatedAt || 0, projected.updatedAt),
        ...(old?.titleSource === "user" ? { title: old.title, titleSource: old.titleSource } : {}),
        workspace: old?.workspace || projected.workspace,
      };
      if (storage.putChat(chat)) storage.setValue(`pi-session:${id}`, JSON.stringify({ file, cwd: projected.workspace!.cwd }));
      fingerprints.set(file, fingerprint);
    } catch { /* A session can disappear or be replaced while scanning. Retry next time. */ }
  }));
}
