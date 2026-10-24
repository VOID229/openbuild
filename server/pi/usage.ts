// A reply's tokens and cost, added up from the usage Pi records on each assistant message (one per
// model request). Shared by Pi threads, Durable threads and discovered sessions.
import type { TokenCounts, Usage } from "../../shared/types";

/** Pi's per-message usage (pi-ai's `Usage`). */
export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

/** Add one model request's usage; the last one added is what the context holds afterwards. */
export function addUsage(usage: Usage, u: PiUsage | undefined) {
  if (!u) return;
  const last: TokenCounts = { input: u.input || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0, output: u.output || 0 };
  // An aborted or failed request can come back without any counts; it changes nothing.
  if (!last.input && !last.cacheRead && !last.cacheWrite && !last.output) return;
  usage.input = (usage.input ?? 0) + last.input;
  usage.output = (usage.output ?? 0) + last.output;
  usage.cacheRead = (usage.cacheRead ?? 0) + last.cacheRead;
  usage.cacheWrite = (usage.cacheWrite ?? 0) + last.cacheWrite;
  usage.cost = (usage.cost ?? 0) + (u.cost?.total || 0);
  usage.firstPrompt ??= last.input + last.cacheRead + last.cacheWrite;
  usage.last = last;
  usage.contextTokens = last.input + last.cacheRead + last.cacheWrite + last.output;
}
