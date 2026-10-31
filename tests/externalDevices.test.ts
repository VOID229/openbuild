import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("external devices, on a throwaway data directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-external-"));
  try {
    const run = Bun.spawnSync(["bun", "test", "./tests/externalDevices.scenario.ts"], {
      env: { ...process.env, OPENCHAT_DATA_DIR: dir, OPENBUILD_EXTERNAL_SCENARIO: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the destructive scenario refuses a flag with the wrong data-directory variable", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-device-sentinel-"));
  const file = join(dir, "devices.json");
  const original = JSON.stringify([{ id: "keep-paired", token: "keep-token" }]);
  writeFileSync(file, original);
  try {
    const run = Bun.spawnSync([process.execPath, "test", "./tests/externalDevices.scenario.ts"], {
      env: { ...process.env, OPENCHAT_DATA_DIR: dir, OPENBUILD_DATA_DIR: dir, OPENBUILD_EXTERNAL_SCENARIO: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("requires a throwaway");
    expect(readFileSync(file, "utf8")).toBe(original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
