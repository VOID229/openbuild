// Saved Codex logins and signed-in numeric siblings, without reading credentials.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeAccount } from "../../shared/types";
import { accountPath } from "../runtimeAccounts";

export function codexAccounts(saved: unknown, home = homedir()): RuntimeAccount[] {
  const accounts: RuntimeAccount[] = [];
  const expand = (path: string) => path.startsWith("~/") ? join(home, path.slice(2)) : accountPath(path);
  for (const entry of Array.isArray(saved) ? saved.slice(0, 16) : []) {
    const id = String(entry?.name ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^codex[-_]?(\d+)$/, "codex$1");
    try {
      let configDir = expand(entry.configDir);
      // Older entries used .codex2 while the login command suggested .codex-2.
      const numeric = /^codex(\d+)$/.exec(id)?.[1];
      const sibling = numeric ? join(home, `.codex-${numeric}`) : undefined;
      if (numeric && configDir === join(home, `.codex${numeric}`) && !existsSync(configDir) && sibling && existsSync(join(sibling, "auth.json"))) configDir = sibling;
      if (id && id !== "codex" && !accounts.some((a) => a.id === id)) accounts.push({ ...entry, id, configDir, runtime: "codex" });
    } catch {}
  }
  for (const name of readdirSync(home)) {
    const numeric = /^\.codex[-_]?(\d+)$/.exec(name)?.[1];
    const configDir = join(home, name);
    if (!numeric || !existsSync(join(configDir, "auth.json"))) continue;
    const id = `codex${numeric}`;
    if (!accounts.some((a) => a.id === id || a.configDir === configDir || (a.shadowHome && expand(a.shadowHome) === configDir))) accounts.push({ id, name: id, configDir, runtime: "codex" });
  }
  return accounts.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}
