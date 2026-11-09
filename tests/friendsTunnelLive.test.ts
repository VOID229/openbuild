import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, identities, peer, until, type Peer } from "./fakeTunnel";

// Friends through the real OpenTunnel client and relay: the hosted one at opentunnel.xyz, or yours with
// OPENBUILD_FRIEND_TUNNEL_API. The host starts the client the way an invite does, on a throwaway data
// folder (so a fresh tunnel each run, deleted again at the end), and the guest holds one WSS to the
// route it gets, speaking the friend protocol, for OPENBUILD_TEST_TUNNEL_HOLD_MS (90s unless set).
// It reaches the internet, so it only runs when asked to, with the client on PATH or named:
//
//   OPENBUILD_TEST_OPENTUNNEL=1 OPENBUILD_FRIEND_TUNNEL_BIN=/path/to/opentunnel bun run test friendsTunnelLive
//
// Everything sent is synthetic.
const bin = process.env.OPENBUILD_FRIEND_TUNNEL_BIN?.trim() || Bun.which("opentunnel");
const enabled = process.env.OPENBUILD_TEST_OPENTUNNEL === "1" && !!bin;
const hold = Number(process.env.OPENBUILD_TEST_TUNNEL_HOLD_MS ?? 90_000);
const directory = mkdtempSync(join(tmpdir(), "openbuild-friends-tunnel-live-"));
const peers: Peer[] = [];
let runtime: string | undefined;
afterAll(() => {
  for (const p of peers) p.child.kill("SIGTERM");
  rmSync(directory, { recursive: true, force: true });
  // The client's control-socket folder, outside the data folder because socket paths are short.
  if (runtime) rmSync(runtime, { recursive: true, force: true });
});

test.skipIf(!enabled)("a long-lived WSS through the real OpenTunnel relay", async () => {
  const hostDir = join(directory, "host");
  const guestDir = join(directory, "guest");
  const keys = identities(hostDir, guestDir);
  const host = peer({
    OPENCHAT_DATA_DIR: hostDir,
    PEER_ROLE: "host",
    PEER_OTHER_KEY: keys.guest.publicKey,
    PEER_PLACE: "1",
    OPENBUILD_FRIEND_HOST: "127.0.0.1",
    OPENBUILD_FRIEND_PORT: String(freePort()),
    OPENBUILD_FRIEND_TUNNEL_BIN: bin!,
  });
  peers.push(host);
  runtime = (await host.next((e) => e.runtime)).runtime;
  try {
    // A new tunnel's certificate can take a few minutes.
    const placed = await host.next((e) => e.placed || e.placeError, 300_000);
    expect(placed.placeError).toBeUndefined();
    const url = placed.placed.urls[0];
    expect(url).toMatch(process.env.OPENBUILD_FRIEND_TUNNEL_API ? /^https:\/\/f[0-9a-f]{20}\./ : /^https:\/\/f[0-9a-f]{20}\.[a-z0-9]+\.opentunnel\.xyz$/);
    console.log(`[live] tunnel: ${url.replace(/^https:\/\/[^.]+/, "https://<route>")}`);
    const guest = peer({ OPENCHAT_DATA_DIR: guestDir, PEER_ROLE: "guest", PEER_OTHER_KEY: keys.host.publicKey, PEER_URL: url });
    peers.push(guest);
    await guest.next((e) => e.online === true, 90_000);
    await host.next((e) => e.online === true, 10_000);
    // Through the relay, the listener still answers nothing but the friend protocol.
    expect((await fetch(`${url}/`)).status).toBe(404);
    expect((await fetch(`${url}/api/auth/status`)).status).toBe(404);
    const started = Date.now();
    let n = 0;
    while (Date.now() - started < hold) {
      host.send({ send: ++n });
      guest.send({ send: 1000 + n });
      await Bun.sleep(Math.min(15_000, hold / 4));
    }
    await until(() => guest.applied().length === n && host.applied().length === n, "messages both ways", 30_000);
    expect(guest.applied()).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    expect(host.applied()).toEqual(Array.from({ length: n }, (_, i) => 1001 + i));
    // One connection the whole time: neither side ever saw it drop.
    expect(guest.events.filter((e) => e.online === false)).toHaveLength(0);
    expect(host.events.filter((e) => e.online === false)).toHaveLength(0);
    console.log(`[live] held one WSS for ${Math.round((Date.now() - started) / 1000)}s, ${n} frames each way`);
    guest.send({ exit: true });
  } finally {
    // The synthetic tunnel goes again, with the same isolated client.
    host.send({ deleteTunnel: true });
    const deleted = await host.next((e) => "deleted" in e, 30_000).catch(() => undefined);
    console.log(`[live] tunnel deleted: ${deleted?.deleted} ${deleted?.output ?? ""}`);
    host.send({ exit: true });
  }
}, hold + 480_000);
