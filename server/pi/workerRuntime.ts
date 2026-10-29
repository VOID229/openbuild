/** Ordinary Pi is not checkpointable. Persist output, never replay an unfinished prompt. */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readEvents } from "../../shared/replies";
import type { PiChatRequest, ShellEvent, StreamEvent } from "../../shared/types";
import { outputTail } from "../../shared/shell";
import { Run } from "../runs";
import * as sessions from "./sessions";
import * as fx from "../fx/sessions";
import * as codex from "../codex/sessions";
import * as cursor from "../cursor/sessions";
import * as claude from "../claude/sessions";
import * as opencode from "../opencode-agent/sessions";
import * as shells from "./shell";

/** Who runs a turn, as messages name it. */
function agentName(runtime: PiChatRequest["runtime"], possessive = false) {
  const name = runtime === "opencode" ? "OpenCode" : runtime === "claude" ? "Claude Code" : runtime === "cursor" ? "Cursor" : runtime === "codex" ? "Codex" : runtime === "fx" ? "fx" : undefined;
  return name ? (possessive ? `${name}'s agent` : name) : "Pi";
}

export interface PiRunRecord {
  id: string;
  threadId: string;
  kind: "run" | "shell";
  request: PiChatRequest | shells.ShellRequest;
  status: "pending" | "finished" | "error" | "aborted" | "interrupted";
  startedAt: number;
  endedAt?: number;
}
type Event = StreamEvent | ShellEvent;
export class WorkerRun extends Run {
  constructor(readonly record: PiRunRecord, private persist: (event: Event) => void) { super(); }
  override push(event: StreamEvent) {
    if (this.ended) return;
    this.persist(event);
    // Shells may be dev servers that print forever. Their complete journal is on disk;
    // connected viewers use disk cursors, not an unbounded resident array.
    if (this.record.kind !== "shell") super.push(event);
  }
}

export class PiWorkerRuntime {
  private db: Database;
  private runs = new Map<string, WorkerRun>();
  private threads = new Set<string>();
  private shellTails = new Map<string, ShellEvent[]>();
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(join(directory, "runs.sqlite"), { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deleted_threads (thread_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(run_id,seq));
      CREATE TABLE IF NOT EXISTS summaries (id TEXT PRIMARY KEY, record TEXT NOT NULL, event_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS shell_snapshots (id TEXT PRIMARY KEY, events TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS count_events AFTER INSERT ON events BEGIN UPDATE summaries SET event_count=event_count+1 WHERE id=NEW.run_id; END;
      INSERT OR IGNORE INTO summaries SELECT id, json_remove(record, '$.request'), (SELECT COUNT(*) FROM events WHERE run_id=runs.id) FROM runs;`);
    // This constructor runs only after acquiring the process ownership lock. Pending means that
    // the former owner died: even if no event was committed, its prompt may have caused effects.
    for (const { record } of this.db.query<{ record: string }, []>("SELECT record FROM runs").all()) {
      const saved = JSON.parse(record) as PiRunRecord;
      this.threads.add(saved.threadId);
      if (saved.status !== "pending") continue;
      const run = this.load(saved);
      run.push(saved.kind === "shell"
        ? { t: "exit", status: "error", error: "Pi worker was interrupted. The command was not rerun.", ms: Date.now() - saved.startedAt } as unknown as StreamEvent
        : { t: "error", message: `${agentName((saved.request as PiChatRequest).runtime, true)} worker was interrupted. The reply was not rerun.` });
      this.finish(run, "interrupted");
    }
  }
  private load(record: PiRunRecord): WorkerRun {
    const cached = this.runs.get(record.id);
    if (cached) return cached;
    let seq = 0;
    const run = new WorkerRun(record, (event) => {
      this.db.query("INSERT INTO events VALUES (?1,?2,?3)").run(record.id, seq++, JSON.stringify(event));
      if (record.kind === "shell") {
        const previous = this.shellTails.get(record.id) ?? [];
        const snap = previous.find((e): e is Extract<ShellEvent, { t: "snap" }> => e.t === "snap");
        let exit = previous.find((e): e is Extract<ShellEvent, { t: "exit" }> => e.t === "exit");
        let output = snap?.output ?? "";
        const e = event as ShellEvent;
        if (e.t === "snap") output = outputTail(e.output, 256 * 1024);
        else if (e.t === "out") output = outputTail(output + e.v, 256 * 1024);
        else if (e.t === "exit") exit = e;
        this.shellTails.set(record.id, [{ t: "snap", output, status: exit?.status ?? "running" }, ...(exit ? [exit] : [])]);
      }
    });
    if (record.kind === "shell") {
      seq = this.eventCount(record.id);
      if (record.status === "pending") this.shellTails.set(record.id, this.snapshotEvents(record) as ShellEvent[]);
    }
    else for (const row of this.db.query<{ event: string }, [string]>("SELECT event FROM events WHERE run_id=? ORDER BY seq").all(record.id)) {
      Run.prototype.push.call(run, JSON.parse(row.event));
      seq++;
    }
    if (record.status !== "pending") run.end();
    if (record.status === "pending") this.runs.set(record.id, run);
    return run;
  }
  findRun(id: string, kind?: PiRunRecord["kind"]): WorkerRun | undefined {
    const active = this.runs.get(id);
    if (active && (!kind || active.record.kind === kind)) return active;
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM runs WHERE id=?").get(id);
    if (!row) return;
    const record = JSON.parse(row.record) as PiRunRecord;
    if (kind && record.kind !== kind) return;
    return this.load(record);
  }
  listRuns(): PiRunRecord[] {
    return this.db.query<{ record: string }, []>("SELECT record FROM runs").all().map((r) => JSON.parse(r.record));
  }
  eventCount(id: string): number {
    return this.db.query<{ count: number }, [string]>("SELECT event_count AS count FROM summaries WHERE id=?").get(id)?.count ?? 0;
  }
  events(id: string, after: number, limit = 256): StreamEvent[] {
    return this.db.query<{ event: string }, [string, number, number]>("SELECT event FROM events WHERE run_id=?1 AND seq>=?2 ORDER BY seq LIMIT ?3").all(id, after, limit).map((row) => JSON.parse(row.event));
  }
  snapshotEvents(record: Omit<PiRunRecord, "request">): (StreamEvent | ShellEvent)[] {
    if (record.kind !== "shell") return this.events(record.id, 0, -1);
    const cached = this.shellTails.get(record.id);
    if (cached) return cached;
    const saved = this.db.query<{ events: string }, [string]>("SELECT events FROM shell_snapshots WHERE id=?").get(record.id);
    if (saved) return JSON.parse(saved.events);
    let output = "";
    let exit: Extract<ShellEvent, { t: "exit" }> | undefined;
    // Keep complete shell output on disk, but only its bounded tail in snapshots/projections.
    for (const row of this.db.query<{ event: string }, [string]>("SELECT event FROM events WHERE run_id=? ORDER BY seq").iterate(record.id)) {
      const event = JSON.parse(row.event) as ShellEvent;
      if (event.t === "snap") output = outputTail(event.output, 256 * 1024);
      else if (event.t === "out") output = outputTail(output + event.v, 256 * 1024);
      else if (event.t === "exit") exit = event;
    }
    return [{ t: "snap", output, status: exit?.status ?? "running" }, ...(exit ? [exit] : [])];
  }
  /** Poll metadata without parsing/transporting prompts or base64 image inputs. */
  summaries(): (Omit<PiRunRecord, "request"> & { eventCount: number })[] {
    return this.db.query<{ record: string; eventCount: number }, []>(`SELECT record, event_count AS eventCount FROM summaries`).all()
      .map((r) => ({ ...JSON.parse(r.record), eventCount: r.eventCount }));
  }
  private finish(run: WorkerRun, status: PiRunRecord["status"]) {
    run.record.status = status;
    run.record.endedAt = Date.now();
    this.db.transaction(() => {
      this.db.query("UPDATE runs SET record=?2 WHERE id=?1").run(run.record.id, JSON.stringify(run.record));
      const { request: _request, ...summary } = run.record;
      this.db.query("UPDATE summaries SET record=?2 WHERE id=?1").run(run.record.id, JSON.stringify(summary));
      if (run.record.kind === "shell") this.db.query("INSERT OR REPLACE INTO shell_snapshots VALUES (?1,?2)").run(run.record.id, JSON.stringify(this.shellTails.get(run.record.id) ?? []));
    })();
    run.end();
    this.runs.delete(run.record.id);
    this.shellTails.delete(run.record.id);
  }
  private admit(id: string, threadId: string, kind: PiRunRecord["kind"], request: PiRunRecord["request"]) {
    if (!id || id.length > 256 || !sessions.isThreadId(threadId)) throw Object.assign(new Error("Invalid run or thread id"), { status: 400 });
    if (this.db.query("SELECT 1 FROM deleted_threads WHERE thread_id=?").get(threadId)) throw Object.assign(new Error("This thread was deleted"), { status: 410 });
    const existing = this.findRun(id);
    if (existing) {
      if (JSON.stringify(existing.record.request) !== JSON.stringify(request) || existing.record.kind !== kind) {
        throw Object.assign(new Error("This run id already belongs to another request"), { status: 409 });
      }
      return { run: existing, fresh: false };
    }
    if (kind === "run" && this.summaries().some((r) => r.threadId === threadId && r.kind === "run" && r.status === "pending")) {
      throw Object.assign(new Error(`${agentName((request as PiChatRequest).runtime)} is still working on this thread.`), { status: 409, code: "busy" });
    }
    const record: PiRunRecord = { id, threadId, kind, request, status: "pending", startedAt: Date.now() };
    this.db.transaction(() => {
      this.db.query("INSERT INTO runs VALUES (?1,?2)").run(id, JSON.stringify(record));
      const { request: _request, ...summary } = record;
      this.db.query("INSERT INTO summaries(id,record) VALUES (?1,?2)").run(id, JSON.stringify(summary));
    })();
    this.threads.add(threadId);
    return { run: this.load(record), fresh: true };
  }
  startRun(req: PiChatRequest): WorkerRun {
    const { run, fresh } = this.admit(req.stream?.id ?? "", req.threadId, "run", req);
    if (fresh) void this.consume(run, req.runtime === "opencode" ? opencode.runTurn(req, run.signal) : req.runtime === "claude" ? claude.runTurn(req, run.signal) : req.runtime === "cursor" ? cursor.runTurn(req, run.signal) : req.runtime === "codex" ? codex.runTurn(req, run.signal) : req.runtime === "fx" ? fx.runTurn(req, run.signal) : sessions.runTurn(req, run.signal));
    return run;
  }
  startShell(req: shells.ShellRequest): WorkerRun {
    const { run, fresh } = this.admit(req.id, req.threadId, "shell", req);
    if (fresh) {
      try { void this.consume(run, shells.startShell(req).stream()); }
      catch (error) { run.push({ t: "error", message: (error as Error).message }); this.finish(run, "error"); }
    }
    return run;
  }
  private async consume(run: WorkerRun, stream: ReadableStream<Uint8Array>) {
    let status: PiRunRecord["status"] = "finished";
    try {
      for await (const event of readEvents(stream)) {
        if (event.t === "end") continue;
        run.push(event);
        if (event.t === "error") status = "error";
        if (event.t === "done" && event.finish === "aborted") status = "aborted";
        const shell = event as unknown as ShellEvent;
        if (shell.t === "exit" && shell.status === "error") status = "error";
        if (shell.t === "exit" && shell.status === "stopped") status = "aborted";
      }
    } catch (error) { run.push({ t: "error", message: (error as Error).message }); status = "error"; }
    // A cancellation while Pi is still initializing can close runTurn without a terminal
    // event. Other devices still need to learn this was stopped rather than completed.
    if (run.signal.aborted && run.record.kind === "run" && !run.events.some((e) => e.t === "done" || e.t === "error")) {
      run.push({ t: "done", finish: "aborted" });
    }
    this.finish(run, run.signal.aborted ? "aborted" : status);
  }
  stopRun(id: string): boolean {
    const run = this.findRun(id);
    if (!run) return false;
    if (run.record.kind === "shell") shells.stopShell(id);
    else run.stop();
    return true;
  }
  stopThread(threadId: string) {
    for (const record of this.summaries()) if (record.threadId === threadId && record.status === "pending") this.stopRun(record.id);
  }
  deleteThread(threadId: string) {
    this.db.query("INSERT OR IGNORE INTO deleted_threads VALUES (?)").run(threadId);
    this.stopThread(threadId);
  }
  ownership() { return [...this.threads].filter((id) => sessions.isSessionLive(id) || fx.isSessionLive(id) || codex.isSessionLive(id) || cursor.isSessionLive(id) || claude.isSessionLive(id) || opencode.isSessionLive(id)); }
  answer(threadId: string, askId: string, reply: Parameters<typeof sessions.answer>[2]) {
    return cursor.hasAsk(threadId, askId) ? cursor.answer(threadId, askId, reply) : opencode.hasAsk(threadId, askId) ? opencode.answer(threadId, askId, reply) : claude.hasAsk(threadId, askId) ? claude.answer(threadId, askId, reply) : codex.hasAsk(threadId, askId) ? codex.answer(threadId, askId, reply) : fx.hasAsk(threadId, askId) ? fx.answer(threadId, askId, reply) : sessions.answer(threadId, askId, reply);
  }
  steer(threadId: string, steerId: string, message: string, images?: PiChatRequest["images"]) {
    return codex.canSteer(threadId) ? codex.steer(threadId, steerId, message, images) : sessions.steer(threadId, steerId, message, images);
  }
  compact = sessions.compact;
  release(threadId: string) { this.stopThread(threadId); sessions.release(threadId); fx.release(threadId); codex.release(threadId); cursor.release(threadId); claude.release(threadId); opencode.release(threadId); }
  restartIdle() { sessions.restartIdle(); fx.restartIdle(); codex.restartIdle(); cursor.restartIdle(); claude.restartIdle(); opencode.restartIdle(); }
}
