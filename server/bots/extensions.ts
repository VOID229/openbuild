// What a bot's Pi loads. Everything OpenBots does comes from extension.ts, shipped with OpenBuild,
// and Claude subscriptions from the bundled pi-claude-code bridge (claude.ts); the user's own Pi
// extensions and packages stay out unless they switch them on one at a time in Settings → Bots.
// Models come from extensions too, so the bots' list is asked of Pi set up this way.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { HELPER_TOOLS, type BotExtension } from "../../shared/bots";
import { FRIEND_TOOLS } from "../../shared/friends";
import { agentDir } from "../pi/install";
import * as resources from "../pi/resources";
import { PiProcess } from "../pi/rpc";
import { modelScope, settledModels, type PiModels } from "../pi/sessions";
import { BRIDGE_PACKAGE, bridgeExtension } from "./claude";
import * as svc from "./service";

const OWN = join(import.meta.dir, "extension.ts");
const TOOLS = ["bash", "read", "write", "edit", "browser", "process", "send_message", "react", "question", "poll", "vote_poll", "html_render", "todo", "memory", "search", "bot_web_search", "apps", "use_app", "routine", "ask_bot", "background", "side_chat", "manage_bot", "openbuild", "plugins", "load_tools"].join(",");
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

/** The package's name, for a local one. */
function packageName(target: string): string | undefined {
  try {
    return JSON.parse(readFileSync(join(target, "package.json"), "utf8")).name;
  } catch {
    return undefined;
  }
}

/** A user extension that is pi-claude-code: it registers the same providers, so OpenBuild's copy stays out. */
const isUserBridge = (target: string) => (isAbsolute(target) ? packageName(target) === BRIDGE_PACKAGE : /(^|[/:@])pi-claude-code(\.git)?([@#].*)?$/.test(target));

/** The user switched on their own pi-claude-code for bots. */
export const userBridgeSelected = () => selected().some(isUserBridge);

/** OpenBuild's Claude bridge, unless the user's own copy is loaded or no login is left for bots. */
function bridge(extra: string[]): string[] {
  if (extra.some(isUserBridge)) return [];
  const path = bridgeExtension();
  return path ? ["-e", path] : [];
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

/**
 * A bot's whole preamble, in place of Pi's default "coding assistant running inside pi" one and the
 * tools, rules and docs sections Pi only adds with it. Who the bot is comes from extension.ts's sections.
 */
export const BOT_SYSTEM_PROMPT =
  "You are a bot in OpenBots: you talk with the user, and sometimes their other bots and friends, through your tools. The sections below say who you are and how to act. If you have bash, use it for file operations like ls, rg and find.";

const base = (systemPrompt: string) => [
  "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp", "--no-builtin-tools",
  // Context-file isolation does not cover Pi's SYSTEM.md / APPEND_SYSTEM.md discovery: any CLI
  // value suppresses each, so the bot's own preamble goes in and the addendum stays empty.
  "--system-prompt", systemPrompt, "--append-system-prompt", "",
];
const BASE = base(BOT_SYSTEM_PROMPT);

/** What a helper session is told it is: the prompt it's given says the rest. */
export const HELPER_SYSTEM_PROMPT =
  "You are a background helper session of a bot in OpenBots. Do the one thing your prompt asks, quickly, and answer in plain text: that answer is all that leaves this session. You can't message anyone.";

/**
 * A helper session's Pi (helpers.ts). The user's extensions still load, since the bot's model can
 * come from one. With `tools` it gets HELPER_TOOLS through the bots extension; without, no tools at all.
 */
export function helperFlags(tools: boolean): string[] {
  const extra = selected();
  return [...base(HELPER_SYSTEM_PROMPT), ...(tools ? ["--tools", HELPER_TOOLS.join(","), "-e", OWN] : ["--no-tools"]), ...bridge(extra), ...extra.flatMap((target) => ["-e", target])];
}

export function piFlags(): string[] {
  const extra = selected();
  return [
    ...BASE,
    // The list keeps a bot to its own tools. An extension the user switched on brings tools of its own, so it goes.
    ...(extra.length ? [] : ["--tools", TOOLS]),
    "-e", OWN,
    ...bridge(extra),
    ...extra.flatMap((target) => ["-e", target]),
  ];
}

/**
 * A bot's Pi for a chat shared with a friend. The user's extensions still load, since a bot's model can
 * come from one, but the tool list stays: only chat, theirs included. With `allowTools` it's the bot's
 * usual Pi.
 */
export function friendFlags(allowTools: boolean): string[] {
  if (allowTools) return piFlags();
  const extra = selected();
  return [...BASE, "--tools", FRIEND_TOOLS.join(","), "-e", OWN, ...bridge(extra), ...extra.flatMap((target) => ["-e", target])];
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
      svc.rememberModelNames(models);
      return { models, defaultModel: state.model ? `${state.model.provider}/${state.model.id}` : undefined, scope, checkedAt: Date.now() };
    } finally {
      proc.close();
    }
  })();
  cache = { key, at: Date.now(), value };
  value.catch(() => cache?.value === value && (cache = undefined));
  return value;
}
