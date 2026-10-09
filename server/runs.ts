// A reply runs on its own, apart from the request that started it: closing the tab, reloading or a
// network blip only drops the connection watching it, and the model keeps thinking, searching and
// writing. Whoever watches gets every event from the start, then new ones as they come, then
// {t:"end"}. Only a stop (or the run finishing) ends it.
import { readEvents } from "../shared/replies";
import type { StreamEvent } from "../shared/types";

const encoder = new TextEncoder();
/** Keep a quiet connection (silent thinking, a slow search) from being closed as idle. */
const HEARTBEAT = 15_000;
const line = (e: StreamEvent) => JSON.stringify(e) + "\n";

export class Run {
  readonly events: StreamEvent[] = [];
  ended = false;
  private ctrl = new AbortController();
  private waiters = new Set<() => void>();

  get signal() {
    return this.ctrl.signal;
  }

  push(e: StreamEvent) {
    if (this.ended) return;
    this.events.push(e);
    this.wake();
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.wake();
  }

  stop() {
    this.ctrl.abort();
  }

  /** Resolves once there are more than `seen` events, or the run has ended. */
  next(seen: number): Promise<void> {
    if (this.events.length > seen || this.ended) return Promise.resolve();
    return new Promise((resolve) => this.waiters.add(resolve));
  }

  private wake() {
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  /** The whole reply as NDJSON, from the start. Cancelling it (the client left) doesn't stop the run. */
  stream(): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream({
      pull: async (controller) => {
        if (sent >= this.events.length && !this.ended) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const beat = await Promise.race([this.next(sent).then(() => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(true), HEARTBEAT)))]);
          clearTimeout(timer);
          if (beat) return controller.enqueue(encoder.encode("\n"));
        }
        if (sent < this.events.length) {
          const batch = this.events.slice(sent);
          sent += batch.length;
          return controller.enqueue(encoder.encode(batch.map(line).join("")));
        }
        controller.enqueue(encoder.encode(line({ t: "end" })));
        controller.close();
      },
    });
  }
}

/** Start a run from a chat handler's response (see handlers.ts handleChat). */
export function startRun(produce: (signal: AbortSignal) => Promise<Response>): Run {
  const run = new Run();
  void (async () => {
    try {
      const res = await produce(run.signal);
      if (run.signal.aborted) return;
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        run.push({ t: "error", status: res.status, message: body?.error ?? `Request failed (HTTP ${res.status})` });
        return;
      }
      for await (const e of readEvents(res.body)) run.push(e);
    } catch (err) {
      if (!run.signal.aborted) run.push({ t: "error", message: `The reply was interrupted: ${(err as Error).message}` });
    } finally {
      run.end();
    }
  })();
  return run;
}

// ------------------------------------------------------------------ local server

/** Finished replies stay this long, for a device that reconnects late. */
const KEEP = 15 * 60 * 1000;
const MAX_RUNS = 200;

// Under `bun --hot` this module re-runs on every edit: keep the replies in progress.
const hot = globalThis as { openchatRuns?: Map<string, Run> };
const runs = (hot.openchatRuns ??= new Map());

export const findRun = (id: string) => runs.get(id);

/** The reply with this id, starting it if it isn't running yet (so retrying a request is safe). */
export function localRun(id: string, start: () => Run): Run {
  const existing = runs.get(id);
  if (existing) return existing;
  // Forget the oldest finished replies if a lot have piled up.
  if (runs.size >= MAX_RUNS) for (const [key, r] of runs) if (r.ended && runs.size >= MAX_RUNS) runs.delete(key);
  const run = start();
  runs.set(id, run);
  void (async () => {
    while (!run.ended) await run.next(run.events.length);
    setTimeout(() => runs.get(id) === run && runs.delete(id), KEEP).unref?.();
  })();
  return run;
}
