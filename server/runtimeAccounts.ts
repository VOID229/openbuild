import { AsyncLocalStorage } from "node:async_hooks";
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
  return scope.run({ ...account, configDir: accountPath(account.configDir) }, run);
}
/** Never mutate process.env: simultaneous threads can use different accounts. */
export function accountEnvironment(runtime: RuntimeAccount["runtime"], base: Record<string, string>): Record<string, string> {
  const account = scope.getStore();
  if (!account || account.runtime !== runtime) return base;
  const env = { ...base, [ACCOUNT_VARIABLE[runtime]]: account.configDir };
  // Ambient API credentials must not silently override a selected subscription account.
  for (const key of runtime === "codex" ? ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"] : runtime === "claude" ? ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] : ["CURSOR_API_KEY"]) delete env[key];
  return env;
}
