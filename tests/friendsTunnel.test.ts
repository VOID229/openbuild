import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyId } from "../server/friends/protocol";
import { certificate, fakeClientBin, fakeNpmInstall, fakeRelay, freePort, identities, peer, until, type Peer } from "./fakeTunnel";
import { spawnScriptSync } from "./spawnScript";

// Friends through a tunnel, with a fake relay in OpenTunnel's place (friendsTunnelLive.test.ts runs the
// same through the real client and relay when asked to). The host starts the tunnel client the way an
// invite does: a stand-in client (fakeOpentunnel.ts) that behaves as the real one does where OpenBuild
// relies on it, and notes how it was started. The guest dials one WSS through the fake relay, which copies bytes to the
// host's friend listener on loopback and resets connections idle too long, like the real one. Each
// side is its own process on a throwaway data dir, and everything they say is synthetic.
const directory = mkdtempSync(join(tmpdir(), "openbuild-friends-tunnel-"));
const peers: Peer[] = [];
let relay: ReturnType<typeof fakeRelay> | undefined;
let runtime: string | undefined;
afterAll(() => {
  for (const p of peers) p.child.kill("SIGKILL");
  relay?.stop();
  rmSync(directory, { recursive: true, force: true });
  if (runtime) rmSync(runtime, { recursive: true, force: true });
});
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

test("a guest holds one WSS through the tunnel, reconnects without losing anything, and is turned away once removed", async () => {
  const hostDir = join(directory, "host");
  const guestDir = join(directory, "guest");
  const keys = identities(hostDir, guestDir);
  const { cert, key, certFile } = certificate(directory);
  const friendPort = freePort();
  const appPort = freePort();
  const tunnelDir = join(hostDir, "friends", "tunnel");
  const npm = fakeNpmInstall(join(directory, "npm"));
  const runs = () => readFileSync(join(tunnelDir, "home", "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

  const host = peer({
    OPENCHAT_DATA_DIR: hostDir,
    PEER_ROLE: "host",
    PEER_OTHER_KEY: keys.guest.publicKey,
    PEER_PLACE: "1",
    PEER_PING_MS: "300",
    PORT: String(appPort),
    OPENBUILD_FRIEND_HOST: "127.0.0.1",
    OPENBUILD_FRIEND_PORT: String(friendPort),
    // No OPENBUILD_FRIEND_TUNNEL_API: the hosted relay. The client as `npm install -g opentunnel`
    // leaves it: a Node launcher, which can't run with the client's empty PATH.
    OPENBUILD_FRIEND_TUNNEL_BIN: npm.launcher,
    // The owner's own tunnel settings, which friends' tunnel mustn't pick up.
    OPENTUNNEL_API: "https://tunnel.someone-else.test",
    OPENTUNNEL_PROFILE: "default",
    OPENTUNNEL_TOKEN: "not-for-friends",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus",
  });
  peers.push(host);
  const placed = (await host.next((e) => e.placed || e.placeError)).placed;
  expect(placed).toBeDefined();
  expect(runs().every((run) => run.native === npm.native)).toBe(true);
  // The invite would give the route under the tunnel's hostname, served by the listener on loopback.
  expect(placed.listen).toBe("127.0.0.1");
  expect(placed.urls).toHaveLength(1);
  expect(placed.urls[0]).toMatch(/^https:\/\/f[0-9a-f]{20}\.t1\.relay\.test$/);
  expect((await host.next((e) => e.listening)).listening).toEqual({ port: friendPort });

  // The client, as OpenTunnel 0.6.2 needs it: `serve`, OpenBuild's own child, then `up` to create the
  // tunnel, which finds that service running and has it reload. The hosted relay is the client's own
  // default, so no --api. A profile, HOME and XDG folders of its own; none of the owner's OPENTUNNEL_*
  // settings; and no PATH, so it finds no systemctl to register a login service with.
  const [serve, up] = runs();
  expect(serve.command).toBe("serve");
  expect(serve.args).toEqual(["--profile", "openbuild-friends", "serve"]);
  expect(up.command).toBe("up");
  expect(up.args).toEqual(["--profile", "openbuild-friends", "up"]);
  expect(up.serviceRunning).toBe(true);
  for (const run of [serve, up]) {
    expect(Object.keys(run.env).filter((k) => k.startsWith("OPENTUNNEL_") || k.startsWith("DBUS"))).toEqual([]);
    expect(run.env.HOME).toBe(join(tunnelDir, "home"));
    expect(run.env.XDG_CONFIG_HOME).toBe(join(tunnelDir, "config"));
    expect(run.env.XDG_DATA_HOME).toBe(join(tunnelDir, "data"));
    expect(run.env.XDG_STATE_HOME).toBe(join(tunnelDir, "state"));
    expect(readdirSync(run.env.PATH)).toEqual([]);
  }
  // The control socket's folder: short enough for a socket path, and private.
  runtime = serve.env.XDG_RUNTIME_DIR as string;
  expect(join(runtime, "opentunnel", "openbuild-friends.sock").length).toBeLessThan(100);
  expect(statSync(runtime).mode & 0o777).toBe(0o700);
  const routes = serve.routes.split("\n").filter((l: string) => l.includes("="));
  expect(routes).toEqual([`${new URL(placed.urls[0]).hostname.split(".")[0]} = "127.0.0.1:${friendPort}"`]);
  expect(serve.routes).not.toContain(String(appPort));

  // Connections idle for 1.5s are reset, as the relay does after its idle timeout. Heartbeats keep
  // the one connection up well past that.
  relay = fakeRelay({ target: friendPort, cert, key, idleMs: 1500 });
  const base = `https://localhost:${relay.port}`;
  const guest = peer({ OPENCHAT_DATA_DIR: guestDir, PEER_ROLE: "guest", PEER_OTHER_KEY: keys.host.publicKey, PEER_URL: base, PEER_PING_MS: "300", NODE_EXTRA_CA_CERTS: certFile });
  peers.push(guest);
  await host.next((e) => e.online === true);
  await guest.next((e) => e.online === true);
  for (let n = 1; n <= 5; n++) {
    host.send({ send: n });
    guest.send({ send: 100 + n });
    await Bun.sleep(1000);
  }
  await until(() => guest.applied().length === 5 && host.applied().length === 5, "messages both ways");
  expect(guest.applied()).toEqual([1, 2, 3, 4, 5]);
  expect(host.applied()).toEqual([101, 102, 103, 104, 105]);
  expect(relay.opened()).toBe(1);
  expect(host.events.filter((e) => e.online === false)).toHaveLength(0);

  // The relay drops the connection. What's written meanwhile waits, and arrives once, in order.
  const mark = host.events.length;
  relay.cut();
  await host.next((e) => e.online === false, 5000, mark);
  host.send({ send: 6 });
  host.send({ send: 7 });
  await host.next((e) => e.online === true, 15_000, mark);
  await until(() => guest.applied().length === 7, "what waited");
  expect(guest.applied()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(relay.opened()).toBe(2);

  // The public endpoint, through the relay: nothing but the friend protocol, and strangers get nowhere.
  // A fresh connection each: the relay resets idle ones, and a pooled one it reset would fail the request.
  const ca = { tls: { ca: cert }, keepalive: false } as RequestInit;
  const status = async (path: string, init: RequestInit = {}) => (await fetch(`${base}${path}`, { ...ca, ...init })).status;
  expect(await status("/")).toBe(404);
  expect(await status("/api/auth/status")).toBe(404);
  expect(await status("/friend/v1/connect?from=../../etc")).toBe(404);
  expect(await status(`/friend/v1/connect?from=${keyId(keys.host.publicKey).replace(/./, "0")}`)).toBe(403);
  expect(await status(`/friend/v1/connect?from=${keyId(keys.guest.publicKey)}`, { headers: { origin: "https://evil.test" } })).toBe(404);
  // A known friend's id without the WebSocket upgrade, or its key, gets no further than this.
  expect(await status(`/friend/v1/connect?from=${keyId(keys.guest.publicKey)}`)).toBe(426);
  expect(await status("/friend/v1/join", { method: "POST", body: "x".repeat(100 * 1024) })).toBe(413);
  expect(await status("/friend/v1/join", { method: "POST", body: JSON.stringify({ p: "{}", s: "x" }) })).toBe(403);
  expect(await status("/friend/v1/join/status", { method: "POST", body: "{}" })).toBe(403);

  // Past the listener's budget, everyone is asked to wait, with no work done for them. The guest's
  // connection, already proved, isn't counted against it.
  // A few at a time: hundreds of TLS handshakes at once through the fake relay are a test of the fake.
  const codes: (readonly [number, string | null])[] = [];
  for (let sent = 0; sent < 320; sent += 8) {
    codes.push(...(await Promise.all(Array.from({ length: 8 }, () => fetch(`${base}/`, ca).then((r) => [r.status, r.headers.get("retry-after")] as const)))));
  }
  expect(codes.filter(([s]) => s === 404).length).toBeGreaterThan(0);
  expect(codes.filter(([s, after]) => s === 429 && after === "60").length).toBeGreaterThan(0);
  host.send({ send: 8 });
  await until(() => guest.applied().includes(8), "a frame past the budget");

  // Removed: the guest hears it at once, nothing it sends is applied, and with nobody left to serve
  // the host stops listening and stops its tunnel client, so there's nothing left to reach.
  host.send({ remove: true });
  await guest.next((e) => e.removedByPeer);
  guest.send({ send: 999 });
  await until(() => gone(serve.pid), "the tunnel client stopping once nobody needs it", 5000);
  await Bun.sleep(1500);
  expect(host.applied()).not.toContain(999);
  expect(await fetch(`http://127.0.0.1:${friendPort}/`).then(() => "answered", () => "closed")).toBe("closed");
  host.send({ exit: true });
  await host.child.exited;
  expect(guest.stderr()).toBe("");

  // Again, through a relay of the owner's own: the client is told it, and nothing else changes. A
  // signal stops the client with the server, since Bun runs no exit hooks there.
  const again = peer({
    OPENCHAT_DATA_DIR: hostDir,
    PEER_ROLE: "host",
    PEER_OTHER_KEY: keys.guest.publicKey,
    PEER_PLACE: "1",
    OPENBUILD_FRIEND_HOST: "127.0.0.1",
    OPENBUILD_FRIEND_PORT: String(friendPort),
    OPENBUILD_FRIEND_TUNNEL_API: "https://relay.test",
    OPENBUILD_FRIEND_TUNNEL_BIN: fakeClientBin(directory),
  });
  peers.push(again);
  const replaced = (await again.next((e) => e.placed || e.placeError)).placed;
  // The same route under the same hostname: a friend's saved address keeps working.
  expect(replaced.urls).toEqual(placed.urls);
  // The tunnel exists, so only `serve` runs this time.
  await until(() => runs().length === 3, "the client starting again");
  const second = runs()[2];
  expect(second.args).toEqual(["--profile", "openbuild-friends", "--api", "https://relay.test", "serve"]);
  again.child.kill("SIGTERM");
  await again.child.exited;
  await until(() => gone(second.pid), "the tunnel client stopping with the server", 5000);
  expect(existsSync(join(runtime, "opentunnel", "openbuild-friends.sock"))).toBe(false);
}, 90_000);

// Which relay the client is told to use: the hosted one unless the owner names theirs, and a bad
// address of theirs is refused rather than quietly swapped for the hosted one.
test("the tunnel uses the hosted relay unless OPENBUILD_FRIEND_TUNNEL_API names another", () => {
  const run = (env: Record<string, string>) => {
    const child = spawnScriptSync(`
      const t = await import('./server/friends/tunnel.ts');
      let out;
      try { out = { relay: t.relay(), args: t.clientArgs() }; } catch (err) { out = { error: err.message }; }
      console.log(JSON.stringify(out));
    `, { OPENCHAT_DATA_DIR: join(directory, "relay-check"), OPENBUILD_FRIEND_TUNNEL_API: "", OPENTUNNEL_API: "https://someone-else.test", ...env });
    return JSON.parse(child.stdout);
  };
  expect(run({})).toEqual({ relay: "https://opentunnel.xyz", args: ["--profile", "openbuild-friends"] });
  expect(run({ OPENBUILD_FRIEND_TUNNEL_API: "https://tunnel.example.com/" })).toEqual({ relay: "https://tunnel.example.com", args: ["--profile", "openbuild-friends", "--api", "https://tunnel.example.com"] });
  expect(run({ OPENBUILD_FRIEND_TUNNEL_API: "http://localhost:8080" }).relay).toBe("http://localhost:8080");
  expect(run({ OPENBUILD_FRIEND_TUNNEL_API: "http://tunnel.example.com" }).error).toContain("has to be https://");
  expect(run({ OPENBUILD_FRIEND_TUNNEL_API: "not a url" }).error).toContain("isn't a URL");
  expect(run({ OPENBUILD_FRIEND_TUNNEL_CA: "/etc/ca.pem" }).args).toEqual(["--profile", "openbuild-friends", "--ca-cert", "/etc/ca.pem"]);
});

// The npm launcher is resolved to the native client beside it, wherever npm or bun put it, and a
// launcher whose native client is missing is said so, rather than run to fail with no PATH.
test("an `env node` launcher from npm is resolved to its native client", () => {
  const resolveBin = (bin: string) => {
    const child = spawnScriptSync(`
      const t = await import('./server/friends/tunnel.ts');
      let out;
      try { out = { bin: t.bin() }; } catch (err) { out = { error: err.message }; }
      console.log(JSON.stringify(out));
    `, { OPENCHAT_DATA_DIR: join(directory, "bin-check"), OPENBUILD_FRIEND_TUNNEL_BIN: bin });
    return JSON.parse(child.stdout);
  };
  const nested = fakeNpmInstall(join(directory, "npm-nested"));
  expect(resolveBin(nested.launcher)).toEqual({ bin: nested.native });
  const hoisted = fakeNpmInstall(join(directory, "npm-hoisted"), { hoisted: true });
  expect(resolveBin(hoisted.launcher)).toEqual({ bin: hoisted.native });
  // The native client named directly, or any other client that isn't a Node script, runs as it is.
  expect(resolveBin(nested.native)).toEqual({ bin: nested.native });
  const plain = fakeClientBin(join(directory));
  expect(resolveBin(plain)).toEqual({ bin: realpathSync(plain) });
  const broken = fakeNpmInstall(join(directory, "npm-broken"), { native: false });
  expect(resolveBin(broken.launcher).error).toContain(`@opentunnel/cli-${process.platform}-${process.arch}`);
  // Run as it is with no PATH, as the client is, the launcher can't even start.
  const run = Bun.spawnSync([nested.launcher, "--version"], { env: { PATH: join(directory, "empty-path") }, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(127);
});
