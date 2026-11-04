// Skills that come with an app: folders with a SKILL.md, fetched from the publisher's repository at
// the commit the catalog pins, into the bots' data folder. Bots read them through the apps tool, so
// they're the same whichever computer a bot runs on.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import type { CatalogApp } from "../../shared/apps";
import { GITHUB_SCOPE } from "../../shared/types";
import * as vault from "../vault";
import { botsDir } from "./db";

export interface InstalledSkill {
  name: string;
  description: string;
  /** Other files in the skill's folder, relative to it. */
  files: string[];
}

const MAX_FILE = 512 * 1024;
const MAX_APP = 8 * 1024 * 1024;
const MAX_FILES = 150;
const NAME = /^[A-Za-z0-9._-]{1,80}$/;
/** Only text a bot can read; images and binaries in a skill folder stay behind. */
const TEXT = /\.(md|mdx|txt|json|jsonc|ya?ml|toml|ts|tsx|js|mjs|cjs|jsx|py|sh|bash|sql|css|html|xml|csv|ini|env\.example|graphql|go|rs|rb|java|kt|swift)$/i;

export const skillsDir = (appId?: string) => join(botsDir(), "apps", "skills", ...(appId ? [appId] : []));

/** The public API, with the user's GitHub key if there is one, for its higher rate limit. */
async function github(path: string): Promise<Response> {
  const [token] = await vault.secrets(GITHUB_SCOPE).catch(() => [] as string[]);
  const get = (key?: string) =>
    fetch(`https://api.github.com${path}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "OpenBuild", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
  const res = await get(token);
  return res.status === 401 && token ? get() : res;
}

/** The skill folders under a source, and the files in each. */
async function listSource(repo: string, ref: string, dir: string) {
  const res = await github(`/repos/${repo}/git/trees/${ref}?recursive=1`);
  if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? "GitHub's rate limit was hit. Try again in a while, or add a GitHub key in Settings." : `GitHub answered ${res.status} for ${repo}.`);
  const tree = ((await res.json()) as { tree: { path: string; type: string; size?: number }[] }).tree;
  const base = dir ? `${dir.replace(/\/$/, "")}/` : "";
  const skills = new Map<string, { path: string; size: number }[]>();
  for (const item of tree) {
    if (item.type !== "blob" || !item.path.startsWith(base)) continue;
    const [name, ...rest] = item.path.slice(base.length).split("/");
    if (!name || !rest.length || !NAME.test(name)) continue;
    if (rest.length === 1 && rest[0] === "SKILL.md") skills.set(name, skills.get(name) ?? []);
  }
  for (const item of tree) {
    if (item.type !== "blob" || !item.path.startsWith(base)) continue;
    const [name, ...rest] = item.path.slice(base.length).split("/");
    const files = name ? skills.get(name) : undefined;
    if (files && rest.length && (rest.join("/") === "SKILL.md" || TEXT.test(item.path)) && (item.size ?? 0) <= MAX_FILE) files.push({ path: rest.join("/"), size: item.size ?? 0 });
  }
  return { base, skills };
}

/** "name" and "description" from a SKILL.md's front matter. */
export function frontMatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    // A folded or literal block: the indented lines after it.
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) block.push(lines[++i]!.trim());
      value = block.join(" ");
    }
    out[kv[1]!] = value.replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
  }
  return out;
}

/** Fetch an app's skills, replacing whatever it had. */
export async function installSkills(app: CatalogApp): Promise<InstalledSkill[]> {
  if (!app.skills?.length) return [];
  const staging = `${skillsDir(app.id)}.${process.pid}.${Date.now()}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  const out: InstalledSkill[] = [];
  let total = 0;
  try {
    for (const source of app.skills) {
      const { base, skills } = await listSource(source.repo, source.ref, source.dir);
      for (const [folder, files] of skills) {
        if (out.some((s) => s.name === folder)) continue;
        const kept: string[] = [];
        for (const file of files.slice(0, MAX_FILES)) {
          if (total + file.size > MAX_APP) break;
          const res = await fetch(`https://raw.githubusercontent.com/${source.repo}/${source.ref}/${base}${folder}/${file.path}`, { signal: AbortSignal.timeout(30_000) });
          if (!res.ok) continue;
          const body = await res.text();
          total += body.length;
          const target = join(staging, folder, file.path);
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          writeFileSync(target, body, { mode: 0o600 });
          if (file.path !== "SKILL.md") kept.push(file.path);
        }
        const main = join(staging, folder, "SKILL.md");
        if (!existsSync(main)) continue;
        const meta = frontMatter(readFileSync(main, "utf8"));
        out.push({ name: folder, description: (meta.description ?? "").slice(0, 600), files: kept });
      }
    }
    rmSync(skillsDir(app.id), { recursive: true, force: true });
    mkdirSync(dirname(skillsDir(app.id)), { recursive: true, mode: 0o700 });
    if (out.length) renameSync(staging, skillsDir(app.id));
    return out;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function removeSkills(appId: string) {
  rmSync(skillsDir(appId), { recursive: true, force: true });
}

/** One file of an installed skill, its SKILL.md unless another is named. Never anything outside the skill's folder. */
export function readSkill(appId: string, skill: string, file = "SKILL.md"): string {
  if (!NAME.test(skill)) throw new Error("No such skill.");
  const root = join(skillsDir(appId), skill);
  const target = normalize(join(root, file));
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`) || rel.split(sep).includes("..")) throw new Error("That file isn't part of the skill.");
  try {
    return readFileSync(target, "utf8");
  } catch {
    throw new Error(file === "SKILL.md" ? "That skill isn't installed." : `The skill has no file ${file}.`);
  }
}
