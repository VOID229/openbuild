// A Pi extension OpenBuild loads (`-e`) into every thread's `pi --mode rpc` process. It applies the
// speed (provider service tier) picked in the composer: Codex/OpenAI Responses take it as
// `service_tier`, Anthropic as `speed` (with the fast-mode beta header). Pi has no setting for this.
//
// sessions.ts writes the thread's choice to a small JSON file before each turn, `{ model, speed }`,
// and passes its path with `--openbuild-speed-file`. The speed only applies while that model is the
// one being called, so a model switch inside Pi (or a compaction on another model) runs at standard.
//
// No imports beyond Node's: Pi loads this file on its own.

import { readFileSync } from "node:fs";

export const FLAG = "openbuild-speed-file";
const FAST_MODE_BETA = "fast-mode-2026-02-01";

/** The speed for the model being called, if the thread picked one for it. */
export function chosenSpeed(file: string | undefined, model: { provider?: string; id?: string } | undefined): string | undefined {
  if (!file || !model?.provider || !model.id) return undefined;
  try {
    const c = JSON.parse(readFileSync(file, "utf8"));
    return c && c.model === `${model.provider}/${model.id}` && typeof c.speed === "string" && /^[a-z0-9_-]{1,32}$/i.test(c.speed) ? c.speed : undefined;
  } catch {
    return undefined;
  }
}

/** The request body with the speed set the way the model's API takes it. */
export function withSpeed(payload: any, api: string | undefined, speed: string): any {
  if (!payload || typeof payload !== "object") return payload;
  if (api === "anthropic-messages") return { ...payload, speed };
  if (api === "openai-codex-responses" || api === "openai-responses") return { ...payload, service_tier: speed };
  return payload;
}

export default function speed(pi: any) {
  pi.registerFlag(FLAG, { type: "string", description: "OpenBuild: file holding the thread's speed choice" });
  const file = () => {
    const f = pi.getFlag(FLAG);
    return typeof f === "string" && f ? f : undefined;
  };

  pi.on("before_provider_headers", (event: any, ctx: any) => {
    if (ctx.model?.api !== "anthropic-messages" || !chosenSpeed(file(), ctx.model)) return;
    const headers = event.headers ?? {};
    const key = Object.keys(headers).find((k) => k.toLowerCase() === "anthropic-beta") ?? "anthropic-beta";
    const betas = String(headers[key] ?? "").split(",").map((b) => b.trim()).filter(Boolean);
    if (!betas.includes(FAST_MODE_BETA)) headers[key] = [...betas, FAST_MODE_BETA].join(",");
  });

  pi.on("before_provider_request", (event: any, ctx: any) => {
    const s = chosenSpeed(file(), ctx.model);
    return s ? withSpeed(event.payload, ctx.model?.api, s) : undefined;
  });
}
