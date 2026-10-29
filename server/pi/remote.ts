/** Server-side client. Disconnects only stop watching; they NEVER abort ordinary Pi. */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { readEvents } from "../../shared/replies";
import { outputTail } from "../../shared/shell";
import type { PiChatRequest, ShellEvent, StreamEvent } from "../../shared/types";
import { Run } from "../runs";
import { dataDir } from "../paths";
import type { ShellRequest } from "./shell";
import type { PiRunRecord } from "./workerRuntime";
import { secureSocketPath, workerSocket } from "./worker";

const onSocket = (socket: string, init: RequestInit = {}) => ({ ...init, unix: socket }) as RequestInit;
export type PiSnapshot = Omit<PiRunRecord, "request"> & { eventCount?: number; events: (StreamEvent | ShellEvent)[] };
export class PiRun extends Run {
  constructor(readonly id: string, readonly threadId: string, readonly record: PiRunRecord, private cancelRun: () => Promise<unknown>) { super(); }
  override stop() { void this.cancelRun().catch(console.error); }
}
/** Shell output uses the same transport, but an indefinitely running dev server must not
 * retain every byte in the web server's RAM. Complete output remains in the worker journal. */
export class PiShell extends PiRun {
  private output = "";
  private exit?: Extract<ShellEvent, { t: "exit" }>;
  private listeners = new Set<(event: ShellEvent) => void>();
  override push(event: StreamEvent) {
    const e = event as unknown as ShellEvent;
    if (e.t === "snap") this.output = outputTail(e.output, 256 * 1024);
    else if (e.t === "out") this.output = outputTail(this.output + e.v, 256 * 1024);
    else if (e.t === "exit") this.exit = e;
    const snapshot: ShellEvent = { t: "snap", output: this.output, status: this.exit?.status ?? "running" };
    this.events.splice(0, this.events.length, snapshot as unknown as StreamEvent, ...(this.exit ? [this.exit as unknown as StreamEvent] : []));
    for (const listener of this.listeners) listener(e);
  }
  override end() {
    super.end();
    for (const listener of this.listeners) listener({ t: "end" });
    this.listeners.clear();
  }
  override stream(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let off = () => {};
    return new ReadableStream({
      start: (controller) => {
        const send = (event: ShellEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        send({ t: "snap", output: this.output, status: this.exit?.status ?? "running" });
        if (this.exit) send(this.exit);
        if (this.ended) { send({ t: "end" }); controller.close(); return; }
        const beat = setInterval(() => controller.enqueue(encoder.encode("\n")), 15_000);
        const listener = (event: ShellEvent) => {
          send(event);
          if (event.t === "end") { off(); controller.close(); }
        };
        this.listeners.add(listener);
        off = () => { clearInterval(beat); this.listeners.delete(listener); };
      },
      cancel: () => off(),
    });
  }
}

export class PiClient {
  private runs = new Map<string, PiRun>();
  private connected?: Promise<void>;
  private closed = false;
  private requests = new AbortController();
  private live = new Set<string>();
  private owned = new Set<string>();
  private snapshotCache = new Map<string, PiSnapshot>();
  constructor(readonly directory = join(dataDir(), "pi-worker"), readonly socket = workerSocket(resolve(directory))) {}
  private async health() {
    secureSocketPath(this.socket);
    try {
      const res = await fetch("http://pi/health", onSocket(this.socket, { signal: AbortSignal.timeout(500) }));
      return res.ok ? await res.json() as { pid: number; protocol: number; features?: string[] } : undefined;
    } catch { return undefined; }
  }
  private connect() {
    return this.connected ??= this.connectNow().catch((error) => { this.connected = undefined; throw error; });
  }
  private async connectNow() {
    const health = await this.health();
    if (health) {
      if (health.protocol !== 1) throw new Error("Pi worker protocol changed; explicitly stop the worker after its active work finishes.");
      return;
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const log = openSync(join(this.directory, "worker.log"), "a", 0o600);
    try {
      const child = spawn(process.execPath, [join(import.meta.dir, "worker.ts")], {
        cwd: resolve(import.meta.dir, "../.."),
        env: { ...process.env, OPENBUILD_PI_WORKER_DIR: resolve(this.directory), OPENBUILD_PI_WORKER_SOCKET: this.socket },
        detached: true, stdio: ["ignore", log, log],
      });
      child.on("error", (error) => console.error("[pi worker]", error));
      child.unref();
    } finally { closeSync(log); }
    // Concurrent starters are harmless: the process-held lock elects exactly one owner.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !this.closed) {
      const health = await this.health();
      if (health?.protocol === 1) return;
      await Bun.sleep(50);
    }
    throw new Error(`Pi worker did not start. See ${join(this.directory, "worker.log")}`);
  }
  private async request(path: string, body?: unknown, retry = false): Promise<Response> {
    if (this.closed) throw new Error("Pi client is closed");
    await this.connect();
    try {
      secureSocketPath(this.socket);
      const res = await fetch(`http://pi${path}`, onSocket(this.socket, {
        ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal: this.requests.signal,
      }));
      if (!res.ok && res.status !== 404) {
        const e = await res.json() as { error?: string; code?: string };
        throw Object.assign(new Error(e.error ?? `Pi worker HTTP ${res.status}`), { status: res.status, code: e.code });
      }
      return res;
    } catch (error) {
      this.connected = undefined;
      // Reads and stable-id admissions can safely retry. Never retry answer/steer/compact:
      // the worker might have executed them before the connection was lost.
      if (retry && !(error as { status?: number }).status) return this.request(path, body, false);
      throw error;
    }
  }
  private async json<T>(path: string, body?: unknown, retry = false): Promise<T> {
    const res = await this.request(path, body, retry);
    if (res.status === 404) throw Object.assign(new Error("No such Pi run"), { status: 404 });
    return await res.json() as T;
  }
  private adopt(record: PiRunRecord) {
    let run = this.runs.get(record.id);
    if (!run) {
      const Ctor = record.kind === "shell" ? PiShell : PiRun;
      run = new Ctor(record.id, record.threadId, record, () => this.stopRun(record.id));
      this.runs.set(record.id, run);
      // Durable retention is on disk; bound the convenience cache of fully replayed runs.
      if (this.runs.size > 200) for (const [id, cached] of this.runs) {
        if (this.runs.size <= 200) break;
        if (cached.ended && id !== record.id) this.runs.delete(id);
      }
      this.owned.add(record.threadId);
      if (record.status === "pending") this.live.add(record.threadId);
      void this.pump(run);
    }
    return run;
  }
  private async pump(run: PiRun) {
    let seen = 0;
    while (!run.ended && !this.closed) {
      try {
        const res = await this.request(`/events?id=${encodeURIComponent(run.id)}&after=${seen}`, undefined, true);
        if (!res.ok || !res.body) throw new Error("Pi worker lost a persisted run");
        for await (const event of readEvents(res.body)) {
          if (event.t === "end") { run.end(); break; }
          run.push(event);
          seen++;
        }
        if (run.ended) { void this.refreshOwnership().catch(() => {}); return; }
      } catch { if (this.closed) return; this.connected = undefined; }
      await Bun.sleep(250);
    }
  }
  async startRun(req: PiChatRequest): Promise<PiRun> {
    if (req.runtime === "fx" || req.runtime === "codex" || req.runtime === "cursor" || req.runtime === "claude" || req.runtime === "opencode") await this.ensureFeature(req.runtime);
    return this.adopt(await this.json<PiRunRecord>("/start", req, true));
  }
  /**
   * A worker started by an older OpenBuild keeps running across updates (that's the point of it), so
   * it may not know a newer runtime. Replace it, but only while it's idle: never cut off a turn.
   */
  private async ensureFeature(feature: string) {
    await this.connect();
    const health = await this.health();
    if (!health) {
      this.connected = undefined;
      throw Object.assign(new Error("Agent worker health is unavailable; retry shortly."), { status: 503 });
    }
    if (health.features?.includes(feature)) return;
    if (!health.features?.includes("idle-retire")) throw Object.assign(new Error(`OpenBuild's existing agent worker cannot safely upgrade automatically. After its work finishes, use \`openbuild stop --all\` and start OpenBuild again to enable ${feature}.`), { status: 409, code: "worker_upgrade" });
    // The worker must fence new admissions itself before retiring. Never signal it based
    // on a racy client-side idle check.
    try { await this.json("/retire", {}); }
    catch (error) {
      if ((error as { code?: string }).code !== "busy") throw error;
      throw Object.assign(new Error(`The existing agent worker must finish its other running threads before it can enable ${feature}. No prompt was sent. Try again once those threads finish.`), { status: 409, code: "worker_upgrade" });
    }
    for (let i = 0; i < 100 && await this.health(); i++) await Bun.sleep(100);
    this.connected = undefined;
    await this.connect();
  }
  async findRun(id: string): Promise<PiRun | undefined> {
    const res = await this.request(`/runs?id=${encodeURIComponent(id)}`, undefined, true);
    if (res.status === 404) return;
    const record = await res.json() as PiRunRecord;
    return record.kind === "run" ? this.adopt(record) : undefined;
  }
  async startShell(req: ShellRequest): Promise<PiShell> { return this.adopt(await this.json<PiRunRecord>("/shell/start", req, true)) as PiShell; }
  async findShell(id: string): Promise<PiShell | undefined> {
    const res = await this.request(`/runs?id=${encodeURIComponent(id)}`, undefined, true);
    if (res.status === 404) return;
    const record = await res.json() as PiRunRecord;
    return record.kind === "shell" ? this.adopt(record) as PiShell : undefined;
  }
  async stopRun(id: string) { return (await this.json<{ found: boolean }>("/stop", { id })).found; }
  async stopShell(id: string) { await this.stopRun(id); }
  async stopThread(threadId: string) { await this.json("/threads/stop", { threadId }); }
  async deleteThread(threadId: string) { await this.json("/threads/delete", { threadId }); }
  answer(threadId: string, askId: string, reply: { value?: string; confirmed?: boolean; cancelled?: boolean }) { return this.json<boolean>("/answer", { threadId, askId, reply }); }
  steer(threadId: string, steerId: string, message: string, images?: PiChatRequest["images"]) { return this.json<{ handled: boolean }>("/steer", { threadId, steerId, message, images }); }
  compact(threadId: string, instructions?: string) { return this.json<{ tokensBefore: number; estimatedTokensAfter?: number }>("/compact", { threadId, instructions }); }
  async release(threadId: string) { await this.json("/release", { threadId }); this.live.delete(threadId); }
  async restartIdle() { await this.json("/restartIdle", {}); await this.refreshOwnership(); }
  listRuns() { return this.json<PiRunRecord[]>("/records", undefined, true); }
  async snapshots(threadId?: string): Promise<PiSnapshot[]> {
    const known = Object.fromEntries([...this.snapshotCache].map(([id, snapshot]) => [id, `${snapshot.eventCount ?? snapshot.events.length}:${snapshot.status}`]));
    const changed = await this.json<PiSnapshot[]>("/snapshots", { threadId, known }, true);
    for (const snapshot of changed) {
      this.snapshotCache.set(snapshot.id, snapshot);
      this.owned.add(snapshot.threadId);
    }
    return [...this.snapshotCache.values()].filter((r) => !threadId || r.threadId === threadId);
  }
  isSessionLive(threadId: string) { return this.live.has(threadId); }
  ownsSession(threadId: string) { return this.owned.has(threadId); }
  async refreshOwnership() {
    const state = await this.json<{ live: string[]; owned: string[] }>("/ownership", undefined, true);
    this.live = new Set(state.live); this.owned = new Set(state.owned);
  }
  async recover() { this.connected = undefined; await this.refreshOwnership(); }
  /** Close watchers, not the worker or any Pi process. */
  async close() { this.closed = true; this.requests.abort(); }
}
const hot = globalThis as { openbuildPiClient?: PiClient; openbuildOpencodeClient?: PiClient };
const client = hot.openbuildPiClient ??= new PiClient();
const opencodeDirectory = () => join(dataDir(), "opencode-worker");
const opencodeClient = () => hot.openbuildOpencodeClient ??= new PiClient(opencodeDirectory());
/** Never start another lane just to poll. Reconnect it only if it has existing journal metadata. */
function existingClients(): PiClient[] {
  if (hot.openbuildOpencodeClient || existsSync(join(opencodeDirectory(), "worker.json"))) return [client, opencodeClient()];
  return [client];
}
export async function startRun(req: PiChatRequest) {
  if (req.runtime !== "opencode") return client.startRun(req);
  // OpenCode was previously admitted to the shared worker. Keep that thread there, including
  // stable-id replays and pending turns; never migrate a native turn between running owners.
  if (existsSync(join(client.directory, "worker.json")) && (await client.snapshots(req.threadId)).length) return client.startRun(req);
  // A dedicated lane can load the new adapter even while an older shared worker is busy.
  // Retiring/upgrading that worker would otherwise block new OpenCode threads indefinitely.
  return opencodeClient().startRun(req);
}
export async function findRun(id: string) {
  for (const c of existingClients()) { const run = await c.findRun(id); if (run) return run; }
}
export async function stopRun(id: string) {
  for (const c of existingClients()) if (await c.stopRun(id)) return true;
  return false;
}
export const stopThread = async (id: string) => { await Promise.all(existingClients().map(c => c.stopThread(id))); };
export const deleteThread = async (id: string) => { await Promise.all(existingClients().map(c => c.deleteThread(id))); };
export const startShell = (req: ShellRequest) => client.startShell(req);
export const findShell = (id: string) => client.findShell(id);
export const stopShell = (id: string) => client.stopShell(id);
export async function answer(threadId: string, askId: string, reply: Parameters<PiClient["answer"]>[2]) {
  for (const c of existingClients()) if (await c.answer(threadId, askId, reply)) return true;
  return false;
}
export const steer = (threadId: string, id: string, message: string, images?: PiChatRequest["images"]) => client.steer(threadId, id, message, images);
export const compact = (threadId: string, instructions?: string) => client.compact(threadId, instructions);
export const release = async (threadId: string) => { await Promise.all(existingClients().map(c => c.release(threadId))); };
export const restartIdle = async () => {
  const { forgetModels, forgetCommands } = await import("./sessions");
  forgetModels(); forgetCommands();
  // Maintenance callers historically fire-and-forget this command.
  await Promise.all(existingClients().map(c => c.restartIdle().catch((error) => console.warn("[pi worker] Could not restart idle sessions:", error))));
};
export const isSessionLive = (id: string) => existingClients().some(c => c.isSessionLive(id));
export const ownsSession = (id: string) => existingClients().some(c => c.ownsSession(id));
export const refreshOwnership = async () => { await Promise.all(existingClients().map(c => c.refreshOwnership())); };
export const recover = async () => { await Promise.all(existingClients().map(c => c.recover())); };
export const listRuns = async () => (await Promise.all(existingClients().map(c => c.listRuns()))).flat();
export const snapshots = async (threadId?: string) => (await Promise.all(existingClients().map(c => c.snapshots(threadId)))).flat();
