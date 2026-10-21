// Pi's user-level extensions, skills and prompt templates (under ~/.pi/agent), for Settings → Pi:
// list them, turn them off or on (an exact "-path" exclusion in Pi's settings.json, as `pi config`
// does), edit their files, add new ones, and remove them (moved to a trash folder, not deleted).
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { agentDir } from "./install";
import { restartIdle } from "./sessions";

export type Kind = "extension" | "skill" | "prompt";
const DIRS: Record<Kind, string> = { extension: "extensions", skill: "skills", prompt: "prompts" };
const SETTING: Record<Kind, string> = { extension: "extensions", skill: "skills", prompt: "prompts" };
const BUILTINS = ["mcp", "llama.cpp", "codemode", "tool-search"];
const TEXT = /\.(ts|js|mjs|cjs|mts|json|md|txt|ya?ml|toml|sh|py)$/i;
/** Largest file the editor opens. */
const MAX_EDIT = 1024 * 1024;

export interface Resource {
  kind: Kind;
  /** Path relative to the agent directory, e.g. "extensions/git.ts" (or "builtin:mcp"). */
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  builtin?: boolean;
  /** Editable files, relative to the agent directory (the main one first). */
  files: string[];
}

const settingsPath = () => join(agentDir(), "settings.json");
function readSettings(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}
function writeSettings(s: Record<string, any>) {
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2) + "\n");
}

/** ~/.agents: the Agent Skills location Pi also reads skills from. */
const agentsHome = () => join(homedir(), ".agents");
/** How a path is named in ids: relative to the agent directory, or "~/.agents/…". */
function idOf(p: string): string {
  const agents = agentsHome();
  return p.startsWith(agents + sep) ? `~/.agents/${relative(agents, p)}` : relative(agentDir(), p);
}

/** Text files of a resource directory (skipping dependencies and dot folders), main file first. */
function filesIn(dir: string, main?: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3 || out.length > 200) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (TEXT.test(e.name) && statSync(p).size <= MAX_EDIT) out.push(idOf(p));
    }
  };
  walk(dir, 0);
  const first = main && idOf(join(dir, main));
  return first && out.includes(first) ? [first, ...out.filter((f) => f !== first)] : out.sort();
}

/** The description from a Markdown file's frontmatter (or its first line of prose). */
function describe(file: string): { name?: string; description?: string } {
  try {
    const text = readFileSync(file, "utf8").slice(0, 4000);
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
    const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, "");
    const prose = text.replace(/^---\n[\s\S]*?\n---/, "").split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean);
    return { name: field("name"), description: field("description") ?? prose };
  } catch {
    return {};
  }
}

/** The first comment of a script, as its description. */
function describeScript(file: string): string | undefined {
  try {
    const text = readFileSync(file, "utf8").slice(0, 3000);
    const block = /\/\*\*?([\s\S]*?)\*\//.exec(text)?.[1];
    const line = text.split("\n").find((l) => l.trim().startsWith("//"));
    const raw = block ? block.split("\n").map((l) => l.replace(/^\s*\*\s?/, "").trim()).filter(Boolean)[0] : line?.replace(/^\s*\/\/\s?/, "");
    return raw?.slice(0, 200);
  } catch {
    return undefined;
  }
}

export function list(): Resource[] {
  const root = agentDir();
  const settings = readSettings();
  const off = (kind: Kind, id: string) => {
    const entries: string[] = Array.isArray(settings[SETTING[kind]]) ? settings[SETTING[kind]] : [];
    return entries.includes(`-${id}`);
  };
  const out: Resource[] = [];

  const extDir = join(root, DIRS.extension);
  if (existsSync(extDir)) {
    for (const e of readdirSync(extDir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(extDir, e.name);
      const id = `${DIRS.extension}/${e.name}`;
      if (e.isFile() && /\.(ts|js|mjs)$/.test(e.name)) {
        out.push({ kind: "extension", id, name: e.name.replace(/\.(ts|js|mjs)$/, ""), description: describeScript(p), enabled: !off("extension", id), files: [id] });
      } else if (e.isDirectory()) {
        const main = ["index.ts", "index.js", "index.mjs"].find((f) => existsSync(join(p, f)));
        // Folders without an entry point are shared code for other extensions, not extensions.
        if (!main) continue;
        out.push({ kind: "extension", id, name: e.name, description: describeScript(join(p, main)), enabled: !off("extension", id), files: filesIn(p, main) });
      }
    }
  }
  for (const b of BUILTINS) {
    out.push({ kind: "extension", id: `builtin:${b}`, name: b, description: "Built into Pi", builtin: true, enabled: !off("extension", `builtin:${b}`), files: [] });
  }

  for (const skillDir of [join(root, DIRS.skill), join(agentsHome(), "skills")]) {
    if (!existsSync(skillDir)) continue;
    const walk = (d: string, depth: number) => {
      if (depth > 3) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
        const p = join(d, e.name);
        if (existsSync(join(p, "SKILL.md"))) {
          const id = idOf(p);
          const meta = describe(join(p, "SKILL.md"));
          out.push({ kind: "skill", id, name: meta.name ?? e.name, description: meta.description, enabled: !off("skill", id), files: filesIn(p, "SKILL.md") });
        } else walk(p, depth + 1);
      }
    };
    walk(skillDir, 0);
  }

  const promptDir = join(root, DIRS.prompt);
  if (existsSync(promptDir)) {
    for (const e of readdirSync(promptDir, { withFileTypes: true })) {
      if (!e.isFile() || extname(e.name) !== ".md") continue;
      const id = `${DIRS.prompt}/${e.name}`;
      const meta = describe(join(promptDir, e.name));
      out.push({ kind: "prompt", id, name: e.name.replace(/\.md$/, ""), description: meta.description, enabled: !off("prompt", id), files: [id] });
    }
  }
  return out;
}

export function setEnabled(kind: Kind, id: string, enabled: boolean) {
  const settings = readSettings();
  const key = SETTING[kind];
  const entries: string[] = Array.isArray(settings[key]) ? settings[key] : [];
  const rest = entries.filter((e) => e !== `-${id}` && e !== `+${id}`);
  settings[key] = enabled ? rest : [...rest, `-${id}`];
  if (!settings[key].length) delete settings[key];
  writeSettings(settings);
  restartIdle();
}

/** A path inside one of the resource folders, or an error. */
function resolveInside(id: string): string {
  const agents = id.startsWith("~/.agents/");
  const rel = agents ? id.slice("~/.agents/".length) : id;
  const root = realpathSync(agents ? agentsHome() : agentDir());
  const full = join(root, rel);
  const top = rel.split(/[\\/]/)[0];
  if (!(agents ? top === "skills" : Object.values(DIRS).includes(top!)) || rel.includes("..")) throw new Error("Not a Pi resource file");
  // Follow symlinks of what exists, so a link can't lead outside.
  const real = existsSync(full) ? realpathSync(full) : join(realpathSync(dirname(full)), basename(full));
  if (!real.startsWith(root + sep)) throw new Error("Not a Pi resource file");
  return real;
}

export function readResourceFile(rel: string): string {
  const p = resolveInside(rel);
  if (statSync(p).size > MAX_EDIT) throw new Error("This file is too large to edit here");
  return readFileSync(p, "utf8");
}

export function writeResourceFile(rel: string, content: string) {
  const p = resolveInside(rel);
  if (!TEXT.test(p)) throw new Error("Only text files can be edited here");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  restartIdle();
}

/** Move a resource to <agent>/.openbuild-trash, where it can be recovered by hand. */
export function remove(id: string): string {
  if (id.startsWith("builtin:")) throw new Error("Built-in extensions can be turned off, not removed");
  const p = resolveInside(id);
  const trash = join(agentDir(), ".openbuild-trash");
  mkdirSync(trash, { recursive: true });
  const dest = join(trash, `${new Date().toISOString().replace(/[:.]/g, "-")}-${basename(p)}`);
  renameSync(p, dest);
  restartIdle();
  return dest.replace(homedir(), "~");
}

const TEMPLATES: Record<Kind, (name: string) => { path: string; content: string }> = {
  extension: (name) => ({
    path: `${DIRS.extension}/${name}.ts`,
    content: `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** ${name}: describe what this extension adds. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("${name}", {
    description: "Describe the command",
    handler: async (args, ctx) => {
      ctx.ui.notify(\`Hello from ${name}\${args ? \`: \${args}\` : ""}\`, "info");
    },
  });
}
`,
  }),
  skill: (name) => ({
    path: `${DIRS.skill}/${name}/SKILL.md`,
    content: `---
name: ${name}
description: When to use this skill, in one sentence. The model reads this to decide.
---

# ${name}

Instructions for the model.
`,
  }),
  prompt: (name) => ({
    path: `${DIRS.prompt}/${name}.md`,
    content: `---
description: What /${name} does
---

The prompt. $ARGUMENTS is replaced by whatever follows the command.
`,
  }),
};

export function create(kind: Kind, rawName: string): string {
  const name = rawName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw new Error("Give it a name (letters, digits and dashes)");
  const { path, content } = TEMPLATES[kind](name);
  mkdirSync(join(agentDir(), DIRS[kind]), { recursive: true });
  const full = resolveInside(path.split("/").slice(0, 2).join("/"));
  if (existsSync(full)) throw new Error(`${name} already exists`);
  mkdirSync(dirname(join(agentDir(), path)), { recursive: true });
  writeFileSync(join(agentDir(), path), content);
  restartIdle();
  return path;
}

/** Installed Pi packages (npm, git or local sources) from Pi's settings. */
export function packages(): string[] {
  const p = readSettings().packages;
  return Array.isArray(p) ? p.map((x: any) => (typeof x === "string" ? x : x?.source)).filter(Boolean) : [];
}
