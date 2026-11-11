import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// A stand-in for `codex app-server daemon version`, shaped like codex-cli 0.166.0's output.
const directory = mkdtempSync(join(tmpdir(), "ob-codex-daemon-"));
const fake = join(directory, "codex");
const log = join(directory, "log");
writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(process.env.CODEX_DAEMON_LOG, argv.join(' ') + '\n');
if (process.env.CODEX_DAEMON_FAIL) { process.stderr.write(process.env.CODEX_DAEMON_FAIL + '\n'); process.exit(1); }
if (argv.join(' ') === 'app-server daemon version') console.log(JSON.stringify({ status: 'running', managedCodexPath: '/x', managedCodexVersion: null, socketPath: '/s', cliVersion: '0.166.0', appServerVersion: '0.163.0' }));
else if (argv[2] === 'enable-remote-control' || argv[2] === 'disable-remote-control') {
  // codex-cli 0.167.0 keeps the choice in <CODEX_HOME>/app-server-daemon/settings.json.
  mkdirSync(process.env.CODEX_HOME + '/app-server-daemon', { recursive: true });
  writeFileSync(process.env.CODEX_HOME + '/app-server-daemon/settings.json', JSON.stringify({ remoteControlEnabled: argv[2] === 'enable-remote-control', shutdownGraceSeconds: 30 }));
}
else process.exit(2);
`);
chmodSync(fake, 0o700);
const original = { CODEX_BIN: process.env.CODEX_BIN, CODEX_DAEMON_LOG: process.env.CODEX_DAEMON_LOG, CODEX_HOME: process.env.CODEX_HOME };
Object.assign(process.env, { CODEX_BIN: fake, CODEX_DAEMON_LOG: log, CODEX_HOME: join(directory, "home") });
const { daemonStatus, setDaemonRemoteControl } = await import("../server/codex/install");
afterAll(() => { for (const [k, v] of Object.entries(original)) if (v === undefined) delete process.env[k]; else process.env[k] = v; rmSync(directory, { recursive: true, force: true }); });

test("Codex Remote Control is reported from the machine's daemon, read-only", async () => {
  expect(await daemonStatus()).toMatchObject({ installed: true, status: "running", version: "0.163.0", remoteControl: false });
  // Only the read-only status command: never start, pair or change remote control.
  expect(readFileSync(log, "utf8")).toBe("app-server daemon version\n");
  process.env.CODEX_DAEMON_FAIL = "app-server daemon is not running";
  try {
    expect(await daemonStatus()).toMatchObject({ installed: true, error: "app-server daemon is not running" });
  } finally { delete process.env.CODEX_DAEMON_FAIL; }
});

test("Settings → General switches the daemon's Remote Control for the whole machine", async () => {
  writeFileSync(log, "");
  expect(await setDaemonRemoteControl(true)).toMatchObject({ installed: true, status: "running", remoteControl: true });
  expect(await daemonStatus()).toMatchObject({ remoteControl: true });
  expect(await setDaemonRemoteControl(false)).toMatchObject({ remoteControl: false });
  expect(readFileSync(log, "utf8").split("\n").filter((l) => l.includes("remote-control"))).toEqual(["app-server daemon enable-remote-control", "app-server daemon disable-remote-control"]);
  // A failed switch reports why, with the state as it stands.
  process.env.CODEX_DAEMON_FAIL = "not signed in";
  try {
    expect(await setDaemonRemoteControl(true)).toMatchObject({ installed: true, remoteControl: false, error: "not signed in" });
  } finally { delete process.env.CODEX_DAEMON_FAIL; }
});
