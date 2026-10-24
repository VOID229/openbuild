// Commands the user runs from the composer: "!cmd" runs in the thread's folder and the agent reads the
// command and its output with the next message; "!!cmd" runs for the user alone. Both go through
// Pi's own `bash` in the thread's Pi process (sessions.ts), so they're part of its session and pass
// the user's `user_bash` extensions, as `!` and `!!` do in Pi's terminal UI. They run alongside a
// turn: nothing waits for the agent, and the agent isn't interrupted.
//
// A command runs on its own, like a reply (runs.ts): closing the tab doesn't stop it, and the app
// picks it back up from /api/pi/shells/:id. Only its latest output is kept (a dev server can print
// for hours); whoever watches gets that, then new output as it comes, then how it ended.
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { outputTail } from "../../shared/shell";
import type { ShellEvent } from "../../shared/types";
import { scratchDir } from "../projects";
import { bash } from "./sessions";

/** Output kept for whoever starts watching later. */
const KEEP_OUTPUT = 256 * 1024;
/** Finished commands stay this long, for a device that reconnects late. */
const KEEP = 15 * 60 * 1000;
const HEARTBEAT = 15_000;
/** New output goes out in batches, at most this often. */
const BATCH = 100;

type Exit = Extract<ShellEvent, { t: "exit" }>;
const encoder = new TextEncoder();
const line = (e: ShellEvent) => encoder.encode(JSON.stringify(e) + "\n");

export class Shell {
  output = "";
  exit?: Exit;
  /** Stopped by the user (Pi stops all of a thread's commands at once, so maybe by another's Stop). */
  stopping = false;
  /** Pi streamed some output for it. */
  heard = false;
  readonly startedAt = Date.now();
  readonly ctrl = new AbortController();
  private pending = "";
  private timer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<(e: ShellEvent) => void>();

  constructor(
    readonly id: string,
    readonly threadId: string,
  ) {}

  write(delta: string) {
    this.heard = true;
    this.pending += delta;
    this.timer ??= setTimeout(() => this.flush(), BATCH);
  }

  private flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending) return;
    const v = this.pending;
    this.pending = "";
    this.output = outputTail(this.output + v, KEEP_OUTPUT);
    // More than is kept arrived at once: watchers start over from what's kept.
    const e: ShellEvent = v.length > KEEP_OUTPUT ? { t: "snap", output: this.output, status: "running" } : { t: "out", v };
    for (const l of this.listeners) l(e);
  }

  finish(exit: Exit) {
    this.flush();
    this.exit = exit;
    for (const l of this.listeners) l(exit);
    this.listeners.clear();
  }

  /** The command as NDJSON: its output so far, then new output, then how it ended. Cancelling it (the client left) doesn't stop it. */
  stream(): ReadableStream<Uint8Array> {
    let off = () => {};
    return new ReadableStream({
      start: (controller) => {
        // Output still waiting for its batch comes in that batch, like for everyone else.
        controller.enqueue(line({ t: "snap", output: this.output, status: this.exit?.status ?? "running" }));
        const close = (exit: Exit) => {
          controller.enqueue(line(exit));
          controller.enqueue(line({ t: "end" }));
          controller.close();
        };
        if (this.exit) return close(this.exit);
        const beat = setInterval(() => controller.enqueue(encoder.encode("\n")), HEARTBEAT);
        const listen = (e: ShellEvent) => {
          if (e.t !== "exit") return controller.enqueue(line(e));
          off();
          close(e);
        };
        this.listeners.add(listen);
        off = () => {
          clearInterval(beat);
          this.listeners.delete(listen);
        };
      },
      cancel: () => off(),
    });
  }
}

// Under `bun --hot` this module re-runs on every edit: keep the commands in progress.
const hot = globalThis as { openbuildShells?: Map<string, Shell> };
const shells = (hot.openbuildShells ??= new Map());

export const findShell = (id: string) => shells.get(id);

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export interface ShellRequest {
  /** Also the id of its stream. */
  id: string;
  threadId: string;
  cwd: string;
  command: string;
  /** "!!": the agent never sees it. */
  hidden: boolean;
}

/** Start a command, or return it if it's already running (so retrying a request is safe). */
export function startShell(req: ShellRequest): Shell {
  const existing = shells.get(req.id);
  if (existing) return existing;
  const shell = new Shell(req.id, req.threadId);
  shells.set(req.id, shell);
  // A scratch thread's folder starts out empty, so its commands run from the home folder; the agent
  // reads where they ran.
  const scratch = real(req.cwd).startsWith(real(scratchDir()) + sep);
  const command = scratch ? `cd ~ && ${req.command}` : req.command;
  const ms = () => Date.now() - shell.startedAt;
  void bash(req.threadId, req.cwd, req.id, command, req.hidden, (d) => shell.write(d), shell.ctrl.signal)
    .then(
      (r) => {
        // An extension answered for it (one that blocks risky commands says why): there was no output stream.
        if (!shell.heard && !shell.stopping && r.output) shell.write(r.output);
        shell.finish(
          shell.stopping
            ? { t: "exit", status: "stopped", ms: ms() }
            : r.cancelled
              ? // An extension turned it down, or Pi let go of the session (a retry or an edit goes back in the thread).
                { t: "exit", status: "error", error: "Pi cancelled this command.", ms: ms() }
              : { t: "exit", status: "done", exitCode: r.exitCode, fullOutputPath: r.truncated ? r.fullOutputPath : undefined, ms: ms() },
        );
      },
      (err: Error) => shell.finish({ t: "exit", status: "error", error: err.message, ms: ms() }),
    )
    .finally(() => setTimeout(() => shells.get(req.id) === shell && shells.delete(req.id), KEEP).unref?.());
  return shell;
}

/** Stop a command. Pi stops every command the user is running in that thread along with it. */
export function stopShell(id: string) {
  const shell = shells.get(id);
  if (!shell || shell.exit) return;
  for (const s of shells.values()) {
    if (s.threadId !== shell.threadId || s.exit) continue;
    s.stopping = true;
    s.ctrl.abort();
  }
}
