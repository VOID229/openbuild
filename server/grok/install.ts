// Finding the Grok Build install OpenBuild drives. It's never bundled: the server runs whatever
// `grok` this user installed (its installer puts it in ~/.local/bin), or GROK_BIN. Its own settings,
// sign-in, skills, hooks and MCP servers apply unchanged.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Effort, ModelInfo } from "../../shared/types";
import { AcpProcess, type AcpProgram } from "../fx/acp";

export const GROK_INSTALL = "curl -fsSL https://x.ai/cli/install.sh | bash";

export function grokEnv(): Record<string, string> {
  const env = { ...process.env, NO_COLOR: "1" } as Record<string, string>;
  env.PATH = [join(homedir(), ".local", "bin"), env.PATH ?? ""].join(":");
  return env;
}

/** The `grok` executable, or undefined when Grok Build isn't installed. */
export function grokBin(): string | undefined {
  if (process.env.GROK_BIN) return existsSync(process.env.GROK_BIN) ? process.env.GROK_BIN : undefined;
  return Bun.which("grok", { PATH: `${grokEnv().PATH}:/opt/homebrew/bin:/usr/local/bin` }) ?? undefined;
}

/** A thread's own agent process: never a shared leader, whose turns would stop with it. */
export function grokProgram(): AcpProgram {
  const bin = grokBin();
  if (!bin) throw new Error(`Grok Build isn't installed on this device. Install it with: ${GROK_INSTALL}`);
  return { name: "Grok", command: [bin, "agent", "--no-leader", "stdio"], env: grokEnv() };
}

async function run(args: string[], timeoutMs = 20_000): Promise<{ code: number; out: string; err: string }> {
  const bin = grokBin();
  if (!bin) return { code: 127, out: "", err: "Grok Build isn't installed" };
  const proc = Bun.spawn([bin, ...args], { cwd: homedir(), stdout: "pipe", stderr: "pipe", stdin: "ignore", env: grokEnv() });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, out: out.trim(), err: err.trim() };
}

/** `grok models`: "You are logged in with grok.com." and a list, the default marked. */
export function parseModels(out: string): { ids: string[]; defaultId?: string; account?: string } {
  const ids: string[] = [];
  let defaultId: string | undefined;
  for (const line of out.split("\n")) {
    const m = /^\s*[*-]\s+(\S+)(\s+\(default\))?\s*$/.exec(line);
    if (!m) continue;
    ids.push(m[1]!);
    if (m[2]) defaultId = m[1];
  }
  return { ids, defaultId, account: /logged in with (.+?)\.?\s*$/m.exec(out)?.[1] };
}

/** The newest release on this install's channel, asked of Grok itself; it installs nothing. */
export async function latestRelease(): Promise<string | undefined> {
  const r = await run(["update", "--check", "--json"]);
  let check: { latestVersion?: string; error?: string | null };
  try {
    check = JSON.parse(r.out);
  } catch {
    throw new Error(r.err || `grok update --check exited with ${r.code}`);
  }
  if (check.error) throw new Error(check.error);
  return check.latestVersion;
}

export interface GrokStatus {
  installed: boolean;
  bin?: string;
  version?: string;
  provider?: string;
  connected?: string[];
  install: string;
  error?: string;
}

export async function status(): Promise<GrokStatus> {
  const bin = grokBin();
  if (!bin) return { installed: false, install: GROK_INSTALL };
  const [v, m] = await Promise.all([run(["--version"]), run(["models"])]);
  const { account } = parseModels(m.out);
  return {
    installed: v.code === 0,
    bin,
    version: v.out,
    provider: "grok",
    connected: account ? [account] : [],
    install: GROK_INSTALL,
    ...(m.code !== 0 ? { error: m.err.split("\n").pop() || "Couldn't list Grok's models" } : {}),
  };
}

interface Details { name?: string; contextLimit?: number; efforts: Effort[] }
const EFFORT_LEVELS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const detailsOf = (list: unknown): Map<string, Details> => new Map((Array.isArray(list) ? list : []).map((m: any) => {
  const levels = (m?._meta?.reasoningEfforts ?? []).map((e: any) => e?.value);
  return [String(m?.modelId), {
    name: m?.name,
    contextLimit: typeof m?._meta?.totalContextTokens === "number" ? m._meta.totalContextTokens : undefined,
    efforts: m?._meta?.supportsReasoningEffort ? EFFORT_LEVELS.filter((e) => levels.includes(e)) : [],
  }];
}));

/**
 * Names, efforts and context windows come only from the agent's initialize. It answers from a cache
 * and pushes the account's current list straight after, so wait briefly for that. Nothing is saved.
 */
async function modelDetails(): Promise<Map<string, Details>> {
  const proc = new AcpProcess(homedir(), grokProgram());
  try {
    let fresh!: (list: unknown) => void;
    const pushed = new Promise<unknown>((r) => (fresh = r));
    proc.on((m) => { if (m.method === "_x.ai/models/update") fresh(m.params?.availableModels); });
    const init = await proc.request<any>("initialize", { protocolVersion: 1, clientCapabilities: {} }, 15_000);
    const timer = new Promise<undefined>((r) => setTimeout(() => r(undefined), 4_000));
    const list = (await Promise.race([pushed, timer])) ?? init?._meta?.modelState?.availableModels;
    return detailsOf(list);
  } finally {
    proc.close();
  }
}

export interface GrokModels {
  models: ModelInfo[];
  defaultModel?: string;
  checkedAt: number;
}

let cache: { at: number; value: Promise<GrokModels> } | undefined;

/** The models Grok can use with its current sign-in. Their ids are "grok/<grok model id>". */
export function listModels(fresh = false): Promise<GrokModels> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.value;
  const value = (async (): Promise<GrokModels> => {
    if (!grokBin()) throw new Error(`Grok Build isn't installed on this device. Install it with: ${GROK_INSTALL}`);
    const m = await run(["models"]);
    const { ids, defaultId, account } = parseModels(m.out);
    if (!ids.length) throw new Error(m.err.split("\n").pop() || "Grok didn't list any models. Sign in with `grok login`.");
    // A model missing here still works: it just offers no effort control.
    const details = await modelDetails().catch(() => new Map<string, Details>());
    const models: ModelInfo[] = ids.map((id) => {
      const d = details.get(id);
      return {
        id: `grok/${id}`,
        name: d?.name ?? id,
        protocol: "chat",
        reasoning: { efforts: d?.efforts ?? [], mode: d?.efforts.length ? "effort" : "none", toggle: false },
        input: ["text", "image"],
        contextLimit: d?.contextLimit,
        tools: true,
        provider: "xai",
        providerName: "Grok",
        billing: account === "grok.com" ? "plan" : "api",
      };
    });
    return { models, defaultModel: defaultId ? `grok/${defaultId}` : undefined, checkedAt: Date.now() };
  })();
  cache = { at: Date.now(), value };
  value.catch(() => cache?.value === value && (cache = undefined));
  return value;
}

export const forgetModels = () => (cache = undefined);
