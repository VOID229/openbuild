import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { systemdService, type Runner } from "../bin/systemd";

const root = resolve(import.meta.dir, "..");
const properties = (state = "active", path = `${root}/server/index.ts`, killMode = "control-group") =>
  `LoadState=loaded\nActiveState=${state}\nExecStart={ path=/bin/bun ; argv[]=/bin/bun ${path} ; }\nKillMode=${killMode}`;
const runner = (out: string, ok = true): Runner => () => ({ ok, out, err: "" });

test("systemd discovery only adopts this installation's loaded Linux user service", () => {
  expect(systemdService(root, runner(properties()), "linux")).toEqual({ active: true, workerSurvives: false });
  expect(systemdService(root, runner(properties("inactive", undefined, "process")), "linux")).toEqual({ active: false, workerSurvives: true });
  expect(systemdService(root, runner(properties("active", `${root}/bin/openbuild.ts`)), "linux")).toBeDefined();
  expect(systemdService(root, runner(properties("active", "/other/server/index.ts")), "linux")).toBeUndefined();
  expect(systemdService(root, runner(properties("active", `${root}/server/index.ts.backup`)), "linux")).toBeUndefined();
  expect(systemdService(root, runner("LoadState=not-found"), "linux")).toBeUndefined();
  expect(systemdService(root, runner("", false), "linux")).toBeUndefined();
  expect(systemdService(root, () => { throw new Error("must not call systemctl on macOS"); }, "darwin")).toBeUndefined();
});

// All lifecycle operations below use a fake systemctl and isolated data. Never
// stop or restart a developer's actual service while running the test suite.
test.skipIf(process.platform !== "linux")("CLI routes service lifecycle commands and protects detached workers", () => {
  const temp = mkdtempSync(join(tmpdir(), "openbuild-systemd-"));
  try {
    const log = join(temp, "calls");
    const executable = join(temp, "systemctl");
    writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
if [ "$2" = show ]; then
  printf '%s\\n' "$SERVICE_PROPERTIES"
  exit 0
fi
if [ "$FAIL_ACTION" = yes ]; then
  echo 'permission denied' >&2
  exit 1
fi
if [ "$2" = status ]; then echo 'OpenBuild active (running)'; fi
`);
    chmodSync(executable, 0o755);
    function cli(args: string[], state = "active", fail = false, killMode = "process") {
      writeFileSync(log, "");
      const child = Bun.spawnSync([process.execPath, join(root, "bin/openbuild.ts"), ...args], {
        env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, OPENCHAT_DATA_DIR: join(temp, "data"), CALL_LOG: log, SERVICE_PROPERTIES: properties(state, undefined, killMode), FAIL_ACTION: fail ? "yes" : "no" },
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000,
      });
      return { code: child.exitCode, output: child.stdout.toString() + child.stderr.toString(), calls: readFileSync(log, "utf8") };
    }
    for (const command of ["start", "stop", "status"]) {
      const result = cli([command]);
      expect(result.code).toBe(0);
      expect(result.calls).toContain(`--user ${command} openbuild.service`);
    }
    for (const flag of [undefined, "--yes", "-y"]) {
      const result = cli(flag ? ["restart", flag] : ["restart"]);
      expect(result.code).toBe(0);
      expect(result.calls).toContain("--user restart openbuild.service");
    }
    expect(cli(["restart"], "inactive").code).toBe(0);
    for (const killMode of ["control-group", "mixed", "none"]) {
      for (const command of ["stop", "restart"]) {
        const refused = cli([command, "--yes"], "active", false, killMode);
        expect(refused.code).toBe(1);
        expect(refused.output).toContain("KillMode=process");
        expect(refused.output).toContain("not updated automatically");
        expect(refused.calls).not.toContain(`--user ${command} openbuild.service`);
      }
    }
    const all = cli(["stop", "--all"], "active", false, "control-group");
    expect(all.code).toBe(0);
    expect(all.calls).toContain("--user stop openbuild.service");
    expect(cli(["restart", "--all"]).code).toBe(1);
    const mode = cli(["start", "tailscale"]);
    expect(mode.code).toBe(1);
    expect(mode.calls).not.toContain("--user start");
    const failed = cli(["restart", "--yes"], "active", true);
    expect(failed.code).toBe(1);
    expect(failed.output).toContain("permission denied");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
