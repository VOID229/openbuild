#!/usr/bin/env bun
// openbuild: run the OpenBuild server in the background.
//
//   openbuild start             this computer only (http://localhost:3100)
//   openbuild start lan         also other devices on your network (plain HTTP)
//   openbuild start tailscale   your tailnet, over HTTPS via `tailscale serve`
//   openbuild stop | restart | status | logs | open
//   openbuild unpair              unpair a paired device (asks which)
//   openbuild remote server stop|start   control a paired device's server remotely
//   openbuild set pass <password>   set/change the local access password
//
// The server's pid, mode and address are kept in <data dir>/server.json, its output in
// <data dir>/server.log. PORT changes the port (default 3100).
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { ask } from "./prompt";
import { discoverPairing, probePairing, type PairCandidate } from "./pairDiscovery";
import { dataDir } from "../server/paths";
import { localAuth } from "../server/localAuth";
import * as devices from "../server/devices";
import { systemdService, systemdNetworkOverride, systemdNetworkOverridePath, UNIT } from "./systemd";

type Mode = "local" | "lan" | "tailscale";

interface State {
  pid: number;
  mode: Mode;
  port: number;
  urls: string[];
  /** The `tailscale serve` HTTPS port OpenBuild set up (turned off again on stop). */
  servePort?: number;
  /** The `tailscale serve` plain-HTTP port on the Tailscale IP (turned off again on stop). */
  serveHttpPort?: number;
  /** Hostnames the server bound, so the keeper (server/keeper.ts) can take the same ones. */
  hosts?: string[];
  startedAt: number;
}

const ROOT = dirname(dirname(realpathSync(import.meta.path)));
const DATA = dataDir();
const STATE = join(DATA, "server.json");
// Never put a systemd PID in server.json: detached lifecycle code must not own it.
const SERVICE_NETWORK = join(DATA, "systemd-network.json");
type ServiceNetwork = Omit<State, "pid">;
function serviceNetwork(): ServiceNetwork | undefined {
  try { return JSON.parse(readFileSync(SERVICE_NETWORK, "utf8")); } catch { return undefined; }
}
const LOG = join(DATA, "server.log");
const KEEPER = join(DATA, "keeper.json");
const KEEPER_LOG = join(DATA, "keeper.log");
/** The process that runs Durable turns, so a server restart doesn't interrupt them (`server/durable/worker.ts`). */
const DURABLE_WORKER = join(DATA, "durable", "worker.json");
const PI_WORKER = join(DATA, "pi-worker", "worker.json");
let PORT = Number(process.env.PORT ?? 3100);

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const fail = (msg: string): never => {
  console.error(`openbuild: ${msg}`);
  process.exit(1);
};

function readState(): State | undefined {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return undefined;
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The running server, if any (a stale state file is cleaned up). */
function running(): State | undefined {
  const s = readState();
  if (s && alive(s.pid)) return s;
  if (s) rmSync(STATE, { force: true });
  return undefined;
}

/** The keepalive process that holds the paired port while the server is stopped. */
function keeperPid(): number | undefined {
  try {
    const { pid } = JSON.parse(readFileSync(KEEPER, "utf8")) as { pid?: unknown };
    if (typeof pid === "number" && alive(pid) && pid !== process.pid) return pid;
  } catch {}
  rmSync(KEEPER, { force: true });
  return undefined;
}

/** Leave the keeper next to the server, so a paired device can stop and start it. */
function ensureKeeper(state: State): void {
  if (keeperPid()) return;
  mkdirSync(DATA, { recursive: true });
  const log = openSync(KEEPER_LOG, "a");
  writeFileSync(log, `\n--- ${new Date().toISOString()} keeper ---\n`);
  const child = spawn(process.execPath, [join(ROOT, "server", "keeper.ts")], {
    cwd: ROOT,
    env: { ...process.env, OPENBUILD_KEEPER: "1" },
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  closeSync(log);
  if (child.pid) writeFileSync(KEEPER, JSON.stringify({ pid: child.pid, port: state.port, startedAt: Date.now() }, null, 2) + "\n", { mode: 0o600 });
}

/** Stop the keeper. Used by `openbuild stop` and before a local start frees the port. */
async function stopKeeper(): Promise<void> {
  const pid = keeperPid();
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 20 && alive(pid); i++) await Bun.sleep(50);
  if (alive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  rmSync(KEEPER, { force: true });
}

function run(cmd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() || (r.error?.message ?? "") };
}

const tailscaleArgs = (args: string[]) => process.env.OPENBUILD_TAILSCALE_SOCKET ? [`--socket=${process.env.OPENBUILD_TAILSCALE_SOCKET}`, ...args] : args;
const tailscaleBin = () => Bun.which("tailscale") ?? ["/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"].find(existsSync);

/** This machine on the tailnet, from its Tailscale daemon; undefined when the daemon can't be reached. */
function tailscaleSelf(bin: string): { name: string; ips: string[]; https: boolean } | undefined {
  const r = run(bin, tailscaleArgs(["status", "--json"]));
  if (!r.ok) return undefined;
  const s = JSON.parse(r.out);
  if (s.BackendState !== "Running") fail(`Tailscale is ${s.BackendState ?? "not running"}. Sign in / connect it first.`);
  return { name: String(s.Self?.DNSName ?? "").replace(/\.$/, ""), ips: s.Self?.TailscaleIPs ?? [], https: Array.isArray(s.CertDomains) && s.CertDomains.length > 0 };
}

/** The address of a Tailscale network interface on this machine (100.64.0.0/10), if there is one. */
function tailscaleInterfaceIp(): string | undefined {
  for (const [name, list] of Object.entries(networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === "IPv4" && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address) && (/^tailscale/.test(name) || /^utun/.test(name))) return a.address;
  return undefined;
}

/** A tailnet address's MagicDNS name, asked of Tailscale's resolver. */
async function magicDnsName(ip: string): Promise<string | undefined> {
  try {
    const { Resolver } = await import("node:dns/promises");
    const r = new Resolver({ timeout: 3000, tries: 1 });
    r.setServers(["100.100.100.100"]);
    return (await r.reverse(ip))[0]?.replace(/\.$/, "");
  } catch {
    return undefined;
  }
}

/** LAN IPv4 addresses (skipping loopback and Tailscale's 100.64/10). */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) out.push(a.address);
  return out;
}

async function waitForServer(url: string, pid: number): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (!alive(pid)) return false;
    try {
      const res = await fetch(`${url}/api/auth/status`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {}
    await Bun.sleep(250);
  }
  return false;
}

/** The Serve config, when its JSON can be read. */
function serveConfig(bin: string): any {
  try {
    return JSON.parse(run(bin, tailscaleArgs(["serve", "status", "--json"])).out || "{}");
  } catch {
    return {};
  }
}

/** The `tailscale serve` HTTPS port already forwarding to this app, if any (443 preferred). */
function existingServePort(bin: string): number | undefined {
  const web = serveConfig(bin).Web ?? {};
  const ports: number[] = [];
  for (const [host, entry] of Object.entries<any>(web)) {
    const port = Number(host.slice(host.lastIndexOf(":") + 1));
    if (!Number.isFinite(port)) continue;
    const proxies = Object.values<any>(entry?.Handlers ?? {}).map((h) => h?.Proxy);
    if (proxies.some((p) => p === `http://127.0.0.1:${PORT}`)) ports.push(port);
  }
  return ports.includes(443) ? 443 : ports[0];
}

/**
 * The `tailscale serve` HTTPS port to use: one already pointing at this app, else 443, else another
 * free port. Never the server's own plain-HTTP port: Serve would take over the tailnet address on
 * that port, and the advertised `http://<tailscale-ip>:PORT` fallback would answer TLS instead.
 */
function freeServePort(bin: string): number {
  const existing = existingServePort(bin);
  if (existing && existing !== PORT) return existing;
  const cfg = serveConfig(bin);
  const used = Object.keys(cfg.TCP ?? {}).map(Number).filter(Number.isFinite);
  if (!used.includes(443)) return 443;
  for (const candidate of [8443, 9443, 10443, 12443, 14443]) if (!used.includes(candidate) && candidate !== PORT) return candidate;
  for (let candidate = 20000; candidate < 30000; candidate++) if (!used.includes(candidate) && candidate !== PORT) return candidate;
  return 443;
}

function disableServe(s?: Pick<State, "servePort" | "serveHttpPort">) {
  const bin = s?.servePort || s?.serveHttpPort ? tailscaleBin() : undefined;
  if (bin && s?.servePort) run(bin, tailscaleArgs(["serve", `--https=${s.servePort}`, "off"]));
  if (bin && s?.serveHttpPort) run(bin, tailscaleArgs(["serve", `--http=${s.serveHttpPort}`, "off"]));
}

async function start(mode: Mode, managed?: { active: boolean; restart: boolean }) {
  if (!["local", "lan", "tailscale"].includes(mode)) fail(`unknown mode "${mode}". Use: openbuild start [local|lan|tailscale]`);
  if (mode !== "local" && !localAuth.configured()) fail("set a local access password first: openbuild set pass <password>");
  if (!managed) {
    const current = running();
    // A stopped server leaves the keeper holding the port. A local start takes it back.
    if (!current) await stopKeeper();
    if (current) {
      if (current.mode === mode) {
        console.log(`OpenBuild is already running (${current.mode}).`);
        for (const u of current.urls) console.log(`  ${bold(u)}`);
        ensureKeeper(current);
        return;
      }
      console.log(dim(`Switching from ${current.mode} to ${mode}…`));
      await stop(true, true);
    } else if (await serving(PORT)) {
      // Two servers on one port split requests between them (especially with Tailscale): some API
      // calls hit the old code, with no pairing routes. Never start a duplicate.
      fail(
        `something else is already answering on port ${PORT}, but it wasn't started by \`openbuild start\` (no ${STATE}).\n` +
          "It may be an older OpenBuild or one managed by systemd. Stop or restart it where it runs, then try again.",
      );
    }
  }

  // Explicitly reset network settings inherited from an earlier mode.
  const env: Record<string, string> = { ...(process.env as Record<string, string>), NODE_ENV: "production", PORT: String(PORT), OPENCHAT_ALLOWED_HOSTS: "", OPENBUILD_PUBLIC_HTTPS: "" };
  const urls: string[] = [];
  const notes: string[] = [];
  let servePort: number | undefined;
  let tailscale: { bin: string; self: NonNullable<ReturnType<typeof tailscaleSelf>> } | undefined;

  if (mode === "local") {
    env.HOST = "127.0.0.1";
    urls.push(`http://localhost:${PORT}`);
  } else if (mode === "lan") {
    // Every interface, answering to this computer's names and LAN addresses.
    const names = [hostname(), `${hostname().replace(/\.local$/, "")}.local`];
    const local = run("scutil", ["--get", "LocalHostName"]);
    if (local.ok && local.out) names.push(`${local.out}.local`);
    const ips = lanAddresses();
    env.HOST = "0.0.0.0";
    env.OPENCHAT_ALLOWED_HOSTS = [...new Set([...names, ...ips])].join(",");
    urls.push(...ips.map((ip) => `http://${ip}:${PORT}`), `http://${names.at(-1)}:${PORT}`);
  } else {
    const bin = tailscaleBin();
    const self = bin ? tailscaleSelf(bin) : undefined;
    if (bin && self) tailscale = { bin, self };
    if (!self) {
      // The daemon isn't ours to drive (it runs as root, or in a container), but its network
      // interface is here: listen on it directly. Plain HTTP, since HTTPS needs `tailscale serve`.
      const ip = tailscaleInterfaceIp() ?? fail("Tailscale isn't running here (no tailscale daemon or tailscale network interface found).");
      const name = await magicDnsName(ip);
      env.HOST = `127.0.0.1,${ip}`;
      env.OPENCHAT_ALLOWED_HOSTS = [ip, ...(name ? [name, name.split(".")[0]!] : [])].join(",");
      if (name) urls.push(`http://${name}:${PORT}`);
      urls.push(`http://${ip}:${PORT}`);
      notes.push("No access to the Tailscale daemon here, so no HTTPS (that needs `tailscale serve`, run as its owner).");
    } else if (self.https) {
      // Served on this computer only; Tailscale terminates HTTPS on the tailnet and forwards here.
      // Userspace Tailscale has no bindable interface; Serve still reaches loopback.
      // Include a direct Tailscale listener only when the OS actually owns that address.
      const ip = self.ips.find((a) => a.includes("."));
      const bindable = ip && Object.values(networkInterfaces()).flat().some((a) => a?.address === ip);
      env.HOST = ["127.0.0.1", ...(bindable ? [ip] : [])].join(",");
      env.OPENCHAT_ALLOWED_HOSTS = [self.name, ...(ip ? [ip] : [])].join(",");
      // The browser reaches us over HTTPS here, but the backend sees plain HTTP from tailscale
      // serve. Mark the public name so session cookies get Secure (direct IP HTTP stays plain).
      env.OPENBUILD_PUBLIC_HTTPS = self.name;
    } else {
      // No HTTPS certificates on this tailnet: listen on the Tailscale address itself, plain HTTP.
      env.HOST = self.ips.find((ip) => ip.includes(".")) ?? fail("This computer has no Tailscale IPv4 address.");
      env.OPENCHAT_ALLOWED_HOSTS = [self.name, ...self.ips].join(",");
      urls.push(`http://${self.name}:${PORT}`, `http://${env.HOST}:${PORT}`);
    }
  }

  mkdirSync(DATA, { recursive: true });
  let pid: number | undefined;
  let restoreService: (() => void) | undefined;
  if (managed) {
    const path = systemdNetworkOverridePath();
    const previous = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const next = systemdNetworkOverride(env);
    const changed = previous !== next;
    mkdirSync(dirname(path), { recursive: true });
    restoreService = () => {
      if (previous === undefined) rmSync(path, { force: true });
      else writeFileSync(path, previous, { mode: 0o600 });
      run("systemctl", ["--user", "daemon-reload"]);
    };
    if (changed) {
      writeFileSync(path, next, { mode: 0o600 });
      const reload = run("systemctl", ["--user", "daemon-reload"]);
      if (!reload.ok) {
        restoreService();
        fail(reload.err || reload.out || "systemd daemon-reload failed");
      }
    }
    const action = managed.restart || (managed.active && changed) ? "restart" : "start";
    const result = run("systemctl", ["--user", action, UNIT]);
    if (!result.ok) {
      restoreService();
      fail(result.err || result.out || `systemd ${action} failed`);
    }
  } else {
    const log = openSync(LOG, "a");
    writeFileSync(log, `\n--- ${new Date().toISOString()} openbuild start ${mode} ---\n`);
    const child = spawn(process.execPath, [join(ROOT, "server", "index.ts")], { cwd: ROOT, env, detached: true, stdio: ["ignore", log, log] });
    child.unref();
    closeSync(log);
    pid = child.pid ?? fail("Couldn't start the server.");

    const first = env.HOST!.split(",")[0]!;
    const probe = `http://${first === "0.0.0.0" ? "127.0.0.1" : first}:${PORT}`;
    if (!(await waitForServer(probe, pid))) {
      const tail = readFileSync(LOG, "utf8").trim().split("\n").slice(-8).join("\n");
      if (alive(pid)) process.kill(pid);
      fail(`the server didn't start. Last lines of ${LOG}:\n${tail}`);
    }
  }

  if (tailscale && tailscale.self && tailscale.self.https) {
    servePort = freeServePort(tailscale.bin);
    // An older start may have put HTTPS on the app's own port, where it answers TLS instead of
    // the plain-HTTP fallback. That entry is never useful; clear it when we use another port.
    if (servePort !== PORT) run(tailscale.bin, tailscaleArgs(["serve", `--https=${PORT}`, "off"]));
    const r = run(tailscale.bin, tailscaleArgs(["serve", "--bg", `--https=${servePort}`, `http://127.0.0.1:${PORT}`]));
    if (!r.ok) {
      if (pid) process.kill(pid);
      if (restoreService) {
        restoreService();
        run("systemctl", ["--user", "restart", UNIT]);
      }
      fail(`tailscale serve failed: ${r.err || r.out}\nHTTPS may need enabling for your tailnet: https://tailscale.com/kb/1153/enabling-https`);
    }
    urls.push(`https://${tailscale.self.name}${servePort === 443 ? "" : `:${servePort}`}`);
    // Advertise the plain HTTP fallback only if there's a real Tailscale interface listener, and
    // only when Serve isn't also using that same port (it would answer TLS there instead).
    const ip = tailscale.self.ips.find((a) => a.includes("."));
    if (ip && env.HOST!.split(",").includes(ip) && servePort !== PORT) urls.push(`http://${ip}:${PORT}`);
  }

  const network: ServiceNetwork = { mode, port: PORT, urls, servePort, hosts: env.HOST!.split(",").filter(Boolean), startedAt: Date.now() };
  if (managed) {
    const previous = serviceNetwork();
    if (previous?.servePort !== servePort || previous?.serveHttpPort) disableServe(previous);
    writeFileSync(SERVICE_NETWORK, JSON.stringify(network, null, 2), { mode: 0o600 });
  } else {
    const state: State = { pid: pid!, ...network };
    writeFileSync(STATE, JSON.stringify(state, null, 2));
    ensureKeeper(state);
  }
  console.log(`OpenBuild is running ${mode === "local" ? "on this computer" : mode === "lan" ? "on your network" : "on your tailnet"}:`);
  for (const u of urls) console.log(`  ${bold(u)}`);
  for (const n of notes) console.log(dim(`  ${n}`));
  console.log(dim("  Access requires your local server password. Unlocked browsers can run Pi as you."));
  if (mode === "lan") console.log(dim("  Plain HTTP does not encrypt passwords or sessions. Prefer Tailscale HTTPS."));
  console.log(dim(`  Logs: openbuild logs · stop: openbuild stop`));
}

/** Only an explicit `stop --all` terminates detached runtimes. */
function stopWorkers() {
  for (const [file, script] of [[PI_WORKER, "server/pi/worker.ts"], [DURABLE_WORKER, "server/durable/worker.ts"]] as const) {
    try {
      const { pid } = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid === process.pid || !alive(pid)) continue;
      // Metadata may outlive a worker and its PID may be reused. Only signal a
      // process whose argv identifies this installation's matching runtime.
      const command = run("ps", ["-p", String(pid), "-o", "args="]);
      if (command.ok && command.out.split(/\s+/).includes(join(ROOT, script))) process.kill(pid, "SIGTERM");
    } catch {}
    // Never remove worker metadata: Pi startup retains its old PID as a
    // process-group fence before admitting new work. Each runtime owns cleanup.
  }
}

/** By default only stop the server/keeper; detached turns keep running. */
async function stop(quiet = false, keepWorker = true) {
  const s = readState();
  const serverAlive = !!s && alive(s.pid);
  const keeper = keeperPid();
  if (!serverAlive && !keeper) {
    rmSync(STATE, { force: true });
    if (!keepWorker) stopWorkers();
    if (!quiet) console.log(keepWorker ? "OpenBuild server isn't running; detached workers left unchanged." : "OpenBuild server isn't running; Pi and Durable workers sent shutdown signals.");
    return;
  }
  // Local stop means fully stopped: no keepalive left offering to start it again.
  await stopKeeper();
  disableServe(s);
  if (serverAlive) {
    process.kill(s!.pid, "SIGTERM");
    for (let i = 0; i < 40 && alive(s!.pid); i++) await Bun.sleep(100);
    if (alive(s!.pid)) process.kill(s!.pid, "SIGKILL");
  }
  rmSync(STATE, { force: true });
  if (!keepWorker) stopWorkers();
  if (!quiet) console.log(keepWorker ? "OpenBuild stopped; Pi and Durable workers left running." : "OpenBuild stopped; Pi and Durable workers sent shutdown signals.");
}

/** Is something OpenBuild-shaped answering on the port? A server started outside `openbuild start` (systemd, `bun dev`) writes no state file. */
async function serving(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { configured?: unknown };
    return typeof body?.configured === "boolean";
  } catch {
    return false;
  }
}

function status() {
  const s = running();
  if (!s) {
    if (keeperPid())
      return console.log("OpenBuild is stopped, but paired devices can still start it: openbuild remote server start");
    return console.log("OpenBuild isn't running. Start it with: openbuild start [lan|tailscale]");
  }
  const mins = Math.round((Date.now() - s.startedAt) / 60_000);
  console.log(`OpenBuild is running (${s.mode}, pid ${s.pid}, up ${mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`}):`);
  for (const u of s.urls) console.log(`  ${bold(u)}`);
}

function help() {
  console.log(`openbuild: build with Pi from your browser or phone

  openbuild start             this computer only (http://localhost:${PORT})
  openbuild start lan         also devices on your local network (plain HTTP)
  openbuild start tailscale   your tailnet, over HTTPS (tailscale serve)
  openbuild pair --host       let another OpenBuild use this computer (shows a code)
  openbuild pair --client     add another computer's OpenBuild (asks for its code)
  openbuild unpair [name]      remove a paired device (asks which when there are several)
  openbuild remote server stop   stop a paired device's server, keep it paired
  openbuild remote server start  start that server again
  openbuild remote status       where each paired device's server stands
  openbuild set pass <pw>     set/change the local access password
  openbuild password          the same, typed at a hidden prompt instead
  openbuild stop              stop the server; Pi and Durable work keep running
  openbuild stop --all        also terminate Pi and Durable workers
  openbuild restart [--yes]   restart in the same mode; running turns continue
  openbuild status            is it running, and where
  openbuild logs              follow the server log
  openbuild open              open it in the browser

  On Linux, an openbuild.service user unit for this installation is managed
  through systemd automatically (start, stop, restart, status, logs).
  Its service configuration controls the address and startup mode.

  PORT=…  use another port (default 3100). Data: ${DATA}`);
}

async function savePassword(password: string) {
  try { await localAuth.setPassword(password); }
  catch (err) { fail((err as Error).message); }
  console.log("Local password saved. All existing browser sessions have been revoked.");
}

// ------------------------------------------------------------------ pairing

async function chooseTransport(verb: string): Promise<"tailscale" | "lan"> {
  if (!process.stdin.isTTY) fail("run pairing in a terminal so the code and questions can be shown privately.");
  const answer = (await ask(`${verb} over [1] Tailscale or [2] LAN? [1] `)).toLowerCase();
  return answer === "2" || answer === "lan" || answer === "local" ? "lan" : "tailscale";
}

const PAIRING_HINT = (name: string) => `On the other computer, run:\n  openbuild pair --client   (enter the code, then pick ${name})\n`;

/** Host: wait with a short code for another OpenBuild to pair. */
async function pairHost() {
  const suggested = devices.deviceName();
  const name = (await ask(`Name this device [${suggested}]: `)) || suggested;
  const mode = await chooseTransport("Share this device");
  if (!localAuth.configured()) fail("set a local access password first: openbuild set pass <password>");
  devices.setDeviceName(name);
  // A headless server is all a paired client needs. Reuse the ordinary start command.
  await start(mode);
  const state = readState();
  if (!state) fail("couldn't read the server state after starting it.");
  // A server left over from an older version has no pairing routes. Say so instead of waiting
  // for a code it will never accept.
  let supportsPairing = false;
  for (const base of [`http://127.0.0.1:${state!.port}`, ...state!.urls]) {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/api/pair/info`, { signal: AbortSignal.timeout(2000) });
      const body = (await res.json().catch(() => null)) as { pending?: unknown } | null;
      if (res.ok && typeof body?.pending === "boolean") {
        supportsPairing = true;
        break;
      }
    } catch {}
  }
  if (!supportsPairing)
    fail(
      "the OpenBuild running on this computer is from an older version and can't pair.\n" +
        "Restart it (`openbuild restart`) or stop the old process, then run `openbuild pair --host` again.",
    );
  const pending = devices.createPairing({ name, mode, urls: state!.urls });
  console.log(`\n  Pairing code: ${bold(pending.code)}`);
  console.log(dim("  Valid for 15 minutes, for one device."));
  for (const url of state!.urls) console.log(dim(`  ${url}`));
  console.log(`\n${PAIRING_HINT(name)}`);
  console.log(dim("  Waiting for the other device… (Ctrl+C cancels)"));

  const cleanup = () => {
    const current = devices.readPairing();
    if (!current?.claimedBy) devices.cancelPairing();
  };
  process.once("SIGINT", () => {
    cleanup();
    console.log("\nPairing cancelled.");
    process.exit(130);
  });
  try {
    for (;;) {
      const current = devices.readPairing();
      if (!current) return fail("the pairing code expired. Run `openbuild pair --host` again.");
      const claimedBy = current.claimedBy;
      if (claimedBy) {
        console.log(`\n  Paired with ${bold(claimedBy)}.`);
        console.log(dim(`  ${claimedBy} can now add projects and run threads on ${name}.`));
        devices.cancelPairing();
        return;
      }
      await Bun.sleep(700);
    }
  } finally {
    cleanup();
  }
}

/** Probe a typed address with the given scheme, and the other one if that fails. */
async function probeAddress(typed: string): Promise<PairCandidate | undefined> {
  if (/^https?:\/\//.test(typed)) return probePairing(typed);
  const host = typed.includes(":") ? typed : `${typed}:${PORT}`;
  // Tailscale often has HTTPS on a nonstandard port; a LAN host is usually plain HTTP.
  return (await probePairing(`https://${host}`)) ?? (await probePairing(`http://${host}`));
}

const isTailscaleIp = (ip: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);

/** Addresses on this computer's LAN subnets to probe. */
function lanCandidates(): string[] {
  const out = new Set<string>([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || isTailscaleIp(a.address)) continue;
      const parts = a.address.split(".");
      const prefix = parts.slice(0, 3).join(".");
      for (let n = 1; n <= 254; n++) out.add(`http://${prefix}.${n}:${PORT}`);
    }
  }
  return [...out];
}

/** This machine and its tailnet peers, by address and MagicDNS name. */
function tailscaleCandidates(): string[] {
  const out = new Set<string>([`http://127.0.0.1:${PORT}`]);
  const bin = tailscaleBin();
  if (!bin) return [...out];
  const r = run(bin, tailscaleArgs(["status", "--json"]));
  if (!r.ok) return [...out];
  let status: any;
  try {
    status = JSON.parse(r.out);
  } catch {
    return [...out];
  }
  const peers = [status.Self, ...Object.values(status.Peer ?? {})];
  for (const peer of peers) {
    for (const ip of peer?.TailscaleIPs ?? []) if (ip.includes(".")) out.add(`http://${ip}:${PORT}`);
    const dns = String(peer?.DNSName ?? "").replace(/\.$/, "");
    if (dns) {
      out.add(`https://${dns}`);
      out.add(`https://${dns}:${PORT}`);
      out.add(`http://${dns}:${PORT}`);
    }
  }
  return [...out];
}

/** Client: find the waiting host and claim its code. */
async function pairClient() {
  const mode = await chooseTransport("Connect");
  const code = await ask("Pairing code: ");
  if (!code) fail("no pairing code entered.");
  console.log(dim(mode === "lan" ? "Looking for a device on your network…" : "Looking for a device on your tailnet…"));
  async function* candidates(): AsyncGenerator<PairCandidate> {
    let foundAny = false;
    for await (const candidate of discoverPairing(mode === "lan" ? lanCandidates() : tailscaleCandidates())) {
      foundAny = true;
      yield candidate;
    }
    if (foundAny) return;
    console.log(dim("No OpenBuild is waiting to pair here. If you know its address, enter it below."));
    const typed = await ask("Host address (host, host:port, or https://…, Enter to cancel): ");
    if (!typed) fail("nothing to pair with.");
    const found = await probeAddress(typed);
    if (!found) fail(`no OpenBuild is waiting to pair at ${typed}. Check that \`openbuild pair --host\` is running there.`);
    yield found!;
  }

  for await (const candidate of candidates()) {
    try {
      const res = await fetch(`${candidate.base}/api/pair/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name: hostname().replace(/\.local$/, "") }),
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json().catch(() => null)) as any;
      if (!res.ok || !body?.token || !body?.device) continue;
      const urls = [...new Set([candidate.base, ...(body.device.urls ?? [])].filter((u: unknown): u is string => typeof u === "string" && /^https?:\/\//.test(u)))];
      devices.addDevice({
        ...body.device,
        id: String(body.device.id),
        name: String(body.device.name || candidate.name),
        machine: body.device.machine || candidate.machine,
        mode: body.device.mode === "lan" ? "lan" : mode,
        urls,
        token: String(body.token),
        serverId: body.device.serverId || body.device.id,
        pairedAt: Date.now(),
      });
      console.log(`\n  Paired with ${bold(String(body.device.name || candidate.name))}.`);
      console.log(dim(`  Its projects now appear in Settings → Projects, under that device.`));
      console.log(dim("  Refresh the OpenBuild app if it was already open."));
      return;
    } catch {
      // Try the next host that has a pairing open.
    }
  }
  fail("the code didn't match any device waiting to pair. Check it and run `openbuild pair --client` again.");
}

// ------------------------------------------------------------------ paired devices

type PairedDevice = ReturnType<typeof devices.readDevices>[number];

/** `--device <name>`, `--device=<name>`, a bare name, and `--all`. */
function deviceArgs(list: string[]): { spec?: string; all: boolean } {
  let spec: string | undefined;
  let all = false;
  const bare: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    if (a === "--all") all = true;
    else if (a === "--device") spec = list[++i];
    else if (a.startsWith("--device=")) spec = a.slice("--device=".length);
    else if (!a.startsWith("-")) bare.push(a);
  }
  return { spec: spec ?? bare[0], all };
}

const deviceLabel = (d: PairedDevice) => (d.machine && d.machine !== d.name ? `${d.name} (${d.machine})` : d.name);

/** Pick one paired device, by name/id or from a numbered list. */
async function chooseDevice(spec?: string): Promise<PairedDevice> {
  const all = devices.readDevices();
  if (!all.length) fail("no paired devices. Add one with: openbuild pair --client");
  if (spec) {
    const wanted = spec.toLowerCase();
    const found = all.find(
      (d) => d.id === spec || d.name.toLowerCase() === wanted || d.machine?.toLowerCase() === wanted || d.name.toLowerCase().startsWith(wanted),
    );
    if (found) return found;
    fail(`no paired device matches "${spec}". Paired: ${all.map(deviceLabel).join(", ")}`);
  }
  if (all.length === 1) return all[0]!;
  if (!process.stdin.isTTY)
    fail(`more than one paired device; pick one with --device <name>. Paired: ${all.map(deviceLabel).join(", ")}`);
  console.log("Paired devices:");
  all.forEach((d, i) => console.log(`  ${i + 1}. ${deviceLabel(d)} — ${d.urls[0] ?? "no address"}`));
  const answer = (await ask(`Choose [1-${all.length}]: `)).trim();
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= all.length) return all[index - 1]!;
  const byName = all.find((d) => d.name.toLowerCase() === answer.toLowerCase());
  if (byName) return byName;
  return fail("no device chosen.");
}

/** Remove a pairing here and revoke its token on the other device. */
async function unpair(raw: string[]) {
  const { spec, all: every } = deviceArgs(raw);
  const list = devices.readDevices();
  if (!list.length) return console.log("No paired devices.");
  const targets = every ? list : [await chooseDevice(spec)];
  for (const device of targets) {
    const revoked = await devices.revokeDevice(device);
    devices.removeDevice(device.id);
    console.log(`Unpaired ${bold(deviceLabel(device))}.`);
    if (revoked) console.log(dim("  Its saved token was revoked on the other device too."));
    else console.log(dim("  It was unreachable, so pair again from there if you want it back."));
  }
}

interface RemoteAnswer {
  ok: boolean;
  status?: number;
  body?: any;
  error?: string;
  base?: string;
}

/** Call a paired device directly with its token, trying each saved address. */
async function remoteRequest(device: PairedDevice, path: string, method: "GET" | "POST"): Promise<RemoteAnswer> {
  let failure: RemoteAnswer | undefined;
  for (const base of device.urls) {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
        method,
        headers: { authorization: `Bearer ${device.token}` },
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 401)
        return { ok: false, status: 401, body, base, error: "the other device no longer trusts this pairing; unpair and pair again" };
      if (res.ok) return { ok: true, status: res.status, body, base };
      failure = { ok: false, status: res.status, body, base, error: `HTTP ${res.status}` };
    } catch (err) {
      failure = { ok: false, error: (err as Error).message, base };
    }
  }
  return failure ?? { ok: false, error: "no address saved for this device" };
}

async function remoteStatus() {
  const list = devices.readDevices();
  if (!list.length) return console.log("No paired devices. Add one with: openbuild pair --client");
  for (const device of list) {
    const answer = await remoteRequest(device, "/api/remote/status", "GET");
    if (answer.status === 401) console.log(`${deviceLabel(device)}: ${answer.error}.`);
    else if (answer.status === 200 && answer.body?.running) console.log(`${deviceLabel(device)}: running (${device.urls[0] ?? "no address"})`);
    else if (answer.status === 200)
      console.log(`${deviceLabel(device)}: stopped, still paired (start it with openbuild remote server start --device ${device.name})`);
    else if (answer.status === 404) console.log(`${deviceLabel(device)}: running, but that OpenBuild has no remote control (update it)`);
    else console.log(`${deviceLabel(device)}: unreachable (${answer.error ?? `HTTP ${answer.status}`})`);
  }
}

async function remoteServer(action: "start" | "stop", raw: string[]) {
  const { spec } = deviceArgs(raw);
  const device = await chooseDevice(spec);
  const answer = await remoteRequest(device, `/api/remote/${action}`, "POST");
  if (!answer.ok && answer.status !== 202) fail(`couldn't ${action} ${device.name}: ${answer.error ?? "no answer"}`);

  if (action === "stop") {
    console.log(`${bold(device.name)} is stopping. It stays paired.`);
    for (let i = 0; i < 25; i++) {
      await Bun.sleep(300);
      const status = await remoteRequest(device, "/api/remote/status", "GET");
      if (status.status === 200 && status.body?.running === false) {
        console.log(dim(`  Stopped. Start it again with: openbuild remote server start --device ${device.name}`));
        return;
      }
    }
    console.log(dim("  Stop requested. Start it again with: openbuild remote server start"));
    return;
  }

  console.log(dim(`  Starting ${device.name}…`));
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(500);
    const status = await remoteRequest(device, "/api/remote/status", "GET");
    if (status.status === 200 && status.body?.running) {
      console.log(`${bold(device.name)} is running again.`);
      return;
    }
  }
  fail(`asked ${device.name} to start, but it didn't answer yet. Check it there with: openbuild status`);
}

const args = process.argv.slice(2);
const stopAll = args.includes("--all");
const [cmd, arg] = args.filter((a) => a !== "--yes" && a !== "-y" && a !== "--all");
if (stopAll && cmd !== "stop") fail("--all is only supported by openbuild stop.");
// An installed user service owns its lifecycle, even while stopped. Never start a
// competing detached server or kill its PID behind systemd's back.
const serviceCommands = ["start", "stop", "restart", "status", "logs"];
const service = cmd && serviceCommands.includes(cmd) && !running() ? systemdService(ROOT, run) : undefined;
if (service) {
  const mode = cmd === "start" || cmd === "restart" ? arg ?? serviceNetwork()?.mode : undefined;
  if (arg && cmd !== "start" && cmd !== "restart") fail(`usage: openbuild ${cmd}${cmd === "stop" ? " [--all]" : ""}`);
  if (mode && !["local", "lan", "tailscale"].includes(mode)) fail(`unknown mode "${mode}". Use: openbuild ${cmd} [local|lan|tailscale]`);
  if ((cmd === "stop" || cmd === "restart" || (mode && service.active)) && !stopAll && !service.workerSurvives) {
    fail(`${UNIT} would kill detached Pi and Durable workers (KillMode is not process). Set [Service] KillMode=process with \`systemctl --user edit ${UNIT}\`, then run \`systemctl --user daemon-reload\` and retry. Existing units are not updated automatically. Use openbuild stop --all only if you intend to terminate workers too.`);
  }
  if (mode || cmd === "stop") {
    // Use the unit's actual network context, not the interactive shell's defaults.
    const configured = run("systemctl", ["--user", "show", UNIT, "--property=Environment", "--value"]);
    for (const match of configured.out.matchAll(/(?:^|\s)"?(PORT|OPENBUILD_TAILSCALE_SOCKET)=([^\s"]+)"?/g)) {
      if (match[1] === "PORT") PORT = Number(match[2]);
      else process.env.OPENBUILD_TAILSCALE_SOCKET = match[2];
    }
  }
  if (mode) {
    await start(mode as Mode, { active: service.active, restart: cmd === "restart" });
  } else if (cmd === "logs") {
    const result = spawnSync("journalctl", ["--user", "-u", UNIT, "-n", "50", "-f"], { stdio: "inherit" });
    process.exit(result.status ?? 1);
  } else if (cmd === "status") {
    const result = run("systemctl", ["--user", "status", UNIT, "--no-pager"]);
    console.log(result.out || result.err);
    if (service.active) for (const url of serviceNetwork()?.urls ?? []) console.log(`  ${bold(url)}`);
  } else {
    const result = run("systemctl", ["--user", cmd!, UNIT]);
    if (!result.ok) fail(result.err || result.out || `systemd ${cmd} failed`);
    if (cmd === "stop") {
      await stopKeeper();
      disableServe(serviceNetwork());
      if (stopAll) stopWorkers();
    }
    console.log(`OpenBuild ${cmd === "stop" ? "stopped" : cmd === "restart" ? "restarted" : "started"} (${UNIT}, systemd user service).`);
    if (cmd === "stop") console.log(stopAll ? "Pi and Durable workers sent shutdown signals." : "Pi and Durable workers left running.");
  }
} else switch (cmd) {
  case "set": {
    if (arg !== "pass" && arg !== "password") fail(`unknown setting "${arg ?? ""}". Use: openbuild set pass <password>`);
    // Everything after `pass`, so a password with spaces works unquoted too.
    // Taken unfiltered: a password may well be "-y".
    const rest = args.slice(2);
    if (!rest.length) fail("usage: openbuild set pass <password>");
    await savePassword(rest.join(" "));
    break;
  }
  case "password": {
    if (!process.stdin.isTTY) fail("run this command in a terminal to enter the password privately.");
    // The password never appears in process arguments, shell history, or logs.
    const prompt = (label: string) => {
      process.stderr.write(label);
      const result = spawnSync("bash", ["-c", 'IFS= read -r -s password </dev/tty || exit 1; printf "%s" "$password"'], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
      process.stderr.write("\n");
      if (result.status !== 0) fail("password entry cancelled (requires bash and a terminal).");
      return result.stdout;
    };
    const password = prompt("New local password (at least 4 characters): ");
    if (password !== prompt("Confirm password: ")) fail("passwords don't match.");
    await savePassword(password);
    break;
  }
  case "start": {
    const mode = (arg ?? "local") as Mode;
    if (!["local", "lan", "tailscale"].includes(mode)) fail(`unknown mode "${arg}". Use: openbuild start [lan|tailscale]`);
    await start(mode);
    break;
  }
  case "pair": {
    if (arg === "--host" || arg === "host") await pairHost();
    else if (arg === "--client" || arg === "client") await pairClient();
    else fail("usage: openbuild pair --host | openbuild pair --client");
    break;
  }
  case "unpair":
    await unpair(args.slice(1).filter((a) => a !== "--yes" && a !== "-y"));
    break;
  case "remote": {
    const rest = args.slice(1).filter((a) => a !== "--yes" && a !== "-y");
    if (!rest.length || rest[0] === "status") await remoteStatus();
    else if (rest[0] !== "server") fail("usage: openbuild remote status | openbuild remote server start|stop [--device <name>]");
    else if (rest[1] === "start" || rest[1] === "stop") await remoteServer(rest[1], rest.slice(2));
    else fail("usage: openbuild remote server start | openbuild remote server stop");
    break;
  }
  case "stop":
    if (arg) fail("usage: openbuild stop [--all]");
    await stop(false, !stopAll);
    break;
  case "restart": {
    const state = readState();
    const owned = !!state && alive(state.pid);
    const port = state?.port ?? PORT;
    const mode = (arg as Mode | undefined) ?? state?.mode ?? "local";
    // No state file means something else runs it (systemd, `bun dev`): there is no pid here to stop.
    if (!owned && (await serving(port)))
      fail(`OpenBuild answers on port ${port}, but it wasn't started by \`openbuild start\` (no ${STATE}), so this command has no pid to stop. Restart it where it runs (systemd: systemctl --user restart openbuild), or stop that process and use \`openbuild start\`.`);
    // Pi and Durable turns carry on in detached workers; the new server reattaches.
    // --yes/-y remain accepted for compatibility; no destructive confirmation is needed.
    if (owned) await stop(true, true);
    await start(mode);
    break;
  }
  case "status":
    status();
    break;
  case "logs":
    if (!existsSync(LOG)) fail("no log yet.");
    spawnSync("tail", ["-n", "50", "-f", LOG], { stdio: "inherit" });
    break;
  case "open": {
    const s = running() ?? fail("OpenBuild isn't running.");
    spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [s.urls[0]!]);
    break;
  }
  case undefined:
  case "help":
  case "-h":
  case "--help":
    help();
    break;
  default:
    fail(`unknown command "${cmd}". Run: openbuild help`);
}
