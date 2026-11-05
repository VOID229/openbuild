import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { PiChatRequest, RuntimeAccount } from "../shared/types";

const scope = new AsyncLocalStorage<RuntimeAccount>();
export const accountCacheKey = () => scope.getStore()?.configDir ?? "";
export const ACCOUNT_VARIABLE = { codex: "CODEX_HOME", claude: "CLAUDE_CONFIG_DIR", cursor: "CURSOR_CONFIG_DIR" } as const;
export function accountPath(path: string): string {
  if (typeof path !== "string" || !path.trim() || path.includes("\0") || path.length > 4096) throw new Error("Invalid account configuration directory");
  const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(expanded)) throw new Error("Account configuration directory must be absolute or start with ~/");
  return expanded;
}
export function withRuntimeAccount<T>(req: PiChatRequest, run: () => T): T {
  const account = req.runtimeAccount;
  if (!account) return run();
  if (!["codex", "claude", "cursor"].includes(account.runtime) || account.runtime !== req.runtime) throw new Error("Account does not match the thread runtime");
  return scope.run(resolveAccount(account), run);
}
/** Check a client-supplied account, and point it at its shadow home when it has one. */
function resolveAccount(account: RuntimeAccount): RuntimeAccount {
  const { binPath, launchArgs, autoCompactWindow, shadowHome } = account;
  if (binPath !== undefined && (typeof binPath !== "string" || !binPath.trim() || binPath.includes("\0") || binPath.length > 4096)) throw new Error("Invalid account binary path");
  if (launchArgs !== undefined) splitArgs(launchArgs);
  if (autoCompactWindow !== undefined && (!Number.isInteger(autoCompactWindow) || autoCompactWindow < 100_000 || autoCompactWindow > 1_000_000)) throw new Error("Auto-compact must be between 100,000 and 1,000,000 tokens");
  const configDir = accountPath(account.configDir);
  if (shadowHome === undefined) return { ...account, configDir };
  if (account.runtime !== "codex") throw new Error("Only Codex accounts have a shadow home");
  const shadow = accountPath(shadowHome);
  shareHome(configDir, shadow);
  return { ...account, configDir: shadow };
}
/** Link what `home` holds into `shadow`, leaving out the sign-in; run per turn so new files join in. */
export function shareHome(home: string, shadow: string): void {
  mkdirSync(shadow, { recursive: true });
  mkdirSync(home, { recursive: true });
  const names = readdirSync(home).filter((name) => name !== "auth.json");
  for (const name of readdirSync(shadow)) {
    const link = join(shadow, name);
    if (lstatSync(link).isSymbolicLink() && !existsSync(link)) unlinkSync(link);
  }
  for (const name of names) if (!existsSync(join(shadow, name))) symlinkSync(join(home, name), join(shadow, name));
}
/** Shell-style words: `--a "b c"` → ["--a", "b c"]. */
export function splitArgs(text: string): string[] {
  if (typeof text !== "string" || text.length > 4096 || text.includes("\0")) throw new Error("Invalid launch arguments");
  return (text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((word) => word.replace(/"([^"]*)"|'([^']*)'/g, "$1$2"));
}
/** The selected account's launch arguments for a runtime. */
export const accountArgs = (runtime: RuntimeAccount["runtime"]): string[] => {
  const account = scope.getStore();
  return account?.runtime === runtime && account.launchArgs ? splitArgs(account.launchArgs) : [];
};
/** The selected account's executable: undefined without one, "" when it can't be found. */
export function accountBin(runtime: RuntimeAccount["runtime"], path: string): string | undefined {
  const account = scope.getStore();
  const bin = account?.runtime === runtime ? account.binPath?.trim() : undefined;
  if (!bin) return undefined;
  if (!bin.includes("/")) return Bun.which(bin, { PATH: path }) ?? "";
  const expanded = accountPath(bin);
  return existsSync(expanded) ? expanded : "";
}
/** Never mutate process.env: simultaneous threads can use different accounts. */
export function accountEnvironment(runtime: RuntimeAccount["runtime"], base: Record<string, string>): Record<string, string> {
  const account = scope.getStore();
  if (!account || account.runtime !== runtime) return base;
  const env = { ...base, [ACCOUNT_VARIABLE[runtime]]: account.configDir };
  if (runtime === "claude" && account.autoCompactWindow) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(account.autoCompactWindow);
  // Ambient API credentials must not silently override a selected subscription account.
  for (const key of runtime === "codex" ? ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"] : runtime === "claude" ? ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] : ["CURSOR_API_KEY"]) delete env[key];
  return env;
}
