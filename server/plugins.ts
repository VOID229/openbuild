// OpenBuild's plugin system: reads plugin folders, validates their manifests, builds their client
// modules on demand for the browser, loads server modules when they become active, and serves the
// small authenticated API the app uses to list, enable and reload them. A file watcher re-scans the
// folders, re-imports changed server sources and tells open browsers to reload client modules, so
// plugin changes (including new folders) apply without restarting OpenBuild.
//
// A plugin is a folder (by default `plugins/`, or `pluginsDir` in openbuild.config.ts):
//
//   plugins/my-plugin/
//     plugin.json    manifest (required)
//     client.tsx     UI: slots, settings page, tool renderers
//     server.ts      routes and chat hooks (loaded at startup)
//     styles.css     styles for both
//
// Client modules are bundled by Bun with React (and the `openbuild` SDK) left as references to the
// host's instances, so a plugin can't accidentally load a second React copy.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as React from "react";
import * as JSXRuntime from "react/jsx-runtime";
import * as ReactDOM from "react-dom";
import {
  PLUGIN_API_VERSION,
  isPluginFile,
  isPluginId,
  validateManifest,
  type PluginApiWrapper,
  type PluginInfo,
  type PluginManifest,
  type PluginsResponse,
  type ServerPluginModule,
} from "../shared/plugins";
import { bad, readJson } from "./handlers";
import { dataDir } from "./paths";
import * as storage from "./storage";

const STATE_KEY = "plugins-state";
// The folder that contains server/ and plugins/, wherever the process was started from.
const ROOT = resolve(import.meta.dir, "..");
const CWD = process.cwd();

interface Config {
  /** Where plugin folders live. Relative to openbuild.config.ts. */
  pluginsDir?: string;
  /** A CSS file applied after OpenBuild's own styles. */
  customCss?: string;
  /** Start with every plugin off (also `OPENBUILD_SAFE=1`). */
  safeMode?: boolean;
  /** Plugins off even if the stored state says otherwise. */
  disabledPlugins?: string[];
}

interface Loaded {
  manifest: PluginManifest;
  dir: string;
  info: PluginInfo;
  serverModule?: ServerPluginModule;
  /** The server source files at the time serverModule was imported. */
  serverKey?: string;
}

let config: Config = {};
let configDir = ROOT;
let pluginsDir = join(ROOT, "plugins");
let customCssPath: string | undefined;
let safeMode = false;
let loaded: Loaded[] = [];
let buildCache = new Map<string, { key: string; code: string }>();
const buildErrors = new Map<string, string>();
const serverErrors = new Map<string, string>();
const serverRuns = new Map<string, ServerPluginModule>();

const enc = new TextEncoder();
const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
let watcher: ReturnType<typeof setInterval> | undefined;
let signature = "";
let reloading = false;
let importSeq = 0;

// ------------------------------------------------------------------ state

function storedState(): { disabled: string[]; enabled: string[]; system: boolean } {
  try {
    const raw = storage.getValue(STATE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { disabled?: unknown; enabled?: unknown; system?: unknown }) : undefined;
    const list = (value: unknown) => (Array.isArray(value) ? value.filter(isPluginId) : []);
    // Off on first run. Turning the whole system on is an explicit choice in Settings.
    return { disabled: list(parsed?.disabled), enabled: list(parsed?.enabled), system: parsed?.system === true };
  } catch {
    return { disabled: [], enabled: [], system: false };
  }
}

/** The master switch: off on first run, and always off in safe mode. */
export function systemEnabled(): boolean {
  return !safeMode && storedState().system;
}

/** Whether a plugin is off: the config's fixed list, a Settings choice, or the plugin's own default. */
function isDisabled(id: string): boolean {
  if (config.disabledPlugins?.includes(id)) return true;
  const state = storedState();
  if (state.enabled.includes(id)) return false;
  if (state.disabled.includes(id)) return true;
  const plugin = loaded.find((p) => p.info.id === id);
  return plugin?.manifest.defaultEnabled === false;
}

/** Disabled plugins, as the app and Settings see them. */
function disabledIds(): string[] {
  return loaded.filter((p) => isDisabled(p.info.id)).map((p) => p.info.id);
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<boolean> {
  if (!loaded.some((p) => p.info.id === id)) return false;
  const state = storedState();
  const disabled = new Set(state.disabled);
  const enabledList = new Set(state.enabled);
  if (enabled) {
    disabled.delete(id);
    enabledList.add(id);
  } else {
    disabled.add(id);
    enabledList.delete(id);
  }
  storage.setValue(STATE_KEY, JSON.stringify({ disabled: [...disabled], enabled: [...enabledList], system: state.system }));
  await syncServerPlugins();
  broadcast("reload");
  return true;
}

/**
 * Delete a plugin's folder and forget any enable/disable choice for it. Only folders directly
 * inside the plugins directory can be removed. Returns false when there is no such plugin.
 */
export async function deletePlugin(id: string): Promise<boolean> {
  if (!isPluginId(id)) return false;
  const plugin = loaded.find((p) => p.info.id === id);
  if (!plugin) return false;
  const dir = resolve(plugin.dir);
  // Never delete anything outside the plugins folder, or a nested file inside a plugin.
  if (dirname(dir) !== resolve(pluginsDir)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    throw new Error(`Couldn't remove ${dir}: ${(err as Error).message}`);
  }
  // A removed plugin should come back enabled if its folder is added again.
  const state = storedState();
  storage.setValue(
    STATE_KEY,
    JSON.stringify({ ...state, disabled: state.disabled.filter((x) => x !== id), enabled: state.enabled.filter((x) => x !== id) }),
  );
  await reloadFromDisk();
  return true;
}

/** Turn the whole plugin system on or off. Server plugins start/stop without a restart. */
export async function setSystemEnabled(enabled: boolean): Promise<void> {
  if (safeMode) return;
  const state = storedState();
  storage.setValue(STATE_KEY, JSON.stringify({ ...state, system: enabled }));
  await syncServerPlugins();
  broadcast("reload");
}

/** All known plugins, including ones with a broken manifest. */
export function pluginInfo(): PluginsResponse {
  return {
    dir: pluginsDir,
    enabled: systemEnabled(),
    safe: safeMode,
    customCss: !!customCssPath,
    disabled: disabledIds(),
    plugins: loaded.map((p) => ({
      ...p.info,
      error: p.info.error ?? buildErrors.get(p.info.id) ?? serverErrors.get(p.info.id),
      serverLoaded: serverRuns.has(p.info.id),
    })),
  };
}

// ------------------------------------------------------------------ events

function send(controller: ReadableStreamDefaultController<Uint8Array>, event: unknown) {
  try {
    controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
  } catch {
    subscribers.delete(controller);
  }
}

export function broadcast(type: "reload" | "enabled" = "reload") {
  const event = { type, at: Date.now() };
  for (const controller of subscribers) send(controller, event);
}

/** The live stream Settings and the app listen to, so a plugin file change shows up without a reload. */
export function pluginEvents(): Response {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      subscribers.add(c);
      c.enqueue(enc.encode(": openbuild plugins\n\n"));
      heartbeat = setInterval(() => {
        try {
          c.enqueue(enc.encode(": ping\n\n"));
        } catch {
          subscribers.delete(c);
        }
      }, 20_000);
    },
    cancel() {
      subscribers.delete(controller);
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" },
  });
}

// ------------------------------------------------------------------ files

/** Recursively stat a plugin folder: a cheap change key for hot reload and bundle caching. */
function folderKey(dir: string, depth = 0): string {
  if (depth > 4) return "";
  let out = "";
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return "";
  }
  for (const name of names) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    const stat = (() => {
      try {
        return statSync(path);
      } catch {
        return undefined;
      }
    })();
    if (!stat) continue;
    if (stat.isDirectory()) out += `${name}/[${folderKey(path, depth + 1)}];`;
    else out += `${name}:${stat.mtimeMs}:${stat.size};`;
    if (out.length > 200_000) return out;
  }
  return out;
}

function pluginSignature(): string {
  const dirs = (() => {
    try {
      return readdirSync(pluginsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
        .map((d) => join(pluginsDir, d.name))
        .sort();
    } catch {
      return [];
    }
  })();
  const css = customCssPath ? `${customCssPath}:${(() => { try { return statSync(customCssPath).mtimeMs; } catch { return 0; } })()}` : "";
  return `${pluginsDir}|${css}|${dirs.map((d) => `${basename(d)}=${folderKey(d)}`).join("||")}`;
}

function beginWatching() {
  if (watcher) return;
  signature = pluginSignature();
  watcher = setInterval(() => {
    const next = pluginSignature();
    if (next === signature) return;
    signature = next;
    void reloadFromDisk();
  }, 1500);
  (watcher as { unref?: () => void }).unref?.();
}

/** The files that make up a server plugin; changing one re-imports it. */
const SERVER_SOURCE = /\.(?:[cm]?[jt]sx?|json)$/i;

function sourceKey(dir: string, ignore: Set<string>, depth = 0): string {
  if (depth > 4) return "";
  let out = "";
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return "";
  }
  for (const name of names) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    const stat = (() => {
      try {
        return statSync(path);
      } catch {
        return undefined;
      }
    })();
    if (!stat) continue;
    if (stat.isDirectory()) out += `${name}/[${sourceKey(path, ignore, depth + 1)}];`;
    else if (!ignore.has(path) && name !== "plugin.json" && SERVER_SOURCE.test(name)) out += `${name}:${stat.mtimeMs}:${stat.size};`;
    if (out.length > 200_000) return out;
  }
  return out;
}

// ------------------------------------------------------------------ config

/** Load openbuild.config.ts (or .js), if there is one. Missing config is fine. */
async function loadConfig() {
  const candidates = [
    process.env.OPENBUILD_CONFIG,
    join(CWD, "openbuild.config.ts"),
    join(CWD, "openbuild.config.js"),
    join(ROOT, "openbuild.config.ts"),
    join(ROOT, "openbuild.config.js"),
    join(dataDir(), "openbuild.config.ts"),
  ].filter((p): p is string => !!p);
  const path = candidates.find((p) => existsSync(p));
  if (path) {
    try {
      const mod = (await import(`${path}?v=${Date.now()}`)) as { default?: Config };
      config = (mod.default ?? {}) as Config;
      configDir = dirname(path);
    } catch (err) {
      console.error(`[plugins] Could not read ${path}:`, err);
    }
  }
  const relative = (p: string) => resolve(configDir, p);
  const defaultDir = join(ROOT, "plugins");
  pluginsDir = config.pluginsDir
    ? relative(config.pluginsDir)
    : existsSync(defaultDir)
      ? defaultDir
      : join(dataDir(), "plugins");
  const css = config.customCss ? relative(config.customCss) : join(dataDir(), "custom.css");
  customCssPath = existsSync(css) ? css : undefined;
  safeMode = process.env.OPENBUILD_SAFE === "1" || config.safeMode === true;
}

// ------------------------------------------------------------------ client bundles

const defaultFilter = (k: string) => k !== "default" && /^[A-Za-z_$][\w$]*$/.test(k);
const reactExports = Object.keys(React).filter(defaultFilter);
const jsxExports = Object.keys(JSXRuntime).filter(defaultFilter);

/**
 * React and the SDK are not bundled: the generated modules read them from the host's
 * `globalThis.__OPENBUILD__`. That keeps one React instance (hooks, context) across the app and
 * every plugin, and means a plugin is just one small ES module.
 */
const hostShim = (): import("bun").BunPlugin => ({
  name: "openbuild-host",
  setup(build) {
    for (const [specifier, module] of [
      ["react", "react"],
      ["react/jsx-runtime", "jsx"],
      ["react/jsx-dev-runtime", "jsx"],
      ["react-dom", "dom"],
      ["react-dom/client", "dom"],
      ["openbuild", "sdk"],
    ] as const) {
      build.onResolve({ filter: new RegExp(`^${specifier.replace(/[/-]/g, "\\$&")}$`) }, () => ({ path: module, namespace: "openbuild-host" }));
    }
    build.onLoad({ filter: /.*/, namespace: "openbuild-host" }, (args) => {
      const key = args.path;
      if (key === "react") {
        return {
          loader: "js",
          contents:
            "const R = globalThis.__OPENBUILD__.React;\n" +
            reactExports.map((n) => `export const ${n} = R.${n};`).join("\n") +
            "\nexport default R;\n",
        };
      }
      if (key === "jsx") {
        return {
          loader: "js",
          contents:
            "const J = globalThis.__OPENBUILD__.JSXRuntime;\n" +
            jsxExports.map((n) => `export const ${n} = J.${n};`).join("\n") +
            "\n",
        };
      }
      if (key === "dom") {
        return {
          loader: "js",
          contents:
            "const D = globalThis.__OPENBUILD__.ReactDOM;\n" +
            Object.keys(ReactDOM)
              .filter(defaultFilter)
              .map((n) => `export const ${n} = D.${n};`)
              .join("\n") +
            "\nexport default D;\n",
        };
      }
      return {
        loader: "js",
        contents:
          "const O = globalThis.__OPENBUILD__;\n" +
          "export const React = O.React;\n" +
          "export const useStore = O.useStore;\n" +
          "export const getState = O.getState;\n" +
          "export const subscribe = O.subscribe;\n" +
          "export const insertComposerText = O.insertComposerText;\n" +
          "export const openSettings = O.openSettings;\n" +
          "export const fetch = O.fetch;\n" +
          "export const plugin = O.plugin;\n" +
          "export default O;\n",
      };
    });
  },
});

async function compileClient(plugin: Loaded): Promise<string> {
  if (!plugin.manifest.client) throw new Error("This plugin has no client module");
  const key = folderKey(plugin.dir);
  const cached = buildCache.get(plugin.info.id);
  if (cached?.key === key) return cached.code;
  const result = await Bun.build({
    entrypoints: [join(plugin.dir, plugin.manifest.client)],
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "none",
    jsx: { runtime: "automatic", importSource: "react" },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [hostShim()],
  });
  if (!result.success) {
    const message = result.logs.map((l) => l.message).filter(Boolean).join("\n") || "Build failed";
    buildErrors.set(plugin.info.id, message);
    throw new Error(message);
  }
  const js = result.outputs.find((o) => o.path.endsWith(".js"));
  if (!js) throw new Error("The client build produced no JavaScript");
  const code = await js.text();
  buildErrors.delete(plugin.info.id);
  buildCache.set(plugin.info.id, { key, code });
  return code;
}

// ------------------------------------------------------------------ loading

function readPlugin(dirName: string): Loaded {
  const dir = join(pluginsDir, dirName);
  const info: PluginInfo = {
    id: dirName,
    name: dirName,
    version: "0.0.0",
    apiVersion: PLUGIN_API_VERSION,
    client: false,
    server: false,
    styles: false,
    slots: [],
  };
  const manifestPath = join(dir, "plugin.json");
  if (!existsSync(manifestPath)) return { manifest: { id: dirName, name: dirName, version: "0.0.0", apiVersion: PLUGIN_API_VERSION }, dir, info: { ...info, error: "Missing plugin.json" } };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { manifest: { id: dirName, name: dirName, version: "0.0.0", apiVersion: PLUGIN_API_VERSION }, dir, info: { ...info, error: `plugin.json is not valid JSON: ${(err as Error).message}` } };
  }
  const { manifest, error } = validateManifest(raw);
  if (!manifest) return { manifest: { id: dirName, name: dirName, version: "0.0.0", apiVersion: PLUGIN_API_VERSION }, dir, info: { ...info, error } };
  const client = !!manifest.client && isPluginFile(manifest.client) && existsSync(join(dir, manifest.client));
  const server = !!manifest.server && isPluginFile(manifest.server) && existsSync(join(dir, manifest.server));
  const styles = !!manifest.styles && isPluginFile(manifest.styles) && existsSync(join(dir, manifest.styles));
  const missing = manifest.client && !client ? manifest.client : manifest.server && !server ? manifest.server : manifest.styles && !styles ? manifest.styles : undefined;
  return {
    manifest,
    dir,
    info: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      description: manifest.description,
      client,
      server,
      styles,
      slots: manifest.slots ?? [],
      tokens: manifest.tokens,
      hide: manifest.hide,
      clientUrl: client ? `/api/plugins/${encodeURIComponent(manifest.id)}/client.js` : undefined,
      stylesUrl: styles ? `/api/plugins/${encodeURIComponent(manifest.id)}/styles.css` : undefined,
      error: missing ? `${missing} doesn't exist` : undefined,
    },
  };
}

/** Read the plugin folders again, carrying server modules for folders that are still there. */
function scanPlugins() {
  const previous = new Map(loaded.map((p) => [p.dir, p]));
  const seen = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => d.name)
      .sort();
  } catch {}
  const next: Loaded[] = [];
  for (const name of names) {
    const plugin = readPlugin(name);
    const old = previous.get(plugin.dir);
    // Same folder and same server file: keep the imported module; sync reloads it if its source changed.
    if (old?.serverModule && old.info.server === plugin.info.server && old.manifest.server === plugin.manifest.server) {
      plugin.serverModule = old.serverModule;
      plugin.serverKey = old.serverKey;
    }
    if (seen.has(plugin.info.id)) {
      plugin.info.error = `Another plugin already uses the id "${plugin.info.id}"`;
    }
    seen.add(plugin.info.id);
    next.push(plugin);
  }
  loaded = next;
  for (const id of [...serverErrors.keys()]) {
    if (!loaded.some((p) => p.info.id === id)) serverErrors.delete(id);
  }
}

/**
 * Re-read the folders and bring server plugins in line. Called by the watcher for any file change:
 * client modules and styles just notify browsers; server sources that changed are re-imported here.
 */
async function reloadFromDisk(): Promise<void> {
  if (reloading) return;
  reloading = true;
  try {
    scanPlugins();
    buildCache = new Map();
    await syncServerPlugins();
    broadcast("reload");
  } catch (err) {
    console.error("[plugins] Reload failed:", err);
  } finally {
    reloading = false;
    // A file changed while the reload was running: pick it up on the next pass.
    const latest = pluginSignature();
    if (latest !== signature) {
      signature = latest;
      void reloadFromDisk();
    }
  }
}

/** Read every plugin folder and (re)import enabled server modules. Safe to call once at startup. */
export async function loadPlugins(): Promise<void> {
  await loadConfig();
  if (!existsSync(pluginsDir)) {
    try {
      mkdirSync(pluginsDir, { recursive: true, mode: 0o700 });
    } catch {}
  }
  await clearServerRuns();
  loaded = [];
  scanPlugins();
  await syncServerPlugins();
  beginWatching();
  const active = loaded.filter((p) => !p.info.error && !isDisabled(p.info.id) && systemEnabled());
  console.log(
    `  Plugins: ${systemEnabled() ? (active.length ? active.map((p) => p.info.name).join(", ") : "none") : "off (enable in Settings → Plugins)"}` +
      (safeMode ? " (safe mode)" : "") +
      ` — ${pluginsDir}`,
  );
}

// ------------------------------------------------------------------ server modules

function pluginContext(plugin: Loaded) {
  return {
    id: plugin.info.id,
    dir: plugin.dir,
    dataDir: dataDir(),
    log: (...args: unknown[]) => console.log(`[plugin:${plugin.info.id}]`, ...args),
  };
}

async function clearServerRuns() {
  for (const [id, plugin] of serverRuns) {
    try {
      await plugin.onStop?.();
    } catch (err) {
      console.error(`[plugin:${id}] onStop failed:`, err);
    }
  }
  serverRuns.clear();
  pluginRouteTable.clear();
  serverErrors.clear();
}

/**
 * Bring the running server plugins in line with the master switch, per-plugin switches and the
 * files on disk. `onStart` runs when a plugin becomes active or its server source changes;
 * `onStop` runs when it stops or is reloaded. Routes are rebuilt from the new modules.
 */
async function syncServerPlugins(): Promise<void> {
  const active = new Set<string>();
  if (systemEnabled()) {
    for (const plugin of loaded) {
      if (plugin.info.server && !plugin.info.error && !isDisabled(plugin.info.id)) active.add(plugin.info.id);
    }
  }

  // Stop plugins that are off, removed, or whose module is no longer the current one.
  for (const [id, running] of [...serverRuns]) {
    const plugin = loaded.find((p) => p.info.id === id);
    if (active.has(id) && plugin?.serverModule === running) continue;
    serverRuns.delete(id);
    try {
      await running.onStop?.();
    } catch (err) {
      console.error(`[plugin:${id}] onStop failed:`, err);
    }
  }

  for (const plugin of loaded) {
    const id = plugin.info.id;
    if (!active.has(id)) {
      serverErrors.delete(id);
      continue;
    }
    const key = sourceKey(plugin.dir, new Set([plugin.manifest.client, plugin.manifest.styles].filter((f): f is string => !!f).map((f) => join(plugin.dir, f))));
    const running = serverRuns.get(id);
    if (running && plugin.serverModule === running && plugin.serverKey === key) continue;
    let installed = false;
    try {
      let mod = plugin.serverModule;
      if (!mod || plugin.serverKey !== key) {
        // Bun imports TypeScript directly; the query busts the module cache on every reload.
        const imported = (await import(`${join(plugin.dir, plugin.manifest.server!)}?v=${Date.now()}-${++importSeq}`)) as { default?: ServerPluginModule };
        mod = imported.default;
        if (!mod) throw new Error("server.ts has no default export");
        if (running && running !== mod) {
          serverRuns.delete(id);
          try {
            await running.onStop?.();
          } catch (err) {
            console.error(`[plugin:${id}] onStop failed:`, err);
          }
        }
        plugin.serverModule = mod;
        plugin.serverKey = key;
      }
      serverRuns.set(id, mod);
      installed = true;
      serverErrors.delete(id);
      await mod.onStart?.(pluginContext(plugin));
    } catch (err) {
      serverErrors.set(id, `server.ts failed: ${(err as Error).message}`);
      console.error(`[plugins] ${id}:`, err);
      // A fresh module that failed to start is retried on the next change or Reload plugins.
      if (installed) serverRuns.delete(id);
    }
  }
  rebuildRouteTable();
}

/** Run every enabled server plugin's `beforeChat`, in load order. */
export async function beforeChat<T>(req: T): Promise<T> {
  let out = req;
  for (const [id, plugin] of serverRuns) {
    if (typeof plugin.beforeChat !== "function") continue;
    try {
      const next = await plugin.beforeChat(out);
      if (next && typeof next === "object") out = next as T;
    } catch (err) {
      console.error(`[plugin:${id}] beforeChat failed:`, err);
    }
  }
  return out;
}

export const hasChatHooks = () => [...serverRuns.values()].some((p) => typeof p.beforeChat === "function");

// ------------------------------------------------------------------ HTTP

type Api = PluginApiWrapper;
type RouteHandler = (req: Request, ...rest: unknown[]) => Response | Promise<Response>;

/** Server plugin paths, rebuilt whenever a plugin starts or stops. */
const pluginRouteTable = new Map<string, Record<string, RouteHandler>>();

/** Server plugin `routes()` sees a pass-through: OpenBuild wraps every handler in `api` once, in dispatch. */
const passthrough = (<R extends Request, A extends unknown[]>(handler: (req: R, ...rest: A) => Response | Promise<Response>) => handler) as Api;

function rebuildRouteTable() {
  pluginRouteTable.clear();
  if (!systemEnabled()) return;
  for (const [id, plugin] of serverRuns) {
    if (typeof plugin.routes !== "function") continue;
    let handlers: Record<string, unknown> | undefined;
    try {
      handlers = plugin.routes(passthrough) as Record<string, unknown>;
    } catch (err) {
      console.error(`[plugin:${id}] routes() failed:`, err);
      continue;
    }
    for (const [path, methods] of Object.entries(handlers ?? {})) {
      if (!path.startsWith(`/api/plugins/${id}/`)) {
        console.warn(`[plugin:${id}] ignored route ${path}: it must start with /api/plugins/${id}/`);
        continue;
      }
      if (!methods || typeof methods !== "object") continue;
      const merged = pluginRouteTable.get(path) ?? {};
      for (const [method, handler] of Object.entries(methods as Record<string, unknown>)) {
        if (typeof handler !== "function") continue;
        const key = method.toUpperCase();
        if (merged[key]) {
          console.warn(`[plugin:${id}] ignored duplicate ${key} ${path}`);
          continue;
        }
        merged[key] = handler as RouteHandler;
      }
      pluginRouteTable.set(path, merged);
    }
  }
}

/** Route handlers for the plugin API, plus the routes contributed by server plugins. */
export function pluginRoutes(api: Api) {
  const routes: Record<string, unknown> = {
    "/api/plugins": {
      GET: api(() => Response.json(pluginInfo())),
    },
    "/api/plugins/events": {
      GET: api(() => pluginEvents()),
    },
    "/api/plugins/reload": {
      POST: api(async () => {
        await reloadFromDisk();
        return Response.json({ ok: true });
      }),
    },
    "/api/plugins/custom.css": {
      GET: api(() => {
        if (!customCssPath) return bad("No custom CSS", 404);
        try {
          return new Response(readFileSync(customCssPath), { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" } });
        } catch {
          return bad("Couldn't read custom CSS", 500);
        }
      }),
    },
    "/api/plugins/:id/client.js": {
      GET: api(async (req: Bun.BunRequest<"/api/plugins/:id/client.js">) => {
        const plugin = loaded.find((p) => p.info.id === req.params.id);
        if (!plugin || !systemEnabled() || isDisabled(plugin.info.id) || !plugin.info.client) return bad("No such plugin", 404);
        try {
          return new Response(await compileClient(plugin), { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" } });
        } catch (err) {
          console.error(`[plugins] ${plugin.info.id}:`, err);
          return bad(`Plugin build failed: ${(err as Error).message}`, 500);
        }
      }),
    },
    "/api/plugins/:id/styles.css": {
      GET: api((req: Bun.BunRequest<"/api/plugins/:id/styles.css">) => {
        const plugin = loaded.find((p) => p.info.id === req.params.id);
        if (!plugin || !systemEnabled() || isDisabled(plugin.info.id) || !plugin.info.styles || !plugin.manifest.styles) return bad("No such styles", 404);
        try {
          return new Response(readFileSync(join(plugin.dir, plugin.manifest.styles)), { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" } });
        } catch {
          return bad("Couldn't read styles", 500);
        }
      }),
    },
    "/api/plugins/system": {
      PUT: api(async (req) => {
        const body = await readJson(req);
        if (typeof body?.enabled !== "boolean") return bad("Expected { enabled: boolean }");
        if (safeMode) return bad("OpenBuild is in safe mode", 409);
        await setSystemEnabled(body.enabled);
        return Response.json({ ok: true, enabled: systemEnabled() });
      }),
    },
    "/api/plugins/:id": {
      PUT: api(async (req: Bun.BunRequest<"/api/plugins/:id">) => {
        const body = await readJson(req);
        if (!isPluginId(req.params.id) || typeof body?.enabled !== "boolean") return bad("Expected { enabled: boolean }");
        if (safeMode) return bad("OpenBuild is in safe mode", 409);
        return (await setPluginEnabled(req.params.id, body.enabled)) ? Response.json({ ok: true }) : bad("No such plugin", 404);
      }),
      DELETE: api(async (req: Bun.BunRequest<"/api/plugins/:id">) => {
        if (!isPluginId(req.params.id)) return bad("Expected a plugin id");
        if (safeMode) return bad("OpenBuild is in safe mode", 409);
        try {
          return (await deletePlugin(req.params.id)) ? Response.json({ ok: true }) : bad("No such plugin", 404);
        } catch (err) {
          return bad((err as Error).message, 500);
        }
      }),
    },
  };

  // Server plugin routes are dispatched from a table that can change when the master switch or a
  // plugin toggle changes, instead of being fixed when the server starts.
  rebuildRouteTable();
  const dispatch = async (req: Request, ...rest: unknown[]) => {
    const path = new URL(req.url).pathname;
    const handler = pluginRouteTable.get(path)?.[req.method.toUpperCase()];
    return handler ? handler(req, ...rest) : bad("Not found", 404);
  };
  const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] as const;
  routes["/api/plugins/:id/*"] = Object.fromEntries(methods.map((method) => [method, api(dispatch)]));
  return routes;
}
