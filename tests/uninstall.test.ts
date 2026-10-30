import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { removeInstallation, uninstallPlan } from "../bin/uninstall";

test("uninstall preserves source and unrelated links, removes marked apps and their data", () => {
  const temp = mkdtempSync(join(tmpdir(), "ob-uninstall-"));
  const previous = process.env.BUN_INSTALL;
  try {
    process.env.BUN_INSTALL = join(temp, "bun");
    const data = join(temp, "data"), root = join(data, "app"), source = join(temp, "source");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "bin")); mkdirSync(source);
    writeFileSync(join(root, "bin", "openbuild.ts"), "");
    expect(() => uninstallPlan(root, data)).toThrow("Unsafe data");
    writeFileSync(join(root, ".git", "openbuild-installed"), root + "\n");
    mkdirSync(join(temp, "bun", "bin"), { recursive: true });
    symlinkSync(join(root, "bin", "openbuild.ts"), join(temp, "bun", "bin", "ob"));
    symlinkSync(source, join(temp, "bun", "bin", "openbuild"));
    const plan = uninstallPlan(root, data);
    expect(plan.links).toEqual([join(temp, "bun", "bin", "ob")]);
    removeInstallation(plan);
    expect(existsSync(data)).toBe(false);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(temp, "bun", "bin", "openbuild"))).toBe(true);
    mkdirSync(data);
    removeInstallation(uninstallPlan(source, data));
    expect(existsSync(source)).toBe(true);
    for (const dangerous of ["/", homedir(), source]) expect(() => uninstallPlan(source, dangerous)).toThrow();
  } finally {
    if (previous === undefined) delete process.env.BUN_INSTALL; else process.env.BUN_INSTALL = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});

test("uninstall refuses piped input and --yes without deleting data", () => {
  const temp = mkdtempSync(join(tmpdir(), "ob-uninstall-cli-"));
  try {
    writeFileSync(join(temp, "keep.txt"), "keep");
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "bin", "openbuild.ts"), "uninstall", "--yes"], {
      env: { ...process.env, OPENCHAT_DATA_DIR: temp, OPENBUILD_SYSTEMD: "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("terminal");
    expect(existsSync(join(temp, "keep.txt"))).toBe(true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
