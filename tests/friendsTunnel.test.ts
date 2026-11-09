import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyId } from "../server/friends/protocol";
import { certificate, fakeClientBin, fakeRelay, freePort, identities, peer, until, type Peer } from "./fakeTunnel";

// Friends through a tunnel, with a fake relay in OpenTunnel's place (there's no self-hosted relay to
// test against here; friendsTunnelLive.test.ts runs the same through a real one when it's configured).
// The host starts the tunnel client the way an invite does: a stand-in client (fakeOpentunnel.ts) that
// notes how it was started. The guest dials one WSS through the fake relay, which copies bytes to the
// host's friend listener on loopback and resets connections idle too long, like the real one. Each
// side is its own process on a throwaway data dir, and everything they say is synthetic.
const directory = mkdtempSync(join(tmpdir(), "openbuild-friends-tunnel-"));
const peers: Peer[] = [];
let relay: ReturnType<typeof fakeRelay> | undefined;
afterAll(() => {
  for (const p of peers) p.child.kill("SIGKILL");
  relay?.stop();
  rmSync(directory, { recursive: true, force: true });
});

test("a guest holds one WSS through the tunnel, reconnects without losing anything, and is turned away once removed", async () => {
  const hostDir = join(directory, "host");
  const guestDir = join(directory, "guest");
  const keys = identities(hostDir, guestDir);
  const { cert, key, certFile } = certificate(directory);
  const friendPort = freePort();
  const appPort = freePort();
  const record = join(directory, "client.json");

  const host = peer({
    OPENCHAT_DATA_DIR: hostDir,
    PEER_ROLE: "host",
    PEER_OTHER_KEY: keys.guest.publicKey,
    PEER_PLACE: "1",
    PEER_PING_MS: "300",
    PORT: String(appPort),
    OPENBUILD_FRIEND_HOST: "127.0.0.1",
    OPENBUILD_FRIEND_PORT: String(friendPort),
    OPENBUILD_FRIEND_TUNNEL_API: "https://relay.test",
    OPENBUILD_FRIEND_TUNNEL_BIN: fakeClientBin(directory),
    // The owner's own tunnel settings, which friends' tunnel mustn't pick up.
    OPENTUNNEL_API: "https://opentunnel.xyz",
    OPENTUNNEL_PROFILE: "default",
    OPENTUNNEL_TOKEN: "not-for-friends",
    FAKE_OPENTUNNEL_RECORD: record,
  });
  peers.push(host);
  const placed = (await host.next((e) => e.placed || e.placeError)).placed;
  expect(placed).toBeDefined();
  // The invite would give the route under the tunnel's hostname, served by the listener on loopback.
  expect(placed.listen).toBe("127.0.0.1");
  expect(placed.urls).toHaveLength(1);
  expect(placed.urls[0]).toMatch(/^https:\/\/f[0-9a-f]{20}\.t1\.relay\.test$/);
  expect((await host.next((e) => e.listening)).listening).toEqual({ port: friendPort });

  // The client: the owner's self-hosted relay and nothing else, on a profile and folders of its own,
  // with one route, to the friend port. The app's port is never routed.
  const client = JSON.parse(readFileSync(record, "utf8"));
  expect(client.args).toEqual(["--profile", "openbuild-friends", "serve"]);
  expect(client.env).toEqual({ OPENTUNNEL_API: "https://relay.test", OPENTUNNEL_PROFILE: "openbuild-friends" });
  expect(client.configHome).toBe(join(hostDir, "friends", "tunnel", "config"));
  const routes = client.routes.split("\n").filter((l: string) => l.includes("="));
  expect(routes).toEqual([`${new URL(placed.urls[0]).hostname.split(".")[0]} = "127.0.0.1:${friendPort}"`]);
  expect(client.routes).not.toContain(String(appPort));

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
  const ca = { tls: { ca: cert } } as RequestInit;
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
  const codes = await Promise.all(Array.from({ length: 320 }, () => fetch(`${base}/`, ca).then((r) => [r.status, r.headers.get("retry-after")] as const)));
  expect(codes.filter(([s]) => s === 404).length).toBeGreaterThan(0);
  expect(codes.filter(([s, after]) => s === 429 && after === "60").length).toBeGreaterThan(0);
  host.send({ send: 8 });
  await until(() => guest.applied().includes(8), "a frame past the budget");

  // Removed: the guest hears it at once, nothing it sends is applied, and with nobody left to serve
  // the host stops listening and stops its tunnel client, so there's nothing left to reach.
  host.send({ remove: true });
  await guest.next((e) => e.removedByPeer);
  guest.send({ send: 999 });
  const gone = (pid: number) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  await until(() => gone(client.pid), "the tunnel client stopping once nobody needs it", 5000);
  await Bun.sleep(1500);
  expect(host.applied()).not.toContain(999);
  expect(await fetch(`http://127.0.0.1:${friendPort}/`).then(() => "answered", () => "closed")).toBe("closed");
  host.send({ exit: true });
  await host.child.exited;
  expect(guest.stderr()).toBe("");

  // A signal stops the server's tunnel client with it, since Bun runs no exit hooks there.
  const again = peer({
    OPENCHAT_DATA_DIR: hostDir,
    PEER_ROLE: "host",
    PEER_OTHER_KEY: keys.guest.publicKey,
    PEER_PLACE: "1",
    OPENBUILD_FRIEND_HOST: "127.0.0.1",
    OPENBUILD_FRIEND_PORT: String(friendPort),
    OPENBUILD_FRIEND_TUNNEL_API: "https://relay.test",
    OPENBUILD_FRIEND_TUNNEL_BIN: fakeClientBin(directory),
    FAKE_OPENTUNNEL_RECORD: record,
  });
  peers.push(again);
  const replaced = (await again.next((e) => e.placed || e.placeError)).placed;
  // The same route under the same hostname: a friend's saved address keeps working.
  expect(replaced.urls).toEqual(placed.urls);
  // The hostname was already known, so the invite needn't wait for the client to come up again.
  const read = () => JSON.parse(readFileSync(record, "utf8"));
  await until(() => read().pid !== client.pid, "the client starting again");
  const second = read();
  again.child.kill("SIGTERM");
  await again.child.exited;
  await until(() => gone(second.pid), "the tunnel client stopping with the server", 5000);
}, 90_000);
