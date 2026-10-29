import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
export interface NativeEvent { type: string; data: any; created?: number }
export class Connection {
  version = "";
  private exitHandler?: () => void;
  constructor(readonly url: string, private password: string, private child?: ReturnType<typeof Bun.spawn>) {
    if (child) { this.exitHandler = () => { if (this.alive) child.kill(); }; process.once("exit", this.exitHandler); }
  }
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
    if (this.exitHandler) { process.removeListener("exit", this.exitHandler); this.exitHandler = undefined; }
    if (!this.child || !this.alive) return;
    this.child.kill();
    const timer = setTimeout(() => this.child?.kill("SIGKILL"), 2000);
    try { await this.child.exited; } finally { clearTimeout(timer); }
  }
}
export async function connect(): Promise<Connection> {
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
  // Do NOT detach: the detached worker's process group owns this child (stop --all).
  const child = Bun.spawn([bin, "serve", "--hostname=127.0.0.1", "--port=0"], { env: serverEnvironment(password), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
let worker: Promise<Connection> | undefined;
/** Only runTurn uses this; HTTP discovery always owns an ephemeral connection. */
export async function workerConnection(): Promise<Connection> {
  if (worker) { const previous = await worker; if (previous.alive) return previous; await previous.close(); worker = undefined; }
  return worker ??= connect().catch((e) => { worker = undefined; throw e; });
}
export async function closeWorkerConnection() { const current = worker; worker = undefined; if (current) await (await current).close(); }
export const locationQuery = (cwd: string) => `location%5Bdirectory%5D=${encodeURIComponent(cwd)}`;
