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
import { addProviderOrder, clearProviderOverrides, setProviderOverrides, snapshotProviderOverrides, type ProviderOverride } from "./pluginOverrides";
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
  /** Provider groups in the model picker's rail, top to bottom; unlisted groups follow in Pi's order. */
  providerOrder?: string[];
  tokens?: Record<string, string>;
  hide?: string[];
  dispose?: () => void;
}

const slots = new Map<string, SlotEntry[]>();
const toolRenderers = new Map<string, ToolEntry[]>();
const settingsSections = new Map<string, PluginSettingsSection & { pluginId: string }>();
const providerIcons = new Map<string, string>();
const brandIcons = new Map<string, string>();
// Icons found by the last successful load are mirrored here so the first paint after a refresh can
// already use them. Client modules are fetched and evaluated asynchronously, so without this the
// built-in marks would flash for a frame or two before the plugin's replacements swapped in.
const ICON_CACHE_KEY = "openbuild:plugin-icons";
let stagedProviderIcons = new Map<string, string>();
let stagedBrandIcons = new Map<string, string>();
// Provider groups/names are staged and cached the same way: without this, a reload lists
// plugin-grouped providers (e.g. claude-code-2) under Custom until the client modules import.
let stagedOverrides: Record<string, ProviderOverride> = {};
let stagedOrder: string[] = [];
/**
 * A committed icon snapshot (including an empty one) is enough to paint the entire sidebar.
 * Keep that snapshot while plugins refresh, then swap the registry atomically. Only a cold load
 * without a usable snapshot waits, avoiding a built-in mark flashing before a plugin override.
 */
let iconsReady = false;
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
  /** Delete a plugin's folder from disk. Resolves false when the server refused. */
  remove: (id: string) => Promise<boolean>;
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
      // A failed initial request must not leave every uncached icon blank indefinitely. Keep any
      // cached overrides, but release built-in fallbacks now that initialization has settled.
      if (!iconsReady) {
        iconsReady = true;
        bump();
      }
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

  remove: async (id) => {
    try {
      const res = await fetch(`/api/plugins/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
      await get().refresh(true);
      return true;
    } catch (err) {
      set({ error: (err as Error).message || `Couldn't delete ${id}` });
      return false;
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
  // Committed icons are left alone until the next load finishes: they're what's on screen right now,
  // and blanking them here would flash the built-in marks while the client modules re-import.
  stagedProviderIcons = new Map();
  stagedBrandIcons = new Map();
  stagedOverrides = {};
  stagedOrder = [];
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
    if (isSvg(svg)) stagedProviderIcons.set(provider.toLowerCase(), svg);
  }
  for (const [prefix, svg] of Object.entries(config.icons?.brands ?? {})) {
    if (isSvg(svg)) stagedBrandIcons.set(prefix.toLowerCase(), svg);
  }

  if (config.providers && typeof config.providers === "object") Object.assign(stagedOverrides, config.providers);
  if (Array.isArray(config.providerOrder)) stagedOrder.push(...config.providerOrder);

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

function isSvg(value: unknown): value is string {
  return typeof value === "string" && value.trim().startsWith("<svg");
}

/** Publish the icons staged by this load and remember them for the next page load. */
function commitIcons() {
  providerIcons.clear();
  brandIcons.clear();
  for (const [provider, svg] of stagedProviderIcons) providerIcons.set(provider, svg);
  for (const [prefix, svg] of stagedBrandIcons) brandIcons.set(prefix, svg);
  clearProviderOverrides();
  setProviderOverrides(stagedOverrides);
  addProviderOrder(stagedOrder);
  iconsReady = true;
  try {
    // Written even when empty: "no overrides" is just as worth remembering as overrides are.
    localStorage.setItem(ICON_CACHE_KEY, JSON.stringify({ providers: Object.fromEntries(providerIcons), brands: Object.fromEntries(brandIcons), ...snapshotProviderOverrides() }));
  } catch {
    // Storage may be full or blocked; the icons still work for this page load.
  }
}

/** Load the icons saved by the previous load, synchronously, before React's first render. */
function hydrateIcons() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(ICON_CACHE_KEY);
  } catch {
    // Storage blocked (site data off, an embedded view, a full quota): fall back to drawing nothing
    // until the plugins load, so no built-in mark is painted and then swapped.
    return;
  }
  if (!raw) return;
  try {
    const saved: unknown = JSON.parse(raw);
    const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
    if (!isRecord(saved) || !isRecord(saved.providers) || !isRecord(saved.brands)) return;
    for (const [provider, svg] of Object.entries(saved.providers)) if (isSvg(svg)) providerIcons.set(provider.toLowerCase(), svg);
    for (const [prefix, svg] of Object.entries(saved.brands)) if (isSvg(svg)) brandIcons.set(prefix.toLowerCase(), svg);
    // Provider groups and names too (snapshots from before they were cached simply lack these).
    if (isRecord(saved.overrides)) setProviderOverrides(saved.overrides as Record<string, ProviderOverride>);
    if (Array.isArray(saved.order)) addProviderOrder(saved.order);
    // commitIcons writes the full registry, not just overrides for icons previously rendered.
    // Missing entries therefore use built-ins immediately, without waiting on plugin imports.
    iconsReady = true;
  } catch {
    // A corrupt cache means the same as none: wait for the plugins rather than guess.
  }
}

hydrateIcons();

async function loadAll(info: PluginsResponse) {
  const current = ++generation;
  unloadAll();
  usePlugins.setState({ info });

  // The master switch, off by default. Nothing runs — not even custom CSS — until it's on.
  if (info.safe || !info.enabled) {
    customCss?.remove();
    customCss = undefined;
    commitIcons();
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
      if (current !== generation) return;
      if (!config || typeof config !== "object") throw new Error("The client module has no default export");
      register(plugin, config, entry);
    } catch (err) {
      if (current !== generation) return;
      const message = (err as Error).message || String(err);
      runtimeErrors.set(plugin.id, message);
      unapply(entry);
      applied.delete(plugin.id);
      console.error(`[plugin:${plugin.id}]`, err);
    }
  }
  if (current === generation) {
    commitIcons();
    bump();
  }
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

/** Whether a cached snapshot or settled initialization permits built-in fallbacks. */
export function pluginIconsReady(): boolean {
  return iconsReady;
}

/** The provider icon a plugin registered, by provider id (e.g. "deepseek"). */
export function pluginProviderSvg(provider: string): string | undefined {
  return providerIcons.get(provider.toLowerCase());
}

/** Provider-scoped model prefixes take precedence over bare model id prefixes. */
export function pluginBrandSvg(modelId: string): string | undefined {
  const id = modelId.toLowerCase();
  // Scoped aliases (e.g. claude-code-2/default) must not rebrand another provider's default.
  let scoped: string | undefined;
  for (const prefix of brandIcons.keys()) {
    if (prefix.includes("/") && id.startsWith(prefix) && (!scoped || prefix.length > scoped.length)) scoped = prefix;
  }
  if (scoped) return brandIcons.get(scoped);
  const bare = id.slice(id.lastIndexOf("/") + 1);
  let match: string | undefined;
  for (const prefix of brandIcons.keys()) {
    if (!prefix.includes("/") && bare.startsWith(prefix) && (!match || prefix.length > match.length)) match = prefix;
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
