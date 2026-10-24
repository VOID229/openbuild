#!/usr/bin/env bun
// openbuild: run the OpenBuild server in the background.
//
//   openbuild start             this computer only (http://localhost:3100)
//   openbuild start lan         also other devices on your network (plain HTTP)
//   openbuild start tailscale   your tailnet, over HTTPS via `tailscale serve`
//   openbuild stop | restart | status | logs | open
//   openbuild set pass <password>   set/change the local access password
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
import * as devices from "../server/devices";

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
  if (mode !== "local" && !localAuth.configured()) fail("set a local access password first: openbuild set pass <password>");
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
  openbuild pair --host       let another OpenBuild use this computer (shows a code)
  openbuild pair --client     add another computer's OpenBuild (asks for its code)
  openbuild set pass <pw>     set/change the local access password
  openbuild password          the same, typed at a hidden prompt instead
  openbuild stop              stop the server
  openbuild restart [--yes]   restart in the same mode (asks first; that ends running Pi threads)
  openbuild status            is it running, and where
  openbuild logs              follow the server log
  openbuild open              open it in the browser

  PORT=…  use another port (default 3100). Data: ${DATA}`);
}

async function savePassword(password: string) {
  try { await localAuth.setPassword(password); }
  catch (err) { fail((err as Error).message); }
  console.log("Local password saved. All existing browser sessions have been revoked.");
}

// ------------------------------------------------------------------ pairing

/** Ask one question on the terminal. */
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

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

interface PairCandidate {
  base: string;
  name: string;
  machine?: string;
  deviceId?: string;
}

/** GET /api/pair/info, which only answers while a pairing is open. */
async function probePairing(base: string): Promise<PairCandidate | undefined> {
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/pair/info`, { signal: AbortSignal.timeout(900) });
    if (!res.ok) return undefined;
    const info = (await res.json()) as { pending?: boolean; name?: string; machine?: string; deviceId?: string; claimed?: boolean };
    if (!info?.pending || info.claimed) return undefined;
    return { base: base.replace(/\/$/, ""), name: info.name || base, machine: info.machine, deviceId: info.deviceId };
  } catch {
    return undefined;
  }
}

/** Run probes a few at a time, so a /24 scan stays quick without hundreds of sockets at once. */
async function probeAll(bases: string[]): Promise<PairCandidate[]> {
  const unique = [...new Set(bases)];
  const found: PairCandidate[] = [];
  const batch = 48;
  for (let i = 0; i < unique.length; i += batch) {
    const results = await Promise.all(unique.slice(i, i + batch).map(probePairing));
    for (const r of results) if (r) found.push(r);
  }
  return found;
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
  let candidates = await probeAll(mode === "lan" ? lanCandidates() : tailscaleCandidates());
  // A device that answers both ways can show up twice; keep one per device/name.
  candidates = candidates.filter((c, i) => candidates.findIndex((x) => x.deviceId && x.deviceId === c.deviceId) === i);
  if (!candidates.length) {
    console.log(dim("No OpenBuild is waiting to pair here. If you know its address, enter it below."));
    const typed = await ask("Host address (host or host:port, Enter to cancel): ");
    if (!typed) fail("nothing to pair with.");
    const base = /^https?:\/\//.test(typed) ? typed.replace(/\/$/, "") : `http://${typed.includes(":") ? typed : `${typed}:${PORT}`}`;
    const found = await probePairing(base);
    if (!found) fail(`no OpenBuild is waiting to pair at ${base}. Check that \`openbuild pair --host\` is running there.`);
    candidates = [found!];
  }

  for (const candidate of candidates) {
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

const args = process.argv.slice(2);
const assumeYes = args.includes("--yes") || args.includes("-y");
const [cmd, arg] = args.filter((a) => a !== "--yes" && a !== "-y");
switch (cmd) {
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
    const password = prompt("New local password (at least 12 characters): ");
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
  case "stop":
    await stop();
    break;
  case "restart": {
    const state = readState();
    const owned = !!state && alive(state.pid);
    const port = state?.port ?? PORT;
    const mode = (arg as Mode | undefined) ?? state?.mode ?? "local";
    // No state file means something else runs it (systemd, `bun dev`): there is no pid here to stop.
    if (!owned && (await serving(port)))
      fail(`OpenBuild answers on port ${port}, but it wasn't started by \`openbuild start\` (no ${STATE}), so this command has no pid to stop. Restart it where it runs (systemd: systemctl --user restart openbuild), or stop that process and use \`openbuild start\`.`);
    // Ordinary Pi RPC replies stop; Durable checkpoints resume on the next server startup.
    // Neither runtime runs while the server is stopped.
    if (owned && !assumeYes) {
      if (!process.stdin.isTTY) fail("restarting ends the Pi threads working in it, and there is no terminal to confirm in. Add --yes to restart anyway.");
      if (!(await confirm("Restarting stops ordinary Pi replies; Durable threads resume after startup. Proceed?"))) {
        console.log("restart canceled");
        break;
      }
    }
    if (owned) await stop(true);
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
