// Remote-server keepalive.
//
// `openbuild start` leaves this small process running next to the server. While the server is
// running the keeper does nothing. If the server stops (a paired device ran `openbuild remote
// server stop`, or the process died), the keeper takes over the same port and answers just a few
// authenticated requests: status, start, and revoke-this-pairing. That is what lets a paired
// device start the server again without SSH or a service manager.
//
// It exits when `openbuild stop` runs on this machine, or when it has handed the port back to a
// freshly started server. Pairing state and tokens live in devices.ts, so stopping the server
// never unpairs anything.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { dataDir } from "./paths";
import * as devices from "./devices";

interface State {
  pid: number;
  mode: "local" | "lan" | "tailscale";
  port: number;
  urls: string[];
  hosts?: string[];
}

const DATA = dataDir();
const STATE = join(DATA, "server.json");
const KEEPER = join(DATA, "keeper.json");
const LOG = join(DATA, "keeper.log");
const ROOT = dirname(dirname(import.meta.path));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function readState(): State | undefined {
  try {
    return JSON.parse(readFileSync(STATE, "utf8")) as State;
  } catch {
    return undefined;
  }
}

const unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });
const unavailable = () => Response.json({ error: "OpenBuild is stopped" }, { status: 503 });

let servers: Array<ReturnType<typeof Bun.serve>> = [];
let handingOver = false;

function releasePort() {
  const running = servers;
  servers = [];
  for (const server of running) {
    try {
      server.stop(true);
    } catch {}
  }
}

/** Bind the same hostnames the server used, so the paired address answers here while it is down. */
function takePort(state: State) {
  const hosts = state.hosts?.length ? state.hosts : ["127.0.0.1"];
  for (const hostname of hosts) {
    try {
      servers.push(
        Bun.serve({
          port: state.port,
          hostname,
          idleTimeout: 30,
          fetch: handle,
        }),
      );
    } catch {
      // The old server may still be closing the socket; the next poll tries again.
    }
  }
}

function startServer() {
  const state = readState();
  if (!state) return;
  const log = openSync(LOG, "a");
  writeFileSync(log, `\n--- ${new Date().toISOString()} starting ${state.mode} ---\n`);
  const child = spawn(process.execPath, [join(ROOT, "bin", "openbuild.ts"), "start", state.mode], {
    cwd: ROOT,
    env: { ...process.env, OPENBUILD_KEEPER: "1" },
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  closeSync(log);
}

/** Hand the port back to a real server. The response has to reach the client first. */
function handOver() {
  if (handingOver) return;
  handingOver = true;
  setTimeout(() => {
    releasePort();
    // The new `openbuild start` writes its own keeper.json; don't let this one look alive.
    rmSync(KEEPER, { force: true });
    startServer();
    process.exit(0);
  }, 200);
}

async function handle(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  const who = devices.authenticateDevice(req);
  if (!who) return unauthorized();

  if (path === "/api/remote/status") {
    return Response.json({
      running: false,
      paired: true,
      device: devices.deviceName(),
      machine: hostname().replace(/\.local$/, ""),
      urls: readState()?.urls ?? [],
    });
  }
  if (path === "/api/remote/stop") {
    // Already stopped. Answering success keeps `openbuild remote server stop` idempotent.
    return Response.json({ ok: true, running: false, already: true });
  }
  if (path === "/api/remote/start" && req.method === "POST") {
    handOver();
    return Response.json({ ok: true, starting: true }, { status: 202 });
  }
  if (path === "/api/pair/self" && req.method === "DELETE") {
    // Let an unpairing client revoke its own token even while the server is down.
    devices.forgetPairedClient(who.id);
    return Response.json({ ok: true });
  }
  // `/api/auth/status` included: the app should show this device as offline while it is stopped.
  return unavailable();
}

function writeKeeperState() {
  try {
    writeFileSync(KEEPER, JSON.stringify({ pid: process.pid, port: readState()?.port, startedAt: Date.now() }, null, 2) + "\n", { mode: 0o600 });
  } catch {}
}

async function main() {
  writeKeeperState();
  const close = () => {
    rmSync(KEEPER, { force: true });
    releasePort();
    process.exit(0);
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);

  for (;;) {
    if (handingOver) return;
    const state = readState();
    if (!state) {
      releasePort();
      await Bun.sleep(1000);
      continue;
    }
    const serverAlive = alive(state.pid);
    if (serverAlive && servers.length) releasePort();
    else if (!serverAlive && !servers.length) takePort(state);
    await Bun.sleep(700);
  }
}

// Only one keeper per data directory.
try {
  const prior = JSON.parse(readFileSync(KEEPER, "utf8")) as { pid?: unknown };
  if (typeof prior.pid === "number" && prior.pid !== process.pid && alive(prior.pid)) process.exit(0);
} catch {}
if (!existsSync(STATE)) process.exit(0);

await main();
