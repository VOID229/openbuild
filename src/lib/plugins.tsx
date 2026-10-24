// The browser side of OpenBuild's plugin system.
//
// A plugin's client module is a normal ES module that the server builds on demand. It renders into
// named slots, can contribute a Settings page and custom tool renderers, and may apply tokens,
// selectors to hide, and a stylesheet. Its `react` and `openbuild` imports resolve to this app's
// instances (see server/plugins.ts), so hooks and context work as if it were part of the app.
//
// Plugins load after the app is unlocked and never block it: each one is wrapped in an error
// boundary, a failed build shows up in Settings → Plugins, and SSE tells every open browser to
// reload when a plugin file changes.
import * as React from "react";
import * as JSXRuntime from "react/jsx-runtime";
import * as ReactDOM from "react-dom";
import { Component, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { create } from "zustand";
import { PLUGIN_API_VERSION, type PluginInfo, type PluginSettingsSection, type PluginsResponse } from "../../shared/plugins";
import { useStore } from "./store";
import { clearProviderOverrides, setProviderOverrides } from "./pluginOverrides";
import type { ToolPart } from "./types";

// ------------------------------------------------------------------ the host bridge

export function insertComposerText(text: string) {
  if (!text) return;
  window.dispatchEvent(new CustomEvent("openbuild:composer-insert", { detail: { text } }));
}

const host = {
  apiVersion: PLUGIN_API_VERSION,
  React,
  JSXRuntime,
  ReactDOM,
  useStore,
  getState: () => useStore.getState(),
  subscribe: useStore.subscribe,
  insertComposerText,
  openSettings: (section?: string) => useStore.getState().openSettings(section as never),
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  /** Current icon overrides, also useful when debugging a plugin. */
  pluginBrandSvg,
  pluginProviderSvg,
  /** Filled in right before a plugin module is evaluated. */
  plugin: { id: "", name: "" },
};

declare global {
  // eslint-disable-next-line no-var
  var __OPENBUILD__: typeof host;
}

// Must exist before the first plugin module is imported: its generated React shim reads it.
globalThis.__OPENBUILD__ = host;

// ------------------------------------------------------------------ registry

interface SlotEntry {
  pluginId: string;
  component: ComponentType<Record<string, unknown>>;
}

interface ToolEntry {
  pluginId: string;
  component: ComponentType<{ part: ToolPart; cwd?: string }>;
}

interface Applied {
  styles?: HTMLLinkElement;
  hide?: HTMLStyleElement;
  tokens: { name: string; previous: string }[];
  dispose?: () => void;
}

interface ClientPlugin {
  slots?: Record<string, ComponentType<Record<string, unknown>> | ComponentType<Record<string, unknown>>[]>;
  toolRenderers?: Record<string, ComponentType<{ part: ToolPart; cwd?: string }>>;
  settings?: { label: string; icon?: string; component: ComponentType<Record<string, unknown>> };
  /** Replace brand marks by provider id and by model id prefix. Values are SVG markup. */
  icons?: { providers?: Record<string, string>; brands?: Record<string, string> };
  /** Move providers into another group and/or rename them (e.g. "pi-claude" → "claude"). */
  providers?: Record<string, { group?: string; name?: string }>;
  tokens?: Record<string, string>;
  hide?: string[];
  dispose?: () => void;
}

const slots = new Map<string, SlotEntry[]>();
const toolRenderers = new Map<string, ToolEntry[]>();
const settingsSections = new Map<string, PluginSettingsSection & { pluginId: string }>();
const providerIcons = new Map<string, string>();
const brandIcons = new Map<string, string>();
const applied = new Map<string, Applied>();
const runtimeErrors = new Map<string, string>();
let generation = 0;
let customCss: HTMLLinkElement | undefined;
let started = false;

interface PluginStore {
  info?: PluginsResponse;
  loading: boolean;
  error?: string;
  /** Bumped whenever the registry changes, so slots re-render. */
  version: number;
  errors: Record<string, string>;
  refresh: (force?: boolean) => Promise<void>;
  /** The master switch for the whole plugin system. Off on first run. */
  setSystemEnabled: (enabled: boolean) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  reload: () => Promise<void>;
}

export const usePlugins = create<PluginStore>((set, get) => ({
  loading: false,
  version: 0,
  errors: {},

  refresh: async (force = false) => {
    if (get().loading && !force) return;
    set({ loading: true, error: undefined });
    try {
      const res = await fetch("/api/plugins", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const info = (await res.json()) as PluginsResponse;
      await loadAll(info);
    } catch (err) {
      set({ error: (err as Error).message || "Couldn't reach the OpenBuild server" });
    } finally {
      set({ loading: false });
    }
  },

  setSystemEnabled: async (enabled) => {
    try {
      const res = await fetch("/api/plugins/system", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
      await get().refresh(true);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  setEnabled: async (id, enabled) => {
    try {
      const res = await fetch(`/api/plugins/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
      await get().refresh(true);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  reload: async () => {
    try {
      await fetch("/api/plugins/reload", { method: "POST" });
    } catch {}
    await get().refresh(true);
  },
}));

function bump() {
  usePlugins.setState((s) => ({ version: s.version + 1, errors: Object.fromEntries(runtimeErrors) }));
}

function reportError(id: string, message: string) {
  runtimeErrors.set(id, message);
  bump();
}

// ------------------------------------------------------------------ applying a plugin

function applyStyles(info: PluginInfo): Applied {
  const entry: Applied = { tokens: [] };
  for (const [name, value] of Object.entries({ ...info.tokens })) {
    if (!name.startsWith("--")) continue;
    const previous = document.documentElement.style.getPropertyValue(name);
    document.documentElement.style.setProperty(name, value);
    entry.tokens.push({ name, previous });
  }
  const hide = info.hide?.filter(Boolean) ?? [];
  if (hide.length) {
    const style = document.createElement("style");
    style.dataset.openbuildHide = info.id;
    style.textContent = `:where(${hide.join(", ")}) { display: none !important; }`;
    document.head.append(style);
    entry.hide = style;
  }
  if (info.stylesUrl) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${info.stylesUrl}?v=${Date.now()}`;
    link.dataset.openbuildPlugin = info.id;
    document.head.append(link);
    entry.styles = link;
  }
  return entry;
}

function unapply(entry: Applied) {
  entry.styles?.remove();
  entry.hide?.remove();
  // Reverse order: a client module's token sits on top of one from the manifest.
  for (const { name, previous } of [...entry.tokens].reverse()) {
    if (previous) document.documentElement.style.setProperty(name, previous);
    else document.documentElement.style.removeProperty(name);
  }
  try {
    entry.dispose?.();
  } catch (err) {
    console.error("[plugins] dispose failed", err);
  }
}

function unloadAll() {
  for (const entry of applied.values()) unapply(entry);
  applied.clear();
  slots.clear();
  toolRenderers.clear();
  settingsSections.clear();
  providerIcons.clear();
  brandIcons.clear();
  clearProviderOverrides();
  runtimeErrors.clear();
  bump();
}

function applyCustomCss(info: PluginsResponse) {
  if (!info.customCss) {
    customCss?.remove();
    customCss = undefined;
    return;
  }
  if (!customCss) {
    customCss = document.createElement("link");
    customCss.rel = "stylesheet";
    customCss.dataset.openbuildCustomCss = "";
    document.head.append(customCss);
  }
  customCss.href = `/api/plugins/custom.css?v=${Date.now()}`;
}

function register(info: PluginInfo, config: ClientPlugin, entry: Applied) {
  const components = (value: NonNullable<ClientPlugin["slots"]>[string] | undefined) =>
    (Array.isArray(value) ? value : value ? [value] : []).filter((c): c is ComponentType<Record<string, unknown>> => typeof c === "function");

  // Manifest slots are listed in Settings before the module loads; the module is what actually fills them.
  for (const [slot, value] of Object.entries(config.slots ?? {})) {
    const list = slots.get(slot) ?? [];
    for (const component of components(value)) list.push({ pluginId: info.id, component });
    slots.set(slot, list);
  }

  for (const [tool, component] of Object.entries(config.toolRenderers ?? {})) {
    if (typeof component !== "function") continue;
    const list = toolRenderers.get(tool) ?? [];
    list.push({ pluginId: info.id, component });
    toolRenderers.set(tool, list);
  }

  for (const [provider, svg] of Object.entries(config.icons?.providers ?? {})) {
    if (typeof svg === "string" && svg.trim().startsWith("<svg")) providerIcons.set(provider.toLowerCase(), svg);
  }
  for (const [prefix, svg] of Object.entries(config.icons?.brands ?? {})) {
    if (typeof svg === "string" && svg.trim().startsWith("<svg")) brandIcons.set(prefix.toLowerCase(), svg);
  }

  if (config.providers) setProviderOverrides(config.providers);

  if (config.settings?.component && typeof config.settings.component === "function") {
    settingsSections.set(`plugin:${info.id}`, {
      id: `plugin:${info.id}`,
      pluginId: info.id,
      label: config.settings.label || info.name,
      icon: config.settings.icon,
      component: config.settings.component,
    });
  }

  // A client module may add tokens/hide rules beyond its manifest.
  for (const [name, value] of Object.entries(config.tokens ?? {})) {
    if (!name.startsWith("--")) continue;
    const previous = document.documentElement.style.getPropertyValue(name);
    document.documentElement.style.setProperty(name, value);
    entry.tokens.push({ name, previous });
  }
  if (config.hide?.length) {
    const style = document.createElement("style");
    style.dataset.openbuildHide = info.id;
    style.textContent = `:where(${config.hide.filter(Boolean).join(", ")}) { display: none !important; }`;
    document.head.append(style);
    entry.hide = style;
  }

  entry.dispose = config.dispose;
}

const importModule = new Function("url", "return import(url)") as (url: string) => Promise<{ default?: unknown }>;

async function loadAll(info: PluginsResponse) {
  const current = ++generation;
  unloadAll();
  usePlugins.setState({ info });

  // The master switch, off by default. Nothing runs — not even custom CSS — until it's on.
  if (info.safe || !info.enabled) {
    customCss?.remove();
    customCss = undefined;
    bump();
    return;
  }

  applyCustomCss(info);

  for (const plugin of info.plugins) {
    if (plugin.error || info.disabled.includes(plugin.id)) continue;
    if (plugin.apiVersion !== PLUGIN_API_VERSION) {
      runtimeErrors.set(plugin.id, `This plugin needs apiVersion ${plugin.apiVersion}; OpenBuild supports ${PLUGIN_API_VERSION}.`);
      continue;
    }
    const entry = applyStyles(plugin);
    applied.set(plugin.id, entry);
    if (!plugin.client || !plugin.clientUrl) continue;

    try {
      host.plugin = { id: plugin.id, name: plugin.name };
      const mod = await importModule(`${plugin.clientUrl}?v=${Date.now()}`);
      if (current !== generation) return;
      const exported = mod.default;
      const config = (typeof exported === "function" ? await (exported as (api: typeof host) => ClientPlugin)(host) : exported) as ClientPlugin | undefined;
      if (!config || typeof config !== "object") throw new Error("The client module has no default export");
      register(plugin, config, entry);
    } catch (err) {
      const message = (err as Error).message || String(err);
      runtimeErrors.set(plugin.id, message);
      unapply(entry);
      applied.delete(plugin.id);
      console.error(`[plugin:${plugin.id}]`, err);
    }
  }
  if (current === generation) bump();
}

/** Fetch plugins and watch for file changes. Called once after the app unlocks. */
export function initPlugins() {
  if (started) return;
  started = true;
  void usePlugins.getState().refresh();
  try {
    const events = new EventSource("/api/plugins/events");
    events.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string };
        if (data.type === "reload" || data.type === "enabled") void usePlugins.getState().refresh(true);
      } catch {}
    };
  } catch {
    // No EventSource (very old browser): the Plugins page has a Reload button.
  }
}

// ------------------------------------------------------------------ icon overrides

/** The provider icon a plugin registered, by provider id (e.g. "deepseek"). */
export function pluginProviderSvg(provider: string): string | undefined {
  return providerIcons.get(provider.toLowerCase());
}

/** The model brand a plugin registered, by the longest matching bare model id prefix. */
export function pluginBrandSvg(modelId: string): string | undefined {
  const id = modelId.toLowerCase();
  const bare = id.slice(id.lastIndexOf("/") + 1);
  let match: string | undefined;
  for (const prefix of brandIcons.keys()) {
    if (bare.startsWith(prefix) && (!match || prefix.length > match.length)) match = prefix;
  }
  return match ? brandIcons.get(match) : undefined;
}

// ------------------------------------------------------------------ React integration

class PluginBoundary extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(this.props.id, error.message || "A plugin crashed while rendering");
    console.error(`[plugin:${this.props.id}]`, error, info.componentStack);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Render every plugin component registered for a slot. Context is passed through as props. */
export function PluginSlot({ name, context }: { name: string; context?: Record<string, unknown> }) {
  usePlugins((s) => s.version);
  const entries = slots.get(name);
  if (!entries?.length) return null;
  return (
    <>
      {entries.map((entry, i) => {
        const Component = entry.component;
        return (
          <PluginBoundary key={`${entry.pluginId}:${i}`} id={entry.pluginId}>
            <Component {...context} />
          </PluginBoundary>
        );
      })}
    </>
  );
}

/** Tool renderers a plugin registered for `name` (e.g. "bash"). Empty means use the built-in row. */
export function useToolRenderers(name: string): ComponentType<{ part: ToolPart; cwd?: string }>[] {
  usePlugins((s) => s.version);
  return (toolRenderers.get(name) ?? []).map((entry) => entry.component);
}

/** Wrap plugin-rendered UI so one plugin's crash can't take the app down. */
export function PluginRender({ pluginId, children }: { pluginId: string; children: ReactNode }) {
  return <PluginBoundary id={pluginId}>{children}</PluginBoundary>;
}

export function usePluginSettingsSections(): PluginSettingsSection[] {
  usePlugins((s) => s.version);
  return [...settingsSections.values()].map((s) => ({ id: s.id, label: s.label, icon: s.icon, component: s.component }));
}

export function PluginSettingsPage({ section }: { section: string }) {
  usePlugins((s) => s.version);
  const entry = settingsSections.get(section);
  if (!entry) return null;
  const Component = entry.component as ComponentType<Record<string, unknown>>;
  return (
    <PluginBoundary id={entry.pluginId}>
      <Component />
    </PluginBoundary>
  );
}

export function pluginRuntimeErrors(): Record<string, string> {
  return Object.fromEntries(runtimeErrors);
}
