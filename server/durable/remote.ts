/**
 * The server's side of the Durable worker: a thin, reconnecting client for `worker.ts`.
 *
 * Durable work runs in that separate process so it keeps going when the server restarts. This module
 * starts the worker when there isn't one, replaces one running older code, forwards the API calls,
 * and pumps each run's events into a local replayable `Run` (the same object the routes stream from).
 */
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { readEvents } from "../../shared/replies";
import type { PiChatRequest, StreamEvent } from "../../shared/types";
import { Run } from "../runs";
import { dataDir } from "../paths";
import { DurableUnsupportedError } from "./runtime";
import { workerSocket, workerVersion } from "./worker";

/** A run as the server sees it: local replay, driven by the worker's event stream. */
export class DurableRun extends Run {
  constructor(readonly id: string, readonly threadId: string, private cancelRun: () => Promise<unknown>) {
    super();
  }
  override stop() {
    void this.cancelRun().catch(console.error);
  }
}

const ROOT = dirname(dirname(import.meta.dir));
const CONNECT_TIMEOUT = 1_000;
const START_TIMEOUT = 20_000;

/** Bun's `unix` socket option, which `RequestInit` doesn't describe. */
const onSocket = (socket: string, init: RequestInit = {}) => ({ ...init, unix: socket }) as unknown as RequestInit;

interface Health {
  pid: number;
  version: string;
}

/** An error the worker reported, keeping the status and code the routes and the app act on. */
function workerError(body: { error?: string; code?: string } | null, status: number) {
  const message = body?.error ?? `Durable worker failed (HTTP ${status})`;
  if (status === 409) return new DurableUnsupportedError(message, body?.code === "busy" ? "busy" : "unsupported");
  return Object.assign(new Error(message), { status: status === 404 ? 404 : 500 });
}

export class DurableClient {
  private runs = new Map<string, DurableRun>();
  private connected?: Promise<void>;
  private closed = false;
  constructor(readonly directory = join(dataDir(), "durable"), readonly socket = workerSocket(directory)) {}

  // ------------------------------------------------------------------ worker lifecycle

  /** Connect to the worker, starting it (detached) if needed and replacing one running older code. */
  private connect(): Promise<void> {
    this.connected ??= this.connectNow().catch((error) => {
      this.connected = undefined;
      throw error;
    });
    return this.connected;
  }

  private async connectNow() {
    for (let attempt = 0; attempt < 2; attempt++) {
      const health = await this.health();
      if (health?.version === workerVersion) return;
      if (health) {
        // The worker survived a code change: stop it so the new code runs. Its pending manifests
        // stay pending, so the replacement resumes them.
        await this.post("/shutdown", {}).catch(() => {});
        await this.waitForExit(health.pid);
      }
      await this.start();
    }
    throw new Error(`The Durable worker didn't start. See ${join(this.directory, "worker.log")}.`);
  }

  private async health(): Promise<Health | undefined> {
    try {
      const res = await fetch("http://durable/health", onSocket(this.socket, { signal: AbortSignal.timeout(CONNECT_TIMEOUT) }));
      return res.ok ? ((await res.json()) as Health) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Start the worker as its own process, so it outlives this server. */
  private async start() {
    // Another OpenBuild instance may be starting one on this directory right now.
    for (let i = 0; i < 20; i++) {
      const health = await this.health();
      if (health?.version === workerVersion) return;
      if (health) await this.waitForExit(health.pid);
      await Bun.sleep(50);
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    // Only this client may own the socket; a dead worker may have left one behind.
    rmSync(this.socket, { force: true });
    const log = openSync(join(this.directory, "worker.log"), "a", 0o600);
    try {
      const child = spawn(process.execPath, [join(import.meta.dir, "worker.ts")], {
        cwd: ROOT,
        env: { ...process.env, OPENBUILD_DURABLE_DIR: this.directory, OPENBUILD_DURABLE_SOCKET: this.socket },
        detached: true,
        stdio: ["ignore", log, log],
      });
      child.unref();
    } finally {
      closeSync(log);
    }
    const end = Date.now() + START_TIMEOUT;
    while (Date.now() < end) {
      const health = await this.health();
      if (health?.version === workerVersion) return;
      await Bun.sleep(50);
    }
    throw new Error(`The Durable worker didn't start. See ${join(this.directory, "worker.log")}.`);
  }

  private async waitForExit(pid: number) {
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await Bun.sleep(50);
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }

  // ------------------------------------------------------------------ requests

  private async post(path: string, body: unknown): Promise<Response> {
    return fetch(
      `http://durable${path}`,
      onSocket(this.socket, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    );
  }

  /** A request that survives one worker restart: after a crash the call is simply made again. */
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (this.closed) throw new Error("The Durable client is closed");
    for (let attempt = 0; ; attempt++) {
      await this.connect();
      try {
        return await fetch(`http://durable${path}`, onSocket(this.socket, init));
      } catch (error) {
        if (attempt > 0) throw error;
        this.connected = undefined;
      }
    }
  }

  // ------------------------------------------------------------------ runs

  private adopt(id: string, threadId: string): DurableRun {
    let run = this.runs.get(id);
    if (!run) {
      run = new DurableRun(id, threadId, () => this.stopRun(id));
      this.runs.set(id, run);
      void this.pump(run);
    }
    return run;
  }

  /** Follow the worker's events for a run, reconnecting (and replaying) if the connection drops. */
  private async pump(run: DurableRun) {
    let delay = 200;
    while (!run.ended && !this.closed) {
      try {
        const res = await this.request(`/events?id=${encodeURIComponent(run.id)}&after=${run.events.length}`);
        // The worker knows its manifests: no such run means there is nothing left to follow.
        if (res.status === 404) {
          run.end();
          return;
        }
        if (!res.ok || !res.body) throw new Error(`no event stream (HTTP ${res.status})`);
        for await (const event of readEvents(res.body)) {
          delay = 200;
          // The worker's end marker is the stream's; the local run makes its own for its watchers.
          if (event.t === "end") {
            run.end();
            break;
          }
          run.push(event as StreamEvent);
        }
        if (run.ended) return;
      } catch (error) {
        if (this.closed) return;
        console.warn("[durable] lost the worker's event stream; reconnecting:", (error as Error).message);
        this.connected = undefined;
      }
      if (run.ended) return;
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, 5_000);
    }
  }

  async steer(threadId: string, steerId: string, message: string, images?: PiChatRequest["images"], display?: string): Promise<{ handled: boolean }> {
    const res = await this.request("/steer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, steerId, message, images, display }) });
    if (!res.ok) throw workerError(await res.json().catch(() => null), res.status);
    return await res.json() as { handled: boolean };
  }

  async answerQuestion(threadId: string, askId: string, reply: import("./questions").QuestionReply): Promise<boolean> {
    const res = await this.request("/answer", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, askId, ...reply }),
    });
    if (!res.ok) throw workerError(await res.json().catch(() => null), res.status);
    return ((await res.json()) as { ok: boolean }).ok;
  }

  async startRun(req: PiChatRequest): Promise<DurableRun> {
    const res = await this.request("/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw workerError(await res.json().catch(() => null), res.status);
    const { id, threadId } = (await res.json()) as { id: string; threadId: string };
    return this.adopt(id, threadId);
  }

  async findRun(id: string): Promise<DurableRun | undefined> {
    const res = await this.request(`/runs?id=${encodeURIComponent(id)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw workerError(await res.json().catch(() => null), res.status);
    const { threadId } = (await res.json()) as { threadId: string };
    return this.adopt(id, threadId);
  }

  async stopRun(id: string): Promise<boolean> {
    const res = await this.request("/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw workerError(await res.json().catch(() => null), res.status);
    return ((await res.json()) as { found: boolean }).found;
  }

  async stopThread(threadId: string): Promise<void> {
    const res = await this.request("/threads/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId }),
    });
    if (!res.ok) throw workerError(await res.json().catch(() => null), res.status);
  }

  async compact(threadId: string, instructions?: string): Promise<number> {
    const res = await this.request("/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, instructions }),
    });
    if (!res.ok) throw workerError(await res.json().catch(() => null), res.status);
    return ((await res.json()) as { id: number }).id;
  }

  /** The worker recovers pending runs by itself; this waits for that to finish. */
  async recover(): Promise<void> {
    // Re-check which worker is running: a hot reload (or an update) may have changed this code, and a
    // worker running the old code must be replaced before it takes new work.
    this.connected = undefined;
    const res = await this.request("/ready");
    if (!res.ok) throw workerError(await res.json().catch(() => null), res.status);
  }

  async close() {
    this.closed = true;
    for (const run of this.runs.values()) run.end();
  }
}

