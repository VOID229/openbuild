// Test preload: the suite must never reach a developer's real systemd user
// service. Put a refusing `systemctl` first on PATH; tests that exercise the
// CLI prepend their own fake, which takes precedence over this one.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set this before any test imports server modules that capture dataDir(). A misspelled
// override must never let a test fall back to the developer's live database or pairings.
if (!process.env.OPENCHAT_DATA_DIR) {
  process.env.OPENCHAT_DATA_DIR = mkdtempSync(join(tmpdir(), "openbuild-test-data-"));
}

const dir = mkdtempSync(join(tmpdir(), "openbuild-systemctl-guard-"));
const fake = join(dir, "systemctl");
writeFileSync(fake, "#!/bin/sh\necho 'blocked: tests must not call the real systemctl (use a fake earlier on PATH)' >&2\nexit 1\n");
chmodSync(fake, 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
