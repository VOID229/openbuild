import { userVisiblePrompt } from "../shared/promptDisplay";
// Bring in the threads people had with the native runtimes (Claude Code, Codex, Cursor, OpenCode)
// before they used OpenBuild. Pi's sessions are discovered continuously (pi/discovery.ts); these
// are imported once, when the user picks them in the first-run dialog. Each import writes the same
// session mapping the runtime's adapter writes for its own threads, so an imported thread carries
// on in the native session instead of starting over.
//
// The dialog is offered at most once per data directory: the first answer (import or skip) is
// recorded on disk before any work starts, so restarts, other browsers and failed imports never
// bring it back.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AskPart, Chat, Message, Part, ToolPart } from "../src/lib/types";
import type { Attachment, ThreadRuntime } from "../shared/types";
import * as storage from "./storage";
import { listProjects } from "./projects";
import { claimRuntime } from "./threadRuntime";
import { claudeEnv } from "./claude/install";
import { doneEvent, resultText, startEvent, type ToolEvent } from "./claude/tools";
import { codexBin } from "./codex/install";
import { CodexProcess } from "./codex/rpc";
import { toolEvent as codexTool } from "./codex/tools";
import { sessionDir as cursorDir, fingerprint as cursorFingerprint } from "./cursor/sessions";
import { QUESTION_PREFIX as CURSOR_PREFIX } from "./cursor/questions";
import { connect as opencodeConnect, opencodeBin } from "./opencode-agent/connection";
import { toolEvent as opencodeTool } from "./opencode-agent/tools";

export const IMPORT_RUNTIMES = ["claude", "codex", "cursor", "opencode"] as const;
export type ImportRuntime = (typeof IMPORT_RUNTIMES)[number];
export const isImportRuntime = (r: unknown): r is ImportRuntime => IMPORT_RUNTIMES.includes(r as ImportRuntime);

const DONE_KEY = "session-import:offered";
/** Imported threads' folders: like Pi's discovered sessions, they may run outside a registered project. */
export const BINDING = "imported-session:";

/** A native session as it would be imported: its thread and the adapter mapping that resumes it. */
interface Found { nativeId: string; load: () => Promise<{ chat: Chat; mapping: object } | undefined> }

const OUTPUT_LIMIT = 12000;
const threadId = (runtime: ImportRuntime, nativeId: string) => `${runtime}-${createHash("sha256").update(nativeId).digest("hex").slice(0, 32)}`;
const ms = (t: unknown) => typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(String(t)) || 0;

/** Native ids OpenBuild's own threads already run on: those sessions are OpenBuild's, not imports. */
function ownSessions(runtime: ImportRuntime): Set<string> {
  const ids = new Set<string>();
  for (const [, value] of storage.listValues(`${runtime}-session:`)) {
    try { ids.add(JSON.parse(value).id); } catch {}
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
}

const chatOf = (runtime: ImportRuntime, nativeId: string, t: Thread, o: { title?: string; named?: boolean; createdAt: number; updatedAt: number; cwd: string }): Chat => ({
  id: threadId(runtime, nativeId),
  runtime,
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

const claudeRoot = () => join(claudeEnv().CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
// Slash commands and their output, kept in the transcript but not prompts anyone typed.
const CLAUDE_NOISE = /^\s*(<command-|<local-command|Caveat: )/;
const INTERRUPTED = /^\[Request interrupted by user/;

/** The session's first prompt says where it came from: only people's own sessions, not SDK-driven or `claude -p` ones (OpenBuild's included). */
function claudeEntrypoint(file: string): string | undefined {
  const head = readFileSync(file, "utf8").slice(0, 1 << 20);
  for (const line of head.split("\n")) {
    try {
      const r = JSON.parse(line);
      if (r.type === "user" && r.entrypoint) return r.entrypoint;
    } catch {}
  }
}

async function claudeSessions(): Promise<Found[]> {
  const own = ownSessions("claude");
  const found: Found[] = [];
  let dirs: string[] = [];
  try { dirs = readdirSync(claudeRoot()); } catch { return []; }
  for (const dir of dirs) {
    let files: string[] = [];
    try { files = readdirSync(join(claudeRoot(), dir)).filter((f) => /^[0-9a-f-]{36}\.jsonl$/i.test(f)); } catch { continue; }
    for (const f of files) {
      const id = f.slice(0, -6), file = join(claudeRoot(), dir, f);
      if (own.has(id)) continue;
      // Sessions nobody prompted in (opened and quit, only slash commands) never become threads: don't count them.
      try { if (claudeEntrypoint(file)?.startsWith("sdk-") || !projectClaude(id, file)) continue; } catch { continue; }
      found.push({ nativeId: id, load: async () => projectClaude(id, file) });
    }
  }
  return found;
}

export function projectClaude(sessionId: string, file: string): { chat: Chat; mapping: object } | undefined {
  const records: any[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
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
  t.close();
  const title = records.findLast((r) => r.type === "ai-title" && typeof r.aiTitle === "string")?.aiTitle
    ?? records.findLast((r) => r.type === "summary" && typeof r.summary === "string")?.summary;
  const chat = chatOf("claude", sessionId, t, { title, named: !!title, createdAt: ms(branch[0].timestamp), updatedAt: statSync(file).mtimeMs, cwd });
  return { chat, mapping: { id: sessionId, cwd: resolve(cwd), turns: t.turns, anchors } };
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

async function codexSessions(): Promise<Found[]> {
  if (!codexBin()) return [];
  const own = ownSessions("codex");
  const threads: any[] = [];
  await withCodex(async (p) => {
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const r = await p.request("thread/list", { limit: 100, ...(cursor ? { cursor } : {}) }, 30_000);
      threads.push(...(r.data ?? []));
      if (!r.nextCursor || r.nextCursor === cursor) break;
      cursor = r.nextCursor;
    }
  });
  return threads
    .filter((th) => th?.id && th.cwd && !own.has(th.id) && th.originator !== "openbuild" && !th.ephemeral && !th.parentThreadId && !(th.source && typeof th.source === "object" && "subagent" in th.source))
    .map((th) => ({ nativeId: th.id, load: () => withCodex(async (p) => projectCodex((await p.request("thread/read", { threadId: th.id, includeTurns: true }, 60_000)).thread)) }));
}

export function projectCodex(th: any): { chat: Chat; mapping: object } | undefined {
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
  t.close();
  const preview = typeof th.preview === "string" ? codexPrompt(th.preview) : undefined;
  const chat = chatOf("codex", th.id, t, { title: th.name || preview, named: !!th.name, createdAt: ms(th.createdAt), updatedAt: ms(th.updatedAt), cwd: th.cwd });
  return { chat, mapping: { id: th.id, cwd: resolve(th.cwd), turns: t.turns, nativeTurns: th.turns.length } };
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

async function cursorSessions(): Promise<Found[]> {
  const own = ownSessions("cursor");
  const found: Found[] = [];
  let hashes: string[] = [];
  try { hashes = readdirSync(cursorDir()); } catch { return []; }
  for (const hash of hashes) {
    let ids: string[] = [];
    try { ids = readdirSync(join(cursorDir(), hash)).filter((id) => /^[0-9a-f-]{36}$/i.test(id)); } catch { continue; }
    for (const id of ids) {
      if (own.has(id)) continue;
      const dir = join(cursorDir(), hash, id);
      try {
        const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
        if (!meta.hasConversation || typeof meta.cwd !== "string" || !existsSync(join(dir, "store.db"))) continue;
        // Cursor files a chat under its folder's hash: the adapter finds it there again.
        const cwd = existsSync(meta.cwd) ? realpathSync(meta.cwd) : meta.cwd;
        if (createHash("md5").update(resolve(cwd)).digest("hex") !== hash) continue;
        found.push({ nativeId: id, load: async () => projectCursor(id, cwd, meta, join(dir, "store.db")) });
      } catch {}
    }
  }
  return found;
}

export async function projectCursor(id: string, cwd: string, meta: any, file: string): Promise<{ chat: Chat; mapping: object } | undefined> {
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
  t.close();
  const updatedAt = meta.updatedAtMs ?? statSync(file).mtimeMs;
  const chat = chatOf("cursor", id, t, { title: meta.title, named: !!meta.title, createdAt: meta.createdAtMs, updatedAt, cwd });
  return { chat, mapping: { id, cwd, turns: t.turns, pending: false, fingerprint: cursorFingerprint(cwd, id) } };
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
    if (cursor && seen.has(cursor)) break;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return out;
}

async function withOpencode<T>(use: (c: Awaited<ReturnType<typeof opencodeConnect>>) => Promise<T>): Promise<T> {
  const c = await opencodeConnect();
  try { return await use(c); } finally { await c.close().catch(() => {}); }
}

async function opencodeSessions(): Promise<Found[]> {
  if (!opencodeBin() && !process.env.OPENCODE_SERVER_URL) return [];
  const own = ownSessions("opencode");
  const sessions = await withOpencode((c) => pages(c, "/api/session"));
  return sessions
    .filter((s) => s?.id && s.location?.directory && !own.has(s.id) && !s.parentID && !s.revert && !s.fork)
    .map((s) => ({ nativeId: s.id, load: () => withOpencode(async (c) => projectOpencode(s, await pages(c, `/api/session/${encodeURIComponent(s.id)}/message`))) }));
}

export function projectOpencode(s: any, messages: any[]): { chat: Chat; mapping: object } | undefined {
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
  t.close();
  const chat = chatOf("opencode", s.id, t, { title: s.title, named: !!s.title, createdAt: ms(s.time?.created), updatedAt: ms(s.time?.updated), cwd: s.location.directory });
  return { chat, mapping: { id: s.id, cwd: s.location.directory, turns, pending: false } };
}

// ------------------------------------------------------------------ the one-time offer

const SCANNERS: Record<ImportRuntime, () => Promise<Found[]>> = { claude: claudeSessions, codex: codexSessions, cursor: cursorSessions, opencode: opencodeSessions };
const timeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} didn't answer in time`)), ms).unref?.())]);

/** Sessions not in OpenBuild yet (an earlier import, or a deleted import, counts as in). */
async function importable(runtime: ImportRuntime): Promise<Found[]> {
  const found = await timeout(SCANNERS[runtime](), 60_000, `Listing ${runtime} sessions`);
  return found.filter((f) => !storage.chatExists(threadId(runtime, f.nativeId)));
}

export const offered = () => storage.getValue(DONE_KEY) !== undefined;

let scan: { at: number; value: Promise<Partial<Record<ImportRuntime, number>>> } | undefined;
/** How many sessions each runtime has to import; shared briefly so several windows don't each spawn Codex/OpenCode. */
function counts(): Promise<Partial<Record<ImportRuntime, number>>> {
  if (scan && Date.now() - scan.at < 10 * 60_000) return scan.value;
  const value = Promise.all(IMPORT_RUNTIMES.map(async (r) => [r, await importable(r).then((f) => f.length, () => 0)] as const))
    .then((pairs) => Object.fromEntries(pairs.filter(([, n]) => n > 0)));
  scan = { at: Date.now(), value };
  return value;
}

/** Whether to offer the import, and what there is: nothing once it was answered. */
export async function offer(): Promise<{ pending: boolean; runtimes: Partial<Record<ImportRuntime, number>> }> {
  if (offered()) return { pending: false, runtimes: {} };
  const runtimes = await counts();
  // Answered in another window while this one counted.
  if (offered()) return { pending: false, runtimes: {} };
  return { pending: Object.keys(runtimes).length > 0, runtimes };
}

/**
 * The user's answer: import these runtimes' sessions ([] = skip). Recorded before anything is read,
 * so the offer is never made again, whatever happens next. A second answer imports nothing.
 */
export async function answer(runtimes: ImportRuntime[]): Promise<{ imported: Partial<Record<ImportRuntime, number>>; errors: Partial<Record<ImportRuntime, string>> }> {
  const imported: Partial<Record<ImportRuntime, number>> = {}, errors: Partial<Record<ImportRuntime, string>> = {};
  if (offered()) return { imported, errors };
  storage.setValue(DONE_KEY, JSON.stringify({ at: Date.now(), runtimes }));
  scan = undefined;
  for (const runtime of runtimes) {
    try {
      let n = 0;
      for (const f of await importable(runtime)) {
        try {
          const loaded = await timeout(f.load(), 120_000, `Reading a ${runtime} session`);
          if (loaded && save(runtime, f.nativeId, loaded.chat, loaded.mapping)) n++;
        } catch (err) {
          console.warn(`[import] ${runtime} session ${f.nativeId}:`, (err as Error).message);
        }
      }
      imported[runtime] = n;
    } catch (err) {
      errors[runtime] = (err as Error).message;
    }
  }
  return { imported, errors };
}

function save(runtime: ImportRuntime, nativeId: string, chat: Chat, mapping: object): boolean {
  const id = chat.id;
  // Something else claimed this thread meanwhile (it's OpenBuild's now): leave it alone.
  if (storage.chatExists(id) || storage.getValue(`${runtime}-session:${id}`)) return false;
  if (!storage.putChat(chat as unknown as storage.StoredChat)) return false;
  storage.setValue(`${runtime}-session:${id}`, JSON.stringify(mapping));
  claimRuntime(id, runtime as ThreadRuntime);
  storage.setValue(BINDING + id, JSON.stringify({ runtime, nativeId, cwd: chat.workspace!.cwd }));
  return true;
}

