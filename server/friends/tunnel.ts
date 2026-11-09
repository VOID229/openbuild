// Friends through a self-hosted OpenTunnel relay (docs/friends.md, "Over OpenTunnel"). Only the host
// runs a tunnel: OpenBuild starts the `opentunnel` client while an invite waits or a friend connects
// this way, with one route, to the friend listener on loopback. The app's own port is never routed. The
// guest needs nothing: it dials the route's https URL as one long-lived WSS, the same connection as
// over Tailscale.
//
// The relay is the owner's own: OPENBUILD_FRIEND_TUNNEL_API names it, and without it there's no
// tunnel. There's no default, so friends' traffic never falls back to a public relay. The client gets a
// profile, config and data of its own under <data>/friends/tunnel, so it doesn't touch the owner's own
// tunnels and never picks up OPENTUNNEL_* settings meant for them.
//
// The relay routes TLS it can't read, and the client hands the listener plain HTTP from a loopback
// peer. So a tunneled request looks local, and the route name is in the URL anyone can find: neither
// is proof of anything. The friend protocol proves who's on the other end, as it does everywhere.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as store from "./store";
import { TransportError, type Transport } from "./transport";

/** The client's profile: one tunnel, one hostname, kept for as long as the data folder is. */
export const PROFILE = "openbuild-friends";
/** How long a starting client has to say which hostname it got. */
const START_MS = 30_000;

type Child = ReturnType<typeof Bun.spawn>;
const hot = globalThis as { openbuildFriendTunnel?: { child: Child; port: number; api: string; log: string[] }; openbuildFriendTunnelSignals?: boolean };

/** The self-hosted relay's API, as the owner configured it. Undefined when they haven't. */
export function relayApi(): string | undefined {
  const raw = process.env.OPENBUILD_FRIEND_TUNNEL_API?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TransportError(`OPENBUILD_FRIEND_TUNNEL_API (${raw}) isn't a URL. Set it to your OpenTunnel server's address, like https://tunnel.example.com.`);
  }
  // Plain http only to a relay on this machine, for trying one out.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new TransportError("OPENBUILD_FRIEND_TUNNEL_API has to be https:// (plain http only for a relay on this machine).");
  return url.origin;
}

export const bin = () => process.env.OPENBUILD_FRIEND_TUNNEL_BIN?.trim() || Bun.which("opentunnel") || undefined;
export const tunnelDir = () => join(store.friendsDir(), "tunnel");
const configHome = () => join(tunnelDir(), "config");
const dataHome = () => join(tunnelDir(), "data");

/** The client's environment: the owner's relay, this profile's own folders, and none of the owner's OPENTUNNEL_* settings. */
export function clientEnv(api: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("OPENTUNNEL_")) env[key] = value;
  const ca = process.env.OPENBUILD_FRIEND_TUNNEL_CA?.trim();
  return { ...env, OPENTUNNEL_API: api, OPENTUNNEL_PROFILE: PROFILE, XDG_CONFIG_HOME: configHome(), XDG_DATA_HOME: dataHome(), ...(ca ? { OPENTUNNEL_CA_CERT: ca } : {}) };
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

/** Bun runs no exit hooks on a signal, so the client is stopped there too, then the signal goes on. */
function stopOnSignals() {
  if (hot.openbuildFriendTunnelSignals) return;
  hot.openbuildFriendTunnelSignals = true;
  const kill = () => {
    try {
      hot.openbuildFriendTunnel?.child.kill("SIGTERM");
    } catch {}
  };
  process.on("exit", kill);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    const handler = () => {
      kill();
      if (process.listeners(signal).every((l) => l === handler)) {
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      }
    };
    process.prependListener(signal, handler);
  }
}

const running = () => {
  const t = hot.openbuildFriendTunnel;
  return t && t.child.exitCode === null && t.child.signalCode === null ? t : undefined;
};

function start(port: number, api: string) {
  const current = running();
  if (current && current.port === port && current.api === api) return current;
  stop();
  const binary = bin();
  if (!binary) throw new TransportError("The OpenTunnel client (`opentunnel`) isn't installed here, or set OPENBUILD_FRIEND_TUNNEL_BIN to it. See docs/friends.md, \"Over OpenTunnel\".");
  mkdirSync(dataHome(), { recursive: true, mode: 0o700 });
  writeRoutes(port);
  stopOnSignals();
  const child = Bun.spawn([binary, "--profile", PROFILE, "serve"], { env: clientEnv(api), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const log: string[] = [];
  const keep = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) for (const line of decoder.decode(chunk).split("\n")) if (line.trim()) log.push(line.trim()), log.length > 20 && log.shift();
  };
  void keep(child.stdout as ReadableStream<Uint8Array>).catch(() => {});
  void keep(child.stderr as ReadableStream<Uint8Array>).catch(() => {});
  return (hot.openbuildFriendTunnel = { child, port, api, log });
}

export function stop() {
  const t = hot.openbuildFriendTunnel;
  hot.openbuildFriendTunnel = undefined;
  try {
    t?.child.kill("SIGTERM");
  } catch {}
}

export const tunnelRunning = () => !!running();

export const tunnel: Transport = {
  async place({ port, address }) {
    if (address) throw new TransportError("--address doesn't go with --tunnel: the address is the tunnel's own.");
    const api = relayApi();
    if (!api) throw new TransportError("Friends over OpenTunnel need your own relay: set OPENBUILD_FRIEND_TUNNEL_API to your OpenTunnel server's URL and restart OpenBuild. See docs/friends.md, \"Over OpenTunnel\".");
    const t = start(port, api);
    const deadline = Date.now() + START_MS;
    for (;;) {
      const host = hostname();
      if (host && running()) return { listen: "127.0.0.1", urls: [publicUrl(host)] };
      if (!running()) throw new TransportError(`The OpenTunnel client stopped${t.log.length ? `: ${t.log.at(-1)}` : ""}. Check OPENBUILD_FRIEND_TUNNEL_API and that your relay is up.`);
      if (Date.now() > deadline) {
        stop();
        throw new TransportError(`The OpenTunnel client didn't get a tunnel from ${api} in ${START_MS / 1000}s${t.log.length ? ` (${t.log.at(-1)})` : ""}.`);
      }
      await Bun.sleep(250);
    }
  },
  sync({ needed, port }) {
    if (!needed) return stop();
    let api: string | undefined;
    try {
      api = relayApi();
    } catch (err) {
      return console.error(`[friends] ${(err as Error).message}`);
    }
    if (!api) return console.error("[friends] a friend connects here over OpenTunnel, but OPENBUILD_FRIEND_TUNNEL_API isn't set, so the tunnel can't start.");
    try {
      start(port, api);
    } catch (err) {
      console.error(`[friends] ${(err as Error).message}`);
    }
  },
  stop,
};
