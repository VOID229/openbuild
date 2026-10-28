import { describe, expect, test } from "bun:test";
import { CommandCache } from "../shared/commandCache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("command discovery cache", () => {
  test("shares cold lookups, then serves warm results without loading again", async () => {
    const cache = new CommandCache<string[]>(100);
    const work = deferred<string[]>();
    let calls = 0;
    const load = () => { calls++; return work.promise; };
    const first = cache.get("a", load);
    expect(cache.get("a", load)).toBe(first);
    work.resolve(["commit"]);
    expect(await first).toEqual(["commit"]);
    expect(await cache.get("a", load)).toEqual(["commit"]);
    expect(calls).toBe(1);
  });

  test("expired results stay available while one background refresh runs", async () => {
    let now = 0;
    const cache = new CommandCache<string[]>(100, 64, () => now);
    await cache.get("a", async () => ["old"]);
    now = 101;
    const work = deferred<string[]>();
    let calls = 0;
    const load = () => { calls++; return work.promise; };
    expect(await cache.get("a", load)).toEqual(["old"]);
    expect(await cache.get("a", load)).toEqual(["old"]);
    const fresh = cache.get("a", load, false);
    expect(cache.peek("a")).toEqual(["old"]);
    work.resolve(["new"]);
    expect(await fresh).toEqual(["new"]);
    expect(cache.peek("a")).toEqual(["new"]);
    expect(calls).toBe(1);
  });

  test("failed refresh retains good data and backs off; cold failures can retry", async () => {
    let now = 0;
    const cache = new CommandCache<string[]>(100, 64, () => now);
    const fail = async (): Promise<string[]> => { throw new Error("offline"); };
    await expect(cache.get("cold", fail)).rejects.toThrow("offline");
    expect(await cache.get("cold", async () => ["retry"])).toEqual(["retry"]);
    now = 101;
    await expect(cache.get("cold", fail, false)).rejects.toThrow("offline");
    expect(await cache.get("cold", fail)).toEqual(["retry"]);
    now += 10_001;
    expect(await cache.get("cold", async () => ["recovered"], false)).toEqual(["recovered"]);
  });

  test("isolates keys, bounds entries, and never lets an invalidated request repopulate", async () => {
    const cache = new CommandCache<string[]>(100, 2);
    await cache.get("device-a:project", async () => ["a"]);
    await cache.get("device-b:project", async () => ["b"]);
    expect(cache.peek("device-a:project")).toEqual(["a"]);
    await cache.get("third", async () => []);
    expect(cache.peek("device-a:project")).toBeUndefined();
    const old = deferred<string[]>();
    const pending = cache.get("pending", () => old.promise);
    cache.clear();
    await cache.get("pending", async () => ["current"]);
    old.resolve(["obsolete"]);
    await pending;
    expect(cache.peek("pending")).toEqual(["current"]);
  });
});
