// OpenBuild plugins: a folder with a plugin.json manifest and optional client.tsx, server.ts and
// styles.css. Shared by the server (loading, validating, building) and the app (slot registry and
// the Plugins settings page), so both agree on what a plugin is.

export const PLUGIN_API_VERSION = 1;

/** Slots the app renders. A plugin may name any slot; only these show up. */
export const SLOT_NAMES = [
  "app:before",
  "app:overlay",
  "home:above-composer",
  "home:below-composer",
  "sidebar:header",
  "sidebar:footer",
  "chat:header",
  "chat:before-messages",
  "composer:above",
  "composer:toolbar",
  "composer:below",
  "message:actions",
  "message:user-actions",
  "settings:appearance:after",
] as const;

export type PluginSlotName = (typeof SLOT_NAMES)[number];

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  description?: string;
  /** Relative file names inside the plugin's folder. */
  client?: string;
  server?: string;
  styles?: string;
  /** Slots the plugin fills, for listing before its client module loads. */
  slots?: string[];
  /** CSS custom properties applied while the plugin is enabled. */
  tokens?: Record<string, string>;
  /** CSS selectors hidden while the plugin is enabled. */
  hide?: string[];
  /** Load this plugin on first run. Default true; set false to ship an example turned off. */
  defaultEnabled?: boolean;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  description?: string;
  client: boolean;
  server: boolean;
  styles: boolean;
  slots: string[];
  /** Applied while the plugin is enabled. */
  tokens?: Record<string, string>;
  hide?: string[];
  clientUrl?: string;
  stylesUrl?: string;
  /** Why this plugin can't load, if it can't. */
  error?: string;
  /** The server module ran (or tried to) for this browser's request. */
  serverLoaded?: boolean;
}

export interface PluginsResponse {
  /** The folder plugins are read from (shown in Settings). */
  dir: string;
  /** The master switch. Off on first run; also false in safe mode. */
  enabled: boolean;
  /** OPENBUILD_SAFE=1 or `?safe`: the app loads with no plugins. */
  safe: boolean;
  /** A custom.css file is being served at /api/plugins/custom.css. */
  customCss: boolean;
  plugins: PluginInfo[];
  disabled: string[];
}

export interface PluginState {
  disabled: string[];
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RELATIVE_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

export const isPluginId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

/** A file path from a manifest: relative, inside the plugin folder, no traversal. */
export const isPluginFile = (value: unknown): value is string => typeof value === "string" && value.length <= 200 && RELATIVE_FILE.test(value);

export interface ManifestResult {
  manifest?: PluginManifest;
  error?: string;
}

/** Validate plugin.json. A bad manifest is reported in Settings rather than crashing startup. */
export function validateManifest(value: unknown): ManifestResult {
  if (!value || typeof value !== "object") return { error: "plugin.json must be an object" };
  const v = value as Record<string, unknown>;
  if (!isPluginId(v.id)) return { error: "id must be lowercase letters, numbers, dots, dashes or underscores" };
  if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 80) return { error: "name must be 1–80 characters" };
  if (typeof v.version !== "string" || !v.version.trim() || v.version.length > 40) return { error: "version must be 1–40 characters" };
  if (v.apiVersion !== PLUGIN_API_VERSION) return { error: `apiVersion must be ${PLUGIN_API_VERSION}` };
  if (v.description !== undefined && (typeof v.description !== "string" || v.description.length > 500)) return { error: "description must be at most 500 characters" };
  for (const key of ["client", "server", "styles"] as const) {
    if (v[key] !== undefined && !isPluginFile(v[key])) return { error: `${key} must be a relative file path inside the plugin folder` };
  }
  if (v.slots !== undefined && (!Array.isArray(v.slots) || v.slots.length > 40 || !v.slots.every((s) => typeof s === "string" && s.length <= 80))) {
    return { error: "slots must be an array of slot names" };
  }
  if (v.tokens !== undefined) {
    if (!v.tokens || typeof v.tokens !== "object" || Array.isArray(v.tokens)) return { error: "tokens must be an object of CSS custom properties" };
    for (const [key, val] of Object.entries(v.tokens)) {
      if (!key.startsWith("--") || key.length > 80) return { error: `token ${key} must start with --` };
      if (typeof val !== "string" || val.length > 300) return { error: `token ${key} must be a string` };
    }
  }
  if (v.hide !== undefined && (!Array.isArray(v.hide) || v.hide.length > 40 || !v.hide.every((s) => typeof s === "string" && s.length > 0 && s.length <= 200))) {
    return { error: "hide must be an array of CSS selectors" };
  }
  if (v.defaultEnabled !== undefined && typeof v.defaultEnabled !== "boolean") return { error: "defaultEnabled must be true or false" };
  return {
    manifest: {
      id: v.id,
      name: v.name.trim(),
      version: v.version.trim(),
      apiVersion: v.apiVersion,
      description: typeof v.description === "string" ? v.description : undefined,
      client: v.client as string | undefined,
      server: v.server as string | undefined,
      styles: v.styles as string | undefined,
      slots: (v.slots as string[] | undefined) ?? [],
      tokens: (v.tokens as Record<string, string> | undefined) ?? {},
      hide: (v.hide as string[] | undefined) ?? [],
      defaultEnabled: v.defaultEnabled as boolean | undefined,
    },
  };
}

/** A settings page a client plugin contributes. */
export interface PluginSettingsSection {
  id: string;
  label: string;
  icon?: string;
  component: unknown;
}

/** What a server plugin's default export may contain. */
export interface ServerPluginModule {
  /** Called once when the server starts, after OpenBuild's own state is available. */
  onStart?: (ctx: { id: string; dir: string; dataDir: string; log: (...args: unknown[]) => void }) => void | Promise<void>;
  /** Extra routes. Every path must start with `/api/plugins/<id>/`. */
  routes?: (api: PluginApiWrapper) => Record<string, unknown>;
  /** Before a Pi turn starts: return a modified request, or nothing to leave it alone. */
  beforeChat?: (req: unknown) => unknown | Promise<unknown>;
  /** Called when the plugin becomes inactive (system off, plugin disabled, or shutdown). */
  onStop?: () => void | Promise<void>;
}

export type PluginApiWrapper = <R extends Request, A extends unknown[]>(
  handler: (req: R, ...rest: A) => Response | Promise<Response>,
) => (req: R, ...rest: A) => Response | Promise<Response>;
