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
export class PiTimeoutError extends PiError {}

/** The longest a command waits on a compaction Pi reports, as long as a reply may take. */
const COMPACTION_LIMIT_MS = 15 * 60 * 1000;

export class PiProcess {
  readonly cwd: string;
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private pending = new Map<string, { resolve: (r: PiRecord) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private stderrTail: string[] = [];
  private closing = false;
  private terminateTimer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;
  /** Set while Pi compacts the session: what to run when it's done. */
  private compacting?: Set<() => void>;
  private compactedAt = 0;
  exited = false;
  exitCode?: number;
  lastUsed = Date.now();

  constructor(args: string[], cwd: string, env?: Record<string, string>) {
    const bin = piBin();
    if (!bin) throw new PiError("Pi isn't installed. Install it in Settings → Pi.");
    this.cwd = cwd;
    this.proc = Bun.spawn([bin, "--mode", "rpc", ...args], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...piEnv(), ...env } });
    void this.readStdout();
    void this.readStderr();
    void this.proc.exited.then((code) => {
      this.exited = true;
      this.exitCode = code;
      clearTimeout(this.terminateTimer);
      clearTimeout(this.killTimer);
      const tail = this.stderrTail.slice(-6).join("\n");
      const err = new PiError(`Pi exited (code ${code})${tail ? `: ${tail}` : ""}`);
      this.compacting = undefined;
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.dispatch({ type: "process_exit", code, message: err.message });
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
    if (record.type === "compaction_start") this.compacting ??= new Set();
    if (record.type === "compaction_end") {
      const waiting = this.compacting;
      this.compacting = undefined;
      this.compactedAt = Date.now();
      for (const resume of waiting ?? []) resume();
    }
    if (record.type === "extension_error") reportProblem(record.extensionPath ?? "extension", `${record.event ? `${record.event}: ` : ""}${record.error}`);
    for (const l of this.listeners) {
      try {
        l(record);
      } catch (err) {
        // A cancelled UI stream or another observer must not kill the only stdout reader.
        // Losing that reader blocks *every* RPC response, including steering and abort.
        reportProblem("rpc", `Pi event listener failed (${record.type}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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

  /** Send a command and wait for its response; rejects when Pi says it failed. A command can bring
   *  its own `id`, which Pi puts on the events it streams for it (`bash_execution_update`). */
  async send<T = any>(command: PiRecord, timeoutMs = 60_000): Promise<T> {
    if (this.exited) throw new PiError(`Pi isn't running (exited with code ${this.exitCode})`);
    this.lastUsed = Date.now();
    const id = typeof command.id === "string" ? command.id : crypto.randomUUID();
    const started = Date.now();
    const response = await new Promise<PiRecord>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let resume: (() => void) | undefined;
      const settle = () => (clearTimeout(timer), resume && this.compacting?.delete(resume));
      const fail = () => {
        settle();
        const err = new PiTimeoutError(`Pi didn't answer "${command.type}" in time`);
        // Pi handles commands concurrently and doesn't cancel a slow one, so its answer can still come.
        err.answered = new Promise((done) => this.pending.set(id, { resolve: done, reject: () => done(undefined) }));
        reject(err);
      };
      // Pi answers a prompt that takes the session over its threshold only once it has compacted it,
      // and that's a model call: minutes on a long session. The deadline starts again once it's done.
      const expire = () => {
        const left = started + COMPACTION_LIMIT_MS - Date.now();
        if (left <= 0) return fail();
        if (this.compacting) {
          resume = () => (clearTimeout(timer), (timer = setTimeout(expire, timeoutMs)));
          this.compacting.add(resume);
          timer = setTimeout(fail, left);
          return;
        }
        const wait = Math.max(started, this.compactedAt) + timeoutMs - Date.now();
        if (wait > 0) timer = setTimeout(expire, wait);
        else fail();
      };
      timer = setTimeout(expire, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => (settle(), resolve(r)),
        reject: (e) => (settle(), reject(e)),
      });
      this.write({ ...command, id });
    });
    if (!response.success) throw new PiError(response.error ?? `Pi couldn't run "${command.type}"`);
    return response.data as T;
  }

  /** Ask Pi to shut down, then signal it; even a stuck SIGTERM handler has a hard deadline. */
  close(graceMs = 5000) {
    if (this.exited || this.closing) return;
    this.closing = true;
    try {
      this.proc.stdin.end();
    } catch {}
    this.terminateTimer = setTimeout(() => {
      if (this.exited) return;
      // Give Pi's signal handler a chance to kill its tracked shell children before hard-killing
      // the host. Its orderly shutdown can itself hang on an extension that ignores abort.
      this.proc.kill("SIGTERM");
      this.killTimer = setTimeout(() => !this.exited && this.proc.kill("SIGKILL"), 1000);
      this.killTimer.unref?.();
    }, graceMs);
    this.terminateTimer.unref?.();
  }
}
