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

export function setProviderOverrides(values: Record<string, ProviderOverride>) {
  for (const [id, value] of Object.entries(values)) {
    if (!value || typeof value !== "object") continue;
    const clean: ProviderOverride = {};
    if (typeof value.group === "string" && value.group.trim()) clean.group = value.group.trim();
    if (typeof value.name === "string" && value.name.trim()) clean.name = value.name.trim();
    if (clean.group || clean.name) overrides.set(id.toLowerCase(), clean);
  }
}

export function clearProviderOverrides() {
  overrides.clear();
}

export function providerOverride(id: string): ProviderOverride | undefined {
  return overrides.get(id.toLowerCase());
}
