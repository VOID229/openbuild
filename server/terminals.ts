// A terminal in the browser: a real shell on a pseudo-terminal (PTY) on this machine, in the folder a
// thread works in, streamed to whoever is looking. The browser side is src/lib/terminal.ts; the app
// opens it with Cmd/Ctrl+J in the folder of the open thread, on the device that thread runs on (this
// one, or a paired one through /api/devices/<id>/…).
//
// A shell runs on its own, like a reply (runs.ts) or a "!" command (pi/shell.ts): closing the panel,
// reloading the page or opening the app on another device doesn't stop it. The app keeps an id per
// folder and opening that id again attaches to the same shell, so a reload brings back the session
// instead of a new one. Only its latest output is kept, for whoever attaches late.
//
// Bun's own terminal support (Bun.spawn({ terminal })) is the PTY, so the shell sees a real tty:
// prompts, colours, job control and full-screen programs (vim, less, htop) behave like they do in a
// terminal window.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isStreamId } from "../shared/replies";
import { TERMINAL_KEEP, terminalSize, terminalTail, type TerminalEvent } from "../shared/terminal";
import { bad, readJson } from "./handlers";
import { piEnv } from "./pi/install";
import { allowedCwd } from "./projects";

/** Output goes out in batches, at most this often: often enough that typing feels immediate. */
const BATCH = 16;
/** A shell that ended stays this long, so a reload can still see how it ended. */
const KEEP = 15 * 60 * 1000;
const HEARTBEAT = 15_000;

type Exit = Extract<TerminalEvent, { t: "exit" }>;
const encoder = new TextEncoder();
const line = (e: TerminalEvent) => encoder.encode(JSON.stringify(e) + "\n");

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export class Session {
  output = "";
  running = true;
  exit?: Exit;
  readonly startedAt = Date.now();
  /** Resolves once the shell has exited (and its last output is out). */
  readonly done: Promise<void>;
  private markDone!: () => void;
  private term?: Bun.Terminal;
  private proc?: Bun.Subprocess;
  private pending = "";
  private timer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<(e: TerminalEvent) => void>();
  /** Bytes become text across chunk boundaries, so a split character isn't a broken one. */
  private decoder = new TextDecoder("utf-8");

  constructor(
    readonly id: string,
    readonly cwd: string,
  ) {
    this.done = new Promise((r) => (this.markDone = r));
  }

  start(size: { cols: number; rows: number }) {
    // A login shell, like a terminal window opens: it picks up the same PATH and prompt the user's
    // own terminal has (Pi's folders are on the PATH too, so `pi` works here).
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    try {
      this.proc = Bun.spawn([shell, "-l"], {
        cwd: this.cwd,
        env: { ...piEnv(), TERM: "xterm-256color", COLORTERM: "truecolor", LANG: process.env.LANG || "en_US.UTF-8" },
        terminal: { ...size, data: (_term, data) => this.write(this.decoder.decode(data, { stream: true })) },
      });
    } catch (err) {
      // No shell to run (SHELL points at something that isn't there): say so instead of hanging.
      this.finish({ t: "exit", error: (err as Error).message });
      return;
    }
    this.term = this.proc.terminal;
    void this.proc.exited.then(
      (code) => this.finish({ t: "exit", exitCode: code }),
      (err: Error) => this.finish({ t: "exit", error: err.message }),
    );
  }

  /** Output from the shell. */
  write(delta: string) {
    if (!delta) return;
    this.pending += delta;
    this.timer ??= setTimeout(() => this.flush(), BATCH);
  }

  /** Typed keys and pasted text. */
  input(data: string) {
    if (!this.running) return;
    try {
      this.term?.write(data);
    } catch {}
  }

  resize(size: { cols: number; rows: number }) {
    if (!this.running) return;
    try {
      this.term?.resize(size.cols, size.rows);
    } catch {}
  }

  /** End the shell. Its exit arrives through `exited`, so every watcher sees it the same way. */
  kill() {
    if (!this.running) return;
    try {
      // Closing the PTY hangs up what's running in it — the shell ignores a plain SIGTERM.
      this.term?.close();
      this.proc?.kill("SIGHUP");
    } catch {}
    // Something that ignored the hangup (a program that traps it) goes too.
    setTimeout(() => {
      if (this.running) {
        try {
          this.proc?.kill("SIGKILL");
        } catch {}
      }
    }, 2000).unref?.();
  }

  private flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending) return;
    const v = this.pending;
    this.pending = "";
    this.output = terminalTail(this.output + v, TERMINAL_KEEP);
    // More arrived at once than is kept: watchers start over from what's kept.
    const e: TerminalEvent = v.length > TERMINAL_KEEP ? { t: "snap", output: this.output, running: this.running } : { t: "out", v };
    for (const l of this.listeners) l(e);
  }

  private finish(exit: Exit) {
    if (!this.running) return;
    // Whatever the shell printed just before it went, then the news.
    this.pending += this.decoder.decode();
    this.flush();
    this.running = false;
    this.exit = exit;
    for (const l of this.listeners) l(exit);
    this.listeners.clear();
    try {
      this.term?.close();
    } catch {}
    this.term = undefined;
    this.markDone();
  }

  /** The terminal as NDJSON: its output so far, then new output, then how it ended. Cancelling it (the client left) doesn't stop the shell. */
  stream(): ReadableStream<Uint8Array> {
    let off = () => {};
    return new ReadableStream({
      start: (controller) => {
        // Output still waiting for its batch comes in that batch, like for everyone else.
        controller.enqueue(line({ t: "snap", output: this.output, running: this.running }));
        const close = (exit: Exit) => {
          controller.enqueue(line(exit));
          controller.enqueue(line({ t: "end" }));
          controller.close();
        };
        if (this.exit) return close(this.exit);
        const beat = setInterval(() => controller.enqueue(encoder.encode("\n")), HEARTBEAT);
        const listen = (e: TerminalEvent) => {
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

// Under `bun --hot` this module re-runs on every edit: keep the terminals that are open.
const hot = globalThis as { openbuildTerminals?: Map<string, Session> };
const sessions = (hot.openbuildTerminals ??= new Map());

export const findSession = (id: string) => sessions.get(id);

export interface TerminalRequest {
  /** Also the id of its stream. Reusing it attaches to the terminal already running under it. */
  id: string;
  cwd: string;
  cols: number;
  rows: number;
}

/** Open a terminal, or attach to the one already running under this id. */
export function openTerminal(req: TerminalRequest): Session {
  const cwd = real(req.cwd);
  const existing = sessions.get(req.id);
  if (existing && existing.running && existing.cwd === cwd) {
    // The window was resized while it was closed (or on another device): match it.
    existing.resize(req);
    return existing;
  }
  // A shell that ended stays around so a reload can see how it ended, but opening the terminal
  // again means a new shell — in this folder, or another one (a thread that moved into a worktree).
  if (existing) killTerminal(req.id);
  const session = new Session(req.id, cwd);
  sessions.set(req.id, session);
  session.start({ cols: req.cols, rows: req.rows });
  void session.done.then(() => setTimeout(() => sessions.get(req.id) === session && sessions.delete(req.id), KEEP).unref?.());
  return session;
}

export function killTerminal(id: string) {
  sessions.get(id)?.kill();
}

type Api = <R extends Request, A extends unknown[]>(handler: (req: R, ...rest: A) => Response | Promise<Response>) => (req: R, ...rest: A) => Response | Promise<Response>;

const ndjson = { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform" };

/** Terminal routes. Mounted by server/index.ts behind its request checks, and proxied to paired devices. */
export function terminalRoutes(api: Api) {
  return {
    // Open (or reattach to) a terminal in a folder. The shell starts before this answers, so the
    // stream that follows has its output from the first prompt onwards.
    "/api/terminals": {
      POST: api(async (req) => {
        const body = await readJson(req);
        if (!isStreamId(body?.id)) return bad("Expected { id, cwd?, cols, rows }");
        if (body.cwd !== undefined && (typeof body.cwd !== "string" || body.cwd.length > 1024)) return bad("Expected { id, cwd?, cols, rows }");
        // No folder: the home folder, like a terminal window opened on its own.
        const cwd = body.cwd || homedir();
        if (!existsSync(cwd)) return bad("That folder doesn't exist anymore (was its worktree removed?).", 410);
        if (cwd !== homedir() && !allowedCwd(cwd)) return bad("That folder isn't a project in OpenBuild", 403);
        const session = openTerminal({ id: body.id, cwd, ...terminalSize(body.cols, body.rows) });
        return Response.json({ id: session.id, cwd: session.cwd, running: session.running });
      }),
    },
    "/api/terminals/:id": {
      GET: api((req: Bun.BunRequest<"/api/terminals/:id">, server: Bun.Server<unknown>) => {
        server.timeout(req, 0);
        const session = isStreamId(req.params.id) ? findSession(req.params.id) : undefined;
        return session ? new Response(session.stream(), { headers: ndjson }) : bad("That terminal isn't running anymore", 404);
      }),
      // Closing it from the app: the shell and anything it started go with it.
      DELETE: api((req: Bun.BunRequest<"/api/terminals/:id">) => {
        if (isStreamId(req.params.id)) killTerminal(req.params.id);
        return Response.json({ ok: true });
      }),
    },
    // Typed keys, pasted text and control sequences, as they come from the browser's terminal.
    "/api/terminals/:id/input": {
      POST: api(async (req: Bun.BunRequest<"/api/terminals/:id/input">) => {
        const body = await readJson(req);
        if (typeof body?.data !== "string" || !body.data || body.data.length > 100_000) return bad("Expected { data }");
        const session = isStreamId(req.params.id) ? findSession(req.params.id) : undefined;
        if (!session) return bad("That terminal isn't running anymore", 404);
        session.input(body.data);
        return Response.json({ ok: true });
      }),
    },
    "/api/terminals/:id/resize": {
      POST: api(async (req: Bun.BunRequest<"/api/terminals/:id/resize">) => {
        const body = await readJson(req);
        const session = isStreamId(req.params.id) ? findSession(req.params.id) : undefined;
        if (!session) return bad("That terminal isn't running anymore", 404);
        session.resize(terminalSize(body?.cols, body?.rows));
        return Response.json({ ok: true });
      }),
    },
  };
}
