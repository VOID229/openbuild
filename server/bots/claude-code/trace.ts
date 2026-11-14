// OpenBuild: when PI_CLAUDE_CODE_TRACE names a file, each step of a request is written there as a
// JSON line with the time it happened (scripts/bot-turn-timeline.ts reads it). Off otherwise.
// Times and counts only: never a prompt, a reply or a credential.
import { appendFileSync } from "node:fs";

const file = process.env.PI_CLAUDE_CODE_TRACE;

/** How big a request's parts are, in characters of JSON: its tool declarations, its system prompt and its messages. Only worked out while tracing. */
export function requestSizes(body: Buffer): Record<string, number> {
  if (!file) return {};
  try {
    const payload = JSON.parse(body.toString("utf8")) as { tools?: unknown[]; system?: unknown; messages?: unknown[] };
    const size = (value: unknown) => (value === undefined ? 0 : JSON.stringify(value).length);
    return { toolChars: size(payload.tools), tools: payload.tools?.length ?? 0, systemChars: size(payload.system), messageChars: size(payload.messages), messages: payload.messages?.length ?? 0 };
  } catch {
    return {};
  }
}

export function trace(step: string, data: Record<string, number | string | boolean | undefined> = {}): void {
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), pid: process.pid, step, ...data })}\n`);
  } catch {
    // A trace that can't be written must not fail the request.
  }
}
