import { expect, test } from "bun:test";
import { warmCaches } from "../server/startupWarmup";

test("startup starts independent cache jobs together and waits for their useful results", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  const warm = warmCaches({
    usage: async () => { started.push("usage"); await blocked; },
    limits: async () => { started.push("limits"); release(); },
  });
  await warm;
  expect(started).toEqual(["usage", "limits"]);
});

test("a hung cache job cannot hold startup forever, and a late failure is observed", async () => {
  let reject!: (err: Error) => void;
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const start = Date.now();
    await warmCaches({ provider: () => new Promise((_, fail) => { reject = fail; }) }, 15);
    expect(Date.now() - start).toBeLessThan(500);
    reject(new Error("provider unavailable"));
    await Bun.sleep(0);
    expect(warnings.length).toBe(1);
  } finally { console.warn = original; }
});
