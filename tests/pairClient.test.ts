import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

// The preload points OPENCHAT_DATA_DIR at a throwaway directory; devices.ts fixes its paths on
// import, so refuse to run anywhere else rather than touch real pairings.
const data = process.env.OPENCHAT_DATA_DIR;
if (!data || !realpathSync(data).startsWith(realpathSync(tmpdir()))) throw new Error("pairClient tests need a temporary OPENCHAT_DATA_DIR");
const devices = await import("../server/devices");
const pairing = await import("../server/pairClient");

// A host with the real host-side logic (devices.pairingInfo / claimPairing), on a real socket.
const hits: string[] = [];
const host = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    hits.push(`${req.method} ${path}`);
    if (path === "/api/pair/info") return Response.json(devices.pairingInfo());
    if (path === "/api/pair/claim" && req.method === "POST") {
      const body = (await req.json()) as { code: string; name: string };
      const claimed = devices.claimPairing(body.code, body.name);
      return claimed ? Response.json(claimed) : Response.json({ error: "no" }, { status: 403 });
    }
    return new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${host.port}`;
// Something that redirects pairing requests elsewhere: the code must never follow.
const elsewhere: string[] = [];
const sink = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (elsewhere.push(new URL(req.url).pathname), Response.json({ pending: true, name: "sink" })) });
const redirector = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => Response.redirect(`http://127.0.0.1:${sink.port}${new URL(req.url).pathname}`, 307) });

afterAll(() => {
  host.stop(true);
  sink.stop(true);
  redirector.stop(true);
});

beforeEach(() => {
  hits.length = 0;
  devices.cancelPairing();
  for (const d of devices.readDevices()) devices.removeDevice(d.id);
});

const open = (mode: "lan" | "tailscale" = "lan") => devices.createPairing({ name: "host-box", mode, urls: [base] });

describe("codes and addresses", () => {
  test("codes are normalized the way the host prints them", () => {
    expect(pairing.normalizeCode("abcd 2345")).toBe("ABCD-2345");
    expect(pairing.normalizeCode("abcd2345")).toBe("ABCD-2345");
    expect(pairing.normalizeCode(" abcd-2345 ")).toBe("ABCD-2345");
    expect(pairing.normalizeCode("short")).toBe("SHORT");
  });

  test("a typed address is a bare origin: no paths, queries or credentials are passed on", () => {
    expect(pairing.addressOrigins("laptop", 3100)).toEqual(["https://laptop:3100", "http://laptop:3100"]);
    expect(pairing.addressOrigins("10.0.0.5:4000", 3100)).toEqual(["https://10.0.0.5:4000", "http://10.0.0.5:4000"]);
    expect(pairing.addressOrigins("https://laptop.tail.ts.net", 3100)).toEqual(["https://laptop.tail.ts.net"]);
    expect(pairing.addressOrigins("http://laptop:3100/", 3100)).toEqual(["http://laptop:3100"]);
    for (const bad of ["", "   ", "http://laptop/api/projects", "laptop/x", "http://a:b@laptop", "laptop?x=1", "laptop#x", "ftp://laptop", "two words", "x".repeat(300)])
      expect(pairing.addressOrigins(bad, 3100)).toBeUndefined();
  });

  test("LAN candidates cover this machine and each LAN subnet, never Tailscale or loopback interfaces", () => {
    const list = pairing.lanCandidates(3100, {
      lo: [{ family: "IPv4", address: "127.0.0.1", internal: true } as never],
      eth0: [{ family: "IPv4", address: "192.168.7.20", internal: false } as never, { family: "IPv6", address: "fe80::1", internal: false } as never],
      tailscale0: [{ family: "IPv4", address: "100.101.1.2", internal: false } as never],
    });
    expect(list.slice(0, 2)).toEqual(["http://127.0.0.1:3100", "http://localhost:3100"]);
    expect(list).toContain("http://192.168.7.1:3100");
    expect(list).toContain("http://192.168.7.254:3100");
    expect(list.some((u) => u.includes("100.101."))).toBe(false);
    expect(list).toHaveLength(2 + 254);
  });

  test("Tailscale candidates are this machine and the tailnet peers, by IP and MagicDNS name", () => {
    expect(pairing.tailscalePeerCandidates(3100, undefined)).toEqual(["http://127.0.0.1:3100"]);
    const list = pairing.tailscalePeerCandidates(3100, {
      Self: { TailscaleIPs: ["100.64.0.1", "fd7a::1"], DNSName: "me.tail.ts.net." },
      Peer: { a: { TailscaleIPs: ["100.109.42.88"], DNSName: "mac.tail.ts.net." } },
    });
    expect(list).toContain("http://100.109.42.88:3100");
    expect(list).toContain("https://mac.tail.ts.net");
    expect(list).toContain("https://mac.tail.ts.net:3100");
    expect(list.some((u) => u.includes("fd7a"))).toBe(false);
  });
});

describe("pairing with a code", () => {
  test("LAN discovery finds the waiting host and keeps the token on this server only", async () => {
    const { code } = open("lan");
    const outcome = await pairing.pairWithCode({ mode: "lan", code: code.toLowerCase().replace("-", " "), port: 1, candidates: [`http://127.0.0.1:1`, base] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.device).toMatchObject({ name: "host-box", mode: "lan" });
    expect(JSON.stringify(outcome.device)).not.toContain("token");
    const saved = devices.deviceCredentials(outcome.device.id)!;
    expect(saved.token).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.urls[0]).toBe(base);
    expect(devices.readPairing()?.claimedBy).toBeTruthy();
    // The host stores only a hash, and the token works there.
    expect(readFileSync(devices.files.paired, "utf8")).not.toContain(saved.token);
    expect(devices.authenticateDevice(new Request(base, { headers: { authorization: `Bearer ${saved.token}` } }))).toBeTruthy();
  });

  test("a code works once: after a claim the host no longer looks open", async () => {
    const { code } = open();
    expect((await pairing.pairWithCode({ mode: "lan", code, port: 1, candidates: [base] })).ok).toBe(true);
    expect(await pairing.pairWithCode({ mode: "lan", code, port: 1, candidates: [base] })).toEqual({ ok: false, reason: "not-found" });
  });

  test("a wrong code is rejected and leaves the host's pairing open", async () => {
    open();
    expect(await pairing.pairWithCode({ mode: "tailscale", code: "ZZZZ-ZZZZ", port: 1, address: base })).toEqual({ ok: false, reason: "rejected" });
    expect(devices.readPairing()?.claimedBy).toBeUndefined();
    expect(devices.readDevices()).toHaveLength(0);
  });

  test("an expired code is not offered at all", async () => {
    const pending = open();
    writeFileSync(devices.files.pairing, JSON.stringify({ ...pending, expiresAt: Date.now() - 1 }));
    expect(await pairing.pairWithCode({ mode: "lan", code: pending.code, port: 1, candidates: [base] })).toEqual({ ok: false, reason: "not-found" });
    expect(hits.some((h) => h.endsWith("/api/pair/claim"))).toBe(false);
  });

  test("a typed address is reached at the fixed pairing paths only", async () => {
    const { code } = open("tailscale");
    const outcome = await pairing.pairWithCode({ mode: "tailscale", code, port: 1, address: `127.0.0.1:${host.port}` });
    expect(outcome.ok).toBe(true);
    expect(new Set(hits)).toEqual(new Set(["GET /api/pair/info", "POST /api/pair/claim"]));
  });

  test("this server never pairs with itself", async () => {
    const { code } = open();
    const self = devices.serverId();
    expect(await pairing.pairWithCode({ mode: "lan", code, port: 1, candidates: [base], selfId: self })).toEqual({ ok: false, reason: "not-found" });
    expect(devices.readPairing()?.claimedBy).toBeUndefined();
  });

  test("redirects are never followed, so the code can't be sent elsewhere", async () => {
    const { code } = open();
    const outcome = await pairing.pairWithCode({ mode: "lan", code, port: 1, address: `http://127.0.0.1:${redirector.port}` });
    expect(outcome).toEqual({ ok: false, reason: "not-found" });
    expect(elsewhere).toEqual([]);
  });

  test("a cancelled search stops, and claims nothing", async () => {
    const { code } = open();
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await pairing.pairWithCode({ mode: "lan", code, port: 1, candidates: [base], signal: ctrl.signal })).toEqual({ ok: false, reason: "cancelled" });
    expect(devices.readPairing()?.claimedBy).toBeUndefined();
  });

  test("cancelling mid-scan returns promptly instead of waiting for slow hosts", async () => {
    // A host that accepts connections and never answers.
    const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const ctrl = new AbortController();
      const started = Date.now();
      setTimeout(() => ctrl.abort(), 100);
      const outcome = await pairing.pairWithCode({ mode: "lan", code: "ABCD-2345", port: 1, candidates: [`http://127.0.0.1:${silent.port}`], signal: ctrl.signal });
      expect(outcome).toEqual({ ok: false, reason: "cancelled" });
      expect(Date.now() - started).toBeLessThan(700);
    } finally {
      silent.stop(true);
    }
  });
});

test("attempts from Settings run one at a time, and a few a minute", () => {
  const first = pairing.beginAttempt(1_000_000);
  expect("end" in first).toBe(true);
  expect(pairing.beginAttempt(1_000_000)).toEqual({ busy: true });
  if ("end" in first) {
    first.end();
    first.end();
  }
  for (let i = 1; i < 10; i++) {
    const slot = pairing.beginAttempt(1_000_000 + i);
    if (!("end" in slot)) throw new Error(`attempt ${i} refused`);
    slot.end();
  }
  expect(pairing.beginAttempt(1_000_100)).toEqual({ limited: true, retryAfter: 60 });
  const later = pairing.beginAttempt(1_061_000);
  expect("end" in later).toBe(true);
  if ("end" in later) later.end();
});

afterAll(() => rmSync(devices.files.pairing, { force: true }));
