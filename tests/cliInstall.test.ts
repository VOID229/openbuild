import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("installation exposes openbuild and ob as the same package CLI", () => {
  const root = realpathSync(join(import.meta.dir, ".."));
  const temp = mkdtempSync(join(tmpdir(), "openbuild-cli-install-"));
  try {
    const install = join(temp, "bun");
    const result = Bun.spawnSync([process.execPath, "run", "cli:install"], {
      cwd: root,
      env: { ...process.env, BUN_INSTALL: install },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    for (const name of ["openbuild", "ob"]) {
      expect(realpathSync(join(install, "bin", name))).toBe(join(root, "bin", "openbuild.ts"));
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
