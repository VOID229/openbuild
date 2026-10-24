// Pi's model scope: the `enabledModels` patterns in a device's Pi settings (`pi --models` in a
// terminal), and the models they resolve to. helper.mjs resolves them with Pi's own SDK; this reads
// its answer and never throws, so a scope that can't be resolved leaves the model list as it was.
import type { ModelScope } from "../../shared/types";

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** The helper's `scope` record as a ModelScope, or undefined when the device has no usable scope. */
export function parseModelScope(record: any): ModelScope | undefined {
  if (!record || record.type !== "scope") return undefined;
  const patterns = Array.isArray(record.patterns) ? record.patterns.filter(str) : [];
  const models = Array.isArray(record.models)
    ? record.models.filter((m: any) => str(m?.provider) && str(m?.id)).map((m: any) => ({ provider: m.provider, id: m.id }))
    : [];
  // No patterns is no scope at all; patterns that match nothing are still a scope (the picker then
  // shows the selected model, and the way back to every model).
  if (!patterns.length && !models.length) return undefined;
  const diagnostics = Array.isArray(record.diagnostics)
    ? record.diagnostics.filter((d: any) => str(d?.message)).map((d: any) => ({ code: String(d.code ?? "warning"), pattern: String(d.pattern ?? ""), message: d.message }))
    : [];
  return diagnostics.length ? { patterns, models, diagnostics } : { patterns, models };
}
