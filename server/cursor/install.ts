import { accountCacheKey, accountEnvironment } from "../runtimeAccounts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Effort, ModelInfo, PermissionMode, PermissionModes } from "../../shared/types";
export const CURSOR_INSTALL = "curl https://cursor.com/install -fsS | bash";
export function cursorEnv(): Record<string, string> { return accountEnvironment("cursor", { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", PATH: `${join(homedir(), ".local/bin")}:${process.env.PATH ?? ""}` } as Record<string, string>); }
export function cursorBin(): string | undefined {
  if (process.env.CURSOR_BIN) return existsSync(process.env.CURSOR_BIN) ? process.env.CURSOR_BIN : undefined;
  return Bun.which("cursor-agent", { PATH: cursorEnv().PATH }) ?? Bun.which("agent", { PATH: cursorEnv().PATH }) ?? undefined;
}
export async function command(args: string[], cwd = homedir()): Promise<string> {
  const bin = cursorBin();
  if (!bin) throw new Error(`Cursor Agent is not installed. Install it with: ${CURSOR_INSTALL}`);
  const p = Bun.spawn([bin, ...args], { cwd, env: cursorEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timeout = false;
  const timer = setTimeout(() => { timeout = true; p.kill(); }, 20000);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (timeout) throw new Error(`Cursor ${args[0]} timed out`);
    if (code !== 0) throw new Error(`Cursor ${args[0]} failed (${code}): ${err.trim() || out.trim() || "no diagnostic output"}`);
    return out;
  } finally { clearTimeout(timer); }
}
export interface CursorStatus { installed: boolean; bin?: string; version?: string; provider?: string; connected?: string[]; install: string; error?: string }
export async function status(): Promise<CursorStatus> {
  const bin = cursorBin();
  if (!bin) return { installed: false, install: CURSOR_INSTALL };
  let version: string | undefined;
  try {
    version = (await command(["--version"])).trim();
    const account = JSON.parse(await command(["status", "--format", "json"]));
    return { installed: true, bin, version, provider: "cursor", connected: account.isAuthenticated ? ["cursor"] : [], install: CURSOR_INSTALL };
  } catch (e) { return { installed: true, bin, version, install: CURSOR_INSTALL, error: String(e) }; }
}
export interface CursorModels { models: ModelInfo[]; defaultModel?: string; checkedAt: number }
interface Entry { slug: string; name: string; default: boolean }
// The installed CLI's `models` command exposes account-supported legacy variants. Use
// only observed variants, never infer effort levels from a vendor/model family name.
export function parseModels(output: string): { result: CursorModels; variants: Map<string, Map<Effort, string>>; slugs: Set<string> } {
  const entries: Entry[] = output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).flatMap(line => {
    const m = /^([a-zA-Z0-9][\w.\/-]*) - (.+)$/.exec(line.trim());
    return m ? [{ slug: m[1]!, name: m[2]!.replace(/ \((?:current|default|current, default)\)$/, ""), default: /\((?:current, )?default\)$/.test(m[2]!) }] : [];
  });
  if (!entries.length) throw new Error("Cursor returned no recognizable models; run `cursor-agent models` and check authentication/CLI compatibility");
  const variants = new Map<string, Map<Effort, string>>();
  const groups = new Map<string, Entry>();
  for (const entry of entries) {
    const match = /^(.*?)-(extra-high|xhigh|low|medium|high|max|none)(-fast|-thinking)?$/.exec(entry.slug);
    const id = match ? match[1]! + (match[3] ?? "") : entry.slug;
    groups.set(id, groups.get(id) ?? { ...entry, slug: id, name: match ? entry.name.replace(/\b(?:Extra High|Low|Medium|High|Max|None)\b/g, "").replace(/\s+/g, " ").trim() : entry.name });
    if (entry.default) groups.get(id)!.default = true;
    if (match) {
      const effort = (match[2] === "none" ? "off" : match[2] === "extra-high" ? "xhigh" : match[2]) as Effort;
      let levels = variants.get(id); if (!levels) variants.set(id, levels = new Map());
      levels.set(effort, entry.slug);
    }
  }
  const models: ModelInfo[] = [...groups].map(([slug, entry]) => {
    const levels = variants.get(slug);
    const efforts = (["off", "low", "medium", "high", "xhigh", "max"] as Effort[]).filter(e => levels?.has(e));
    return { id: `cursor/${slug}`, name: entry.name, protocol: "chat", provider: "cursor", providerName: "Cursor", input: ["text"], tools: true, reasoning: { efforts, mode: efforts.length ? "effort" : "none", toggle: false } };
  });
  return { result: { models, defaultModel: [...groups].find(([, e]) => e.default)?.[0] ? `cursor/${[...groups].find(([, e]) => e.default)![0]}` : undefined, checkedAt: Date.now() }, variants, slugs: new Set(entries.map(e => e.slug)) };
}
const accountCaches = new Map<string, { at: number; value: Promise<ReturnType<typeof parseModels>> }>();
function catalog(fresh = false) {
  const cacheKey = accountCacheKey();
  const cache = accountCaches.get(cacheKey);
  if (!fresh && cache && Date.now() - cache.at < 60000) return cache.value;
  const value = command(["models"]).then(parseModels);
  accountCaches.set(cacheKey, { at: Date.now(), value }); value.catch(() => { if (accountCaches.get(cacheKey)?.value === value) accountCaches.delete(cacheKey); }); return value;
}
export async function listModels(fresh = false): Promise<CursorModels> { return (await catalog(fresh)).result; }
export async function modelSlug(model: string, effort?: Effort): Promise<string> {
  if (!model.startsWith("cursor/")) throw new Error("Cursor requires a cursor/ model id");
  const slug = model.slice(7), c = await catalog();
  if (!c.result.models.some(m => m.id === model)) throw new Error(`Cursor model ${slug} is unavailable for this account`);
  const levels = c.variants.get(slug);
  // `off` is the shared UI's neutral value for models without an effort control.
  if (!levels && (effort === undefined || effort === "off") && c.slugs.has(slug)) return slug;
  if (effort !== undefined) {
    const variant = levels?.get(effort);
    if (!variant) throw new Error(`Cursor model ${slug} does not support effort ${effort}`);
    return variant;
  }
  if (c.slugs.has(slug)) return slug;
  throw new Error(`Choose an effort for Cursor model ${slug}`);
}
export const forgetModels = () => { accountCaches.clear(); permissions = undefined; };

/** The installed CLI's options, from its own `--help`: flag → { argument choices, description }. */
export function parseHelp(output: string): Map<string, { choices?: string[]; description: string }> {
  const options = new Map<string, { choices?: string[]; description: string }>();
  const section = output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n(?=\S)/).find((s) => /^Options:/.test(s));
  if (!section) return options;
  // Each option starts on a line indented by two spaces and a dash; wrapped text continues it.
  for (const block of section.split(/\r?\n(?=  -)/).slice(1)) {
    const text = block.replace(/\s+/g, " ").trim();
    const m = /^(?:-\w, )?(--[\w-]+)(?: [<[][\w-]+[>\]])?\s+(.*)$/.exec(text);
    if (!m) continue;
    let description = m[2]!;
    const choices = /\(choices: ([^)]*)\)/.exec(description)?.[1]?.match(/"([^"]+)"/g)?.map((c) => c.slice(1, -1));
    description = description.replace(/\s*\((?:choices|default|env):[^)]*\)/g, "").trim();
    options.set(m[1]!, { ...(choices ? { choices } : {}), description });
  }
  return options;
}

// Mode descriptions are written "plan: read-only/planning (…). ask: Q&A style …": split per choice.
function choiceDescription(description: string, choice: string): string | undefined {
  const m = new RegExp(`(?:^|[.\\s])${choice}: (.*?)(?=\\s\\w+: |$)`).exec(description);
  return m?.[1]?.replace(/\.$/, "").trim();
}

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/**
 * Print mode can't relay approvals, so only modes the installed CLI advertises as flags are offered:
 * "default" (no flag) keeps its configured allowlist; the others are its own flags and their choices.
 */
export function permissionModes(help: ReturnType<typeof parseHelp>): PermissionMode[] {
  const modes: PermissionMode[] = [{ id: "default", name: "Configured", description: "Cursor's own allowlist (cli-config.json); anything else is not run" }];
  const mode = help.get("--mode");
  for (const choice of mode?.choices ?? []) modes.push({ id: `mode:${choice}`, name: title(choice), ...(choiceDescription(mode!.description, choice) ? { description: choiceDescription(mode!.description, choice) } : {}) });
  const review = help.get("--auto-review");
  if (review) modes.push({ id: "auto-review", name: "Auto-review", description: review.description.replace(/^Use Auto-review \(Smart Auto\): /, "") });
  const force = help.get("--force") ?? help.get("--yolo");
  if (force) modes.push({ id: "force", name: "Run everything", description: force.description });
  return modes;
}
/** CLI flags for a mode id from `permissionModes`; throws for one this CLI doesn't offer. */
export async function permissionArgs(id: string | undefined): Promise<string[]> {
  if (id === undefined || id === "default") return [];
  const { modes } = await listPermissions();
  if (!modes.some((m) => m.id === id)) throw new Error(`This Cursor Agent doesn't offer permission mode ${id}`);
  if (id === "force") return ["--force"];
  if (id === "auto-review") return ["--auto-review"];
  if (id.startsWith("mode:")) return ["--mode", id.slice(5)];
  throw new Error(`Unknown Cursor permission mode ${id}`);
}
let permissions: { at: number; value: Promise<PermissionModes> } | undefined;
export function listPermissions(fresh = false): Promise<PermissionModes> {
  if (!fresh && permissions && Date.now() - permissions.at < 10 * 60000) return permissions.value;
  const value = command(["--help"]).then((out) => ({ modes: permissionModes(parseHelp(out)), defaultMode: "default", checkedAt: Date.now() }));
  permissions = { at: Date.now(), value }; value.catch(() => { if (permissions?.value === value) permissions = undefined; });
  return value;
}
