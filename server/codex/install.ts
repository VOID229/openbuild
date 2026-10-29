import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { Effort, ModelInfo, PermissionMode, PermissionModes } from "../../shared/types";
// rpc imports these functions but does not instantiate until discovery is called.
import { CodexProcess } from "./rpc";
export const CODEX_INSTALL = "npm install -g @openai/codex";
export function codexBin(): string | undefined {
  if (process.env.CODEX_BIN) return existsSync(process.env.CODEX_BIN) ? process.env.CODEX_BIN : undefined;
  return Bun.which("codex", { PATH: `${join(homedir(), ".local/bin")}:${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` }) ?? undefined;
}
/** Update the installation we actually resolve, not an unrelated npm global on PATH. */
export function codexUpdateCommand(bin: string): string[] {
  const resolved = realpathSync(bin);
  if (resolved.includes(`${sep}standalone${sep}releases${sep}`)) return [bin, "update"];
  // npm's launcher lives at <prefix>/lib/node_modules/@openai/codex/bin/codex.js.
  const suffix = join("lib", "node_modules", "@openai", "codex", "bin", "codex.js");
  if (resolved.endsWith(`${sep}${suffix}`)) {
    const prefix = resolved.slice(0, -suffix.length - 1);
    return ["npm", "install", "-g", "--prefix", prefix, "@openai/codex@latest"];
  }
  // New standalone releases know how to update themselves. Never silently install a second copy.
  return [bin, "update"];
}
export function codexEnv(): Record<string, string> { return { ...process.env, PATH: `${join(homedir(), ".local/bin")}:${process.env.PATH ?? ""}` } as Record<string, string>; }
export interface CodexStatus { installed: boolean; bin?: string; version?: string; provider?: string; connected?: string[]; install: string; error?: string }
export async function status(): Promise<CodexStatus> {
  const bin = codexBin();
  if (!bin) return { installed: false, install: CODEX_INSTALL };
  const p = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe", env: codexEnv() });
  const timer = setTimeout(() => p.kill(), 10000);
  try {
    const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    const proc = new CodexProcess(homedir());
    try {
      await proc.initialize();
      const account = await proc.request("account/read", {});
      return { installed: code === 0, bin, version: out.trim(), provider: "codex", connected: account.account ? [account.account.type ?? "codex"] : [], install: CODEX_INSTALL };
    } catch (e) { return { installed: code === 0, bin, version: out.trim(), install: CODEX_INSTALL, error: String(e) }; }
    finally { proc.close(); }
  } finally { clearTimeout(timer); }
}
export interface CodexModels { models: ModelInfo[]; defaultModel?: string; checkedAt: number }
let cache: { at: number; value: Promise<CodexModels> } | undefined;
export function listModels(fresh = false): Promise<CodexModels> {
  if (!fresh && cache && Date.now() - cache.at < 60000) return cache.value;
  const value = (async () => {
    const proc = new CodexProcess(homedir());
    try {
      await proc.initialize();
      const entries: any[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const r = await proc.request("model/list", { ...(cursor ? { cursor } : {}), limit: 100 });
        if (!Array.isArray(r.data)) throw new Error("Codex returned an invalid model list");
        entries.push(...r.data);
        cursor = r.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error("Codex repeated its model cursor");
        if (cursor) seen.add(cursor);
      } while (cursor);
      const models: ModelInfo[] = entries.filter((m) => !m.hidden).map((m) => {
        const efforts: Effort[] = (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort).filter((e: string) => ["low", "medium", "high", "xhigh", "max"].includes(e));
        return { id: `codex/${m.model ?? m.id}`, name: m.displayName ?? m.id, protocol: "chat", provider: "codex", providerName: "Codex", input: m.inputModalities ?? ["text"], tools: true, speeds: m.serviceTiers?.map((t: any) => ({ id: t.id, name: t.name, description: t.description })), reasoning: { efforts, mode: efforts.length ? "effort" : "none", toggle: false } };
      });
      const d = entries.find((m) => m.isDefault);
      return { models, defaultModel: d ? `codex/${d.model ?? d.id}` : undefined, checkedAt: Date.now() };
    } finally { proc.close(); }
  })();
  cache = { at: Date.now(), value };
  value.catch(() => { if (cache?.value === value) cache = undefined; });
  return value;
}
export const forgetModels = () => { cache = undefined; permissionCache.clear(); };

// Codex's built-in profiles report no description; name them for display only. Any other
// profile (user-defined `[permissions.<id>]`) shows its own id and description.
const BUILTIN: Record<string, { name: string; description: string }> = {
  ":read-only": { name: "Read only", description: "Reads files; asks before edits, commands and network" },
  ":workspace": { name: "Workspace", description: "Edits and runs commands in the workspace; asks to go further" },
  ":danger-full-access": { name: "Full access", description: "No sandbox: edits, commands and network without limits" },
};
/** OpenBuild's id for Codex's auto-review preset, and the profile it runs in. */
export const AUTO_REVIEW = "auto-review";
export const AUTO_REVIEW_PROFILE = ":workspace";
/** turn/start overrides for a permission mode id from `listPermissions`. */
export function permissionParams(id: string | undefined): Record<string, string> {
  if (!id) return {};
  if (id === AUTO_REVIEW) return { permissions: AUTO_REVIEW_PROFILE, approvalsReviewer: "auto_review" };
  return { permissions: id };
}
const permissionCache = new Map<string, { at: number; value: Promise<PermissionModes> }>();
/** The permission profiles Codex offers for `cwd` (project layers included), as it lists them. */
export function listPermissions(cwd?: string, fresh = false): Promise<PermissionModes> {
  const key = cwd ?? "";
  const hit = permissionCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 60000) return hit.value;
  const value = (async () => {
    const proc = new CodexProcess(cwd ?? homedir());
    try {
      await proc.initialize();
      const entries: any[] = [];
      let next: string | undefined;
      const seen = new Set<string>();
      do {
        const r = await proc.request("permissionProfile/list", { ...(next ? { cursor: next } : {}), ...(cwd ? { cwd } : {}) });
        if (!Array.isArray(r?.data)) throw new Error("Codex returned an invalid permission profile list");
        entries.push(...r.data);
        next = r.nextCursor ?? undefined;
        if (next && seen.has(next)) throw new Error("Codex repeated its permission profile cursor");
        if (next) seen.add(next);
      } while (next);
      // The configured default, when the user set one; otherwise Codex picks its own.
      const config = await proc.request("config/read", { ...(cwd ? { cwd } : {}) }).catch(() => undefined);
      let configured = typeof config?.config?.default_permissions === "string" ? config.config.default_permissions : undefined;
      // Auto-review isn't a profile: it routes approval requests to Codex's reviewer agent instead of
      // the user. Offer it only when this Codex has the feature on and managed policy permits it.
      const [features, requirements] = await Promise.all([
        proc.request("experimentalFeature/list", {}).catch(() => undefined),
        proc.request("configRequirements/read", {}).catch(() => undefined),
      ]);
      const reviewer = Array.isArray(features?.data) && features.data.some((f: any) => f?.name === "guardian_approval" && f.enabled === true);
      const reviewers = requirements?.requirements?.allowedApprovalsReviewers;
      const reviewerAllowed = !Array.isArray(reviewers) || reviewers.includes("auto_review");
      const modes: PermissionMode[] = entries.filter((p) => typeof p?.id === "string").map((p) => ({
        id: p.id,
        name: BUILTIN[p.id]?.name ?? p.id,
        ...(p.description ?? BUILTIN[p.id]?.description ? { description: p.description ?? BUILTIN[p.id]!.description } : {}),
        allowed: p.allowed !== false,
      }));
      // Like Codex's own preset: the workspace sandbox, with escalations reviewed automatically.
      if (reviewer && modes.some((m) => m.id === AUTO_REVIEW_PROFILE)) {
        const at = modes.findIndex((m) => m.id === AUTO_REVIEW_PROFILE) + 1;
        modes.splice(at, 0, { id: AUTO_REVIEW, name: "Auto-review", description: "Workspace sandbox; a reviewer agent approves or denies requests to go further", allowed: reviewerAllowed && modes[at - 1]!.allowed !== false });
        if (config?.config?.approvals_reviewer === "auto_review" && (!configured || configured === AUTO_REVIEW_PROFILE)) configured = AUTO_REVIEW;
      }
      return { modes, defaultMode: configured, checkedAt: Date.now() };
    } finally { proc.close(); }
  })();
  permissionCache.set(key, { at: Date.now(), value });
  value.catch(() => { if (permissionCache.get(key)?.value === value) permissionCache.delete(key); });
  return value;
}
