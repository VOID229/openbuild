import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const hasPython = process.platform === "linux" && Bun.spawnSync(["which", "python3"]).exitCode === 0;
// Exercise the real CLI and prompt in a PTY, with a copied CLI, stubbed release
// installer, isolated data and fake systemctl. No real update or lifecycle action.
const driver = String.raw`
import json, os, pty, subprocess, sys, time
interactive = sys.argv[3] == 'tty'
master, slave = pty.openpty() if interactive else (None, subprocess.DEVNULL)
if interactive: os.set_blocking(master, False)
child = subprocess.Popen([sys.argv[1], sys.argv[2], 'update'] + sys.argv[5:], stdin=slave, stdout=slave if interactive else subprocess.PIPE, stderr=slave if interactive else subprocess.STDOUT)
if interactive: os.close(slave)
output = b''
sent = False
try:
    start = time.monotonic()
    while time.monotonic() - start < 5:
        if interactive:
            try: output += os.read(master, 65536)
            except OSError: pass
            if not sent and b'Restart now?' in output:
                os.write(master, bytes.fromhex(sys.argv[4]))
                sent = True
        if child.poll() is not None: break
        time.sleep(0.005)
    if not interactive and child.poll() is not None: output += child.stdout.read()
    print(json.dumps({'code': child.poll(), 'output': output.decode(errors='replace')}))
finally:
    if child.poll() is None: child.kill()
    child.wait()
    if interactive: os.close(master)
`;

for (const scenario of [
  { name: "yes", input: "790a", restart: true },
  { name: "Enter", input: "0a", restart: true },
  { name: "no", input: "6e0a" },
  { name: "EOF", input: "04" },
  { name: "noninteractive", noninteractive: true },
  { name: "noninteractive --yes", noninteractive: true, flag: "--yes" },
  { name: "--yes still asks", input: "6e0a", flag: "--yes" },
  { name: "-y still asks", input: "6e0a", flag: "-y" },
  { name: "failed update", outcome: "fail" },
  { name: "no update", outcome: "current" },
  { name: "unsafe service", input: "790a", unsafe: true },
  { name: "restart fails", input: "790a", restart: true, failRestart: true },
]) test.skipIf(!hasPython)(`update restart: ${scenario.name}`, () => {
  const temp = mkdtempSync(join(tmpdir(), "ob-cli-update-"));
  try {
    mkdirSync(join(temp, "bin"));
    const cli = join(temp, "bin/openbuild.ts");
    // Resolve dependencies against the source checkout except the installer stub.
    const source = readFileSync(join(root, "bin/openbuild.ts"), "utf8").replace(/from "(\.[^"]+)"/g, (_, path: string) =>
      `from ${JSON.stringify(path === "../server/releases" ? join(temp, "releases.ts") : resolve(root, "bin", path))}`);
    writeFileSync(cli, source);
    writeFileSync(join(temp, "releases.ts"), `
export const checkRelease = async () => ({ available: false });
export const releaseTrack = () => 'stable';
export const setReleaseTrack = () => {};
export async function installRelease() {
  if (process.env.OUTCOME === 'fail') throw new Error('fixture install failed');
  return { installed: process.env.OUTCOME !== 'current', current: 'v1.2.3', track: 'stable' };
}
`);
    const calls = join(temp, "calls");
    writeFileSync(calls, "");
    const systemctl = join(temp, "systemctl");
    writeFileSync(systemctl, `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
if [ "$2" = show ]; then
  printf '%s\\n' 'LoadState=loaded' 'ActiveState=active' 'ExecStart=/bin/bun ${temp}/server/index.ts' 'KillMode=${scenario.unsafe ? "control-group" : "process"}'
elif [ "$2" = restart ] && [ "$FAIL_RESTART" = yes ]; then
  echo 'fixture restart failed' >&2
  exit 1
fi
`);
    chmodSync(systemctl, 0o755);
    const child = Bun.spawnSync(["python3", "-c", driver, process.execPath, cli, scenario.noninteractive ? "pipe" : "tty", scenario.input ?? "", ...(scenario.flag ? [scenario.flag] : [])], {
      env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, OPENCHAT_DATA_DIR: join(temp, "data"), XDG_CONFIG_HOME: join(temp, "config"), CALL_LOG: calls, OUTCOME: scenario.outcome ?? "installed", FAIL_RESTART: scenario.failRestart ? "yes" : "no", NO_COLOR: "1", TERM: "dumb" },
      timeout: 8000,
    });
    expect(child.exitCode).toBe(0);
    const actual = JSON.parse(child.stdout.toString());
    expect(actual.code).toBe(scenario.outcome === "fail" || scenario.unsafe || scenario.failRestart ? 1 : 0);
    const log = readFileSync(calls, "utf8");
    expect(log.includes("--user restart openbuild.service")).toBe(!!scenario.restart);
    if (scenario.outcome) {
      expect(actual.output).not.toContain("Restart now?");
      expect(actual.output).not.toContain("Changes will take effect");
      expect(actual.output).toContain(scenario.outcome === "fail" ? "fixture install failed" : "is up to date");
    } else {
      expect(actual.output.includes("Restart now? [Y/n]")).toBe(!scenario.noninteractive);
      if (!scenario.restart && !scenario.unsafe) expect(actual.output).toContain("Changes will take effect on the next restart.");
    }
    if (scenario.unsafe) expect(actual.output).toContain("KillMode=process");
    if (scenario.failRestart) expect(actual.output).toContain("fixture restart failed");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
