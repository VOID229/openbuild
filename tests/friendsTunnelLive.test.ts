import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, identities, peer, until, type Peer } from "./fakeTunnel";

// The same friendship as friendsTunnel.test.ts, through a real self-hosted OpenTunnel relay: the host
// starts the real `opentunnel` client, and the guest holds one WSS to the route it gets, on the default
// heartbeats, for OPENBUILD_TEST_TUNNEL_HOLD_MS (90s unless set). Only with a relay of your own:
//
//   OPENBUILD_TEST_OPENTUNNEL_API=https://tunnel.example.com bun run test friendsTunnelLive
//
// It's skipped without one, and never falls back to a public relay. The client's profile and data are
// on a throwaway folder, so each run gets a fresh tunnel. Everything sent is synthetic.
const api = process.env.OPENBUILD_TEST_OPENTUNNEL_API?.trim();
const bin = process.env.OPENBUILD_FRIEND_TUNNEL_BIN?.trim() || Bun.which("opentunnel");
const hold = Number(process.env.OPENBUILD_TEST_TUNNEL_HOLD_MS ?? 90_000);
const directory = mkdtempSync(join(tmpdir(), "openbuild-friends-tunnel-live-"));
const peers: Peer[] = [];
afterAll(() => {
  for (const p of peers) p.child.kill("SIGTERM");
  rmSync(directory, { recursive: true, force: true });
});

test.skipIf(!api || !bin)("a long-lived WSS through a self-hosted OpenTunnel relay", async () => {
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
    OPENBUILD_FRIEND_TUNNEL_API: api!,
    OPENBUILD_FRIEND_TUNNEL_BIN: bin!,
  });
  peers.push(host);
  const placed = await host.next((e) => e.placed || e.placeError, 45_000);
  expect(placed.placeError).toBeUndefined();
  const url = placed.placed.urls[0];
  const guest = peer({ OPENCHAT_DATA_DIR: guestDir, PEER_ROLE: "guest", PEER_OTHER_KEY: keys.host.publicKey, PEER_URL: url });
  peers.push(guest);
  // A new tunnel's certificate and DNS can take a little while.
  await guest.next((e) => e.online === true, 90_000);
  const started = Date.now();
  let n = 0;
  while (Date.now() - started < hold) {
    host.send({ send: ++n });
    guest.send({ send: 1000 + n });
    await Bun.sleep(Math.min(15_000, hold / 4));
  }
  await until(() => guest.applied().length === n && host.applied().length === n, "messages both ways", 30_000);
  expect(guest.applied()).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  // One connection the whole time: neither side ever saw it drop.
  expect(guest.events.filter((e) => e.online === false)).toHaveLength(0);
  expect(host.events.filter((e) => e.online === false)).toHaveLength(0);
  host.send({ exit: true });
  guest.send({ exit: true });
}, hold + 240_000);
