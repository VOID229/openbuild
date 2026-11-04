// What a bot's Pi loads. Everything OpenBots does comes from extension.ts, shipped with OpenBuild;
// the user's own Pi extensions and packages stay out unless they switch them on one at a time in
// Settings → Bots. Models come from extensions too, so the bots' list is asked of Pi set up this way.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { BotExtension } from "../../shared/bots";
import { agentDir } from "../pi/install";
import * as resources from "../pi/resources";
import { PiProcess } from "../pi/rpc";
import { modelScope, settledModels, type PiModels } from "../pi/sessions";
import * as svc from "./service";

const OWN = join(import.meta.dir, "extension.ts");
const TOOLS = ["bash", "read", "write", "edit", "browser", "process", "send_message", "react", "question", "poll", "vote_poll", "remember", "forget", "search", "bot_web_search", "routine", "ask_bot", "manage_bot", "openbuild"].join(",");
const PACKAGE = "package:";

const isLocal = (source: string) => !/^[a-z+]+:/i.test(source);
const packagePath = (source: string) => (isAbsolute(source) ? source : join(agentDir(), source));

function describePackage(source: string): string | undefined {
  if (!isLocal(source)) return undefined;
  try {
    return JSON.parse(readFileSync(join(packagePath(source), "package.json"), "utf8")).description;
  } catch {
    return undefined;
  }
}

/** The user's extensions and packages. Pi's own built-ins aren't theirs, and stay off. */
export function available(): BotExtension[] {
  const scripts = resources.list().filter((r) => r.kind === "extension" && !r.builtin);
  return [
    ...resources.packages().map((source) => ({ id: `${PACKAGE}${source}`, name: source.split("/").pop() || source, description: describePackage(source), kind: "package" as const })),
    ...scripts.map((r) => ({ id: r.id, name: r.name, description: r.description, kind: "extension" as const })),
  ];
}

/** What to pass Pi for the extensions the user switched on. Only ones that are still installed, and never a path from anywhere else. */
function selected(): string[] {
  const custom = svc.getSettings().customExtensions;
  if (!custom?.enabled || !custom.ids.length) return [];
  const installed = new Set(available().map((e) => e.id));
  return custom.ids
    .filter((id) => installed.has(id))
    .map((id) => {
      if (!id.startsWith(PACKAGE)) return join(agentDir(), id);
      const source = id.slice(PACKAGE.length);
      return isLocal(source) ? packagePath(source) : source;
    })
    .filter((target) => !isAbsolute(target) || existsSync(target));
}

export function piFlags(): string[] {
  const extra = selected();
  return [
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp", "--no-builtin-tools",
    // The list keeps a bot to its own tools. An extension the user switched on brings tools of its own, so it goes.
    ...(extra.length ? [] : ["--tools", TOOLS]),
    "-e", OWN,
    ...extra.flatMap((target) => ["-e", target]),
  ];
}

let cache: { key: string; at: number; value: Promise<PiModels> } | undefined;
let memory = { known: new Set<string>() };

/** The models a bot can use right now, Pi's default among them. Rejects, saying why, if Pi can't start with these extensions. */
export function botModels(fresh = false): Promise<PiModels> {
  const flags = piFlags();
  const key = JSON.stringify(flags);
  if (cache?.key !== key) memory = { known: new Set() };
  else if (!fresh && Date.now() - cache.at < 60_000) return cache.value;
  const value = (async () => {
    const proc = new PiProcess(["--no-session", ...flags], homedir());
    try {
      const [models, state, scope] = await Promise.all([settledModels(proc, memory), proc.send<{ model?: any }>({ type: "get_state" }), modelScope()]);
      return { models, defaultModel: state.model ? `${state.model.provider}/${state.model.id}` : undefined, scope, checkedAt: Date.now() };
    } finally {
      proc.close();
    }
  })();
  cache = { key, at: Date.now(), value };
  value.catch(() => cache?.value === value && (cache = undefined));
  return value;
}
