// OpenBuild's plugin system: reads plugin folders, validates their manifests, builds their client
// modules on demand for the browser, loads their server modules at startup, and serves the small
// authenticated API the app uses to list, enable and reload them.
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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
}

let config: Config = {};
let configDir = ROOT;
let pluginsDir = join(ROOT, "plugins");
let customCssPath: string | undefined;
let safeMode = false;
let loaded: Loaded[] = [];
let buildCache = new Map<string, { key: string; code: string }>();
const buildErrors = new Map<string, string>();
const serverRuns = new Map<string, ServerPluginModule>();

const enc = new TextEncoder();
const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
let watcher: ReturnType<typeof setInterval> | undefined;
let signature = "";

// ------------------------------------------------------------------ state

function storedState(): { disabled: string[]; enabled: string[] } {
  try {
    const raw = storage.getValue(STATE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { disabled?: unknown; enabled?: unknown }) : undefined;
    const list = (value: unknown) => (Array.isArray(value) ? value.filter(isPluginId) : []);
    return { disabled: list(parsed?.disabled), enabled: list(parsed?.enabled) };
  } catch {
    return { disabled: [], enabled: [] };
  }
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

export function setPluginEnabled(id: string, enabled: boolean): boolean {
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
  storage.setValue(STATE_KEY, JSON.stringify({ disabled: [...disabled], enabled: [...enabledList] }));
  broadcast("reload");
  return true;
}

/** All known plugins, including ones with a broken manifest. */
export function pluginInfo(): PluginsResponse {
  return {
    dir: pluginsDir,
    safe: safeMode,
    customCss: !!customCssPath,
    disabled: disabledIds(),
    plugins: loaded.map((p) => ({
      ...p.info,
      error: p.info.error ?? buildErrors.get(p.info.id),
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
    // With no browser listening, skip the work: the next request reads everything fresh anyway.
    if (!subscribers.size) {
      signature = pluginSignature();
      return;
    }
    const next = pluginSignature();
    if (next === signature) return;
    signature = next;
    buildCache = new Map();
    broadcast("reload");
  }, 1500);
  (watcher as { unref?: () => void }).unref?.();
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
      const mod = (await import(`${pathToFileURL(path).href}?v=${Date.now()}`)) as { default?: Config };
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

/** Read every plugin folder and (re)import enabled server modules. Safe to call once at startup. */
export async function loadPlugins(): Promise<void> {
  await loadConfig();
  if (!existsSync(pluginsDir)) {
    try {
      mkdirSync(pluginsDir, { recursive: true, mode: 0o700 });
    } catch {}
  }
  loaded = [];
  serverRuns.clear();
  const seen = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => d.name)
      .sort();
  } catch {}
  for (const name of names) {
    const plugin = readPlugin(name);
    if (seen.has(plugin.info.id)) {
      plugin.info.error = `Another plugin already uses the id "${plugin.info.id}"`;
    }
    seen.add(plugin.info.id);
    loaded.push(plugin);
    if (!plugin.info.server || plugin.info.error || safeMode || isDisabled(plugin.info.id)) continue;
    try {
      // Bun imports TypeScript directly; the query busts the module cache across `bun --hot` restarts.
      const mod = (await import(`${pathToFileURL(join(plugin.dir, plugin.manifest.server!)).href}?v=${Date.now()}`)) as { default?: ServerPluginModule };
      plugin.serverModule = mod.default;
      if (plugin.serverModule) {
        serverRuns.set(plugin.info.id, plugin.serverModule);
        await plugin.serverModule.onStart?.({
          id: plugin.info.id,
          dir: plugin.dir,
          dataDir: dataDir(),
          log: (...args: unknown[]) => console.log(`[plugin:${plugin.info.id}]`, ...args),
        });
      }
    } catch (err) {
      const message = `server.ts failed to load: ${(err as Error).message}`;
      plugin.info.error = message;
      console.error(`[plugins] ${plugin.info.id}:`, err);
    }
  }
  beginWatching();
  const enabled = loaded.filter((p) => !p.info.error && !isDisabled(p.info.id) && !safeMode);
  console.log(
    `  Plugins: ${enabled.length ? enabled.map((p) => p.info.name).join(", ") : "none"}` +
      (safeMode ? " (safe mode)" : "") +
      ` — ${pluginsDir}`,
  );
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
      POST: api(() => {
        buildCache = new Map();
        broadcast("reload");
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
        if (!plugin || safeMode || isDisabled(plugin.info.id) || !plugin.info.client) return bad("No such plugin", 404);
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
        if (!plugin || !plugin.info.styles || !plugin.manifest.styles) return bad("No such styles", 404);
        try {
          return new Response(readFileSync(join(plugin.dir, plugin.manifest.styles)), { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" } });
        } catch {
          return bad("Couldn't read styles", 500);
        }
      }),
    },
    "/api/plugins/:id": {
      PUT: api(async (req: Bun.BunRequest<"/api/plugins/:id">) => {
        const body = await readJson(req);
        if (!isPluginId(req.params.id) || typeof body?.enabled !== "boolean") return bad("Expected { enabled: boolean }");
        if (safeMode) return bad("OpenBuild is in safe mode", 409);
        return setPluginEnabled(req.params.id, body.enabled) ? Response.json({ ok: true }) : bad("No such plugin", 404);
      }),
    },
  };

  // Routes contributed by server plugins. Every path must stay under /api/plugins/<id>/, and every
  // method is wrapped in `api` here too, so a plugin can't accidentally serve an unauthenticated route.
  for (const [id, plugin] of serverRuns) {
    if (typeof plugin.routes !== "function") continue;
    let handlers: Record<string, unknown> | undefined;
    try {
      handlers = plugin.routes(api) as Record<string, unknown>;
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
      const merged = (routes[path] as Record<string, unknown> | undefined) ?? {};
      for (const [method, handler] of Object.entries(methods as Record<string, unknown>)) {
        if (typeof handler !== "function") continue;
        if (merged[method]) {
          console.warn(`[plugin:${id}] ignored duplicate ${method} ${path}`);
          continue;
        }
        merged[method] = api(handler as (req: Request, ...rest: unknown[]) => Response | Promise<Response>);
      }
      routes[path] = merged;
    }
  }
  return routes;
}
