// Other Claude Code logins on this device: a `claude2` wrapper or alias that sets CLAUDE_CONFIG_DIR,
// or a signed-in sibling such as ~/.claude-2. OpenBuild only notes the directory; the CLI's own
// credentials stay unread. Sign-ins may live in the macOS keychain, so `.claude.json` also counts.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { accountPath } from "../runtimeAccounts";
import type { RuntimeAccount } from "../../shared/types";

const WRAPPER = /^claude[-_]?\d+$/;
const CONFIG_DIR = /CLAUDE_CONFIG_DIR=(?:"([^"]+)"|'([^']+)'|([^\s;"']+))/;
const ALIAS = /^\s*alias\s+(claude[-_]?\d+)=(.*)$/gm;
const SHELL_FILES = [".zshrc", ".zshenv", ".zprofile", ".bashrc", ".bash_aliases", ".bash_profile", ".profile"];
const MAX_SCRIPT = 64 * 1024;

function read(path: string): string {
  try { return statSync(path).size <= MAX_SCRIPT ? readFileSync(path, "utf8") : ""; } catch { return ""; }
}
function list(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
function configDir(text: string, home: string): string | undefined {
  const match = CONFIG_DIR.exec(text);
  const value = (match?.[1] ?? match?.[2] ?? match?.[3])?.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  return value && isAbsolute(value) && !value.includes("$") ? resolve(value) : undefined;
}
function signedIn(dir: string): boolean {
  if (existsSync(join(dir, ".credentials.json"))) return true;
  try { return !!JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).oauthAccount; } catch { return false; }
}

/** `claude-2` and `Claude 2` read as `claude2`; `.claude-work` keeps its word. */
export const accountId = (name: string) => name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").replace(/^claude[-_]?(\d+)$/, "claude$1");

export function detectAccounts(home = homedir(), path = process.env.PATH ?? ""): RuntimeAccount[] {
  const found: { id: string; dir: string }[] = [];
  const bins = new Set([...path.split(delimiter).filter(Boolean), join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"]);
  for (const bin of bins) for (const name of list(bin).filter((n) => WRAPPER.test(n))) {
    const dir = configDir(read(join(bin, name)), home);
    if (dir) found.push({ id: accountId(name), dir });
  }
  for (const file of SHELL_FILES) for (const [, name, value] of read(join(home, file)).matchAll(ALIAS)) {
    const dir = configDir(value!, home);
    if (dir) found.push({ id: accountId(name!), dir });
  }
  for (const name of list(home).filter((n) => /^\.claude[-_.]?[^-_.].*$/.test(n) && n !== ".claude")) {
    const dir = join(home, name);
    try { if (statSync(dir).isDirectory() && signedIn(dir)) found.push({ id: accountId(name.replace(/^\.claude[-_.]?(?=\d)/, "claude").replace(/^\./, "")), dir }); } catch {}
  }
  // The server's own CLAUDE_CONFIG_DIR only says where the default login is for its real home.
  const primary = resolve((home === homedir() && process.env.CLAUDE_CONFIG_DIR) || join(home, ".claude"));
  const ids = new Set<string>(), dirs = new Set([primary]);
  return found
    .filter(({ id, dir }) => {
      if (ids.has(id) || dirs.has(dir) || !existsSync(dir)) return false;
      ids.add(id); dirs.add(dir);
      return true;
    })
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map(({ id, dir }) => ({ id, name: id, runtime: "claude", configDir: dir }));
}

/** Accounts added in Settings come first: their name wins for a directory detection also found. */
export function claudeAccounts(saved: unknown, home = homedir(), path = process.env.PATH ?? ""): RuntimeAccount[] {
  const accounts: RuntimeAccount[] = [];
  for (const entry of Array.isArray(saved) ? saved.slice(0, 16) : []) {
    const id = accountId(String(entry?.name ?? ""));
    try {
      const configDir = accountPath(entry?.configDir);
      if (id && id !== "claude" && !accounts.some((a) => a.id === id || a.configDir === configDir)) accounts.push({ id, name: entry.name, runtime: "claude", configDir });
    } catch {}
  }
  accounts.push(...detectAccounts(home, path).filter((a) => !accounts.some((b) => b.id === a.id || b.configDir === a.configDir)));
  return accounts.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}
