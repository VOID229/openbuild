import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageLimits, UsageReport } from "../shared/usage";

const dir = mkdtempSync(join(tmpdir(), "openbuild-external-"));
const previous = process.env.OPENCHAT_DATA_DIR;
process.env.OPENCHAT_DATA_DIR = dir;
const devices = await import("../server/devices");
const { machineLimits, machineReports } = await import("../server/usage/machines");
const remoteUsage = await import("../server/usage/remoteRequest");

const device = (id: string, external?: boolean) => ({ id, name: id, mode: "lan" as const, urls: [`http://${id}`], token: "t", ...(external && { external }) });
const limit = (provider: UsageLimits["provider"], id: string): UsageLimits => ({ provider, id, windows: [{ id: "w", label: "Week", kind: "weekly", usedPercent: 10 }], asOf: Date.now() });

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.OPENCHAT_DATA_DIR;
  else process.env.OPENCHAT_DATA_DIR = previous;
});

beforeEach(() => {
  for (const d of devices.readDevices()) devices.removeDevice(d.id);
  (globalThis as { usageRemote?: Map<string, unknown> }).usageRemote = new Map();
});

describe("external devices", () => {
  test("the mark can be cleared and survives pairing again", () => {
    devices.addDevice(device("friend"));
    expect(devices.setDeviceExternal("friend", true)).toBe(true);
    devices.addDevice({ ...device("friend"), token: "new" });
    expect(devices.deviceCredentials("friend")).toMatchObject({ token: "new", external: true });
    devices.setDeviceExternal("friend", false);
    expect(devices.deviceCredentials("friend")?.external).toBeUndefined();
    expect(devices.setDeviceExternal("nobody", true)).toBe(false);
  });

  test("usage never asks an external device", async () => {
    devices.addDevice(device("friend", true));
    const request = spyOn(remoteUsage, "requestUsage");
    const { machines, reports } = await machineReports("7d", "UTC", false, async () => ({ generatedAt: 1 }) as UsageReport);
    expect(machines.map((m) => m.id)).toEqual(["local"]);
    expect(reports).toHaveLength(1);
    expect(request).not.toHaveBeenCalled();
    request.mockRestore();
  });

  test("limits are labelled, and Cursor on an external device stays apart from the user's", async () => {
    devices.addDevice(device("friend", true));
    const request = spyOn(remoteUsage, "requestUsage").mockImplementation((async () => ({
      providers: [limit("claude", "claude:theirs"), limit("claude", "claude:shared"), limit("cursor", "cursor:cursor")],
      checkedAt: Date.now(),
    })) as never);
    await machineLimits(false, async () => []);
    await Bun.sleep(0);
    const report = await machineLimits(false, async () => [limit("claude", "claude:shared"), limit("cursor", "cursor:cursor")]);
    request.mockRestore();
    const by = (id: string) => report.providers.find((p) => p.id === id);
    expect(by("claude:theirs")).toMatchObject({ external: true, machine: "friend", machineId: "friend" });
    expect(by("claude:shared")?.external).toBeUndefined();
    expect(by("cursor:cursor")?.external).toBeUndefined();
    expect(by("cursor:cursor@friend")?.external).toBe(true);
    expect(report.machines?.find((m) => m.id === "friend")?.external).toBe(true);
  });
});
