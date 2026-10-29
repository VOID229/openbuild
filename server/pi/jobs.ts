// Long-running Pi maintenance commands (install, update, package install/remove), one at a time.
// Their output is kept so Settings can show it live and again after a reload.
import { spawn } from "node:child_process";
import { piEnv } from "./install";

export interface Job {
  id: string;
  title: string;
  command: string[];
  lines: string[];
  done: boolean;
  code?: number;
  startedAt: number;
}

const hot = globalThis as { openbuildJob?: Job; openbuildJobWaiters?: Set<() => void> };
const waiters = (hot.openbuildJobWaiters ??= new Set());
const wake = () => {
  for (const w of waiters) w();
  waiters.clear();
};

export const currentJob = () => hot.openbuildJob;

/** Start a job unless one is already running (that one is returned instead). */
export function startJob(title: string, command: string[], onDone?: (job: Job) => void | Promise<void>): Job {
  const running = hot.openbuildJob;
  if (running && !running.done) return running;
  const job: Job = { id: crypto.randomUUID(), title, command, lines: [], done: false, startedAt: Date.now() };
  hot.openbuildJob = job;
  // Detached: no controlling terminal, so installers take their non-interactive defaults instead
  // of waiting on /dev/tty for a key press nobody can give.
  let partial = "";
  const add = (chunk: Buffer) => {
    // Drop ANSI escapes and carriage-return progress redraws.
    partial += chunk.toString("utf8").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const parts = partial.split(/\r?\n/);
    partial = parts.pop() ?? "";
    for (const p of parts) {
      const line = p.split("\r").pop()!.trimEnd();
      if (line) job.lines.push(line);
    }
    if (job.lines.length > 2000) job.lines.splice(0, job.lines.length - 2000);
    wake();
  };
  let finishing = false;
  const finish = async (code: number) => {
    if (job.done || finishing) return;
    finishing = true;
    if (partial.trim()) job.lines.push(partial.trim());
    job.code = code;
    try {
      // Verification is part of maintenance: don't publish success or unlock another update early.
      await onDone?.(job);
    } catch (err) {
      job.lines.push(`Post-maintenance verification failed: ${err instanceof Error ? err.message : String(err)}`);
      if (job.code === 0) job.code = 1;
    } finally {
      job.done = true;
      wake();
    }
  };
  let child;
  try {
    child = spawn(command[0]!, command.slice(1), { env: { ...piEnv(), CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  } catch (err) {
    job.lines.push(err instanceof Error ? err.message : String(err));
    finish(127);
    return job;
  }
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  child.on("error", (err) => {
    job.lines.push(err.message);
    finish(127);
  });
  child.on("close", (code) => finish(code ?? 1));
  return job;
}

/** The job's output as NDJSON: {line} records, then {done, code}. Follows it live until it ends. */
export function jobStream(job: Job): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let sent = 0;
  return new ReadableStream({
    async pull(controller) {
      while (sent >= job.lines.length && !job.done) {
        await new Promise<void>((r) => {
          waiters.add(r);
          setTimeout(r, 15_000);
        });
        if (sent >= job.lines.length && !job.done) return controller.enqueue(enc.encode("\n"));
      }
      if (sent < job.lines.length) {
        const batch = job.lines.slice(sent);
        sent += batch.length;
        return controller.enqueue(enc.encode(batch.map((line) => JSON.stringify({ line }) + "\n").join("")));
      }
      controller.enqueue(enc.encode(JSON.stringify({ done: true, code: job.code, title: job.title }) + "\n"));
      controller.close();
    },
  });
}
