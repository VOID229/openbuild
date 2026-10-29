/** Detached single owner for ordinary Pi RPC children. No automatic version replacement. */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { dataDir } from "../paths";
import type { PiWorkerRuntime, WorkerRun } from "./workerRuntime";

export const workerSocket = (directory: string) => join("/tmp", `ob-pi-${process.getuid?.() ?? "user"}`, `${createHash("sha256").update(directory).digest("hex").slice(0, 20)}.sock`);
const encoder = new TextEncoder();
/** What this worker can run beyond the original protocol. A server needing more replaces an idle older worker. */
export const WORKER_FEATURES = ["fx", "codex", "cursor", "claude", "opencode", "idle-retire"];

export function secureSocketPath(socket: string) {
  const parent = dirname(socket);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = lstatSync(parent);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.()) {
    throw new Error("Pi worker socket directory must be private and owned by the current user");
  }
  chmodSync(parent, 0o700);
  try {
    const entry = lstatSync(socket);
    if (!entry.isSocket() || entry.uid !== process.getuid?.()) throw new Error("Pi worker socket has an unexpected owner or file type");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Validate an inherited random identity before signalling a previous process group: a stale
 * metadata PID must never kill an unrelated process after PID reuse. Production workers are
 * detached group leaders, and Pi/tool descendants inherit both their group and this token. */
function fencePreviousOwner(directory: string) {
  const metadata = join(directory, "worker.json");
  if (!existsSync(metadata)) return;
  const old = JSON.parse(readFileSync(metadata, "utf8")) as { pid: number; token?: string; groupLeader?: boolean };
  if (!old.token || !old.groupLeader || old.pid === process.pid) return;
  const ps = Bun.spawnSync(["ps", "-eo", "pid=,pgid="], { stdout: "pipe", stderr: "pipe" });
  if (ps.exitCode !== 0) throw new Error("Cannot inspect previous Pi worker process group");
  const members = ps.stdout.toString().trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number)).filter(([, pgid]) => pgid === old.pid).map(([pid]) => pid!);
  if (!members.length) return;
  const identity = `OPENBUILD_PI_WORKER_TOKEN=${old.token}`;
  const matches = members.some((pid) => {
    try {
      if (process.platform === "linux") return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(identity);
      const env = Bun.spawnSync(["ps", "eww", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
      return env.stdout.toString().split(/\s+/).includes(identity);
    } catch { return false; }
  });
  if (!matches) throw new Error("Previous Pi worker group identity is uncertain; refusing to signal it. Inspect worker.json manually.");
  try { process.kill(-old.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

function events(runtime: PiWorkerRuntime, run: WorkerRun, after: number) {
  let sent = after;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent >= runtime.eventCount(run.record.id) && !run.ended) {
        // Poll rather than retaining a Run.next waiter for every disconnected quiet watcher.
        await Bun.sleep(250);
        if (sent >= runtime.eventCount(run.record.id) && !run.ended) { controller.enqueue(encoder.encode("\n")); return; }
      }
      const batch = runtime.events(run.record.id, sent);
      if (batch.length) {
        sent += batch.length;
        controller.enqueue(encoder.encode(batch.map((e) => JSON.stringify(e) + "\n").join("")));
        return;
      }
      controller.enqueue(encoder.encode('{"t":"end"}\n'));
      controller.close();
    },
  });
}

export async function serveWorker(directory: string, socket = workerSocket(directory)) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  secureSocketPath(socket);
  // The file is NEVER unlinked. An OS-held SQLite lock is released even by SIGKILL, with no
  // PID-reuse window or stale-lock removal race. Only the lock holder may unlink the socket.
  const lock = new Database(join(directory, "owner.sqlite"), { create: true });
  lock.exec("PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner (id INTEGER); ");
  lock.exec("BEGIN EXCLUSIVE");
  try {
    // A live listener must never be unlinked, even if an older implementation owns it.
    try {
      const res = await fetch("http://pi/health", { unix: socket, signal: AbortSignal.timeout(500) } as RequestInit);
      if (res.ok) throw new Error("Pi worker socket already has a live owner");
    } catch (error) {
      if ((error as Error).message === "Pi worker socket already has a live owner") throw error;
    }
    fencePreviousOwner(directory);
    rmSync(socket, { force: true });
    process.env.OPENBUILD_PI_WORKER_TOKEN = crypto.randomUUID();
    const { PiWorkerRuntime } = await import("./workerRuntime");
    const runtime = new PiWorkerRuntime(directory);
    let lastSeen = Date.now();
    let active = 0;
    let retiring = false;
    const server = Bun.serve({
      unix: socket,
      async fetch(req, server) {
        server.timeout(req, 0);
        const url = new URL(req.url);
        lastSeen = Date.now();
        active++;
        try {
          const body = req.method === "POST" ? await req.json() as Record<string, any> : {};
          const id = url.searchParams.get("id") ?? "";
          if (retiring && req.method === "POST") return Response.json({ error: "Agent worker is retiring; retry shortly.", code: "busy" }, { status: 409 });
          switch (url.pathname) {
            case "/health": return Response.json({ pid: process.pid, protocol: 1, features: WORKER_FEATURES });
            // Admission and retirement execute synchronously in this one owner. A separate
            // /records check followed by SIGTERM could kill a newly admitted turn.
            case "/retire": {
              if (req.method !== "POST") return new Response(null, { status: 405 });
              if (active > 1 || runtime.summaries().some((r) => r.status === "pending")) return Response.json({ error: "Agent worker is still busy.", code: "busy" }, { status: 409 });
              retiring = true;
              setTimeout(() => shutdown(), 100);
              return Response.json({ ok: true });
            }
            case "/ownership": return Response.json({ live: runtime.ownership(), owned: [...new Set(runtime.summaries().map((r) => r.threadId))] });
            case "/records": return Response.json(runtime.listRuns());
            case "/snapshots": {
              const known = body.known ?? {};
              const threadId = body.threadId ?? url.searchParams.get("threadId");
              return Response.json(runtime.summaries().filter((r) => !threadId || r.threadId === threadId).flatMap((r) => {
                const version = `${r.eventCount}:${r.status}`;
                if (known[r.id] === version) return [];
                return [{ ...r, events: runtime.snapshotEvents(r) }];
              }));
            }
            case "/start": { const run = runtime.startRun(body as any); return Response.json(run.record); }
            case "/shell/start": { const run = runtime.startShell(body as any); return Response.json(run.record); }
            case "/runs": { const run = runtime.findRun(id); return run ? Response.json(run.record) : Response.json({ error: "No such run" }, { status: 404 }); }
            case "/events": { const run = runtime.findRun(id); return run ? new Response(events(runtime, run, Math.max(0, Number(url.searchParams.get("after")) || 0)), { headers: { "content-type": "application/x-ndjson" } }) : new Response(null, { status: 404 }); }
            case "/stop": return Response.json({ found: runtime.stopRun(String(body.id)) });
            case "/threads/stop": runtime.stopThread(String(body.threadId)); return Response.json({ ok: true });
            case "/threads/delete": runtime.deleteThread(String(body.threadId)); return Response.json({ ok: true });
            case "/answer": return Response.json(runtime.answer(body.threadId, body.askId, body.reply));
            case "/steer": return Response.json(await runtime.steer(body.threadId, body.steerId, body.message, body.images));
            case "/compact": return Response.json(await runtime.compact(body.threadId, body.instructions));
            case "/release": runtime.release(body.threadId); return Response.json({ ok: true });
            case "/restartIdle": runtime.restartIdle(); return Response.json({ ok: true });
            default: return new Response(null, { status: 404 });
          }
        } catch (error) {
          const e = error as Error & { status?: number; code?: string };
          return Response.json({ error: e.message, code: e.code }, { status: e.status ?? 500 });
        } finally { active--; }
      },
    });
    chmodSync(socket, 0o600);
    const metadata = join(directory, "worker.json");
    const group = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)], { stdout: "pipe", stderr: "pipe" });
    const groupLeader = Number(group.stdout.toString().trim()) === process.pid;
    writeFileSync(metadata, JSON.stringify({ pid: process.pid, socket, protocol: 1, token: process.env.OPENBUILD_PI_WORKER_TOKEN, groupLeader }), { mode: 0o600 });
    // An ask, shell or quiet turn can stay pending indefinitely; idle exit is ONLY safe
    // once all ordinary work has ended and no control request (e.g. compact) is active.
    const idle = setInterval(() => {
      if (!active && Date.now() - lastSeen > 10 * 60_000 && !runtime.summaries().some((r) => r.status === "pending")) shutdown();
    }, 60_000);
    const shutdown = () => {
      clearInterval(idle);
      server.stop(true);
      // Keep metadata: startup fences any old Pi/tool children before admitting new work.
      rmSync(socket, { force: true });
      // Exit while holding the lock, and terminate the detached group as one operation.
      // Merely closing Pi stdin can leave a hung tool alive indefinitely after `stop --all`.
      if (groupLeader) process.kill(-process.pid, "SIGKILL");
      process.exit(0);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    return { server, runtime, lock };
  } catch (error) { lock.close(); throw error; }
}
if (import.meta.main) {
  process.umask(0o077);
  const directory = process.env.OPENBUILD_PI_WORKER_DIR ?? join(dataDir(), "pi-worker");
  await serveWorker(directory, process.env.OPENBUILD_PI_WORKER_SOCKET ?? workerSocket(directory));
}
