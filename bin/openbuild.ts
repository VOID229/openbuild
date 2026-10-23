#!/usr/bin/env bun
// openbuild: run the OpenBuild server in the background.
//
//   openbuild start             this computer only (http://localhost:3100)
//   openbuild start lan         also other devices on your network (plain HTTP)
//   openbuild start tailscale   your tailnet, over HTTPS via `tailscale serve`
//   openbuild stop | restart | status | logs | open
//
// The server's pid, mode and address are kept in <data dir>/server.json, its output in
// <data dir>/server.log. PORT changes the port (default 3100).
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { dataDir } from "../server/paths";
import { localAuth } from "../server/localAuth";

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
  startedAt: number;
}

const ROOT = dirname(dirname(realpathSync(import.meta.path)));
const DATA = dataDir();
const STATE = join(DATA, "server.json");
const LOG = join(DATA, "server.log");
const PORT = Number(process.env.PORT ?? 3100);

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

/** The `tailscale serve` HTTPS port to use: 443 unless something else already serves there. */
function freeServePort(bin: string): number {
  const r = run(bin, tailscaleArgs(["serve", "status", "--json"]));
  try {
    const cfg = JSON.parse(r.out || "{}");
    const used = Object.keys(cfg.TCP ?? {}).map(Number);
    return used.includes(443) ? PORT : 443;
  } catch {
    return 443;
  }
}

async function start(mode: Mode) {
  if (mode !== "local" && !localAuth.configured()) fail("set a local access password first: openbuild password");
  const current = running();
  if (current) {
    if (current.mode === mode) {
      console.log(`OpenBuild is already running (${current.mode}).`);
      for (const u of current.urls) console.log(`  ${bold(u)}`);
      return;
    }
    console.log(dim(`Switching from ${current.mode} to ${mode}…`));
    await stop(true);
  }

  const env: Record<string, string> = { ...(process.env as Record<string, string>), NODE_ENV: "production", PORT: String(PORT) };
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
    } else {
      // No HTTPS certificates on this tailnet: listen on the Tailscale address itself, plain HTTP.
      env.HOST = self.ips.find((ip) => ip.includes(".")) ?? fail("This computer has no Tailscale IPv4 address.");
      env.OPENCHAT_ALLOWED_HOSTS = [self.name, ...self.ips].join(",");
      urls.push(`http://${self.name}:${PORT}`, `http://${env.HOST}:${PORT}`);
    }
  }

  mkdirSync(DATA, { recursive: true });
  const log = openSync(LOG, "a");
  writeFileSync(log, `\n--- ${new Date().toISOString()} openbuild start ${mode} ---\n`);
  const child = spawn(process.execPath, [join(ROOT, "server", "index.ts")], { cwd: ROOT, env, detached: true, stdio: ["ignore", log, log] });
  child.unref();
  closeSync(log);
  const pid = child.pid ?? fail("Couldn't start the server.");

  const first = env.HOST!.split(",")[0]!;
  const probe = `http://${first === "0.0.0.0" ? "127.0.0.1" : first}:${PORT}`;
  if (!(await waitForServer(probe, pid))) {
    const tail = readFileSync(LOG, "utf8").trim().split("\n").slice(-8).join("\n");
    if (alive(pid)) process.kill(pid);
    fail(`the server didn't start. Last lines of ${LOG}:\n${tail}`);
  }

  if (tailscale && tailscale.self && tailscale.self.https) {
    servePort = freeServePort(tailscale.bin);
    const r = run(tailscale.bin, tailscaleArgs(["serve", "--bg", `--https=${servePort}`, `http://127.0.0.1:${PORT}`]));
    if (!r.ok) {
      process.kill(pid);
      fail(`tailscale serve failed: ${r.err || r.out}\nHTTPS may need enabling for your tailnet: https://tailscale.com/kb/1153/enabling-https`);
    }
    urls.push(`https://${tailscale.self.name}${servePort === 443 ? "" : `:${servePort}`}`);
    // Advertise the plain HTTP fallback only if there's a real Tailscale interface listener.
    const ip = tailscale.self.ips.find((a) => a.includes("."));
    if (ip && env.HOST!.split(",").includes(ip)) urls.push(`http://${ip}:${PORT}`);
  }

  const state: State = { pid, mode, port: PORT, urls, servePort, startedAt: Date.now() };
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(`OpenBuild is running ${mode === "local" ? "on this computer" : mode === "lan" ? "on your network" : "on your tailnet"}:`);
  for (const u of urls) console.log(`  ${bold(u)}`);
  for (const n of notes) console.log(dim(`  ${n}`));
  console.log(dim("  Access requires your local server password. Unlocked browsers can run Pi as you."));
  if (mode === "lan") console.log(dim("  Plain HTTP does not encrypt passwords or sessions. Prefer Tailscale HTTPS."));
  console.log(dim(`  Logs: openbuild logs · stop: openbuild stop`));
}

async function stop(quiet = false) {
  const s = readState();
  if (!s || !alive(s.pid)) {
    rmSync(STATE, { force: true });
    if (!quiet) console.log("OpenBuild isn't running.");
    return;
  }
  const bin = s.servePort || s.serveHttpPort ? tailscaleBin() : undefined;
  if (bin && s.servePort) run(bin, tailscaleArgs(["serve", `--https=${s.servePort}`, "off"]));
  if (bin && s.serveHttpPort) run(bin, tailscaleArgs(["serve", `--http=${s.serveHttpPort}`, "off"]));
  process.kill(s.pid, "SIGTERM");
  for (let i = 0; i < 40 && alive(s.pid); i++) await Bun.sleep(100);
  if (alive(s.pid)) process.kill(s.pid, "SIGKILL");
  rmSync(STATE, { force: true });
  if (!quiet) console.log("OpenBuild stopped.");
}

/** Ask on the terminal; Enter takes the default. */
async function confirm(question: string, fallback = true): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    return answer ? answer === "y" || answer === "yes" : fallback;
  } finally {
    rl.close();
  }
}

function status() {
  const s = running();
  if (!s) return console.log("OpenBuild isn't running. Start it with: openbuild start [lan|tailscale]");
  const mins = Math.round((Date.now() - s.startedAt) / 60_000);
  console.log(`OpenBuild is running (${s.mode}, pid ${s.pid}, up ${mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`}):`);
  for (const u of s.urls) console.log(`  ${bold(u)}`);
}

function help() {
  console.log(`openbuild: build with Pi from your browser or phone

  openbuild start             this computer only (http://localhost:${PORT})
  openbuild start lan         also devices on your local network (plain HTTP)
  openbuild start tailscale   your tailnet, over HTTPS (tailscale serve)
  openbuild password          set/change the local access password (hidden prompt)
  openbuild stop              stop the server
  openbuild restart [--yes]   restart in the same mode (asks first; that ends running Pi threads)
  openbuild status            is it running, and where
  openbuild logs              follow the server log
  openbuild open              open it in the browser

  PORT=…  use another port (default 3100). Data: ${DATA}`);
}

const args = process.argv.slice(2);
const assumeYes = args.includes("--yes") || args.includes("-y");
const [cmd, arg] = args.filter((a) => a !== "--yes" && a !== "-y");
switch (cmd) {
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
    const password = prompt("New local password (at least 12 characters): ");
    if (password !== prompt("Confirm password: ")) fail("passwords don't match.");
    try { await localAuth.setPassword(password); }
    catch (err) { fail((err as Error).message); }
    console.log("Local password saved. All existing browser sessions have been revoked.");
    break;
  }
  case "start": {
    const mode = (arg ?? "local") as Mode;
    if (!["local", "lan", "tailscale"].includes(mode)) fail(`unknown mode "${arg}". Use: openbuild start [lan|tailscale]`);
    await start(mode);
    break;
  }
  case "stop":
    await stop();
    break;
  case "restart": {
    const state = readState();
    const mode = (arg as Mode | undefined) ?? state?.mode ?? "local";
    // A restart ends the server process, and with it the `pi --mode rpc` process of every thread it
    // has open: a reply being written right now is lost and has to be asked for again. The session
    // files stay on disk, so the threads themselves are still there afterwards.
    if (state && alive(state.pid) && !assumeYes) {
      if (!process.stdin.isTTY) fail("restarting ends the Pi threads working in it, and there is no terminal to confirm in. Add --yes to restart anyway.");
      if (!(await confirm("Restarting OpenBuild will stop working Pi threads in it, proceed?"))) {
        console.log("restart canceled");
        break;
      }
    }
    await stop(true);
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
