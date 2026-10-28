import { describe, expect, test } from "bun:test";
import { discoverPairing, probePairing } from "../bin/pairDiscovery";

describe("pairing discovery", () => {
  test("yields a host before slow probes finish and cancels on success", async () => {
    const signals: AbortSignal[] = [];
    const discovery = discoverPairing(["slow", "host", "also-slow"], async (base, signal) => {
      signals.push(signal);
      if (base === "host") return { base, name: "MacBook" };
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
    });
    expect((await discovery.next()).value).toEqual({ base: "host", name: "MacBook" });
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    await discovery.return(undefined);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  test("refills free slots without waiting for the slowest probe", async () => {
    const started: string[] = [];
    const discovery = discoverPairing(["slow", "empty", "host"], async (base, signal) => {
      started.push(base);
      if (base === "slow") return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
      return base === "host" ? { base, name: base } : undefined;
    }, 2);
    expect((await discovery.next()).value?.base).toBe("host");
    expect(started).toEqual(["slow", "empty", "host"]);
    await discovery.return(undefined);
  });

  test("bounds concurrency, tolerates failures and deduplicates addresses and device IDs", async () => {
    let active = 0;
    let peak = 0;
    const visited: string[] = [];
    const found = [];
    for await (const candidate of discoverPairing(["a", "a", "bad", "b", "legacy"], async (base) => {
      visited.push(base);
      peak = Math.max(peak, ++active);
      await Bun.sleep(1);
      active--;
      if (base === "bad") throw new Error("unreachable");
      return { base, name: base, deviceId: base === "legacy" ? undefined : "same-device" };
    }, 2)) found.push(candidate);
    expect(peak).toBeLessThanOrEqual(2);
    expect(visited.filter((base) => base === "a")).toHaveLength(1);
    expect(found.map((candidate) => candidate.base)).toEqual(["a", "legacy"]);
  });

  test("empty scans finish normally", async () => {
    expect((await discoverPairing([]).next()).done).toBe(true);
    expect((await discoverPairing(["missing"], async () => undefined).next()).done).toBe(true);
  });

  test("real HTTP probing handles waiting, claimed and cancelled hosts", async () => {
    let claimed = false;
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ pending: true, claimed, name: "MacBook", deviceId: "mac" }),
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      expect(await probePairing(base)).toEqual({ base, name: "MacBook", deviceId: "mac", machine: undefined });
      claimed = true;
      expect(await probePairing(base)).toBeUndefined();
      expect(await probePairing(base, AbortSignal.abort())).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});
