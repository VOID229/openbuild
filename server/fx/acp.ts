// One agent child process speaking the Agent Client Protocol (JSON-RPC 2.0, one message per line)
// over stdio: `fx acp` by default, or another ACP agent's command. Agents are installed on the
// device (never bundled), like Pi.
import type { Subprocess } from "bun";
import { fxBin, fxEnv } from "./install";

export type AcpMessage = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string; data?: unknown } };
type Listener = (message: AcpMessage) => void;

export class FxError extends Error {}

/** The program to run; errors name it, since they reach the thread as they are. */
export interface AcpProgram { name: string; command: string[]; env: Record<string, string> }
function fxProgram(): AcpProgram {
  const bin = fxBin();
  if (!bin) throw new FxError("Fx isn't installed on this device. Install it with: curl -fsSL https://fx.sh/setup.sh | bash");
  return { name: "Fx", command: [bin, "acp"], env: fxEnv() };
}

export class AcpProcess {
  readonly cwd: string;
  private name: string;
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private stderrTail: string[] = [];
  exited = false;
  exitCode?: number;
  lastUsed = Date.now();

  constructor(cwd: string, program: AcpProgram = fxProgram()) {
    this.cwd = cwd;
    this.name = program.name;
    this.proc = Bun.spawn(program.command, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: program.env });
    void this.readStdout();
    void this.readStderr();
    void this.proc.exited.then((code) => {
      this.exited = true;
      this.exitCode = code;
      const tail = this.stderrTail.slice(-6).join("\n");
      const err = new FxError(`${this.name} exited (code ${code})${tail ? `: ${tail}` : ""}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      for (const l of this.listeners) l({ jsonrpc: "2.0", method: "$/exit", params: { code, message: err.message } });
    });
  }

  private async readStdout() {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of this.proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let message: AcpMessage;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        this.dispatch(message);
      }
    }
  }

  private async readStderr() {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of this.proc.stderr) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (!line) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 50) this.stderrTail.shift();
      }
    }
  }

  private dispatch(message: AcpMessage) {
    // A response to one of our requests.
    if (message.method === undefined && typeof message.id === "number" && this.pending.has(message.id)) {
      const p = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) p.reject(new FxError([message.error.message || `${this.name} error ${message.error.code}`, typeof message.error.data === "string" ? message.error.data : ""].filter(Boolean).join(": ")));
      else p.resolve(message.result);
      return;
    }
    // A notification, or a request from the agent (permission, file system) that wants an answer.
    for (const l of this.listeners) l(message);
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private write(message: AcpMessage) {
    if (this.exited) return;
    this.proc.stdin.write(JSON.stringify(message) + "\n");
    this.proc.stdin.flush();
  }

  notify(method: string, params: unknown) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Answer a request the agent sent us. */
  respond(id: number | string, result: unknown) {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number | string, code: number, message: string) {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async request<T = any>(method: string, params: unknown, timeoutMs = 60_000, onSent?: (id: number) => void): Promise<T> {
    if (this.exited) throw new FxError(`${this.name} isn't running (exited with code ${this.exitCode})`);
    this.lastUsed = Date.now();
    const id = this.nextId++;
    return await new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new FxError(`${this.name} didn't answer "${method}" in time`));
      }, timeoutMs) : undefined;
      this.pending.set(id, {
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      onSent?.(id);
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  close() {
    if (this.exited) return;
    try {
      this.proc.stdin.end();
    } catch {}
    setTimeout(() => !this.exited && this.proc.kill(), 5000).unref?.();
  }
}
