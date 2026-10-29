import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { UsageResetResult } from "../../shared/usage";

export interface RedemptionAttempt {
  operationId: string;
  /** Persisted before the first mutation; never reselected on retry. */
  grant?: { creditId: string; organization: string };
  result?: UsageResetResult;
}
export interface RedemptionContext {
  attempt: RedemptionAttempt;
  pin: (grant: NonNullable<RedemptionAttempt["grant"]>) => Promise<void>;
}
export const validOperationId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(id);

/** No expiry/eviction: losing a dedup record could spend another credit. Files contain no tokens.
 * Cross-process lock is fail-closed. A crash leaving .lock requires operator recovery, NOT a TTL.
 */
export class RedemptionLedger {
  private chains = new Map<string, Promise<unknown>>();
  constructor(private root: () => string) {}

  run(account: string, operationId: string, consume: (context: RedemptionContext) => Promise<UsageResetResult>): Promise<UsageResetResult> {
    if (!validOperationId(operationId)) return Promise.reject(new Error("A stable operationId (16–128 letters, digits, _ or -) is required."));
    const previous = this.chains.get(account) ?? Promise.resolve();
    const run = previous.then(() => this.locked(account, operationId, consume));
    const tail = run.catch(() => undefined);
    this.chains.set(account, tail);
    void tail.finally(() => { if (this.chains.get(account) === tail) this.chains.delete(account); });
    return run;
  }

  private async locked(account: string, operationId: string, consume: (context: RedemptionContext) => Promise<UsageResetResult>) {
    const root = this.root();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const file = join(root, createHash("sha256").update(account).digest("hex") + ".json");
    const lock = file + ".lock";
    await mkdir(lock).catch(() => { throw new Error("Redemption ledger is locked. Retry later; a crash lock needs operator recovery."); });
    try {
      const text = await readFile(file, "utf8").catch((err) => { if (err.code === "ENOENT") return undefined; throw err; });
      const records: RedemptionAttempt[] = text === undefined ? [] : JSON.parse(text);
      if (!Array.isArray(records) || records.some(r => !validOperationId(r.operationId))) throw new Error("Invalid redemption ledger; refusing to spend.");
      let attempt = records.find(r => r.operationId === operationId);
      if (attempt?.result) return attempt.result;
      if (records.some(r => !r.result && r.operationId !== operationId)) throw new Error("An earlier reset is unconfirmed. Retry its original operationId before starting another.");
      const save = async () => {
        const tmp = file + ".tmp";
        const handle = await open(tmp, "w", 0o600);
        try { await handle.writeFile(JSON.stringify(records)); await handle.sync(); } finally { await handle.close(); }
        await rename(tmp, file);
        const dir = await open(root, "r");
        try { await dir.sync(); } finally { await dir.close(); }
      };
      if (!attempt) { attempt = { operationId }; records.push(attempt); await save(); }
      const current = attempt;
      const result = await consume({ attempt: current, pin: async grant => {
        if (current.grant) throw new Error("Reset grant already pinned.");
        current.grant = grant;
        await save();
      } });
      current.result = result;
      await save();
      return result;
    } finally { await rmdir(lock); }
  }
}
