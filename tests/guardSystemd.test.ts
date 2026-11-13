import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The preload runs in every test process. What it makes has to go when the process does.
test("a test process leaves no temp directories behind, and clears stale ones", () => {
  const temp = mkdtempSync(join(tmpdir(), "openbuild-guard-test-"));
  try {
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const name of ["openbuild-test-data-stale", "openbuild-systemctl-guard-stale"]) {
      mkdirSync(join(temp, name));
      utimesSync(join(temp, name), old, old);
    }
    mkdirSync(join(temp, "openbuild-test-data-recent"));
    mkdirSync(join(temp, "unrelated-stale"));
    utimesSync(join(temp, "unrelated-stale"), old, old);

    // A real `bun test` run from the repository, so bunfig.toml's preload is what's under test.
    const file = join(temp, "probe.test.ts");
    writeFileSync(file, `
      import { expect, test } from "bun:test";
      import { existsSync } from "node:fs";
      test("the guard is in place while tests run", () => {
        const guard = process.env.PATH!.split(":")[0]!;
        expect(guard.startsWith(${JSON.stringify(temp)}) && existsSync(guard + "/systemctl")).toBe(true);
        expect(process.env.OPENCHAT_DATA_DIR!.startsWith(${JSON.stringify(temp)}) && existsSync(process.env.OPENCHAT_DATA_DIR!)).toBe(true);
      });
    `);
    const { OPENCHAT_DATA_DIR: _data, ...rest } = process.env;
    const result = Bun.spawnSync([process.execPath, "test", file], { cwd: join(import.meta.dir, ".."), env: { ...rest, TMPDIR: temp }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    rmSync(file);
    expect(readdirSync(temp).sort()).toEqual(["openbuild-test-data-recent", "unrelated-stale"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
