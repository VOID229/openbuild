// Test preload: the suite must never reach a developer's real systemd user
// service. Put a refusing `systemctl` first on PATH; tests that exercise the
// CLI prepend their own fake, which takes precedence over this one.
import { afterAll } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set this before any test imports server modules that capture dataDir(). A misspelled
// override must never let a test fall back to the developer's live database or pairings.
const DATA = "openbuild-test-data-", GUARD = "openbuild-systemctl-guard-";
const made: string[] = [];
if (!process.env.OPENCHAT_DATA_DIR) {
  made.push(process.env.OPENCHAT_DATA_DIR = mkdtempSync(join(tmpdir(), DATA)));
}

const dir = mkdtempSync(join(tmpdir(), GUARD));
made.push(dir);
// Every test process makes these, so each removes its own: left behind, they filled a
// quota'd /tmp with tens of thousands of directories and writes there began to fail.
// `bun test` ends without running "exit" handlers, so the removal hangs off the last test instead.
afterAll(() => {
  for (const path of made) try { rmSync(path, { recursive: true, force: true }); } catch { /* Best effort. */ }
});
// A killed process (a timeout, a signal) runs no exit handler. Clear what such runs left,
// once it is too old to belong to a test that is still going.
try {
  const stale = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(DATA) && !name.startsWith(GUARD)) continue;
    const path = join(tmpdir(), name);
    try { if (statSync(path).mtimeMs < stale) rmSync(path, { recursive: true, force: true }); } catch { /* Another process got there first. */ }
  }
} catch { /* Best effort. */ }
const fake = join(dir, "systemctl");
writeFileSync(fake, "#!/bin/sh\necho 'blocked: tests must not call the real systemctl (use a fake earlier on PATH)' >&2\nexit 1\n");
chmodSync(fake, 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
