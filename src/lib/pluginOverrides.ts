// Provider metadata that plugins can change without the app importing the plugin registry (models.ts
// and modelSearch.ts stay plain data helpers). The plugin loader fills this in when a client module
// registers and clears it when plugins unload.
export interface ProviderOverride {
  /** The provider id to group this provider's models under, e.g. "pi-claude" → "claude". */
  group?: string;
  /** A display name for the raw provider id, when something shows it directly. */
  name?: string;
}

const overrides = new Map<string, ProviderOverride>();
// Provider groups in the order a plugin wants them in the picker rail: ["openai-codex", "claude", …].
// Lists from several plugins are merged in registration order, first mention winning.
const order: string[] = [];

export function setProviderOverrides(values: Record<string, ProviderOverride>) {
  for (const [id, value] of Object.entries(values)) {
    if (!value || typeof value !== "object") continue;
    const clean: ProviderOverride = {};
    if (typeof value.group === "string" && value.group.trim()) clean.group = value.group.trim();
    if (typeof value.name === "string" && value.name.trim()) clean.name = value.name.trim();
    if (clean.group || clean.name) overrides.set(id.toLowerCase(), clean);
  }
}

export function addProviderOrder(values: readonly string[]) {
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const id = value.trim().toLowerCase();
    if (!order.includes(id)) order.push(id);
  }
}

/** Where a provider group sits in a plugin's rail order; undefined = after every ordered group. */
export function providerOrder(group: string): number | undefined {
  const index = order.indexOf(group.toLowerCase());
  return index < 0 ? undefined : index;
}

export function clearProviderOverrides() {
  overrides.clear();
  order.length = 0;
}

/** Everything plugins set, for caching across page loads (see plugins.tsx). */
export function snapshotProviderOverrides(): { overrides: Record<string, ProviderOverride>; order: string[] } {
  return { overrides: Object.fromEntries(overrides), order: [...order] };
}

export function providerOverride(id: string): ProviderOverride | undefined {
  return overrides.get(id.toLowerCase());
}
