import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedemptionLedger } from "../server/usage/redemptionLedger";
import { createRedemptionClient } from "../shared/redemptionClient";
import { normalizeResetCredits } from "../shared/usage";
import { requestUsage } from "../server/usage/remoteRequest";

let root: string;
const op = "operation_00000001";
const op2 = "operation_00000002";
const network = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("LIVE NETWORK FORBIDDEN"); }) as unknown as typeof fetch);
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "redemption-safety-")); });
afterAll(async () => { network.mockRestore(); await rm(root, { recursive: true, force: true }); });
const ledger = (name: string) => new RedemptionLedger(() => join(root, name));

test("provider and browser-to-paired route integration runs with fake accounts/CLI/transport only", async () => {
  const child = Bun.spawn([process.execPath, new URL("./redemptionProviderFixture.ts", import.meta.url).pathname], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("isolated provider and route checks passed");
});

test("completed response is durable and concurrent duplicates consume once", async () => {
  let calls = 0;
  const consume = async () => { calls++; await Bun.sleep(5); return { outcome: "reset" as const }; };
  const l = ledger("complete");
  expect(await Promise.all([l.run("acct", op, consume), l.run("acct", op, consume)])).toEqual([{ outcome: "reset" }, { outcome: "reset" }]);
  expect(await ledger("complete").run("acct", op, consume)).toEqual({ outcome: "reset" });
  expect(calls).toBe(1);
});

test("response loss blocks new operations and restart retries original pinned grant and identity", async () => {
  const l = ledger("uncertain");
  await expect(l.run("acct", op, async context => {
    await context.pin({ creditId: "grant-original", organization: "org" });
    throw new Error("provider applied reset but response lost");
  })).rejects.toThrow("response lost");
  const restarted = ledger("uncertain");
  let freshCalls = 0;
  await expect(restarted.run("acct", op2, async () => { freshCalls++; return { outcome: "reset" }; })).rejects.toThrow("earlier reset");
  expect(freshCalls).toBe(0);
  expect(await restarted.run("acct", op, async ({ attempt }) => {
    expect(attempt.operationId).toBe(op);
    expect(attempt.grant).toEqual({ creditId: "grant-original", organization: "org" });
    return { outcome: "alreadyRedeemed" };
  })).toEqual({ outcome: "alreadyRedeemed" });
});

test("different operation IDs on one account serialize", async () => {
  let active = 0, peak = 0;
  const consume = async () => { peak = Math.max(peak, ++active); await Bun.sleep(10); active--; return { outcome: "nothingToReset" as const }; };
  const l = ledger("serialized");
  await Promise.all([l.run("acct", op, consume), l.run("acct", op2, consume)]);
  expect(peak).toBe(1);
});

test("invalid identity, corrupt disk and cross-process lock fail closed", async () => {
  const l = ledger("closed");
  let calls = 0;
  const consume = async () => { calls++; return { outcome: "reset" as const }; };
  await expect(l.run("acct", "", consume)).rejects.toThrow("operationId");
  await l.run("acct", op, consume);
  const dir = join(root, "closed");
  const file = (await readdir(dir)).find(f => f.endsWith(".json"))!;
  await writeFile(join(dir, file), "broken");
  await expect(l.run("acct", op2, consume)).rejects.toThrow();
  await mkdir(join(dir, file + ".lock"));
  await expect(l.run("acct", op2, consume)).rejects.toThrow("locked");
  expect(calls).toBe(1);
});

test("POST HTTP errors and lost/invalid responses never fail over addresses; GET still can", async () => {
  for (const response of [() => Response.json({ error: "provider uncertain" }, { status: 500 }), () => new Response("not json"), () => { throw new Error("lost"); }]) {
    network.mockImplementation((async () => response()) as unknown as typeof fetch);
    const before = network.mock.calls.length;
    await expect(requestUsage(["https://one.invalid", "https://two.invalid"], "/reset", "fake", 100, { method: "POST" })).rejects.toThrow();
    expect(network.mock.calls.length - before).toBe(1);
  }
  let reads = 0;
  network.mockImplementation((async () => ++reads === 1 ? new Response("", { status: 500 }) : Response.json({ ok: true })) as unknown as typeof fetch);
  expect(await requestUsage<{ ok: boolean }>(["https://one.invalid", "https://two.invalid"], "/usage", "fake")).toEqual({ ok: true });
  expect(reads).toBe(2);
});

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
}

test("browser state survives popover subscribers and concurrent clicks; reload keeps identity and machine", async () => {
  const storage = memoryStorage();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const bodies: unknown[] = [];
  const first = createRedemptionClient(() => storage, async body => { bodies.push(body); await gate; throw new Error("lost response"); }, () => op);
  const unsubscribe = first.subscribe(() => {});
  const run = first.run("acct", "paired-original");
  unsubscribe(); // popover closed
  expect(first.snapshot("acct").busy).toBe(true);
  await first.run("acct", "paired-other");
  expect(bodies.length).toBe(1);
  release(); await run;
  const reloaded = createRedemptionClient(() => storage, async body => { bodies.push(body); return { outcome: "reset" }; }, () => op2);
  await reloaded.run("acct", "paired-other");
  expect(bodies).toEqual([{ id: "acct", operationId: op, machine: "paired-original" }, { id: "acct", operationId: op, machine: "paired-original" }]);
  await reloaded.run("acct", "paired-other");
  expect(bodies.length).toBe(2);
});

test("browser refuses to mutate without durable storage", async () => {
  let calls = 0;
  const client = createRedemptionClient(() => { throw new Error("storage denied"); }, async () => { calls++; return { outcome: "reset" }; }, () => op);
  await client.run("acct");
  expect(calls).toBe(0);
  expect(client.snapshot("acct").error).toContain("storage denied");
  expect(normalizeResetCredits(3)).toEqual({ available: 3 });
  expect(normalizeResetCredits({ available: 2, expiresAt: 42 })).toEqual({ available: 2, expiresAt: 42 });
});
