/**
 * The process that actually runs Durable turns.
 *
 * It is started detached by the OpenBuild server (`remote.ts`) and outlives it: a server restart
 * only drops the connection, while the model request, tools and their checkpoints keep going. The
 * new server reconnects to the same worker (its pid and socket are in `worker.json`) and replays the
 * run's events from the manifests. Only `openbuild stop` stops it.
 *
 * One worker per data directory: it is the single owner of the Durable storage. It speaks HTTP over
 * a private Unix socket, so nothing is exposed on the network.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Run } from "../runs";
import { dataDir } from "../paths";
import { DurableRuntime } from "./runtime";

/** Bumped when the socket protocol changes, so a stale worker is replaced even if its files look current. */
const PROTOCOL = 1;

/**
 * Identifies the worker's code. A server running changed code replaces a stale worker instead of
 * talking to a process with different behavior.
 */
export const workerVersion = (() => {
  try {
    const hash = createHash("sha256").update(`protocol:${PROTOCOL}`);
    for (const name of ["worker.ts", "runtime.ts", "tools.ts", "questions.ts"]) hash.update(readFileSync(join(import.meta.dir, name)));
    hash.update(readFileSync(join(import.meta.dir, "../htmlDelivery.ts")));
    return hash.digest("hex").slice(0, 16);
  } catch {
    return "dev";
  }
})();

/** The per-directory socket: short enough for the platform's path limit, and unique per data dir. */
export const workerSocket = (directory = dataDir()) => {
  if (process.platform === "win32") return join(directory, "durable", "worker.sock");
  const id = createHash("sha256").update(directory).digest("hex").slice(0, 16);
  return join(process.env.OPENBUILD_DURABLE_SOCKET_DIR || "/tmp", `openbuild-durable-${id}.sock`);
};

const encoder = new TextEncoder();
const line = (value: unknown) => encoder.encode(JSON.stringify(value) + "\n");
const HEARTBEAT = 15_000;
/** Exit this long after the last request when no turn is unfinished (a stopped server leaves no one to reattach). */
const IDLE_EXIT = 10 * 60_000;

/**
 * One run's events from `after` on, then {t:"end"}. Mirrors `Run.stream()` so the server can pump it
 * into its own replayable run, exactly as it would with an in-process runtime.
 */
function eventStream(run: Run, after: number): ReadableStream<Uint8Array> {
  let sent = after;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent >= run.events.length && !run.ended) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const beat = await Promise.race([run.next(sent).then(() => false), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), HEARTBEAT)))]);
        clearTimeout(timer);
        if (beat) return controller.enqueue(encoder.encode("\n"));
      }
      if (sent < run.events.length) {
        const batch = run.events.slice(sent);
        sent += batch.length;
        return controller.enqueue(encoder.encode(batch.map((event) => JSON.stringify(event) + "\n").join("")));
      }
      controller.enqueue(line({ t: "end" }));
      controller.close();
    },
  });
}

/** Serve the runtime on `socket`. Returns the server and a promise that settles when recovery has run. */
export function serveWorker(runtime: DurableRuntime, socket: string) {
  const recovered = runtime.recover();
  // Recovery failures are reported per run; the worker still serves the ones that opened.
  const ready = recovered.catch((error) => console.error("[durable] Startup recovery failed:", error));

  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const failure = (error: unknown) => {
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
    const code = (error as { code?: unknown })?.code;
    return json({ error: error instanceof Error ? error.message : String(error), ...(typeof code === "string" ? { code } : {}) }, status);
  };

  let lastSeen = Date.now();
  let active = 0;
  const server = Bun.serve({
    unix: socket,
    fetch: async (req, server) => {
      // A run can think or wait on a tool for a long time without an event.
      server.timeout(req, 0);
      lastSeen = Date.now();
      active++;
      const url = new URL(req.url);
      const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, any>) : {};
      try {
        switch (url.pathname) {
          case "/health":
            return json({ pid: process.pid, version: workerVersion, socket });
          case "/ready":
            await ready;
            return json({ ok: true });
          case "/start": {
            const run = await runtime.startRun(body as any);
            return json({ id: run.id, threadId: run.threadId });
          }
          case "/runs": {
            const found = await runtime.findRun(String(url.searchParams.get("id")));
            return found ? json({ id: found.id, threadId: found.threadId }) : json({ error: "No such run" }, 404);
          }
          case "/events": {
            const found = await runtime.findRun(String(url.searchParams.get("id")));
            if (!found) return json({ error: "No such run" }, 404);
            const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
            return new Response(eventStream(found, after), { headers: { "content-type": "application/x-ndjson" } });
          }
          case "/answer":
            return json({ ok: await runtime.answer(String(body.threadId), String(body.askId), {
              value: typeof body.value === "string" ? body.value : undefined,
              confirmed: typeof body.confirmed === "boolean" ? body.confirmed : undefined,
              cancelled: body.cancelled === true,
            }) });
          case "/stop":
            return json({ found: await runtime.stopRun(String(body.id)) });
          case "/threads/stop":
            await runtime.stopThread(String(body.threadId));
            return json({ ok: true });
          case "/steer":
            return json(await runtime.steer(String(body.threadId), String(body.steerId), String(body.message), body.images));
          case "/compact":
            return json({ id: await runtime.compact(String(body.threadId), typeof body.instructions === "string" ? body.instructions : undefined) });
          case "/shutdown":
            setTimeout(() => void shutdown(), 50);
            return json({ ok: true });
          default:
            return json({ error: "Not found" }, 404);
        }
      } catch (error) {
        return failure(error);
      } finally {
        active--;
      }
    },
  });

  // The runtime is not a network service: only this machine's user may talk to it.
  chmodSync(socket, 0o600);

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    server.stop(true);
    // Pending manifests stay pending: the next worker resumes them.
    await runtime.close().catch(() => {});
    rmSync(socket, { force: true });
    process.exit(0);
  }

  return { server, ready, shutdown, idle: () => active === 0 && Date.now() - lastSeen > IDLE_EXIT };
}

if (import.meta.main) {
  const directory = process.env.OPENBUILD_DURABLE_DIR || join(dataDir(), "durable");
  const socket = process.env.OPENBUILD_DURABLE_SOCKET || workerSocket(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // A worker that died without cleaning up leaves its socket behind; this process owns it now.
  rmSync(socket, { force: true });
  const runtime = new DurableRuntime(directory);
  const worker = serveWorker(runtime, socket);
  writeFileSync(join(directory, "worker.json"), JSON.stringify({ pid: process.pid, socket, version: workerVersion, startedAt: Date.now() }) + "\n", { mode: 0o600 });
  const bye = () => void worker.shutdown().catch(() => process.exit(0));
  process.once("SIGTERM", bye);
  process.once("SIGINT", bye);
  // A server that is gone for good (an ad-hoc or test instance) must not leave this running forever.
  // While a turn is unfinished it stays, however long the server is away.
  setInterval(() => {
    if (worker.idle() && !runtime.pending()) bye();
  }, 30_000).unref?.();
  console.log(`[durable] Worker ${process.pid} serving ${directory} on ${socket}`);
}
