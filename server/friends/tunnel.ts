// Friends through OpenTunnel (docs/friends.md, "Over OpenTunnel"): the hosted relay at opentunnel.xyz
// unless OPENBUILD_FRIEND_TUNNEL_API names one of the owner's own. Only the host runs a tunnel:
// OpenBuild runs the `opentunnel` client while an invite waits or a friend connects this way, with one
// route, to the friend listener on loopback. The app's own port is never routed. The guest needs
// nothing: it dials the route's https URL as one long-lived WSS, the same connection as over Tailscale.
//
// The client is kept to itself. It gets a profile of its own and its own HOME and XDG folders under
// <data>/friends/tunnel (its control socket under a short private folder, since socket paths are
// short), so it never touches the owner's own tunnels, and only the environment it needs: no
// OPENTUNNEL_* settings meant for the owner's tunnels, and no PATH. Without PATH it finds no systemctl
// or launchctl, so it never registers a login service: OpenBuild runs `serve` itself, as its child,
// and stops it when it's not needed. `serve` only connects a tunnel that exists, so the first time,
// `up` creates one (no account needed), finds that `serve` running and has it reload.
//
// The relay routes TLS it can't read, and the client hands the listener plain HTTP from a loopback
// peer. So a tunneled request looks local, and anyone may find the URL: neither is proof of anything.
// The friend protocol proves who's on the other end, as it does everywhere.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "./store";
import { TransportError } from "./errors";
import type { Transport } from "./transport";

/** The client's profile: one tunnel, one hostname, kept for as long as the data folder is. */
export const PROFILE = "openbuild-friends";
/** The relay friends use unless the owner names their own. */
export const HOSTED = "https://opentunnel.xyz";
/** How long a new tunnel has to get its certificate. OpenTunnel says it "can take a few minutes". */
const START_MS = 5 * 60_000;

type Child = ReturnType<typeof Bun.spawn>;
interface Running {
  child: Child;
  port: number;
  api: string;
  log: string[];
  /** `up`, creating the tunnel, while it runs. */
  creating?: Child;
  created?: Promise<void>;
}
const hot = globalThis as { openbuildFriendTunnel?: Running; openbuildFriendTunnelSignals?: boolean };

/** A relay of the owner's own, as they configured it. Undefined for the hosted one. */
export function customRelay(): string | undefined {
  const raw = process.env.OPENBUILD_FRIEND_TUNNEL_API?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TransportError(`OPENBUILD_FRIEND_TUNNEL_API (${raw}) isn't a URL. Set it to your OpenTunnel server's address, like https://tunnel.example.com, or unset it for the hosted relay.`);
  }
  // Plain http only to a relay on this machine, for trying one out.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new TransportError("OPENBUILD_FRIEND_TUNNEL_API has to be https:// (plain http only for a relay on this machine).");
  return url.origin;
}
/** The relay this server's tunnel uses. */
export const relay = () => customRelay() ?? HOSTED;

export const bin = () => process.env.OPENBUILD_FRIEND_TUNNEL_BIN?.trim() || Bun.which("opentunnel") || undefined;
export const tunnelDir = () => join(store.friendsDir(), "tunnel");
const home = () => join(tunnelDir(), "home");
const configHome = () => join(tunnelDir(), "config");
const dataHome = () => join(tunnelDir(), "data");
const stateHome = () => join(tunnelDir(), "state");
/** An empty folder, as the client's whole PATH. */
const noPath = () => join(tunnelDir(), "no-path");

/**
 * Where the client keeps its control socket and lock. A socket's path has to be short (about 100
 * bytes), so not under the data folder: a private folder of this server's own in the user's runtime
 * folder, or /tmp, named after the data folder so two OpenBuilds don't share one.
 */
export function runtimeDir(): string {
  const tag = createHash("sha256").update(tunnelDir()).digest("hex").slice(0, 10);
  const uid = process.getuid?.() ?? 0;
  const base = [process.env.XDG_RUNTIME_DIR, process.platform === "win32" ? tmpdir() : "/tmp"].find((dir) => dir && existsSync(dir) && dir.length < 40)!;
  return join(base, `openbuild-friends-${uid}-${tag}`);
}

function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  // In a shared /tmp it has to be this user's own folder, not something planted there.
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) throw new TransportError(`${dir} isn't a private folder of this user's, so the OpenTunnel client can't use it.`);
}

/** The client's arguments before its command: this profile, and the owner's relay when they have one. */
export function clientArgs(): string[] {
  const api = customRelay();
  const ca = process.env.OPENBUILD_FRIEND_TUNNEL_CA?.trim();
  return ["--profile", PROFILE, ...(api ? ["--api", api] : []), ...(ca ? ["--ca-cert", ca] : [])];
}

/** The client's whole environment: its own folders, and only what reaching the relay may need from this one's. */
export function clientEnv(): Record<string, string> {
  const pass: Record<string, string> = {};
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "TZ", "LANG"]) {
    const value = process.env[key];
    if (value) pass[key] = value;
  }
  return { ...pass, HOME: home(), XDG_CONFIG_HOME: configHome(), XDG_DATA_HOME: dataHome(), XDG_STATE_HOME: stateHome(), XDG_RUNTIME_DIR: runtimeDir(), PATH: noPath(), RUST_LOG: "info" };
}

/** The one route: the friend listener on loopback, under the route name this server keeps. */
export function writeRoutes(port: number) {
  const dir = join(configHome(), "opentunnel");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${PROFILE}.toml`), `# Written by OpenBuild: friends reach its friend listener here, and nothing else.\n[routes]\n${store.tunnelRoute()} = "127.0.0.1:${port}"\n`, { mode: 0o600 });
}

/** The tunnel's hostname, once the client has one. */
export function hostname(): string | undefined {
  try {
    const name = JSON.parse(readFileSync(join(dataHome(), "opentunnel", PROFILE, "tunnel.json"), "utf8"))?.hostname;
    return typeof name === "string" && /^[A-Za-z0-9.-]+$/.test(name) ? name.replace(/\.$/, "") : undefined;
  } catch {
    return undefined;
  }
}

/** Where friends dial: the route, under the tunnel's hostname. */
export const publicUrl = (host: string) => `https://${store.tunnelRoute()}.${host}`;

const kill = (t?: Running) => {
  for (const child of [t?.creating, t?.child]) {
    try {
      child?.kill("SIGTERM");
    } catch {}
  }
};

/** Bun runs no exit hooks on a signal, so the client is stopped there too, then the signal goes on. */
function stopOnSignals() {
  if (hot.openbuildFriendTunnelSignals) return;
  hot.openbuildFriendTunnelSignals = true;
  process.on("exit", () => kill(hot.openbuildFriendTunnel));
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    const handler = () => {
      kill(hot.openbuildFriendTunnel);
      if (process.listeners(signal).every((l) => l === handler)) {
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      }
    };
    process.prependListener(signal, handler);
  }
}

const alive = (child?: Child) => !!child && child.exitCode === null && child.signalCode === null;
const running = () => {
  const t = hot.openbuildFriendTunnel;
  return t && alive(t.child) ? t : undefined;
};

function keepLog(child: Child, log: string[]) {
  const keep = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) for (const line of decoder.decode(chunk).split("\n")) if (line.trim()) log.push(line.trim()), log.length > 20 && log.shift();
  };
  void keep(child.stdout as ReadableStream<Uint8Array>).catch(() => {});
  void keep(child.stderr as ReadableStream<Uint8Array>).catch(() => {});
}

/** `up`, once the service is listening, so it reloads that one rather than starting its own. */
async function create(t: Running, binary: string) {
  const socket = join(runtimeDir(), "opentunnel", `${PROFILE}.sock`);
  for (let i = 0; i < 100 && !existsSync(socket) && alive(t.child); i++) await Bun.sleep(50);
  if (!alive(t.child) || hot.openbuildFriendTunnel !== t) return;
  t.creating = Bun.spawn([binary, ...clientArgs(), "up"], { env: clientEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  keepLog(t.creating, t.log);
  await t.creating.exited;
}

function start(port: number) {
  const api = relay();
  const current = running();
  if (current && current.port === port && current.api === api) return current;
  stop();
  const binary = bin();
  if (!binary) throw new TransportError("The OpenTunnel client (`opentunnel`) isn't installed here: `npm install -g opentunnel`, or set OPENBUILD_FRIEND_TUNNEL_BIN to it. See docs/friends.md, \"Over OpenTunnel\".");
  for (const dir of [home(), dataHome(), stateHome(), noPath()]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  privateDir(runtimeDir());
  writeRoutes(port);
  stopOnSignals();
  const child = Bun.spawn([binary, ...clientArgs(), "serve"], { env: clientEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const t: Running = { child, port, api, log: [] };
  keepLog(child, t.log);
  if (!hostname()) t.created = create(t, binary);
  return (hot.openbuildFriendTunnel = t);
}

export function stop() {
  const t = hot.openbuildFriendTunnel;
  hot.openbuildFriendTunnel = undefined;
  kill(t);
}

export const tunnelRunning = () => !!running();

export const tunnel: Transport = {
  async place({ port, address }) {
    if (address) throw new TransportError("--address doesn't go with --tunnel: the address is the tunnel's own.");
    const t = start(port);
    const deadline = Date.now() + START_MS;
    for (;;) {
      const host = hostname();
      if (host && running()) return { listen: "127.0.0.1", urls: [publicUrl(host)] };
      const why = t.log.at(-1);
      if (!running()) throw new TransportError(`The OpenTunnel client stopped${why ? `: ${why}` : ""}.`);
      if (t.creating && !alive(t.creating) && t.creating.exitCode !== 0) {
        stop();
        throw new TransportError(`OpenTunnel couldn't create a tunnel at ${t.api}${why ? `: ${why}` : ""}.`);
      }
      if (Date.now() > deadline) {
        stop();
        throw new TransportError(`OpenTunnel didn't have a tunnel ready at ${t.api} after ${START_MS / 60_000} minutes${why ? ` (${why})` : ""}.`);
      }
      await Bun.sleep(250);
    }
  },
  sync({ needed, port }) {
    if (!needed) return stop();
    try {
      start(port);
    } catch (err) {
      console.error(`[friends] ${(err as Error).message}`);
    }
  },
  stop,
};
