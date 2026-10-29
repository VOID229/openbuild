// Test preload: the suite must never reach a developer's real systemd user
// service. Put a refusing `systemctl` first on PATH; tests that exercise the
// CLI prepend their own fake, which takes precedence over this one.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "openbuild-systemctl-guard-"));
const fake = join(dir, "systemctl");
writeFileSync(fake, "#!/bin/sh\necho 'blocked: tests must not call the real systemctl (use a fake earlier on PATH)' >&2\nexit 1\n");
chmodSync(fake, 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
