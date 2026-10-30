import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Move plugins out of a checkout from before they were personal, once. Updates never touch the copies. */
export function prepareUserPlugins(bundled: string, destination: string): string {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const marker = join(destination, ".openbuild-initialized");
  if (existsSync(marker)) return destination;
  if (existsSync(bundled)) {
    for (const entry of readdirSync(bundled, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const target = join(destination, entry.name);
      if (existsSync(target)) continue;
      const temp = join(destination, `.migrate-${entry.name}-${process.pid}`);
      try {
        cpSync(join(bundled, entry.name), temp, { recursive: true, force: false, errorOnExist: true });
        // A concurrent startup may already have installed this folder.
        if (!existsSync(target)) renameSync(temp, target);
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
  }
  writeFileSync(marker, "Plugin copies belong to the user; do not replace them during updates.\n", { mode: 0o600 });
  return destination;
}
