// Plugin controls deliberately do not expose files, installation, deletion or arbitrary routes.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { coversProject, type Bot } from "../../shared/bots";
import { PLUGIN_GUIDANCE_NOTE } from "../pluginGuidance";
import { pluginControlInfo, setPluginEnabled, setSystemEnabled } from "../plugins";
import { listProjects } from "../projects";
import * as db from "./db";
import { BotsError } from "./service";

const root = resolve(import.meta.dir, "../..");
// Worktrees of this installation count, but a different clone or similarly named project doesn't.
function repository(path: string): string | undefined {
  try {
    const result = Bun.spawnSync(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], { stdout: "pipe", stderr: "ignore" });
    return result.exitCode === 0 ? realpathSync(result.stdout.toString().trim()) : undefined;
  } catch { return undefined; }
}
const ownRepository = repository(root);
function authoringProject(bot: Pick<Bot, "threads">) {
  if (!bot.threads?.enabled) return undefined;
  return listProjects().find((project) => {
    if (project.missing || !coversProject(bot.threads!, project.id)) return false;
    try { return realpathSync(project.path) === realpathSync(root) || (!!ownRepository && repository(project.path) === ownRepository); }
    catch { return false; }
  });
}

export function guide(bot: Pick<Bot, "threads" | "primary">): string {
  if (!authoringProject(bot)) return "";
  return `For OpenBuild plugin authoring, call plugins action guide, then use an ordinary openbuild coding thread in your granted OpenBuild project. This gives no additional computer, host or file access. ${bot.primary ? "You alone can use plugins list, set (id, enabled), and system (enabled)." : "Only the primary bot can list plugins or change their switches."}`;
}

export async function handle(botId: string, params: Record<string, unknown>) {
  const bot = db.getBot(botId);
  if (!bot) throw new BotsError("This bot no longer exists.", 404);
  const project = authoringProject(bot);
  if (!project) throw new BotsError("Plugin tools require access to this installation's OpenBuild project in Settings → Bots.", 403);
  if (params.action === "guide") return {
    project: { id: project.id, name: project.name },
    guidance: `${PLUGIN_GUIDANCE_NOTE}Plugins are trusted executable code, not sandboxed. Use openbuild options, then start a normal coding thread in the project above. Ask it to read docs/plugins.md, implement and test the plugin in its worktree with defaultEnabled: false, and report the artifact and review instructions. Use openbuild read/send/answer to follow up. Keep existing harness permissions and approval boundaries. Do not install into the live plugins directory or activate code unless the user asked and the thread's existing permissions allow it. If installation needs access it lacks, leave the reviewed artifact for the user; do not change project grants or computer isolation. The primary can inspect the live directory and switches with plugins list. Toggles can execute trusted code immediately.`,
  };
  if (!bot.primary) throw new BotsError("Only the primary bot can list plugins or change their switches.", 403);
  if (params.action === "list") return pluginControlInfo();
  if (params.action !== "set" && params.action !== "system") throw new BotsError("action is guide, list, set or system.");
  if (typeof params.enabled !== "boolean") throw new BotsError("enabled must be true or false.");
  if (params.action === "system") await setSystemEnabled(params.enabled);
  else {
    if (typeof params.id !== "string" || !await setPluginEnabled(params.id, params.enabled)) throw new BotsError("No such plugin.", 404);
  }
  // Safe mode can refuse a system change; config may hold a plugin off. Report reality.
  return pluginControlInfo();
}
