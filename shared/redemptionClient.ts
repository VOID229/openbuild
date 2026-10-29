import type { UsageResetResult } from "./usage";

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
interface Operation { operationId: string; machine?: string }
export interface RedemptionState { busy: boolean; result?: UsageResetResult; error?: string }
const empty: RedemptionState = { busy: false };

/** Account-scoped state survives popover/tab unmounts. Pending identity survives page reload.
 * Storage must work before sending; failures are fail-closed. Never retries automatically.
 */
export function createRedemptionClient(storage: () => Storage, transport: (body: { id: string } & Operation) => Promise<UsageResetResult>, uuid: () => string) {
  const states = new Map<string, RedemptionState>();
  const listeners = new Set<() => void>();
  const update = (id: string, state: RedemptionState) => { states.set(id, state); listeners.forEach(f => f()); };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: (id: string) => states.get(id) ?? empty,
    async run(id: string, machine?: string) {
      if (states.get(id)?.busy || states.get(id)?.result) return;
      update(id, { busy: true });
      try {
        const key = `openbuild:reset:${id}`;
        const store = storage();
        const saved = store.getItem(key);
        const operation: Operation = saved ? JSON.parse(saved) : { operationId: uuid(), machine };
        if (typeof operation.operationId !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(operation.operationId)) throw new Error("Invalid saved reset identity; refusing to spend.");
        store.setItem(key, JSON.stringify(operation));
        const result = await transport({ id, ...operation });
        // Remember successful completion for this session; only explicit future sessions can start anew.
        update(id, { busy: false, result });
        store.removeItem(key);
      } catch (err) {
        update(id, { busy: false, error: `${(err as Error).message} Retry uses the same reset operation.` });
      }
    },
  };
}
