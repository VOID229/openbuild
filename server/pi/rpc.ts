// One `pi --mode rpc` child process: JSONL commands on stdin, responses and session events on
// stdout (see Pi's docs/rpc.md). Records are split on LF only, never on Unicode line separators.
import type { Subprocess } from "bun";
import { piBin, piEnv } from "./install";

export type PiRecord = { type: string; [key: string]: any };
type Listener = (record: PiRecord) => void;

/** Problems Pi reported (stderr warnings, extension errors), for Settings → Pi. Newest last. */
export interface PiProblem {
  at: number;
  source: string;
  message: string;
}
const hot = globalThis as { openbuildPiProblems?: PiProblem[] };
export const problems = (hot.openbuildPiProblems ??= []);
export function reportProblem(source: string, message: string) {
  const text = message.trim();
  if (!text) return;
  // Same message again: just move it to the end with the new time.
  const i = problems.findIndex((p) => p.source === source && p.message === text);
  if (i >= 0) problems.splice(i, 1);
  problems.push({ at: Date.now(), source, message: text.slice(0, 2000) });
  if (problems.length > 100) problems.splice(0, problems.length - 100);
}

export class PiError extends Error {}

export class PiProcess {
  readonly cwd: string;
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private pending = new Map<string, { resolve: (r: PiRecord) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private stderrTail: string[] = [];
  exited = false;
  exitCode?: number;
  lastUsed = Date.now();

  constructor(args: string[], cwd: string) {
    const bin = piBin();
    if (!bin) throw new PiError("Pi isn't installed. Install it in Settings → Pi.");
    this.cwd = cwd;
    this.proc = Bun.spawn([bin, "--mode", "rpc", ...args], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: piEnv() });
    void this.readStdout();
    void this.readStderr();
    void this.proc.exited.then((code) => {
      this.exited = true;
      this.exitCode = code;
      const tail = this.stderrTail.slice(-6).join("\n");
      const err = new PiError(`Pi exited (code ${code})${tail ? `: ${tail}` : ""}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      for (const l of this.listeners) l({ type: "process_exit", code, message: err.message });
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
        let record: PiRecord;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        this.dispatch(record);
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
        // Expected noise: a new thread's session doesn't exist yet.
        if (/No project session found with id/.test(line)) continue;
        if (/warn|error|fail|cannot|could not|couldn't/i.test(line)) reportProblem("pi", line);
      }
    }
  }

  private dispatch(record: PiRecord) {
    if (record.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
      const p = this.pending.get(record.id)!;
      this.pending.delete(record.id);
      p.resolve(record);
      return;
    }
    if (record.type === "extension_error") reportProblem(record.extensionPath ?? "extension", `${record.event ? `${record.event}: ` : ""}${record.error}`);
    for (const l of this.listeners) l(record);
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Write a record that gets no response (extension_ui_response). */
  write(record: PiRecord) {
    if (this.exited) return;
    this.proc.stdin.write(JSON.stringify(record) + "\n");
    this.proc.stdin.flush();
  }

  /** Send a command and wait for its response; rejects when Pi says it failed. */
  async send<T = any>(command: PiRecord, timeoutMs = 60_000): Promise<T> {
    if (this.exited) throw new PiError(`Pi isn't running (exited with code ${this.exitCode})`);
    this.lastUsed = Date.now();
    const id = crypto.randomUUID();
    const response = await new Promise<PiRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiError(`Pi didn't answer "${command.type}" in time`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.write({ ...command, id });
    });
    if (!response.success) throw new PiError(response.error ?? `Pi couldn't run "${command.type}"`);
    return response.data as T;
  }

  /** Ask Pi to shut down (closing stdin), and kill it if it doesn't. */
  close() {
    if (this.exited) return;
    try {
      this.proc.stdin.end();
    } catch {}
    setTimeout(() => !this.exited && this.proc.kill(), 5000).unref?.();
  }
}
