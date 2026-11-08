import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir } from "../paths";

export function opencodeBin(): string | undefined {
  const configured = process.env.OPENCODE_BIN;
  if (configured) return existsSync(configured) ? configured : Bun.which(configured) ?? undefined;
  const local = join(homedir(), ".opencode/bin/opencode");
  return existsSync(local) ? local : Bun.which("opencode") ?? undefined;
}
export function serverEnvironment(password: string): NodeJS.ProcessEnv {
  const { OPENCODE_SERVER_PASSWORD: _, ...env } = process.env;
  return { ...env, OPENCODE_PASSWORD: password };
}
type Child = ReturnType<typeof Bun.spawn>;
/** Every opencode server this process started and hasn't seen exit, across hot reloads. Bun runs no
 * exit hooks on a signal, so SIGTERM/SIGINT/SIGHUP kill them here and are then re-raised; a crash
 * runs "exit". SIGKILL can't be caught: tethered servers exit with their parent by themselves, and
 * the registry lets the next start reap the rest. */
const hot = globalThis as { openbuildOpencodeServers?: Set<Child> };
const spawned = hot.openbuildOpencodeServers ??= (() => {
  const children = new Set<Child>();
  const killAll = () => { for (const child of children) try { child.kill("SIGKILL"); } catch {} };
  process.on("exit", killAll);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    const handler = () => {
      killAll();
      // Keep the default (exit by that signal) unless someone else, e.g. the worker, handles it.
      // Prepended, so a later `once` handler is still registered when this looks.
      if (process.listeners(signal).every((l) => l === handler)) { process.removeListener(signal, handler); process.kill(process.pid, signal); }
    };
    process.prependListener(signal, handler);
  }
  return children;
})();
/** One file per spawned server: { pid, owner, token }. The token is also in the server's environment,
 * so a recycled PID or the user's own `opencode serve` never matches. */
const registry = () => join(dataDir(), "opencode-servers");
const TOKEN = "OPENBUILD_OPENCODE_TOKEN";
function identity(pid: number, token: string): { ppid: number } | undefined {
  try {
    if (process.platform === "linux") {
      if (!readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`${TOKEN}=${token}`)) return;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return { ppid: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) };
    }
    const env = Bun.spawnSync(["ps", "eww", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
    if (!env.stdout.toString().split(/\s+/).includes(`${TOKEN}=${token}`)) return;
    const ppid = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
    return { ppid: Number(ppid.stdout.toString().trim()) };
  } catch { return; }
}
/** Kill the servers OpenBuild started whose owner is gone (it was SIGKILLed or ran out of memory).
 * A server still parented by its owner, e.g. a detached worker's, is left alone. */
export function reapOrphans(directory = registry()): number[] {
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const reaped: number[] = [];
  for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
    const file = join(directory, name);
    try {
      const { pid, owner, token } = JSON.parse(readFileSync(file, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 1 || typeof token !== "string" || token.length < 32) { rmSync(file, { force: true }); continue; }
      const found = identity(pid, token);
      if (found && found.ppid === owner) continue;
      if (found) { try { process.kill(pid, "SIGKILL"); reaped.push(pid); } catch {} }
      rmSync(file, { force: true });
    } catch {}
  }
  return reaped;
}
function track(child: Child, token: string) {
  spawned.add(child);
  const file = join(registry(), `${child.pid}.json`);
  try {
    mkdirSync(registry(), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ pid: child.pid, owner: process.pid, token }), { mode: 0o600 });
  } catch { /* best effort: the signal hooks still cover this process */ }
  void child.exited.then(() => { spawned.delete(child); try { rmSync(file, { force: true }); } catch {} });
}
export interface NativeEvent { type: string; data: any; created?: number }
export class Connection {
  version = "";
  constructor(readonly url: string, private password: string, private child?: Child) {}
  get alive() { return !this.child || this.child.exitCode === null; }
  private headers() { return { Authorization: `Basic ${Buffer.from(`opencode:${this.password}`, "utf8").toString("base64")}` }; }
  async request(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<any> {
    const response = await fetch(this.url + path, { method, redirect: "error", headers: { ...this.headers(), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) });
    if (!response.ok) throw new Error(`OpenCode ${method} ${path.split("?")[0]} returned HTTP ${response.status}`);
    if (response.status === 204) return;
    try { return await response.json(); } catch { throw new Error("Expected OpenCode 2 JSON (v1 is not supported)"); }
  }
  async verify() {
    const response = await this.request("/api/info");
    const info = response.data ?? response;
    if (typeof info?.version !== "string" || !/^2\./.test(info.version)) throw new Error("OpenCode 2 is required; v1 is not supported");
    this.version = info.version;
    return this;
  }
  /** Resolves after SSE headers, before the caller submits a prompt. Never reconnect/replay. */
  async subscribe(onEvent: (event: NativeEvent) => void, onLoss: (error: Error) => void, signal: AbortSignal): Promise<() => void> {
    const stop = new AbortController();
    const combined = AbortSignal.any([stop.signal, signal]);
    const deadline = setTimeout(() => stop.abort(), 15_000);
    let response: Response;
    try { response = await fetch(this.url + "/api/event", { redirect: "error", headers: { ...this.headers(), Accept: "text/event-stream" }, signal: combined }); }
    finally { clearTimeout(deadline); }
    if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) { stop.abort(); throw new Error("OpenCode 2 event stream unavailable"); }
    const reader = response.body.getReader();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const heartbeat = () => { clearTimeout(idle); idle = setTimeout(() => { onLoss(new Error("OpenCode event stream heartbeat timed out; prompt will not be resent")); stop.abort(); }, 60_000); };
    heartbeat();
    void (async () => {
      const decoder = new TextDecoder(); let buffer = "";
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) throw new Error("OpenCode event stream ended; prompt will not be resent");
          heartbeat();
          buffer += decoder.decode(part.value, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
            if (data) { const event = JSON.parse(data); if (typeof event.type !== "string") throw new Error("Invalid OpenCode 2 event"); onEvent(event); }
          }
          if (buffer.length > 8 * 1024 * 1024) throw new Error("OpenCode event frame exceeded limit");
        }
      } catch (e) { if (!combined.aborted) onLoss(e instanceof Error ? e : new Error(String(e))); }
      finally { clearTimeout(idle); reader.releaseLock(); }
    })();
    return () => { clearTimeout(idle); stop.abort(); void reader.cancel().catch(() => {}); };
  }
  async close() {
    if (!this.child || !this.alive) return;
    this.child.kill();
    const timer = setTimeout(() => this.child?.kill("SIGKILL"), 2000);
    try { await this.child.exited; } finally { clearTimeout(timer); }
  }
}
/** `tethered` servers exit when this process does, even on SIGKILL (Bun's no-orphans mode, which
 * OpenCode builds honour). Not for turns: the flag is inherited by the tools a turn runs, and a
 * background `bun dev &` there must outlive its shell. */
export async function connect({ tethered = false } = {}): Promise<Connection> {
  if (process.env.OPENCODE_SERVER_URL) {
    let url: URL;
    try { url = new URL(process.env.OPENCODE_SERVER_URL); } catch { throw new Error("Invalid OPENCODE_SERVER_URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid OPENCODE_SERVER_URL");
    // Only the explicit external password, never the randomly generated local credential.
    return new Connection(url.toString().replace(/\/$/, ""), process.env.OPENCODE_SERVER_PASSWORD ?? "").verify();
  }
  const bin = opencodeBin();
  if (!bin) throw new Error("OpenCode 2 binary not found");
  const password = crypto.randomUUID() + crypto.randomUUID();
  const token = crypto.randomUUID() + crypto.randomUUID();
  // Do NOT detach: the detached worker's process group owns this child (stop --all).
  const child = Bun.spawn([bin, "serve", "--hostname=127.0.0.1", "--port=0"], { env: { ...serverEnvironment(password), [TOKEN]: token, ...(tethered ? { BUN_FEATURE_FLAG_NO_ORPHANS: "1" } : {}) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  track(child, token);
  // Drain both streams for the server's entire life; never include credentials in errors.
  let report!: (url: string) => void;
  const listening = new Promise<string>((r) => { report = r; });
  void (async () => { let text = ""; const decoder = new TextDecoder(); for await (const chunk of child.stdout as ReadableStream<Uint8Array>) { text = (text + decoder.decode(chunk, { stream: true })).slice(-8000); const m = text.match(/server listening on\s+(https?:\/\/[^\s\u001b]+)/i); if (m) report(m[1]!); } })().catch(() => {});
  void (async () => { for await (const _ of child.stderr as ReadableStream<Uint8Array>) { /* discard; never retain secrets or unbounded logs */ } })().catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let owned: Connection | undefined;
  try {
    const url = await Promise.race([listening, child.exited.then(() => { throw new Error("OpenCode server exited before readiness (OpenCode 2 required)"); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("OpenCode server startup timed out")), 20_000); })]);
    owned = new Connection(url, password, child);
    return await owned.verify();
  } catch (e) { await (owned ?? new Connection("", password, child)).close(); throw e; }
  finally { clearTimeout(timer); }
}
interface Shared { connection: Promise<Connection>; users: number; idle?: ReturnType<typeof setTimeout> }
let shared: Shared | undefined;
const IDLE_MS = 30_000;
function retire(s: Shared) {
  if (shared === s) shared = undefined;
  clearTimeout(s.idle);
  if (!s.users) void s.connection.then((c) => c.close(), () => {});
}
/** Status, model lists, session import and one-off answers share one tethered server, closed once
 * it has been idle for a while (or retired), instead of starting a server per call. */
export async function withConnection<T>(use: (c: Connection) => Promise<T>): Promise<T> {
  for (let retried = false; ; retried = true) {
    let s = shared;
    if (!s) {
      const created: Shared = s = shared = { connection: connect({ tethered: true }), users: 0 };
      created.connection.catch(() => { if (shared === created) shared = undefined; });
    }
    s.users++; clearTimeout(s.idle);
    try {
      const c = await s.connection;
      if (!c.alive && !retried) { retire(s); continue; }
      return await use(c);
    } finally {
      if (!--s.users) { if (shared === s) { const idle = s; s.idle = setTimeout(() => retire(idle), IDLE_MS); s.idle.unref?.(); } else retire(s); }
    }
  }
}
/** Start a new shared server for the next caller (e.g. after an update or sign-in); the old one
 * closes when its current users finish. */
export function retireConnection() { if (shared) retire(shared); }
let worker: Promise<Connection> | undefined;
/** Only runTurn uses this, in the detached worker that owns its turns' process group. */
export async function workerConnection(): Promise<Connection> {
  if (worker) { const previous = await worker; if (previous.alive) return previous; await previous.close(); worker = undefined; }
  return worker ??= connect().catch((e) => { worker = undefined; throw e; });
}
export async function closeWorkerConnection() { const current = worker; worker = undefined; if (current) await (await current).close(); }
export const locationQuery = (cwd: string) => `location%5Bdirectory%5D=${encodeURIComponent(cwd)}`;
