import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AcpProcess } from "../fx/acp";
import type { ModelInfo } from "../../shared/types";
export const HERMES_INSTALL = "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash";
export const hermesEnv = () => ({ ...process.env, NO_COLOR: "1", PATH: `${join(homedir(), ".local/bin")}:${process.env.PATH ?? ""}` }) as Record<string, string>;
export function hermesBin() {
  if (process.env.HERMES_BIN) return existsSync(process.env.HERMES_BIN) ? process.env.HERMES_BIN : undefined;
  return Bun.which("hermes", { PATH: hermesEnv().PATH }) ?? undefined;
}
export function hermesProgram() {
  const bin = hermesBin();
  if (!bin) throw new Error(`Hermes isn't installed. Install with: ${HERMES_INSTALL}`);
  return { name: "Hermes", command: [bin, "acp"], env: hermesEnv() };
}
export async function status() {
  const bin = hermesBin();
  if (!bin) return { installed: false, install: HERMES_INSTALL };
  const p = Bun.spawn([bin, "--version"], { env: hermesEnv(), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), 10000);
  try { const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); return { installed: true, bin, version: out.trim(), install: HERMES_INSTALL, error: code ? err.trim() : undefined }; }
  finally { clearTimeout(timer); }
}
let cache: Promise<{ models: ModelInfo[]; defaultModel?: string; checkedAt: number }> | undefined;
let checked = 0;
export const forgetModels = () => { cache = undefined; };
export function listModels(fresh = false) {
  if (!fresh && cache && Date.now() - checked < 60000) return cache;
  checked = Date.now();
  const value = (async () => {
    const proc = new AcpProcess(homedir(), hermesProgram());
    try {
      await proc.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const s = await proc.request<any>("session/new", { cwd: homedir(), mcpServers: [] }, 60000);
      const models: ModelInfo[] = (s.models?.availableModels ?? []).map((m: any) => ({ id: `hermes/${m.modelId}`, name: m.name ?? m.modelId, protocol: "chat", reasoning: { efforts: [], mode: "none", toggle: false }, input: ["text", "image"], tools: true, provider: "hermes", providerName: "Hermes", billing: "api" }));
      if (!models.length) throw new Error("Hermes returned no models. Run `hermes setup` on this device.");
      return { models, defaultModel: s.models?.currentModelId ? `hermes/${s.models.currentModelId}` : undefined, checkedAt: Date.now() };
    } finally { proc.close(); }
  })();
  cache = value;
  value.catch(() => { if (cache === value) cache = undefined; });
  return value;
}
