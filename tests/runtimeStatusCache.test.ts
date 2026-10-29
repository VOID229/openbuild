import { expect, test } from "bun:test";
import { cachedRuntimeStatuses, loadRuntimeStatuses } from "../src/lib/runtimeStatus";

const statuses = (version: string) => Object.fromEntries(["pi", "durable", "claude", "codex", "cursor", "fx", "opencode"].map((id) => [id, { installed: true, version, install: "test", updateAvailable: false }]));

test("runtime status shares startup requests and caches per device; manual checks bypass cache", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url));
    await gate;
    return Response.json({ runtimes: statuses(String(calls.length)) });
  }) as typeof fetch;
  try {
    const first = loadRuntimeStatuses(false, "cache-test-a");
    const second = loadRuntimeStatuses(false, "cache-test-a");
    expect(first).toBe(second);
    expect(calls).toHaveLength(1);
    release();
    await first;
    expect(cachedRuntimeStatuses("cache-test-a")?.pi.version).toBe("1");
    await loadRuntimeStatuses(false, "cache-test-a");
    expect(calls).toHaveLength(1);
    await loadRuntimeStatuses(true, "cache-test-a");
    expect(calls[1]).toBe("/api/devices/cache-test-a/api/runtimes/status?fresh=1");
    await loadRuntimeStatuses(false, "cache-test-b");
    expect(calls).toHaveLength(3);
    expect(cachedRuntimeStatuses("cache-test-a")?.pi.version).toBe("2");
    expect(cachedRuntimeStatuses("cache-test-b")?.pi.version).toBe("3");
  } finally { globalThis.fetch = original; }
});

test("persisted status paints synchronously after a reload and remains available when stale", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>([["openbuild:runtime-status:v1:cache-test-reload", JSON.stringify({ at: 1, statuses: statuses("persisted") })]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null } });
  try {
    expect(cachedRuntimeStatuses("cache-test-reload")?.codex.version).toBe("persisted");
    values.set("openbuild:runtime-status:v1:cache-test-corrupt", "broken json");
    expect(cachedRuntimeStatuses("cache-test-corrupt")).toBeUndefined();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("failed manual refresh keeps last known runtime status", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ runtimes: statuses("saved") })) as unknown as typeof fetch;
    await loadRuntimeStatuses(false, "cache-test-offline");
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await expect(loadRuntimeStatuses(true, "cache-test-offline")).rejects.toThrow("offline");
    expect(cachedRuntimeStatuses("cache-test-offline")?.pi.version).toBe("saved");
  } finally { globalThis.fetch = original; }
});

test("manual check queued behind a preload still requests fresh status", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url));
    await gate;
    return Response.json({ runtimes: statuses("ok") });
  }) as typeof fetch;
  try {
    const preload = loadRuntimeStatuses(false, "cache-test-race");
    const refresh = loadRuntimeStatuses(true, "cache-test-race");
    expect(calls).toHaveLength(1);
    release();
    await Promise.all([preload, refresh]);
    expect(calls).toEqual(["/api/devices/cache-test-race/api/runtimes/status", "/api/devices/cache-test-race/api/runtimes/status?fresh=1"]);
  } finally { globalThis.fetch = original; }
});
