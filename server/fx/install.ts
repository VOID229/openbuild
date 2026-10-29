// Finding the fx install OpenBuild drives. fx (Vercel Labs' coding agent, https://fx.sh) is never
// bundled: the server runs whatever `fx` this user installed (its installer puts it in
// ~/.local/bin), or FX_BIN. Its own settings, sign-ins, skills and MCP servers apply unchanged.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Effort, ModelInfo } from "../../shared/types";

export const FX_INSTALL = "curl -fsSL https://fx.sh/setup.sh | bash";

/** The `fx` executable, or undefined when fx isn't installed. */
export function fxBin(): string | undefined {
  if (process.env.FX_BIN) return existsSync(process.env.FX_BIN) ? process.env.FX_BIN : undefined;
  return Bun.which("fx", { PATH: `${join(homedir(), ".local", "bin")}:${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` }) ?? undefined;
}

/** Environment for fx: its install dir on PATH, and no interactive onboarding or auto-upgrade mid-turn. */
export function fxEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  env.PATH = [join(homedir(), ".local", "bin"), env.PATH ?? ""].join(":");
  env.FX_SKIP_ONBOARDING ??= "1";
  env.FX_NO_OPEN_BROWSER ??= "1";
  env.FX_AUTO_UPGRADE ??= "0";
  return env;
}

async function run(args: string[], timeoutMs = 20_000): Promise<{ code: number; out: string; err: string }> {
  const bin = fxBin();
  if (!bin) return { code: 127, out: "", err: "fx isn't installed" };
  const proc = Bun.spawn([bin, ...args], { cwd: homedir(), stdout: "pipe", stderr: "pipe", stdin: "ignore", env: fxEnv() });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
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
  install: string;
}

export async function status(): Promise<FxStatus> {
  const bin = fxBin();
  if (!bin) return { installed: false, install: FX_INSTALL };
  const [v, s] = await Promise.all([run(["--version"]), run(["status", "--json"])]);
  const st = json(s.out);
  return {
    installed: v.code === 0,
    bin,
    version: v.out.split("\n").pop()?.trim(),
    model: st?.model,
    effort: st?.effort,
    provider: st?.auth ?? st?.model_source,
    connected: Array.isArray(st?.connected_providers) ? st.connected_providers : undefined,
    install: FX_INSTALL,
  };
}

/** fx's provider names ("Codex subscription", "Vercel AI Gateway"…) as the icon ids the picker knows. */
function providerOf(source: string | undefined, id: string): string {
  const s = (source ?? "").toLowerCase();
  if (s.includes("codex")) return "codex";
  if (s.includes("grok")) return "xai";
  if (id.includes("/")) return id.slice(0, id.indexOf("/"));
  return "vercel";
}

const EFFORT_LEVELS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface FxModels {
  models: ModelInfo[];
  defaultModel?: string;
  checkedAt: number;
}

let cache: { at: number; value: Promise<FxModels> } | undefined;

/** The models fx can use with its current sign-in. Their ids are "fx/<fx model id>". */
export function listModels(fresh = false): Promise<FxModels> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.value;
  const value = (async (): Promise<FxModels> => {
    if (!fxBin()) throw new Error(`fx isn't installed on this device. Install it with: ${FX_INSTALL}`);
    const [m, s] = await Promise.all([run(["models", "--json"]), run(["status", "--json"])]);
    const listed = json(m.out);
    if (!listed || !Array.isArray(listed.models)) throw new Error(m.err.split("\n").pop() || "fx didn't list any models. Sign in with `fx login`.");
    const st = json(s.out);
    // fx 0.0.12+ reports a reasoning effort setting; older builds pick it themselves.
    const efforts = typeof st?.effort === "string" ? EFFORT_LEVELS : [];
    const models: ModelInfo[] = listed.models.map((x: { id: string; source?: string }) => ({
      id: `fx/${x.id}`,
      name: x.id,
      protocol: "chat",
      reasoning: { efforts, mode: efforts.length ? "effort" : "none", toggle: false },
      input: ["text", "image"],
      tools: true,
      provider: providerOf(x.source, x.id),
      providerName: x.source,
      billing: x.source?.toLowerCase().includes("subscription") ? "plan" : "api",
    }));
    return { models, defaultModel: typeof st?.model === "string" ? `fx/${st.model}` : undefined, checkedAt: Date.now() };
  })();
  cache = { at: Date.now(), value };
  value.catch(() => cache?.value === value && (cache = undefined));
  return value;
}

export const forgetModels = () => (cache = undefined);
