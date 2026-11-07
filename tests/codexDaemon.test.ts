import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// A stand-in for `codex app-server daemon version`, shaped like codex-cli 0.166.0's output.
const directory = mkdtempSync(join(tmpdir(), "ob-codex-daemon-"));
const fake = join(directory, "codex");
const log = join(directory, "log");
writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(process.env.CODEX_DAEMON_LOG, argv.join(' ') + '\n');
if (process.env.CODEX_DAEMON_FAIL) { process.stderr.write(process.env.CODEX_DAEMON_FAIL + '\n'); process.exit(1); }
if (argv.join(' ') === 'app-server daemon version') console.log(JSON.stringify({ status: 'running', managedCodexPath: '/x', managedCodexVersion: null, socketPath: '/s', cliVersion: '0.166.0', appServerVersion: '0.163.0' }));
else process.exit(2);
`);
chmodSync(fake, 0o700);
const original = { CODEX_BIN: process.env.CODEX_BIN, CODEX_DAEMON_LOG: process.env.CODEX_DAEMON_LOG };
Object.assign(process.env, { CODEX_BIN: fake, CODEX_DAEMON_LOG: log });
const { daemonStatus } = await import("../server/codex/install");
afterAll(() => { for (const [k, v] of Object.entries(original)) if (v === undefined) delete process.env[k]; else process.env[k] = v; rmSync(directory, { recursive: true, force: true }); });

test("Codex Remote Control is reported from the machine's daemon, read-only", async () => {
  expect(await daemonStatus()).toMatchObject({ installed: true, status: "running", version: "0.163.0" });
  // Only the read-only status command: never start, pair or change remote control.
  expect(readFileSync(log, "utf8")).toBe("app-server daemon version\n");
  process.env.CODEX_DAEMON_FAIL = "app-server daemon is not running";
  try {
    expect(await daemonStatus()).toMatchObject({ installed: true, error: "app-server daemon is not running" });
  } finally { delete process.env.CODEX_DAEMON_FAIL; }
});
