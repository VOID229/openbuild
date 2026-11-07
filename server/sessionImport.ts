import { userVisiblePrompt } from "../shared/promptDisplay";
// Bring in the threads people have with the native runtimes (Claude Code, Codex, Cursor, OpenCode)
// outside OpenBuild, on every account they're signed in with. Pi's sessions are discovered by
// pi/discovery.ts; these are discovered here, in the background and without asking: a session the
// runtime is working on shows as a working thread, a finished one is filed under Closed. Each
// import writes the same session mapping the runtime's adapter writes for its own threads, so an
// imported thread carries on in the native session instead of starting over.
//
// Discovery is incremental: a session whose stamp (when it was written, and whether the runtime is
// on it) hasn't changed costs a stat, and Codex and OpenCode are only asked when their files
// changed. History belongs to the native session until OpenBuild runs a turn in the thread;
// metadata (title, pins, closing) belongs to OpenBuild. Nothing is ever deleted, and a thread the
// user deleted stays deleted.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AskPart, Chat, Message, Part, ToolPart } from "../src/lib/types";
import type { Attachment, PiChatRequest, RuntimeAccount, ThreadRuntime } from "../shared/types";
import { EXTERNAL_VIA } from "../shared/replies";
import * as storage from "./storage";
import { listProjects } from "./projects";
import { claimRuntime } from "./threadRuntime";
import { serverId } from "./devices";
import { accountPath, withRuntimeAccount } from "./runtimeAccounts";
import { claudeAccounts } from "./claude/accounts";
import { claudeEnv } from "./claude/install";
import { doneEvent, resultText, startEvent, type ToolEvent } from "./claude/tools";
import { codexAccounts } from "./codex/accounts";
import { codexBin, codexEnv } from "./codex/install";
import { CodexProcess } from "./codex/rpc";
import { toolEvent as codexTool } from "./codex/tools";
import { sessionDir as cursorDir, fingerprint as cursorFingerprint } from "./cursor/sessions";
import { QUESTION_PREFIX as CURSOR_PREFIX } from "./cursor/questions";
import { connect as opencodeConnect, opencodeBin } from "./opencode-agent/connection";
import { toolEvent as opencodeTool } from "./opencode-agent/tools";

export const IMPORT_RUNTIMES = ["claude", "codex", "cursor", "opencode"] as const;
export type ImportRuntime = (typeof IMPORT_RUNTIMES)[number];
export const isImportRuntime = (r: unknown): r is ImportRuntime => IMPORT_RUNTIMES.includes(r as ImportRuntime);

/** Imported threads' folders: like Pi's discovered sessions, they may run outside a registered project. */
export const BINDING = "imported-session:";

/** A native session as it would be imported: its thread and the adapter mapping that resumes it. */
export interface Projected { chat: Chat; mapping: object; working: boolean }
/**
 * A native session as listed: `stamp` changes whenever it needs reading again. `probe` cheaply
 * checks a session is someone's own before it counts toward the recent ones.
 */
interface Found { nativeId: string; updatedAt: number; stamp: string; probe?: () => Promise<boolean>; load: () => Promise<Projected | undefined> }

const OUTPUT_LIMIT = 12000;
/** The first discovery on an account brings in its newest sessions; every session after them follows. */
export const RECENT_IMPORT_LIMIT = 100;
// A turn that stopped mid-way is still running if its session was written this recently (as with
// Pi's sessions). Runtimes that say what they're doing themselves are taken at their word instead.
const LIVE_MS = 10 * 60 * 1000;
const isLive = (modified: number) => Date.now() - modified < LIVE_MS;

/** What the native runtime is doing with a session: `busy` when it says so itself. */
export interface Activity { busy?: boolean; modified: number }

export const threadId = (runtime: ImportRuntime, nativeId: string) => `${runtime}-${createHash("sha256").update(nativeId).digest("hex").slice(0, 32)}`;
const ms = (t: unknown) => typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(String(t)) || 0;

/** Native ids OpenBuild's own threads run on: those sessions are OpenBuild's, not imports. */
function ownSessions(runtime: ImportRuntime): Set<string> {
  const ids = new Set<string>();
  for (const [key, value] of storage.listValues(`${runtime}-session:`)) {
    try {
      const id = JSON.parse(value).id;
      // An imported thread's own mapping doesn't make its session OpenBuild's.
      if (key.slice(`${runtime}-session:`.length) !== threadId(runtime, id)) ids.add(id);
    } catch {}
  }
  return ids;
}

function workspaceFor(cwd: string): Chat["workspace"] {
  const project = listProjects().find((p) => p.path === cwd);
  return project ? { cwd, projectId: project.id, projectName: project.name } : { cwd, projectId: "", projectName: basename(cwd) || cwd };
}

// ------------------------------------------------------------------ building a thread

/** Turns a native transcript into OpenBuild messages, in the shape live replies are saved in. */
class Thread {
  messages: Message[] = [];
  reply?: Message;
  private tools = new Map<string, ToolPart>();
  /** Whether the next text starts a new block (a paragraph break after earlier text). */
  private fresh = true;
  constructor(private plan: ImportRuntime) {}

  user(id: string, content: string, at: number, attachments: Attachment[] = []) {
    this.reply = undefined;
    this.messages.push({ id, role: "user", content: userVisiblePrompt(content), createdAt: at, ...(attachments.length ? { attachments } : {}) });
  }
  /** The reply to the latest prompt (started by its first output). */
  private open(id: string, at: number): Message {
    if (!this.reply) {
      this.reply = { id, role: "assistant", content: "", parts: [], status: "done", createdAt: at };
      this.messages.push(this.reply);
      this.fresh = true;
    }
    return this.reply;
  }
  model(id: string, at: number, model: string | undefined, ref = model) {
    if (model) this.open(id, at).model = { plan: this.plan, id: `${this.plan}/${ref}`, name: model };
  }
  /** Text in a new block (`block`) gets a paragraph break after the text before it. */
  text(id: string, at: number, text: string, block = true) {
    if (!text) return;
    const reply = this.open(id, at);
    if (block && !this.fresh && reply.content) text = "\n\n" + text;
    this.fresh = false;
    reply.content += text;
    const last = reply.parts!.at(-1);
    if (last?.type === "text") last.text += text;
    else if (text.trim()) reply.parts!.push({ type: "text", text: text.replace(/^\s+/, "") });
  }
  thought(id: string, at: number, text: string) {
    if (text.trim()) this.open(id, at).parts!.push({ type: "thought", text });
  }
  part(id: string, at: number, part: Part) { this.open(id, at).parts!.push(part); }
  tool(id: string, at: number, ev: ToolEvent) {
    const { t: _t, ...call } = ev;
    if (call.output) call.output = call.output.slice(0, OUTPUT_LIMIT);
    const known = this.tools.get(call.id);
    if (known) { Object.assign(known, Object.fromEntries(Object.entries(call).filter(([, v]) => v !== undefined && v !== ""))); return; }
    const part: ToolPart = { type: "tool", ...call };
    this.tools.set(call.id, part);
    this.open(id, at).parts!.push(part);
  }
  end(status: Message["status"], error?: string) {
    if (!this.reply) return;
    this.reply.status = status;
    if (error) this.reply.error = error;
  }
  /** Tools that never reported back ended with the session. */
  close() {
    for (const tool of this.tools.values()) if (tool.status === "running") tool.status = "done";
    for (const m of this.messages) for (const p of m.parts ?? []) if (p.type === "ask") p.answer ??= "";
  }
  get turns() { return this.messages.filter((m) => m.role === "user").length; }
  /** The transcript stops mid-turn: a prompt with no reply yet, or tools that haven't reported back. */
  get pending() {
    const last = this.messages.at(-1);
    return last?.role === "user" || (!!last && last === this.reply && [...this.tools.values()].some((t) => t.status === "running"));
  }
  /**
   * Ends the projection. A turn the runtime is still on stays running, as a reply made outside
   * OpenBuild; whether it is comes from the runtime (`busy`), else from a recent unfinished turn.
   */
  finish(activity: Activity | undefined, pending = this.pending): boolean {
    const working = !!activity && (activity.busy ?? (pending && isLive(activity.modified)));
    if (!working) { this.close(); return false; }
    const last = this.messages.at(-1)!;
    const reply = this.open(`${last.id}-reply`, last.createdAt);
    reply.status = "streaming";
    reply.stream = { id: "", via: EXTERNAL_VIA };
    delete reply.error;
    return true;
  }
}

const chatOf = (runtime: ImportRuntime, nativeId: string, t: Thread, working: boolean, o: { title?: string; named?: boolean; createdAt: number; updatedAt: number; cwd: string }): Chat => ({
  id: threadId(runtime, nativeId),
  runtime,
  imported: true,
  // Finished sessions arrive closed; one the runtime is on shows with the working threads.
  archived: !working,
  title: (o.title || t.messages.find((m) => m.role === "user")?.content || "Imported thread").trim().slice(0, 100),
  ...(o.title && o.named ? { titleSource: "auto" as const } : {}),
  createdAt: o.createdAt || o.updatedAt,
  updatedAt: o.updatedAt || o.createdAt,
  messages: t.messages,
  workspace: workspaceFor(o.cwd),
});

const imageAttachment = (id: string, mime: string, data: string): Attachment =>
  ({ id, name: "Image", mime, dataUrl: `data:${mime};base64,${data}`, size: Math.floor(data.length * 3 / 4) });

// ------------------------------------------------------------------ Claude Code

const claudeConfig = () => claudeEnv().CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const claudeRoot = () => join(claudeConfig(), "projects");
// Slash commands and their output, kept in the transcript but not prompts anyone typed.
const CLAUDE_NOISE = /^\s*(<command-|<local-command|Caveat: )/;
const INTERRUPTED = /^\[Request interrupted by user/;

/**
 * The session's first prompt says where it came from: only people's own sessions, not SDK-driven
 * or `claude -p` ones, nor OpenBuild's (which can be on disk before their thread maps them).
 */
const claudeOwn = (source: string) => { const entry = claudeEntrypoint(source); return entry === "openbuild" || !!entry?.startsWith("sdk-"); };
function claudeEntrypoint(source: string): string | undefined {
  const head = source.slice(0, 1 << 20);
  for (const line of head.split("\n")) {
    try {
      const r = JSON.parse(line);
      if (r.type === "user" && r.entrypoint) return r.entrypoint;
    } catch {}
  }
}

/** Whether `pid` is still the process that started at `start` (Linux clock ticks), not a reused pid. */
export function processAlive(pid: number, start?: unknown): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EPERM") return false; }
  if (typeof start !== "string" || process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === start;
  } catch { return true; }
}

/**
 * What Claude Code's running processes are on: each writes `sessions/<pid>.json` with its session
 * and whether it's busy. Files of exited processes stay behind with whatever they last said, so
 * only a live process counts. Undefined when this Claude Code keeps no such files.
 */
export function claudeActivity(config = claudeConfig()): Map<string, boolean> | undefined {
  let names: string[];
  try { names = readdirSync(join(config, "sessions")); } catch { return undefined; }
  const busy = new Map<string, boolean>();
  for (const name of names) {
    const pid = /^(\d+)\.json$/.exec(name)?.[1];
    if (!pid || !processAlive(Number(pid))) continue;
    try {
      const r = JSON.parse(readFileSync(join(config, "sessions", name), "utf8"));
      if (typeof r.sessionId !== "string" || Number(r.pid) !== Number(pid) || !processAlive(Number(pid), r.procStart)) continue;
      busy.set(r.sessionId, busy.get(r.sessionId) || r.status !== "idle");
    } catch {}
  }
  return busy;
}

/** Only probe a small prefix; a huge image record must never be allocated just to list sessions. */
async function claudeEligible(file: string, size: number): Promise<boolean> {
  const handle = await open(file, "r");
  let prefix: string;
  try {
    const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    prefix = buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
  if (claudeOwn(prefix)) return false;
  const hasPrompt = prefix.split("\n").some(line => {
    try {
      const r = JSON.parse(line);
      if (r.type !== "user" || r.isSidechain || r.isMeta || r.isCompactSummary || !r.cwd) return false;
      const c = r.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : "";
      return !!text.trim() && !CLAUDE_NOISE.test(text) && !INTERRUPTED.test(text);
    } catch { return false; }
  });
  // If a record extends past the probe, eligibility is checked when it's read instead.
  return hasPrompt || size > 64 * 1024;
}

async function claudeSessions(visit: (found: Found[]) => Promise<void>): Promise<void> {
  const found: Found[] = [];
  let dirs: string[] = [];
  try { dirs = readdirSync(claudeRoot()); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
  const activity = claudeActivity();
  for (const dir of dirs) {
    let files: string[] = [];
    try { files = readdirSync(join(claudeRoot(), dir)).filter(f => /^[0-9a-f-]{36}\.jsonl$/i.test(f)); } catch { continue; }
    for (const f of files) {
      const id = f.slice(0, -6), file = join(claudeRoot(), dir, f);
      let info;
      try { info = await stat(file); } catch { continue; }
      if (!info.isFile()) continue;
      // No process on it means it isn't running, whatever its last turn looks like.
      const busy = activity ? activity.get(id) ?? false : undefined;
      found.push({
        nativeId: id, updatedAt: info.mtimeMs, stamp: `${info.mtimeMs}:${info.size}:${busy ?? isLive(info.mtimeMs)}`,
        probe: () => claudeEligible(file, info.size),
        load: async () => {
          const source = await readFile(file, "utf8");
          if (claudeOwn(source)) return;
          return projectClaude(id, file, source, { busy, modified: info.mtimeMs });
        },
      });
    }
  }
  await visit(found);
}

export function projectClaude(sessionId: string, file: string, source = readFileSync(file, "utf8"), activity?: Activity): Projected | undefined {
  const records: any[] = [];
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* A writer may not have finished its last line. */ }
  }
  const byUuid = new Map(records.filter((r) => r.uuid).map((r) => [r.uuid, r]));
  // The active branch: back from the newest message (a rewind leaves the old branch in the file).
  let leaf = records.findLast((r) => (r.type === "user" || r.type === "assistant") && r.uuid && !r.isSidechain);
  if (!leaf) return;
  const branch: any[] = [], seen = new Set<string>();
  // A compaction's boundary has no parentUuid: its logicalParentUuid leads back to the earlier history.
  while (leaf && !seen.has(leaf.uuid)) { seen.add(leaf.uuid); branch.push(leaf); leaf = byUuid.get(leaf.parentUuid ?? leaf.logicalParentUuid); }
  branch.reverse();
  const cwd = branch.find((r) => typeof r.cwd === "string")?.cwd;
  if (!cwd) return;
  const t = new Thread("claude");
  const tools = new Map<string, { start: ToolEvent; native: string }>();
  const asks = new Map<string, AskPart>();
  // anchors[k]: the last top-level assistant message after prompt k, where a rewind to k+1 resumes.
  const anchors: (string | null)[] = [];
  let anchor: string | null = null;
  for (const r of branch) {
    if (r.isSidechain || r.isMeta || r.isCompactSummary) continue;
    const at = ms(r.timestamp);
    const content = r.message?.content;
    if (r.type === "user") {
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (b?.type !== "tool_result") continue;
        const ask = asks.get(b.tool_use_id);
        if (ask) { ask.answer = b.is_error ? "" : resultText(b.content); continue; }
        const call = tools.get(b.tool_use_id);
        if (call) t.tool(r.uuid, at, doneEvent(call.start, call.native, b, r.toolUseResult));
      }
      const text = blocks.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n").trim();
      if (INTERRUPTED.test(text)) { t.end("stopped"); continue; }
      const images = blocks.filter((b: any) => b?.type === "image" && b.source?.type === "base64").map((b: any, i: number) => imageAttachment(`${r.uuid}-image-${i}`, b.source.media_type, b.source.data));
      if ((!text && !images.length) || CLAUDE_NOISE.test(text)) continue;
      if (t.turns) anchors.push(anchor);
      t.user(r.uuid, text, at, images);
    } else if (r.type === "assistant") {
      anchor = r.uuid;
      const model = r.message?.model;
      if (model && model !== "<synthetic>") t.model(r.uuid, at, model);
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === "text") t.text(r.uuid, at, b.text);
        else if (b.type === "thinking" && b.thinking) t.thought(r.uuid, at, b.thinking);
        else if (b.type === "tool_use" && b.name === "AskUserQuestion") {
          const q = b.input?.questions?.[0];
          const ask: AskPart = { type: "ask", id: b.id, method: "select", title: String(q?.question ?? ""), options: (q?.options ?? []).map((o: any) => String(o?.label ?? "")), other: true };
          asks.set(b.id, ask);
          t.part(r.uuid, at, ask);
        } else if (b.type === "tool_use") {
          const start = startEvent(b.id, b.name, b.input);
          tools.set(b.id, { start, native: b.name });
          t.tool(r.uuid, at, start);
        }
      }
      if (r.message?.stop_reason === "error" || r.isApiErrorMessage) t.end("error", t.reply?.content || undefined);
    }
  }
  if (!t.turns) return;
  anchors.push(anchor);
  const working = t.finish(activity);
  const customTitle = records.findLast((r) => r.type === "custom-title" && typeof r.customTitle === "string")?.customTitle;
  const title = customTitle ?? records.findLast((r) => r.type === "ai-title" && typeof r.aiTitle === "string")?.aiTitle
    ?? records.findLast((r) => r.type === "summary" && typeof r.summary === "string")?.summary;
  const chat = chatOf("claude", sessionId, t, working, { title, named: !!title, createdAt: ms(branch[0].timestamp), updatedAt: statSync(file).mtimeMs, cwd });
  if (customTitle) chat.titleSource = "user";
  return { chat, mapping: { id: sessionId, cwd: resolve(cwd), turns: t.turns, anchors }, working };
}

// ------------------------------------------------------------------ Codex

// Codex Desktop wraps the prompt with the files mentioned in it.
const CODEX_REQUEST = "## My request for Codex:";
const codexPrompt = (text: string) => {
  const at = text.lastIndexOf(CODEX_REQUEST);
  return (at >= 0 ? text.slice(at + CODEX_REQUEST.length) : text).trim();
};

/** Codex's own app server lists and reads its threads (wherever it keeps them). */
async function withCodex<T>(use: (p: CodexProcess) => Promise<T>): Promise<T> {
  const p = new CodexProcess(homedir());
  try {
    await p.initialize();
    return await use(p);
  } finally {
    p.close();
  }
}

/** Listings that start a runtime are skipped while its files are unchanged, but not for longer than this. */
const RELIST_MS = 5 * 60 * 1000;
const listed = new Map<string, { signature: string; at: number }>();
/** Whether a runtime's listing could have changed since it was last read, judged from its files. */
async function changed(key: string, paths: string[]): Promise<{ unchanged: boolean; record: () => void }> {
  const parts: string[] = [];
  const walk = async (path: string, depth: number): Promise<void> => {
    let info;
    try { info = await stat(path); } catch { return; }
    if (info.isDirectory() && depth < 5) {
      let names: string[] = [];
      try { names = readdirSync(path).sort(); } catch {}
      for (const name of names) await walk(join(path, name), depth + 1);
    } else if (info.isFile()) parts.push(`${path}:${info.mtimeMs}:${info.size}:${isLive(info.mtimeMs)}`);
  };
  for (const path of paths) await walk(path, 0);
  const signature = createHash("sha256").update(parts.join("\n")).digest("hex");
  const last = listed.get(key);
  return { unchanged: !!last && last.signature === signature && Date.now() - last.at < RELIST_MS, record: () => { listed.set(key, { signature, at: Date.now() }); } };
}

async function codexSessions(visit: (found: Found[]) => Promise<void>, key: string): Promise<void> {
  if (!codexBin()) return;
  const home = codexEnv().CODEX_HOME ?? join(homedir(), ".codex");
  const files = await changed(key, [join(home, "sessions"), join(home, "archived_sessions"), join(home, "session_index.jsonl")]);
  if (files.unchanged) return;
  await withCodex(async (p) => {
    const threads = new Map<string, any>();
    // Archived native threads still belong in the import.
    for (const archived of [false, true]) {
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const r = await p.request("thread/list", { limit: 100, archived, ...(cursor ? { cursor } : {}) }, 30_000);
        if (!Array.isArray(r.data)) throw new Error("Invalid Codex thread listing");
        for (const th of r.data) if (th?.id) threads.set(th.id, th);
        cursor = r.nextCursor || undefined;
        if (cursor && seen.has(cursor)) throw new Error("Codex repeated a listing cursor");
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    const found: Found[] = [];
    for (const th of threads.values()) {
      if (!th.cwd || th.originator === "openbuild" || th.ephemeral || th.parentThreadId || (th.source && typeof th.source === "object" && "subagent" in th.source)) continue;
      const updatedAt = ms(th.updatedAt) || ms(th.createdAt);
      // A thread loaded in a running Codex says what it's doing; others only have their last turn.
      const status = th.status && typeof th.status === "object" ? th.status.type : undefined;
      const busy = status === "active" ? true : status === "idle" ? false : undefined;
      found.push({ nativeId: th.id, updatedAt, stamp: `${updatedAt}:${status ?? ""}:${isLive(updatedAt)}`, load: async () => {
        const detail = (await p.request("thread/read", { threadId: th.id, includeTurns: true }, 30_000)).thread;
        return projectCodex({ ...th, ...detail, name: detail?.name || th.name }, { busy, modified: updatedAt });
      } });
    }
    await visit(found);
  });
  files.record();
}

export function projectCodex(th: any, activity?: Activity): Projected | undefined {
  if (!th?.id || !Array.isArray(th.turns)) return;
  const t = new Thread("codex");
  for (const turn of th.turns) {
    const at = ms(turn.startedAt) || ms(th.createdAt);
    const items: any[] = Array.isArray(turn.items) ? turn.items : [];
    const prompt = items.find((i) => i.type === "userMessage");
    if (prompt) {
      const content: any[] = Array.isArray(prompt.content) ? prompt.content : [];
      const text = codexPrompt(content.filter((c) => c.type === "text").map((c) => c.text).join("\n"));
      const images = content.filter((c) => c.type === "image" && /^data:[^;]+;base64,/.test(c.url ?? "")).map((c, i) => {
        const [, mime, data] = /^data:([^;]+);base64,(.*)$/s.exec(c.url)!;
        return imageAttachment(`${prompt.id}-image-${i}`, mime!, data!);
      });
      t.user(prompt.id, text, at, images);
    }
    const replyId = `${turn.id}-reply`;
    t.model(replyId, at, th.model ?? undefined);
    for (const item of items) {
      if (item.type === "userMessage") continue;
      if (item.type === "agentMessage") t.text(replyId, at, item.text ?? "");
      else if (item.type === "reasoning") t.thought(replyId, at, [...(item.summary ?? []), ...(item.content ?? [])].map(String).join("\n\n"));
      else { const ev = codexTool(item, true); if (ev) t.tool(replyId, at, ev); }
    }
    if (prompt || t.reply) t.end(turn.status === "failed" ? "error" : turn.status === "interrupted" ? "stopped" : "done", turn.error?.message);
  }
  if (!t.turns) return;
  const working = t.finish(activity, th.turns.at(-1)?.status === "inProgress");
  const preview = typeof th.preview === "string" ? codexPrompt(th.preview) : undefined;
  const chat = chatOf("codex", th.id, t, working, { title: th.name || preview, named: !!th.name, createdAt: ms(th.createdAt), updatedAt: ms(th.updatedAt), cwd: th.cwd });
  return { chat, mapping: { id: th.id, cwd: resolve(th.cwd), turns: t.turns, nativeTurns: th.turns.length }, working };
}

// ------------------------------------------------------------------ Cursor

const CURSOR_TOOLS: Record<string, string> = {
  shell: "bash", run_terminal_cmd: "bash", read: "read", read_file: "read", edit: "edit", strreplace: "edit", search_replace: "edit", multiedit: "edit",
  write: "write", delete: "edit", grep: "grep", glob: "find", ls: "ls", todowrite: "todo", updatetodos: "todo", websearch: "web_search", webfetch: "web_fetch", task: "task",
};

/** One protobuf message's top-level length-delimited fields (Cursor's root blob lists the messages in field 1). */
function protoFields(b: Uint8Array): [number, Uint8Array][] {
  const out: [number, Uint8Array][] = [];
  let i = 0;
  const varint = () => { let r = 0, s = 0, x: number; do { x = b[i++]!; r += (x & 127) * 2 ** s; s += 7; } while (x & 128 && i < b.length); return r; };
  while (i < b.length) {
    const tag = varint(), wire = tag % 8;
    if (wire === 0) varint();
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) { const n = varint(); out.push([Math.floor(tag / 8), b.slice(i, i + n)]); i += n; }
    else throw new Error(`Unexpected protobuf wire type ${wire}`);
  }
  return out;
}

const cursorQuery = (text: string) => {
  const m = /<user_query>\n?([\s\S]*?)\n?<\/user_query>/.exec(text);
  return m ? m[1]! : undefined;
};

/** When Cursor last wrote a chat: its store (and the store's write-ahead log) or its metadata. */
function cursorUpdated(dir: string, meta: any): number {
  let at = Number(meta.updatedAtMs ?? meta.createdAtMs) || 0;
  for (const name of ["store.db", "store.db-wal"]) try { at = Math.max(at, statSync(join(dir, name)).mtimeMs); } catch {}
  return at;
}

async function cursorSessions(visit: (found: Found[]) => Promise<void>): Promise<void> {
  const found: Found[] = [];
  let hashes: string[] = [];
  try { hashes = readdirSync(cursorDir()); } catch { return; }
  for (const hash of hashes) {
    let ids: string[] = [];
    try { ids = readdirSync(join(cursorDir(), hash)).filter((id) => /^[0-9a-f-]{36}$/i.test(id)); } catch { continue; }
    for (const id of ids) {
      const dir = join(cursorDir(), hash, id);
      try {
        const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
        if (!meta.hasConversation || typeof meta.cwd !== "string" || !existsSync(join(dir, "store.db"))) continue;
        // Cursor files a chat under its folder's hash: the adapter finds it there again.
        const cwd = existsSync(meta.cwd) ? realpathSync(meta.cwd) : meta.cwd;
        if (createHash("md5").update(resolve(cwd)).digest("hex") !== hash) continue;
        const updatedAt = cursorUpdated(dir, meta);
        found.push({ nativeId: id, updatedAt, stamp: `${updatedAt}:${isLive(updatedAt)}`, load: async () => projectCursor(id, cwd, meta, join(dir, "store.db"), { modified: updatedAt }) });
      } catch {}
    }
  }
  await visit(found);
}

export async function projectCursor(id: string, cwd: string, meta: any, file: string, activity?: Activity): Promise<Projected | undefined> {
  const { Database } = await import("bun:sqlite");
  const db = new Database(file, { readonly: true });
  const t = new Thread("cursor");
  try {
    const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = '0'").get();
    if (!row) return;
    const info = JSON.parse(Buffer.from(row.value, "hex").toString());
    const blob = (hash: string) => db.query<{ data: Uint8Array }, [string]>("SELECT data FROM blobs WHERE id = ?").get(hash)?.data;
    const root = info.latestRootBlobId && blob(info.latestRootBlobId);
    if (!root) return;
    const at = meta.createdAtMs ?? info.createdAt ?? 0;
    let n = 0;
    for (const [field, ref] of protoFields(root)) {
      if (field !== 1 || ref.length !== 32) continue;
      const data = blob(Buffer.from(ref).toString("hex"));
      let m: any;
      try { m = data && JSON.parse(Buffer.from(data).toString()); } catch { continue; }
      if (!m) continue;
      const msgId = `${id}-${n++}`;
      const parts: any[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
      if (m.role === "user") {
        // Cursor sends context of its own as user messages too; the prompt is in <user_query>.
        const query = cursorQuery(parts.filter((p) => p.type === "text").map((p) => p.text).join("\n"));
        if (query === undefined) continue;
        // OpenBuild's own Cursor threads start every prompt with its question instructions.
        if (query.startsWith(CURSOR_PREFIX.trim())) return;
        t.user(msgId, query.trim(), at);
      } else if (m.role === "assistant") {
        t.model(msgId, at, "Cursor", "auto");
        for (const p of parts) {
          if (p.type === "text") t.text(msgId, at, p.text ?? "");
          else if (p.type === "reasoning") t.thought(msgId, at, p.text ?? "");
          else if (p.type === "tool-call") {
            const args = p.args && typeof p.args === "object" ? p.args : {};
            const path = args.path ?? args.filePath ?? args.target_file;
            t.tool(msgId, at, { t: "tool", id: p.toolCallId, name: CURSOR_TOOLS[String(p.toolName).toLowerCase()] ?? String(p.toolName), args: { ...args, ...(path ? { path } : {}), cursor: { toolName: p.toolName } }, status: "running" });
          }
        }
      } else if (m.role === "tool") {
        for (const p of parts) {
          if (p.type !== "tool-result") continue;
          const output = typeof p.result === "string" ? p.result : JSON.stringify(p.result);
          t.tool(msgId, at, { t: "tool", id: p.toolCallId, name: "", status: p.isError ? "error" : "done", output });
        }
      }
    }
  } finally {
    db.close();
  }
  if (!t.turns) return;
  const working = t.finish(activity);
  const updatedAt = activity?.modified || (meta.updatedAtMs ?? statSync(file).mtimeMs);
  const chat = chatOf("cursor", id, t, working, { title: meta.title, named: !!meta.title, createdAt: meta.createdAtMs, updatedAt, cwd });
  return { chat, mapping: { id, cwd, turns: t.turns, pending: false, fingerprint: cursorFingerprint(cwd, id) }, working };
}

// ------------------------------------------------------------------ OpenCode

const OPENCODE_OWN = "<openbuild-question-instructions>";

async function pages(c: Awaited<ReturnType<typeof opencodeConnect>>, path: string): Promise<any[]> {
  const out: any[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const r = await c.request(`${path}${path.includes("?") ? "&" : "?"}limit=100&${cursor ? `cursor=${encodeURIComponent(cursor)}` : "order=asc"}`);
    if (!Array.isArray(r?.data)) throw new Error("Invalid OpenCode listing");
    out.push(...r.data);
    cursor = r.cursor?.next ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("OpenCode repeated a listing cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return out;
}

async function withOpencode<T>(use: (c: Awaited<ReturnType<typeof opencodeConnect>>) => Promise<T>): Promise<T> {
  const c = await opencodeConnect();
  try { return await use(c); } finally { await c.close().catch(() => {}); }
}

/** Where OpenCode keeps its sessions on this computer (its database), when it's local. */
const opencodeData = () => join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "opencode");

async function opencodeSessions(visit: (found: Found[]) => Promise<void>, key: string): Promise<void> {
  if (!opencodeBin() && !process.env.OPENCODE_SERVER_URL) return;
  // A remote server's sessions can't be stat'ed: it's listed every few minutes instead.
  const files = await changed(key, process.env.OPENCODE_SERVER_URL ? [] : ["opencode.db", "opencode.db-wal", "storage"].map((n) => join(opencodeData(), n)));
  if (files.unchanged) return;
  await withOpencode(async (c) => {
    const sessions = await pages(c, "/api/session");
    const found: Found[] = [];
    for (const s of sessions) {
      if (!s?.id || !s.location?.directory || s.parentID || s.revert || s.fork) continue;
      const updatedAt = ms(s.time?.updated) || ms(s.time?.created);
      found.push({ nativeId: s.id, updatedAt, stamp: `${updatedAt}:${isLive(updatedAt)}`, load: async () =>
        projectOpencode(s, await pages(c, `/api/session/${encodeURIComponent(s.id)}/message`), { modified: updatedAt }) });
    }
    await visit(found);
  });
  files.record();
}

export function projectOpencode(s: any, messages: any[], activity?: Activity): Projected | undefined {
  const t = new Thread("opencode");
  let turns = 0;
  for (const m of messages) {
    const at = ms(m.time?.created) || ms(s.time?.created);
    if (m.type === "user") {
      const text = String(m.text ?? "");
      if (text.startsWith(OPENCODE_OWN)) return;
      turns++;
      t.user(m.id, text, at);
    } else if (m.type === "assistant") {
      if (m.model?.id) t.model(m.id, at, m.model.id, `${m.model.providerID}/${m.model.id}`);
      for (const p of m.content ?? []) {
        if (p.type === "text") t.text(m.id, at, p.text ?? "");
        else if (p.type === "reasoning") t.thought(m.id, at, p.text ?? "");
        else if (p.type === "tool") {
          const state = p.state ?? {};
          const status = state.status === "error" ? "error" : state.status === "completed" ? "done" : "running";
          const data = { ...state, ...(typeof state.output === "string" ? { content: [{ type: "text", text: state.output }] } : {}), ...(typeof state.error === "string" ? { error: { message: state.error } } : {}) };
          t.tool(m.id, at, opencodeTool(p.id, { name: p.name, input: state.input, metadata: state.metadata }, status, data));
        }
      }
      t.end(m.finish === "error" || m.error ? "error" : m.finish === "aborted" ? "stopped" : "done", m.error?.message);
    }
  }
  if (!turns) return;
  // A reply OpenCode hasn't finished writing has no finish reason yet.
  const last = messages.at(-1);
  const working = t.finish(activity, t.pending || (last?.type === "assistant" && !last.finish && !last.error));
  const chat = chatOf("opencode", s.id, t, working, { title: s.title, named: !!s.title, createdAt: ms(s.time?.created), updatedAt: ms(s.time?.updated), cwd: s.location.directory });
  return { chat, mapping: { id: s.id, cwd: s.location.directory, turns, pending: false }, working };
}

// ------------------------------------------------------------------ discovery

/** Where a runtime keeps sessions: its default login, or another account's. */
interface Source { runtime: ImportRuntime; key: string; account?: RuntimeAccount }

const SCANNERS: Record<ImportRuntime, (visit: (found: Found[]) => Promise<void>, key: string) => Promise<void>> = { claude: claudeSessions, codex: codexSessions, cursor: cursorSessions, opencode: opencodeSessions };
async function timeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} didn't answer in time`)), ms);
      timer.unref?.();
    })]);
  } finally { clearTimeout(timer); }
}

/** What discovery last did with a session's thread; history is only refreshed while the mapping is still the one it wrote. */
interface Tracked {
  source: string; nativeId: string; stamp: string;
  /** Not someone's own session (SDK-driven, no prompt): read again only once it changes. */
  skipped?: boolean;
  /** OpenBuild ran a turn in it, or the user deleted it: discovery leaves it alone from then on. */
  left?: boolean;
  mapping?: string; archived?: boolean; working?: boolean;
}
const STATE = "session-import:v2:";
const trackedKey = (id: string) => `${STATE}thread:${id}`;
function tracked(id: string): Tracked | undefined {
  try { const raw = storage.getValue(trackedKey(id)); return raw ? JSON.parse(raw) : undefined; } catch { return undefined; }
}
const track = (id: string, t: Tracked) => storage.setValue(trackedKey(id), JSON.stringify(t));

/** The app's settings, as the last browser saved them: they list the accounts added by hand. */
function savedAccounts(): RuntimeAccount[] {
  try {
    const accounts = JSON.parse(storage.getValue("client-state") ?? "{}")?.state?.settings?.runtimeAccounts;
    // Accounts on paired devices keep their sessions on those devices; this server's are local.
    return Array.isArray(accounts) ? accounts.filter((a) => a && typeof a === "object" && (!a.deviceId || a.deviceId === serverId())) : [];
  } catch { return []; }
}

/** Every runtime's default login, and each other account signed in on this computer. */
export function sources(): Source[] {
  const saved = savedAccounts();
  const of = (runtime: RuntimeAccount["runtime"]) => saved.filter((a) => a.runtime === runtime);
  const dir = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const all: Source[] = [
    { runtime: "claude", key: `claude:${dir(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"))}` },
    { runtime: "codex", key: `codex:${dir(process.env.CODEX_HOME || join(homedir(), ".codex"))}` },
    { runtime: "cursor", key: `cursor:${dir(cursorDir())}` },
    { runtime: "opencode", key: "opencode" },
  ];
  const accounts: RuntimeAccount[] = [];
  try { accounts.push(...claudeAccounts(of("claude"))); } catch {}
  try { accounts.push(...codexAccounts(of("codex"))); } catch {}
  for (const a of of("cursor")) try { accounts.push({ ...a, configDir: accountPath(a.configDir) }); } catch {}
  for (const account of accounts) {
    const home = account.runtime === "cursor" ? join(account.configDir, "chats") : account.shadowHome ?? account.configDir;
    try { all.push({ runtime: account.runtime, key: `${account.runtime}:${dir(accountPath(home))}`, account }); } catch {}
  }
  return [...new Map(all.map((s) => [s.key, s])).values()];
}

const inAccount = <T>(source: Source, run: () => Promise<T>): Promise<T> =>
  source.account ? withRuntimeAccount({ runtime: source.runtime, runtimeAccount: source.account } as PiChatRequest, run) : run();

/** A reply OpenBuild itself is running in the thread: discovery waits for it to end. */
const ownTurn = (chat: Chat) => chat.messages.some((m) => m.status === "streaming" && m.stream?.via !== EXTERNAL_VIA);

async function discoverSource(source: Source): Promise<void> {
  const { runtime } = source;
  const errors: string[] = [];
  await inAccount(source, () => SCANNERS[runtime](async (listing) => {
    const own = ownSessions(runtime);
    const found = [...new Map(listing.map((f) => [f.nativeId, f])).values()]
      .filter((f) => !own.has(f.nativeId))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.nativeId.localeCompare(b.nativeId));
    // The first discovery on an account brings in its newest sessions, not years of them; the
    // line it draws stays, so later passes add the sessions after it and never reach further back.
    const cutoffKey = `${STATE}cutoff:${source.key}`;
    let cutoff = Number(storage.getValue(cutoffKey) ?? NaN);
    if (Number.isNaN(cutoff)) {
      let n = 0;
      cutoff = 0;
      for (const f of found) {
        if (!storage.chatExists(threadId(runtime, f.nativeId)) && f.probe && !(await f.probe().catch(() => false))) continue;
        if (++n === RECENT_IMPORT_LIMIT) { cutoff = f.updatedAt; break; }
      }
      storage.setValue(cutoffKey, String(cutoff));
    }
    for (const f of found) {
      const id = threadId(runtime, f.nativeId);
      const was = tracked(id);
      if (was?.left || was?.stamp === f.stamp) continue;
      const imported = !!was && !was.skipped;
      // Imported before discovery tracked it (or deleted since): it stays as the user left it.
      if (!imported && storage.chatExists(id)) continue;
      if (!imported && f.updatedAt < cutoff) continue;
      const skip = () => track(id, { source: source.key, nativeId: f.nativeId, stamp: f.stamp, skipped: true });
      try {
        if (!imported && f.probe && !(await f.probe())) { skip(); continue; }
        const loaded = await timeout(f.load(), 120_000, `Reading a ${runtime} session`);
        if (!loaded) { if (imported) track(id, { ...was, stamp: f.stamp }); else skip(); continue; }
        if (imported) refresh(id, was, f, loaded);
        else create(source, f, loaded);
      } catch (err) {
        // A session being rewritten, or one that can't be read: tried again on the next pass.
        errors.push((err as Error).message);
      }
      // Yield between histories so auth, sidebar polls and Stop stay responsive during a first discovery.
      await Bun.sleep(0);
    }
    settle(source, new Set(found.map((f) => f.nativeId)));
  }, source.key));
  if (errors.length) throw new Error(`${errors.length} session${errors.length === 1 ? "" : "s"} couldn't be read: ${errors[0]}`);
}

function create(source: Source, f: Found, { chat, mapping, working }: Projected) {
  const { runtime } = source;
  const id = chat.id;
  if (source.account) chat.runtimeAccount = source.account;
  storage.transaction(() => {
    // Something else claimed this thread or session meanwhile (it's OpenBuild's now): leave it alone.
    if (storage.chatExists(id) || storage.getValue(`${runtime}-session:${id}`) || ownSessions(runtime).has(f.nativeId)) return;
    claimRuntime(id, runtime as ThreadRuntime);
    if (!storage.putChat(chat as unknown as storage.StoredChat)) return;
    const saved = JSON.stringify(mapping);
    storage.setValue(`${runtime}-session:${id}`, saved);
    storage.setValue(BINDING + id, JSON.stringify({ runtime, nativeId: f.nativeId, cwd: chat.workspace!.cwd }));
    track(id, { source: source.key, nativeId: f.nativeId, stamp: f.stamp, mapping: saved, archived: chat.archived, working });
  });
}

/**
 * Whether the thread is closed: discovery's call (open while the runtime works on it, closed once
 * it's finished) until the user opens or closes it themselves; from then on it's theirs.
 */
const closedState = (old: Chat, was: Pick<Tracked, "archived">, working: boolean) =>
  // Reopening by hand also marks it done (Sidebar's closePatch); discovery never does.
  !!old.archived === !!was.archived && !old.done ? !working : old.archived;

/** History comes from the native session; what the user did with the thread stays theirs. */
export function merged(old: Chat, next: Chat, was: Pick<Tracked, "archived">, working: boolean): Chat {
  const keepTitle = old.titleSource === "user" || (old.titleSource === "auto" && !next.titleSource);
  return {
    ...old, messages: next.messages, updatedAt: Math.max(old.updatedAt, next.updatedAt),
    ...(keepTitle ? {} : { title: next.title, titleSource: next.titleSource }),
    archived: closedState(old, was, working),
  };
}

function refresh(id: string, was: Tracked, f: Found, { chat, mapping, working }: Projected) {
  const runtime = chat.runtime as ImportRuntime;
  storage.transaction(() => {
    const old = storage.getChat(id) as Chat | undefined;
    if (!old || storage.getValue(`${runtime}-session:${id}`) !== was.mapping) { track(id, { ...was, stamp: f.stamp, left: true }); return; }
    if (ownTurn(old)) return;
    const next = merged(old, chat, was, working);
    if (!storage.putChat(next as unknown as storage.StoredChat)) return;
    const saved = JSON.stringify(mapping);
    storage.setValue(`${runtime}-session:${id}`, saved);
    track(id, { ...was, stamp: f.stamp, mapping: saved, archived: next.archived, working });
  });
}

/** A session that was running and has since gone from its runtime's listing isn't running anymore. */
function settle(source: Source, listed: Set<string>) {
  for (const [key, value] of storage.listValues(`${STATE}thread:`)) {
    let was: Tracked;
    try { was = JSON.parse(value); } catch { continue; }
    if (!was.working || was.left || was.source !== source.key || listed.has(was.nativeId)) continue;
    const id = key.slice(`${STATE}thread:`.length);
    storage.transaction(() => {
      const chat = storage.getChat(id) as Chat | undefined;
      if (!chat || storage.getValue(`${source.runtime}-session:${id}`) !== was.mapping) { track(id, { ...was, left: true }); return; }
      const reply = chat.messages.findLast((m) => m.role === "assistant");
      const running = reply?.status === "streaming" && reply.stream?.via === EXTERNAL_VIA;
      const archived = closedState(chat, was, false);
      if (running || archived !== chat.archived) {
        const ended = running ? chat.messages.map((m) => { if (m !== reply) return m; const { stream: _, ...rest } = m; return { ...rest, status: "stopped" as const }; }) : chat.messages;
        storage.putChat({ ...chat, messages: ended, archived } as unknown as storage.StoredChat);
      }
      track(id, { ...was, working: false, archived });
    });
  }
}

const failures = new Map<string, string>();
let running: Promise<void> | undefined;
/** One discovery pass over every runtime and account; concurrent callers share it. */
export function discover(): Promise<void> {
  return running ??= Promise.all(sources().map(async (source) => {
    try {
      await timeout(discoverSource(source), 10 * 60_000, `Discovering ${source.runtime} sessions`);
      failures.delete(source.key);
    } catch (err) {
      // Retried on the next pass; said once, not every few seconds.
      const message = (err as Error).message;
      if (failures.get(source.key) !== message) console.warn(`[session-import] ${source.key}: ${message}`);
      failures.set(source.key, message);
    }
  })).then(() => {}).finally(() => { running = undefined; });
}

/** Keep discovering in the background, a pass every `interval` after the last one ends. */
export function startDiscovery(interval = 10_000): void {
  // Test servers exercise adapters in isolation; they must not read this computer's sessions.
  if (process.env.OPENBUILD_SESSION_DISCOVERY === "0" || (process.env.NODE_ENV === "test" && process.env.OPENBUILD_SESSION_DISCOVERY !== "1")) return;
  const tick = () => void discover().finally(() => { setTimeout(tick, interval).unref?.(); });
  tick();
}
