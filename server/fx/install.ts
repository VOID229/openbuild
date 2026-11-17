// Finding the fx install OpenBuild drives. fx (Vercel Labs' coding agent, https://fx.sh) is never
// bundled: the server runs whatever `fx` this user installed (its installer puts it in
// ~/.local/bin), or FX_BIN. Its own settings, sign-ins, skills and MCP servers apply unchanged.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Effort, ModelInfo } from "../../shared/types";
import { shellVariables } from "../shellEnv";

export const FX_INSTALL = "curl -fsSL https://fx.sh/setup.sh | bash";

/** The `fx` executable, or undefined when fx isn't installed. */
export function fxBin(): string | undefined {
  if (process.env.FX_BIN) return existsSync(process.env.FX_BIN) ? process.env.FX_BIN : undefined;
  return Bun.which("fx", { PATH: `${join(homedir(), ".local", "bin")}:${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` }) ?? undefined;
}

/**
 * Environment for fx: its install dir on PATH, no interactive onboarding or auto-upgrade mid-turn,
 * and the variables its custom providers read their keys and headers from (see prepare()).
 */
export function fxEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  env.PATH = [join(homedir(), ".local", "bin"), env.PATH ?? ""].join(":");
  env.FX_SKIP_ONBOARDING ??= "1";
  env.FX_NO_OPEN_BROWSER ??= "1";
  env.FX_AUTO_UPGRADE ??= "0";
  // Empty counts as unset, as it does for finding them (prepare) and for saying what's missing.
  for (const [name, value] of Object.entries(prepared?.value.vars ?? {})) if (!env[name]) env[name] = value;
  // A session id header ("x-opencode-session") is one per run: a shell wrapper makes a new one for
  // each `fx` it starts, so each fx process OpenBuild starts gets its own.
  for (const name of prepared?.value.sessionVars ?? []) env[name] ||= crypto.randomUUID();
  return env;
}

// ------------------------------------------------------------------ providers fx's settings define

/** A provider set up in fx's settings ("providers.<name>"), with the variables it reads its key and headers from. */
export interface FxCustomProvider {
  name: string;
  keyEnv?: string;
  headerEnv: { header: string; env: string }[];
}

/** fx's own providers; the rest are the ones its settings define. */
export const BUILTIN_PROVIDERS = ["gateway", "codex", "grok"];

/** The custom providers in `fx config list --json`'s entries. */
export function customProviders(entries: unknown): FxCustomProvider[] {
  const byName = new Map<string, FxCustomProvider>();
  const of = (name: string) => byName.get(name) ?? byName.set(name, { name, headerEnv: [] }).get(name)!;
  for (const e of Array.isArray(entries) ? entries : []) {
    const key = typeof e?.key === "string" ? e.key : "";
    const value = typeof e?.value === "string" ? e.value : undefined;
    let m: RegExpExecArray | null;
    if ((m = /^providers\.(.+)\.auth\.env$/.exec(key))) {
      if (value) of(m[1]!).keyEnv = value;
    } else if ((m = /^providers\.(.+)\.headers\.([^.]+)\.env$/.exec(key))) {
      if (value) of(m[1]!).headerEnv.push({ header: m[2]!, env: value });
    } else if ((m = /^providers\.(.+)\.(protocol|base_url)$/.exec(key))) of(m[1]!);
  }
  return [...byName.values()].filter((p) => !BUILTIN_PROVIDERS.includes(p.name));
}

/** A header whose value names one run rather than an account: OpenBuild makes one up when nothing sets it. */
const isSessionHeader = (h: { header: string; env: string }) => /session/i.test(h.header) || /SESSION/i.test(h.env);

interface Prepared {
  providers: FxCustomProvider[];
  /** Values found in the user's shell for variables the server's own environment lacks. */
  vars: Record<string, string>;
  /** Session header variables nothing sets. */
  sessionVars: string[];
}

let prepared: { at: number; value: Prepared } | undefined;
let preparing: Promise<Prepared> | undefined;

/** Whether a variable is set for fx (the server's environment, or what the user's shell sets). */
const hasVar = (name: string, p: Prepared) => !!process.env[name] || !!p.vars[name];

/** The variables a provider needs and doesn't have. */
export function missingVars(provider: FxCustomProvider, p: Prepared | undefined = prepared?.value): string[] {
  const all = [provider.keyEnv, ...provider.headerEnv.filter((h) => !isSessionHeader(h)).map((h) => h.env)].filter((n): n is string => !!n);
  return p ? all.filter((n) => !hasVar(n, p)) : all;
}

/**
 * Read fx's custom providers and find the variables they need. fx's settings name environment
 * variables for keys and headers (`"auth": {"env": "OPENCODE_GO_API_KEY"}`), which people export
 * from their shell profile; OpenBuild's server doesn't run one, so it asks the user's shell for them.
 * Cached; a result with something missing is asked again a little later.
 */
export function prepare(fresh = false): Promise<Prepared> {
  const ttl = prepared && prepared.value.providers.some((p) => missingVars(p, prepared!.value).length) ? 2 * 60_000 : 10 * 60_000;
  if (!fresh && prepared && Date.now() - prepared.at < ttl) return Promise.resolve(prepared.value);
  return (preparing ??= (async (): Promise<Prepared> => {
    const config = await run(["config", "list", "--json"], { raw: true });
    const providers = customProviders(json(config.out)?.entries);
    const wanted = providers.flatMap((p) => [p.keyEnv, ...p.headerEnv.map((h) => h.env)]).filter((n): n is string => !!n && !process.env[n]);
    const vars = wanted.length ? await shellVariables(wanted) : {};
    const sessionVars = providers.flatMap((p) => p.headerEnv.filter((h) => isSessionHeader(h) && !process.env[h.env] && !vars[h.env]).map((h) => h.env));
    const value = { providers, vars, sessionVars };
    prepared = { at: Date.now(), value };
    return value;
  })().finally(() => (preparing = undefined)));
}

export const forgetProviders = () => (prepared = undefined);

/** All the providers fx may use: its own and the ones its settings define. */
export async function providerNames(): Promise<string[]> {
  return [...BUILTIN_PROVIDERS, ...(await prepare()).providers.map((p) => p.name)];
}

/**
 * A picker model id ("fx/<provider>/<model>") as fx's provider and model. Ids from before fx had
 * several providers ("fx/<model>") have none: fx uses its default provider for them.
 */
export function splitModel(id: string, providers: string[]): { provider?: string; model: string } {
  const rest = id.startsWith("fx/") ? id.slice(3) : id;
  const slash = rest.indexOf("/");
  if (slash > 0 && providers.includes(rest.slice(0, slash))) return { provider: rest.slice(0, slash), model: rest.slice(slash + 1) };
  return { model: rest };
}

/**
 * Why fx can't use a provider OpenBuild was asked for, if a variable it needs is missing. fx's own
 * error would be about the Vercel AI Gateway, which it falls back to.
 */
export async function providerProblem(provider: string | undefined): Promise<string | undefined> {
  if (!provider) return undefined;
  const p = await prepare();
  const custom = p.providers.find((x) => x.name === provider);
  const missing = custom ? missingVars(custom, p) : [];
  if (!missing.length) return undefined;
  return `fx's ${provider} provider reads ${missing.join(" and ")} from the environment, and neither OpenBuild's nor your shell's sets it. Export it in your shell profile (~/.bashrc, ~/.zshrc), then try again.`;
}

async function run(args: string[], opts: { timeoutMs?: number; env?: Record<string, string>; raw?: boolean } = {}): Promise<{ code: number; out: string; err: string }> {
  const bin = fxBin();
  if (!bin) return { code: 127, out: "", err: "fx isn't installed" };
  if (!opts.raw) await prepare();
  const proc = Bun.spawn([bin, ...args], { cwd: homedir(), stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...fxEnv(), ...opts.env } });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 20_000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, out: out.trim(), err: err.trim() };
}

const json = (text: string) => {
  try {
    return JSON.parse(text.slice(text.indexOf("{")));
  } catch {
    return undefined;
  }
};

export interface FxStatus {
  installed: boolean;
  bin?: string;
  version?: string;
  model?: string;
  effort?: string;
  provider?: string;
  connected?: string[];
  /** The release channel `fx upgrade` follows. */
  channel?: string;
  install: string;
}

export async function status(): Promise<FxStatus> {
  const bin = fxBin();
  if (!bin) return { installed: false, install: FX_INSTALL };
  const [v, s] = await Promise.all([run(["--version"], { raw: true }), run(["status", "--json"])]);
  const st = json(s.out);
  return {
    installed: v.code === 0,
    bin,
    version: v.out.split("\n").pop()?.trim(),
    model: st?.model,
    effort: st?.effort,
    provider: st?.auth ?? st?.model_source,
    connected: Array.isArray(st?.connected_providers) ? st.connected_providers : undefined,
    channel: st?.update_channel,
    install: FX_INSTALL,
  };
}

/** The provider fx names in a model's source or its status ("Codex subscription", "Vercel AI Gateway"…), as its own id. */
export function providerId(source: string | undefined): string | undefined {
  const s = (source ?? "").trim().toLowerCase();
  if (!s) return undefined;
  if (s.includes("gateway") || s === "vercel") return "gateway";
  if (s.includes("codex")) return "codex";
  if (s.includes("grok")) return "grok";
  return source!.trim();
}

/**
 * The picker group (and icon) for a fx provider's models: one per provider, so the gateway's
 * "xai/…" models don't land among the Grok sign-in's. The picker knows the gateway as "vercel".
 */
const groupOf = (provider: string) => (provider === "gateway" ? "vercel" : provider);

const EFFORT_LEVELS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface FxModels {
  models: ModelInfo[];
  defaultModel?: string;
  checkedAt: number;
}

type Listed = { id: string; source?: string };

function modelInfo(x: Listed, id: string, provider: string | undefined, efforts: Effort[]): ModelInfo {
  return {
    id,
    name: x.id,
    protocol: "chat",
    reasoning: { efforts, mode: efforts.length ? "effort" : "none", toggle: false },
    input: ["text", "image"],
    tools: true,
    provider: groupOf(provider ?? providerId(x.source) ?? "gateway"),
    providerName: x.source,
    billing: x.source?.toLowerCase().includes("subscription") ? "plan" : "api",
  };
}

/** One provider's models, if fx can use it: `FX_PROVIDER` picks it for one run, as fx's --provider does. */
async function providerModels(provider: string): Promise<ModelInfo[]> {
  const env = { FX_PROVIDER: provider };
  const st = json((await run(["status", "--json"], { env })).out);
  // Not signed in (or the variables its settings name aren't set), or an fx that ignored FX_PROVIDER.
  if (!st || st.auth === "missing" || (providerId(st.model_source) ?? "gateway") !== provider) return [];
  const listed = json((await run(["models", "--json"], { env })).out);
  if (!Array.isArray(listed?.models)) return [];
  const efforts = typeof st.effort === "string" ? EFFORT_LEVELS : [];
  return (listed.models as Listed[])
    .filter((x) => typeof x?.id === "string" && (providerId(x.source) ?? provider) === provider)
    .map((x) => modelInfo(x, `fx/${provider}/${x.id}`, provider, efforts));
}

let cache: { at: number; value: Promise<FxModels> } | undefined;

/**
 * The models of every provider fx can use: its own (Vercel AI Gateway, Codex and Grok sign-ins) and
 * the ones its settings define (OpenCode Go, OpenRouter…). Their ids are "fx/<provider>/<fx model id>".
 * An fx that can't list them by provider gives its current provider's, as "fx/<fx model id>".
 */
export function listModels(fresh = false): Promise<FxModels> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.value;
  const value = (async (): Promise<FxModels> => {
    if (!fxBin()) throw new Error(`fx isn't installed on this device. Install it with: ${FX_INSTALL}`);
    await prepare(fresh);
    const names = await providerNames();
    const [s, ...lists] = await Promise.all([run(["status", "--json"]), ...names.map(providerModels)]);
    const st = json(s.out);
    const current = providerId(st?.model_source) ?? (st?.auth && st.auth !== "missing" ? "gateway" : undefined);
    // The provider fx is set to first: the picker opens on the first one.
    const at = names.indexOf(current ?? "");
    const models = (at > 0 ? [lists[at]!, ...lists.filter((_, i) => i !== at)] : lists).flat();
    if (models.length) {
      const defaultModel = current && typeof st?.model === "string" ? `fx/${current}/${st.model}` : undefined;
      return { models, defaultModel: models.some((m) => m.id === defaultModel) ? defaultModel : undefined, checkedAt: Date.now() };
    }
    // An older fx: what `fx models` lists.
    const m = await run(["models", "--json"]);
    const listed = json(m.out);
    if (!listed || !Array.isArray(listed.models)) throw new Error(m.err.split("\n").pop() || "fx didn't list any models. Sign in with `fx login`.");
    // fx 0.0.12+ reports a reasoning effort setting; older builds pick it themselves.
    const efforts = typeof st?.effort === "string" ? EFFORT_LEVELS : [];
    return {
      models: (listed.models as Listed[]).map((x) => modelInfo(x, `fx/${x.id}`, undefined, efforts)),
      defaultModel: typeof st?.model === "string" ? `fx/${st.model}` : undefined,
      checkedAt: Date.now(),
    };
  })();
  cache = { at: Date.now(), value };
  value.catch(() => cache?.value === value && (cache = undefined));
  return value;
}

export const forgetModels = () => {
  cache = undefined;
  forgetProviders();
};
