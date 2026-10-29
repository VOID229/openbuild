import { homedir } from "node:os";
import { EFFORTS, type Effort, type ModelInfo } from "../../shared/types";
import { connect, locationQuery, opencodeBin } from "./connection";
export { opencodeBin } from "./connection";
export const OPENCODE_INSTALL = "npm install -g @opencode/cli";
export interface OpenCodeStatus { installed: boolean; bin?: string; version?: string; provider?: string; connected?: string[]; install: string; error?: string }
export async function status(): Promise<OpenCodeStatus> {
  const bin = opencodeBin();
  if (!bin && !process.env.OPENCODE_SERVER_URL) return { installed: false, install: OPENCODE_INSTALL };
  let c;
  try {
    c = await connect();
    const models = await c.request(`/api/model?${locationQuery(homedir())}`);
    if (!Array.isArray(models?.data)) throw new Error("Invalid OpenCode 2 model list");
    return { installed: true, bin, version: c.version, provider: "opencode", connected: [...new Set<string>(models.data.filter((m: any) => m.enabled).map((m: any) => m.providerID))], install: OPENCODE_INSTALL };
  } catch (e) { return { installed: !!bin, bin, install: OPENCODE_INSTALL, error: String(e) }; }
  finally { await c?.close(); }
}
export const modelId = (m: any) => `opencode/${m.providerID}/${m.id}`;
export function modelRow(m: any): ModelInfo {
  const efforts: Effort[] = (m.variants ?? []).map((v: any) => v.id).filter((v: any) => EFFORTS.includes(v));
  return { id: modelId(m), name: m.name ?? m.id, provider: m.providerID, providerName: m.providerID, protocol: "chat", input: m.capabilities?.input ?? ["text"], tools: m.capabilities?.tools ?? false, contextLimit: m.limit?.context, outputLimit: m.limit?.output, reasoning: { efforts, mode: efforts.length ? "effort" : "none", toggle: false } };
}
export interface OpenCodeModels { models: ModelInfo[]; defaultModel?: string; checkedAt: number }
let cache: { at: number; value: Promise<OpenCodeModels> } | undefined;
export function listModels(fresh = false): Promise<OpenCodeModels> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.value;
  const value = (async () => {
    const c = await connect();
    try {
      const q = locationQuery(homedir());
      const [r, d] = await Promise.all([c.request(`/api/model?${q}`), c.request(`/api/model/default?${q}`)]);
      if (!Array.isArray(r?.data)) throw new Error("Invalid OpenCode 2 model list");
      return { models: r.data.filter((m: any) => m.enabled).map(modelRow), defaultModel: d?.data ? modelId(d.data) : undefined, checkedAt: Date.now() };
    } finally { await c.close(); }
  })();
  cache = { at: Date.now(), value };
  value.catch(() => { if (cache?.value === value) cache = undefined; });
  return value;
}
export function forgetModels() { cache = undefined; }
