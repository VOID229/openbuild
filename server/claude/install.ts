import { accountArgs, accountBin, accountCacheKey, accountEnvironment, withRuntimeAccount } from "../runtimeAccounts";
import { claudeAccounts } from "./accounts";
// The installed Claude Code CLI, driven through Anthropic's Agent SDK (as t3code does). OpenBuild
// never bundles or substitutes its own Claude binary, and never handles Claude's credentials: the
// CLI uses whatever sign-in (`claude login`) and settings it has on this device.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeAccountModels, Effort, ModelInfo, PermissionMode, PermissionModes, PiChatRequest } from "../../shared/types";

export const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
/** Claude Code's own fast mode, offered as a speed on models that support it. */
export const FAST = "fast";

export function claudeEnv(): Record<string, string> {
  return accountEnvironment("claude", { ...process.env, PATH: `${join(homedir(), ".local/bin")}:${process.env.PATH ?? ""}`, CLAUDE_AGENT_SDK_CLIENT_APP: "openbuild" } as Record<string, string>);
}
export function claudeBin(): string | undefined {
  const custom = accountBin("claude", `${claudeEnv().PATH}:/opt/homebrew/bin:/usr/local/bin`);
  if (custom !== undefined) return custom || undefined;
  if (process.env.CLAUDE_BIN) return existsSync(process.env.CLAUDE_BIN) ? process.env.CLAUDE_BIN : undefined;
  return Bun.which("claude", { PATH: `${claudeEnv().PATH}:/opt/homebrew/bin:/usr/local/bin` }) ?? undefined;
}
export function requireBin(): string {
  const bin = claudeBin();
  if (!bin) throw new Error(`Claude Code is not installed on this device. Install it with: ${CLAUDE_INSTALL}, then run \`claude\` once to sign in.`);
  return bin;
}

/** The account's launch arguments in the SDK's shape: `--flag value` → { flag: "value" }. */
export function claudeArgs(): Record<string, string | null> {
  const args: Record<string, string | null> = {};
  const words = accountArgs("claude");
  for (let i = 0; i < words.length; i++) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(words[i]!);
    if (!match) throw new Error(`Claude Code launch arguments must be --flags, not "${words[i]}"`);
    const next = words[i + 1];
    args[match[1]!] = match[2] ?? (next && !next.startsWith("-") ? (i++, next) : null);
  }
  return args;
}

/** The options every OpenBuild Claude process starts with: the CLI's own prompt, tools and settings. */
export function baseOptions(cwd: string) {
  return {
    cwd,
    pathToClaudeCodeExecutable: requireBin(),
    env: claudeEnv(),
    extraArgs: claudeArgs(),
    // Load CLAUDE.md, skills, hooks, MCP servers and permission rules like the CLI does.
    settingSources: ["user", "project", "local"] as ("user" | "project" | "local")[],
    systemPrompt: { type: "preset" as const, preset: "claude_code" as const },
    tools: { type: "preset" as const, preset: "claude_code" as const },
  };
}

/** A short-lived control-only Claude process (no prompt is ever sent, so nothing is billed). */
async function probe<T>(cwd: string, fn: (q: import("@anthropic-ai/claude-agent-sdk").Query) => Promise<T>): Promise<T> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  let release!: () => void;
  const idle = new Promise<void>((r) => (release = r));
  async function* never(): AsyncGenerator<never> { await idle; }
  let stderr = "";
  const q = query({ prompt: never(), options: { ...baseOptions(cwd), stderr: (s: string) => { stderr = (stderr + s).slice(-4000); } } });
  const timer = setTimeout(() => q.close(), 30_000);
  try {
    return await fn(q);
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
  } finally { clearTimeout(timer); release(); q.close(); }
}

export interface ClaudeStatus { installed: boolean; bin?: string; version?: string; provider?: string; connected?: string[]; account?: { email?: string; subscription?: string; apiProvider?: string }; install: string; error?: string }
export async function status(): Promise<ClaudeStatus> {
  const bin = claudeBin();
  if (!bin) return { installed: false, install: CLAUDE_INSTALL };
  try {
    const init = await probe(homedir(), (q) => q.initializationResult());
    const a = (init as any).account ?? {};
    const signedIn = !!(a.email || a.subscriptionType || a.apiKeySource || a.tokenSource);
    return { installed: true, bin, version: (init as any).claude_code_version, provider: "claude", connected: signedIn ? ["claude"] : [], account: { email: a.email, subscription: a.subscriptionType, apiProvider: a.apiProvider }, install: CLAUDE_INSTALL };
  } catch (e) { return { installed: true, bin, install: CLAUDE_INSTALL, error: e instanceof Error ? e.message : String(e) }; }
}

/** A Claude Code model row (SDK ModelInfo) as an OpenBuild model. */
export function toModel(m: any): ModelInfo {
  const efforts: Effort[] = [...(m.supportsThinkingOff ? ["off" as Effort] : []), ...((m.supportedEffortLevels ?? []) as Effort[]).filter((e) => ["low", "medium", "high", "xhigh", "max"].includes(e))];
  const name = m.value === "default" ? `Default (${m.description ?? "Claude Code's choice"})` : m.displayName ?? m.value;
  return {
    id: `claude/${m.value}`,
    name,
    family: m.resolvedModel,
    protocol: "messages",
    provider: "claude",
    providerName: "Claude Code",
    input: ["text", "image"],
    tools: true,
    billing: "plan",
    reasoning: { efforts, mode: efforts.length ? "effort" : "none", toggle: !!m.supportsThinkingOff },
    ...(m.supportsFastMode ? { speeds: [{ id: FAST, name: "Fast", description: "Claude Code's fast mode: quicker output, billed at a higher rate" }] } : {}),
  };
}

export interface ClaudeModels { models: ModelInfo[]; defaultModel?: string; checkedAt: number }
const accountCaches = new Map<string, { at: number; value: Promise<ClaudeModels & { raw: any[] }> }>();
function catalog(fresh = false) {
  const cacheKey = accountCacheKey();
  const cache = accountCaches.get(cacheKey);
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.value;
  const value = probe(homedir(), (q) => q.supportedModels()).then((raw) => {
    if (!Array.isArray(raw) || !raw.length) throw new Error("Claude Code listed no models; run `claude` once to sign in");
    return { raw, models: raw.map(toModel), defaultModel: raw.some((m) => m.value === "default") ? "claude/default" : `claude/${raw[0]!.value}`, checkedAt: Date.now() };
  });
  accountCaches.set(cacheKey, { at: Date.now(), value });
  value.catch(() => { if (accountCaches.get(cacheKey)?.value === value) accountCaches.delete(cacheKey); });
  return value;
}
export async function listModels(fresh = false): Promise<ClaudeModels> {
  const { models, defaultModel, checkedAt } = await catalog(fresh);
  return { models, defaultModel, checkedAt };
}
/** Every account's models, listed under its own sign-in. A login that can't list yet stays empty. */
export async function listAccountModels(fresh = false, saved?: unknown): Promise<ClaudeModels & { accounts: ClaudeAccountModels[] }> {
  const [primary, accounts] = await Promise.all([
    listModels(fresh),
    Promise.all(claudeAccounts(saved).map(async (account): Promise<ClaudeAccountModels> => {
      const req = { runtime: "claude", runtimeAccount: account } as PiChatRequest;
      const models = await (async () => withRuntimeAccount(req, () => catalog(fresh)))().then((c) => c.models, () => []);
      return { account, models: models.map((m) => ({ ...m, id: m.id.replace(/^claude\//, `${account.id}/`), provider: account.id, providerName: account.name })) };
    })),
  ]);
  return { ...primary, accounts };
}
/** The SDK's model row for an OpenBuild id, or an error when this sign-in doesn't offer it. */
export async function modelRow(id: string): Promise<any> {
  if (!id.startsWith("claude/")) throw new Error("Claude Code requires a claude/ model id");
  const value = id.slice(7);
  const row = (await catalog()).raw.find((m) => m.value === value) ?? (await catalog(true)).raw.find((m) => m.value === value);
  if (!row) throw new Error(`Claude Code doesn't offer model ${value} on this device`);
  return row;
}
export const forgetModels = () => { accountCaches.clear(); permissionCache.clear(); };

// ------------------------------------------------------------------ permissions

export type ClaudePermission = "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";
const MODES: { id: ClaudePermission; name: string; description: string }[] = [
  { id: "default", name: "Ask", description: "Asks before edits, commands and other tools your rules don't allow" },
  { id: "acceptEdits", name: "Accept edits", description: "Edits files without asking; asks before commands" },
  { id: "plan", name: "Plan", description: "Read-only: explores and proposes a plan for you to approve" },
  { id: "auto", name: "Auto", description: "A classifier approves safe actions and asks about the rest" },
  { id: "dontAsk", name: "Don't ask", description: "Only what your allow rules permit; everything else is denied" },
  { id: "bypassPermissions", name: "Bypass permissions", description: "Runs every tool without asking. Use only in a sandbox" },
];
export const isClaudePermission = (id: string | undefined): id is ClaudePermission => MODES.some((m) => m.id === id);

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}
/** Claude's settings layers for a folder, lowest precedence first (user, project, local, managed). */
function settingsLayers(cwd?: string): any[] {
  const config = claudeEnv().CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const managed = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json";
  return [join(config, "settings.json"), ...(cwd ? [join(cwd, ".claude/settings.json"), join(cwd, ".claude/settings.local.json")] : []), managed].map(readJson).filter(Boolean);
}

const permissionCache = new Map<string, { at: number; value: Promise<PermissionModes> }>();
/** Claude Code's permission modes for a folder, with the one its settings start in. */
export function listPermissions(cwd?: string, fresh = false): Promise<PermissionModes> {
  const key = JSON.stringify([accountCacheKey(), cwd ?? ""]);
  const hit = permissionCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = (async () => {
    const layers = settingsLayers(cwd);
    const bypassOff = layers.some((s) => s.permissions?.disableBypassPermissionsMode === "disable");
    const autoOff = layers.some((s) => s.disableAutoMode === "disable" || s.permissions?.disableAutoMode === "disable");
    let configured: string | undefined;
    for (const s of layers) if (isClaudePermission(s.permissions?.defaultMode)) configured = s.permissions.defaultMode;
    const modes: PermissionMode[] = MODES.map((m) => ({ ...m, allowed: !(m.id === "bypassPermissions" && bypassOff) && !(m.id === "auto" && autoOff) }));
    return { modes, defaultMode: configured ?? "default", checkedAt: Date.now() };
  })();
  permissionCache.set(key, { at: Date.now(), value });
  value.catch(() => { if (permissionCache.get(key)?.value === value) permissionCache.delete(key); });
  return value;
}
