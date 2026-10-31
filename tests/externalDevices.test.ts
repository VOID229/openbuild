import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
