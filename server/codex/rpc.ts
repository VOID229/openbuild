import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { accountArgs } from "../runtimeAccounts";
import { codexBin, codexEnv } from "./install";

export interface RpcMessage { id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } }
export class CodexRpcError extends Error { constructor(message: string, readonly code: number) { super(message); this.name = "CodexRpcError"; } }
export class CodexProcess {
  private child: ChildProcessWithoutNullStreams;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(m: RpcMessage) => void>();
  exited = false;
  lastUsed = Date.now();
  private stderr = "";
  constructor(readonly cwd: string, env?: Record<string, string>) {
    const bin = codexBin();
    if (!bin) throw new Error("Codex isn't installed. Install @openai/codex or set CODEX_BIN.");
    this.child = spawn(bin, ["app-server", ...accountArgs("codex")], { cwd, env: env ?? codexEnv(), stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", (e) => this.fail(e));
    this.child.stderr.on("data", (b) => { this.stderr = (this.stderr + b).slice(-16000); });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      let m: RpcMessage;
      try { m = JSON.parse(line); } catch { this.close(new Error("Codex sent invalid JSON")); return; }
      if (!m.method && typeof m.id === "number") {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.reject(new CodexRpcError(m.error.message, m.error.code)); else p.resolve(m.result);
      } else {
        for (const fn of this.listeners) {
          try { fn(m); } catch (e) { this.close(e instanceof Error ? e : new Error(String(e))); }
        }
      }
    });
    this.child.on("error", (e) => this.fail(e));
    this.child.on("exit", (code, signal) => this.fail(new Error(`Codex exited (${signal ?? code})${this.stderr ? `: ${this.stderr}` : ""}`)));
  }
  private fail(error: Error) {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    for (const fn of this.listeners) fn({ method: "$/exit", params: { message: error.message } });
    this.listeners.clear();
  }
  private send(m: RpcMessage) {
    if (this.exited) throw new Error("Codex process is closed");
    this.lastUsed = Date.now();
    this.child.stdin.write(JSON.stringify(m) + "\n");
  }
  request<T = any>(method: string, params: unknown, timeout = 60000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = timeout ? setTimeout(() => this.close(new Error(`Codex ${method} timed out`)), timeout) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  notify(method: string, params?: unknown) { this.send({ method, params }); }
  respond(id: number | string, result: unknown) { this.send({ id, result }); }
  respondError(id: number | string, message: string) { this.send({ id, error: { code: -32601, message } }); }
  on(fn: (m: RpcMessage) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  async initialize() {
    await this.request("initialize", { clientInfo: { name: "openbuild", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    this.notify("initialized");
  }
  close(error = new Error("Codex process closed")) {
    this.fail(error);
    this.child.stdin.destroy();
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL"); }, 2000);
    timer.unref();
  }
}
