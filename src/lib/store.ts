import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { GITHUB_SCOPE, PLANS, SEARCH_PROVIDERS, type Device, type KeyEdit, type KeyInventory, type PlanId, type Project, type SearchProviderId, type ThreadRuntime } from "../../shared/types";
import { verifySearch } from "./api";
import { opencodeModels, claudeModels, cursorModels, codexModels, fxModels, permissionModes, listDevices, listProjects, piModels, piProblems, piProviders, piResources, piStatus, type PiProblem, type PiProvider, type PiResource, type PiStatus } from "./pi";
import { qualifyProject, setDeviceList } from "./devices";
import { config } from "./runtime";
import { deleteAllChats, deleteChat, saveChat } from "./db";
import { defaultModel, findModel, isAuto } from "./models";
import { keyId } from "./keys";
import { effortFor, effortKey, speedFor } from "./effort";
import type { Effort, ModelInfo, PermissionModes } from "../../shared/types";
import { serverStorage } from "./stateStorage";
import { clearLegacyKeys, fetchKeys, readLegacyKeys, saveKeys, stashLegacyKeys } from "./keyStore";
import type { Chat, Detection, KeyStatus, Message, ModelRef, Selection, Settings } from "./types";

export type SettingsSection = "security" | "account" | "profile" | "general" | "shortcuts" | "pi" | "keys" | "runtimes" | "projects" | "devices" | "search" | "appearance" | "notifications" | "plugins" | `plugin:${string}`;

const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  font: "fun",
  autoScroll: true,
  confirmDelete: true,
  notifications: { builds: true, runtimeUpdates: true },
  autoRouter: false,
  avoid: [],
  prioritize: [],
  profile: { name: "", bio: "", location: "", language: "" },
  keys: {},
  webSearch: true,
  search: {},
  github: [],
  searchDigest: { enabled: true },
  effort: "medium",
  naming: { enabled: true, models: [] },
  syncApiKeys: false,
  workspace: { mode: "worktree", defaultMode: "worktree" },
  favorites: [],
  threadRuntime: "pi",
  terminal: "bottom",
  shortcuts: {},
};

type SidebarSections = { pinned: boolean; archived: boolean };

/** Sidebar list options from the filter menu. */
export interface SidebarView {
  sort: "updated" | "created";
  /** Model ids to show; empty = all models. */
  models: string[];
  includePinned: boolean;
  /** Also list threads subagents ran. */
  subagents: boolean;
  /** Runtime to list: both, or only threads on one. */
  runtime: "all" | ThreadRuntime;
}

export const DEFAULT_VIEW: SidebarView = { sort: "updated", models: [], includePinned: true, subagents: false, runtime: "all" };

/**
 * What Settings → Pi and Settings → Providers show, fetched at launch (and kept from the last
 * session) so those pages open with their content instead of a spinner.
 */
export interface PiCache {
  status?: PiStatus;
  resources?: { resources: PiResource[]; packages: string[] };
  problems?: PiProblem[];
  providers?: PiProvider[];
}

const NO_PI: PiCache = {};

/** Pi's state on one device: this one, or a paired device reached through the proxy. */
export const piCacheOn = (s: Pick<State, "piCache" | "piRemote">, deviceId?: string): PiCache => (deviceId ? (s.piRemote[deviceId] ?? NO_PI) : s.piCache);

/** Keep Pi's state for this device (persisted) or for a paired one (for as long as the page is open). */
function withPi(s: State, deviceId: string | undefined, patch: PiCache): Partial<State> {
  if (!deviceId) return { piCache: { ...s.piCache, ...patch } };
  return { piRemote: { ...s.piRemote, [deviceId]: { ...s.piRemote[deviceId], ...patch } } };
}

/** How old a model list gets before it's asked for again (the old one stays on screen meanwhile). */
export const MODELS_STALE = 10 * 60 * 1000;
/** Paired devices whose Pi model list is being fetched right now. */
const inflightDevices = new Set<string>();

/** A paired device whose model list hasn't arrived yet. */
const PENDING_PI: Detection = { plan: "pi", status: "checking", models: [] };
const PENDING_FX: Detection = { plan: "fx", status: "checking", models: [] };
const PENDING_CODEX: Detection = { plan: "codex", status: "checking", models: [] };
const PENDING_CURSOR: Detection = { plan: "cursor", status: "checking", models: [] };
const PENDING_CLAUDE: Detection = { plan: "claude", status: "checking", models: [] };
const PENDING_OPENCODE: Detection = { plan: "opencode", status: "checking", models: [] };

/** Runtimes that list their own permission modes. */
export type PermissionRuntime = "codex" | "cursor" | "claude";
export const hasPermissionModes = (runtime: ThreadRuntime | undefined): runtime is PermissionRuntime => runtime === "codex" || runtime === "cursor" || runtime === "claude";
export type PermissionListing = PermissionModes & { status: "checking" | "valid" | "error"; error?: string };
/** Codex and Claude Code resolve project config layers, so their listings are per folder; Cursor's is per device. */
export const permissionKey = (runtime: PermissionRuntime, deviceId?: string, cwd?: string) => `${runtime}|${deviceId ?? ""}|${runtime !== "cursor" ? cwd ?? "" : ""}`;

/** The permission mode a thread (or the draft) asks for; undefined = the runtime's configured default. */
export function permissionOf(s: Pick<State, "chats" | "settings">, chatId?: string): string | undefined {
  const chat = chatId ? s.chats.find((c) => c.id === chatId) : undefined;
  const runtime = chat ? chat.runtime : s.settings.threadRuntime;
  if (!hasPermissionModes(runtime)) return undefined;
  if (!chat) return s.settings.runtimePermissions?.[runtime] || undefined;
  return chat.permission ?? (runtime === "cursor" && chat.cursorAllowAllTools === true ? "force" : undefined);
}

/** The runtime a thread uses (or, with no thread, the one new threads start with). */
export function runtimeOf(s: Pick<State, "chats" | "settings">, chatId?: string): ThreadRuntime {
  const chat = chatId ? s.chats.find((c) => c.id === chatId) : undefined;
  return chat ? (chat.runtime ?? "pi") : (s.settings.threadRuntime ?? "pi");
}

/**
 * The paired device a thread's next turn runs on: the one its workspace lives on, or (before its
 * first turn made a workspace) the device of the project new threads start in, or the device picked
 * for project-less threads. Undefined = this server.
 */
export function threadDevice(
  s: Pick<State, "chats" | "settings"> & Partial<Pick<State, "projects">>,
  chatId?: string,
): string | undefined {
  const chat = chatId ? s.chats.find((c) => c.id === chatId) : undefined;
  if (chat?.workspace) return chat.workspace.deviceId;
  const id = s.settings.workspace?.projectId;
  return id ? s.projects?.find((p) => p.id === id)?.deviceId : s.settings.workspace?.deviceId;
}

/** The device the composer is pointed at. */
export const composerDevice = (s: Pick<State, "activeChatId" | "chats" | "settings"> & Partial<Pick<State, "projects">>): string | undefined =>
  threadDevice(s, s.activeChatId);

/**
 * Pi's models on a device: this server's, or a paired device's own list. A device whose list isn't
 * in yet reads as "checking" rather than borrowing this server's models, which it may not share.
 */
export function deviceDetection(
  s: Pick<State, "detection"> & Partial<Pick<State, "remoteModels" | "fxModels" | "codexModels" | "cursorModels" | "claudeModels" | "opencodeModels">>,
  deviceId?: string,
  runtime?: ThreadRuntime,
): Partial<Record<PlanId, Detection>> {
  // fx threads use the models fx lists on that device, and only those.
  if (runtime === "fx") return { fx: s.fxModels?.[deviceId ?? ""] ?? PENDING_FX };
  if (runtime === "codex") return { codex: s.codexModels?.[deviceId ?? ""] ?? PENDING_CODEX };
  if (runtime === "cursor") return { cursor: s.cursorModels?.[deviceId ?? ""] ?? PENDING_CURSOR };
  if (runtime === "claude") return { claude: s.claudeModels?.[deviceId ?? ""] ?? PENDING_CLAUDE };
  if (runtime === "opencode") return { opencode: s.opencodeModels?.[deviceId ?? ""] ?? PENDING_OPENCODE };
  if (!deviceId) return s.detection;
  return { pi: s.remoteModels?.[deviceId] ?? PENDING_PI };
}

interface State {
  settings: Settings;
  detection: Partial<Record<PlanId, Detection>>;
  /** Per search provider, the result of checking each saved key or instance (by keyId). */
  searchStatus: Partial<Record<SearchProviderId, Record<string, KeyStatus>>>;
  chats: Chat[];
  chatsLoaded: boolean;
  activeChatId?: string;
  /** Pick a permission mode for a thread (or the draft). Ignored for runtimes without permission modes. */
  setPermission: (id: string | undefined, chatId?: string) => void;
  /** Permission modes each native runtime reports, by `permissionKey`. Not persisted. */
  permissionModes: Record<string, PermissionListing>;
  loadPermissionModes: (runtime: PermissionRuntime, deviceId?: string, cwd?: string, fresh?: boolean) => Promise<void>;
  /** A model picked in a chat without sending yet. Otherwise a chat uses the model of its last reply. Kept on this device only. */
  selections: Record<string, Selection>;
  /** Set when a chat is opened from a search result, so the matching message can be highlighted. */
  searchFocus?: { chatId: string; messageId: string; words: string[] };
  sidebarOpen: boolean;
  /** Expanded state of the collapsible sidebar sections. */
  sections: SidebarSections;
  view: SidebarView;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  /** The usage page is showing in place of a thread. */
  usageOpen: boolean;
  /** Projects threads can work in (from this server, and from paired devices). Remote ids are namespaced. */
  projects: Project[];
  projectsLoaded: boolean;
  loadProjects: () => Promise<void>;
  /** This server first, then paired devices. */
  devices: Device[];
  devicesLoaded: boolean;
  loadDevices: () => Promise<void>;
  /** Pi's own default model ("<provider>/<id>"), used until one is picked here. */
  piDefault?: string;
  /** Pi's install state, resources and providers, loaded at launch and reused by Settings. */
  piCache: PiCache;
  /** The same for paired devices, fetched when Settings asks for one. Not persisted. */
  piRemote: Record<string, PiCache>;
  /**
   * The models each paired device's Pi lists, by device id. This server's models live in
   * `detection.pi`. Persisted, and warmed for every device at launch (`warmModels`), so switching
   * device shows the last known list at once instead of waiting.
   */
  remoteModels: Record<string, Detection>;
  /** The models fx lists, by device id ("" = this server). Persisted like `remoteModels`. */
  fxModels: Record<string, Detection & { defaultModel?: string }>;
  loadFxModels: (deviceId?: string, fresh?: boolean) => Promise<void>;
  codexModels: Record<string, Detection & { defaultModel?: string }>;
  loadCodexModels: (deviceId?: string, fresh?: boolean) => Promise<void>;
  cursorModels: Record<string, Detection & { defaultModel?: string }>;
  loadCursorModels: (deviceId?: string, fresh?: boolean) => Promise<void>;
  claudeModels: Record<string, Detection & { defaultModel?: string }>;
  loadClaudeModels: (deviceId?: string, fresh?: boolean) => Promise<void>;
  opencodeModels: Record<string, Detection & { defaultModel?: string }>;
  loadOpencodeModels: (deviceId?: string, fresh?: boolean) => Promise<void>;
  loadDeviceModels: (deviceId: string, fresh?: boolean) => Promise<void>;
  /** Fetch, in the background, every model list (each runtime, each online device) that's missing or old. */
  warmModels: () => void;
  loadPiStatus: (fresh?: boolean, deviceId?: string) => Promise<void>;
  loadPiResources: (deviceId?: string) => Promise<void>;
  loadPiProviders: (deviceId?: string) => Promise<void>;
  setPiCache: (patch: PiCache, deviceId?: string) => void;

  updateSettings: (patch: Partial<Settings>) => void;
  updateProfile: (patch: Partial<Settings["profile"]>) => void;
  /** Where the server keeps secrets (known once the server has answered). */
  keyBackend?: KeyInventory["backend"];
  /** The last failure to save a key, shown in Settings. */
  keysError?: string;
  /** Replace a plan's ordered key list (empty removes the plan). The secrets go to the server's vault. */
  setKeys: (plan: PlanId, keys: KeyEdit[]) => Promise<void>;
  /** Replace a search provider's ordered key list; for instance URLs (`{ id: url }` / `{ secret: url }`) it's kept locally. */
  setSearchKeys: (provider: SearchProviderId, keys: KeyEdit[]) => Promise<void>;
  /** Replace the saved GitHub tokens (fallbacks in order). The secrets go to the server's vault. */
  setGithubKeys: (keys: KeyEdit[]) => Promise<void>;
  /** Load the saved key ids from the server, first moving any keys a previous version left in this browser. */
  syncKeys: () => Promise<void>;
  toggleSection: (section: keyof SidebarSections) => void;
  setView: (patch: Partial<SidebarView>) => void;
  refreshDetection: (plan?: PlanId) => Promise<void>;
  /** Check a search provider's keys: the given ones, or else those not checked yet. */
  verifySearch: (provider: SearchProviderId, only?: string[]) => Promise<void>;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setUsageOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  /** Point the composer at a model: for the open chat only, or (on the new-chat screen) for new chats. */
  setSelection: (selection: Selection) => void;
  setEffort: (effort: Effort, selection?: Selection) => void;
  /** Pick a service tier for the selected model (undefined = standard). */
  setSpeed: (speed: string | undefined, selection?: Selection) => void;
  newChat: () => void;
  selectChat: (id: string) => void;
  removeChat: (id: string) => void;
  removeAllChats: () => void;
  setChats: (chats: Chat[]) => void;
  upsertChat: (chat: Chat, persist?: boolean) => void;
  /** Update chat metadata (title, pinned, archived, workspace) without changing its recency. */
  updateChat: (id: string, patch: Partial<Pick<Chat, "title" | "pinned" | "archived" | "titleSource" | "unread" | "workspace" | "cursorAllowAllTools" | "permission">>) => void;
  setSearchFocus: (focus: State["searchFocus"]) => void;
  patchMessage: (chatId: string, messageId: string, patch: Partial<Message> | ((m: Message) => Partial<Message>), persist?: boolean) => void;
}

const detectControllers: Partial<Record<PlanId, AbortController>> = {};
const searchControllers = new Map<string, AbortController>();

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      setPermission: (id, chatId) => {
        const s = get();
        const runtime = runtimeOf(s, chatId);
        if (!hasPermissionModes(runtime)) return;
        if (chatId) {
          // Clearing the legacy Cursor flag too, so "default" really means default.
          s.updateChat(chatId, { permission: id, cursorAllowAllTools: undefined });
        }
        s.updateSettings({ runtimePermissions: { ...get().settings.runtimePermissions, [runtime]: id ?? "" } });
      },
      permissionModes: {},
      loadPermissionModes: async (runtime, deviceId, cwd, fresh = false) => {
        const key = permissionKey(runtime, deviceId, cwd);
        const prev = get().permissionModes[key];
        if (prev?.status === "checking" && Date.now() - prev.checkedAt < 30_000) return;
        set((s) => ({ permissionModes: { ...s.permissionModes, [key]: { modes: prev?.modes ?? [], defaultMode: prev?.defaultMode, status: "checking", checkedAt: Date.now() } } }));
        try {
          const r = await permissionModes(runtime, deviceId, cwd, fresh);
          if (!Array.isArray(r?.modes)) throw new Error("No permission modes listed");
          set((s) => ({ permissionModes: { ...s.permissionModes, [key]: { modes: r.modes, defaultMode: r.defaultMode, status: "valid", checkedAt: r.checkedAt ?? Date.now() } } }));
        } catch (err) {
          set((s) => ({ permissionModes: { ...s.permissionModes, [key]: { modes: s.permissionModes[key]?.modes ?? [], defaultMode: s.permissionModes[key]?.defaultMode, status: "error", error: (err as Error).message, checkedAt: Date.now() } } }));
        }
      },
      detection: {},
      searchStatus: {},
      chats: [],
      chatsLoaded: false,
      selections: {},
      sidebarOpen: typeof window === "undefined" || window.innerWidth > 768,
      sections: { pinned: true, archived: false },
      view: DEFAULT_VIEW,
      settingsOpen: false,
      settingsSection: "profile",
      usageOpen: false,
      projects: [],
      projectsLoaded: false,
      devices: [],
      devicesLoaded: false,
      piCache: {},
      piRemote: {},
      remoteModels: {},
      cursorModels: {},
      loadCursorModels: async (deviceId, fresh = false) => {
        const key = deviceId ?? "";
        const prev = get().cursorModels[key];
        if (prev?.status === "checking" && prev.checkedAt && Date.now() - prev.checkedAt < 30_000) return;
        set((s) => ({ cursorModels: { ...s.cursorModels, [key]: { plan: "cursor", status: "checking", models: prev?.models ?? [], defaultModel: prev?.defaultModel, checkedAt: Date.now() } } }));
        try {
          const r = await cursorModels(fresh, deviceId);
          if (!Array.isArray(r?.models)) throw new Error("Cursor didn't list any models");
          set((s) => ({ cursorModels: { ...s.cursorModels, [key]: { plan: "cursor", status: "valid", models: r.models, defaultModel: r.defaultModel, checkedAt: r.checkedAt ?? Date.now() } } }));
        } catch (err) {
          set((s) => ({ cursorModels: { ...s.cursorModels, [key]: { plan: "cursor", status: "error", error: (err as Error).message, models: s.cursorModels[key]?.models ?? [], defaultModel: s.cursorModels[key]?.defaultModel, checkedAt: Date.now() } } }));
        }
      },
      opencodeModels: {},
      loadOpencodeModels: async (deviceId, fresh = false) => {
        const key = deviceId ?? "";
        const prev = get().opencodeModels[key];
        if (prev?.status === "checking" && prev.checkedAt && Date.now() - prev.checkedAt < 30_000) return;
        set((s) => ({ opencodeModels: { ...s.opencodeModels, [key]: { plan: "opencode", status: "checking", models: prev?.models ?? [], defaultModel: prev?.defaultModel, checkedAt: Date.now() } } }));
        try {
          const r = await opencodeModels(fresh, deviceId);
          if (!Array.isArray(r?.models)) throw new Error("OpenCode didn't list any models");
          set((s) => ({ opencodeModels: { ...s.opencodeModels, [key]: { plan: "opencode", status: "valid", models: r.models, defaultModel: r.defaultModel, checkedAt: r.checkedAt ?? Date.now() } } }));
        } catch (err) {
          set((s) => ({ opencodeModels: { ...s.opencodeModels, [key]: { plan: "opencode", status: "error", error: (err as Error).message, models: s.opencodeModels[key]?.models ?? [], defaultModel: s.opencodeModels[key]?.defaultModel, checkedAt: Date.now() } } }));
        }
      },
      claudeModels: {},
      loadClaudeModels: async (deviceId, fresh = false) => {
        const key = deviceId ?? "";
        const prev = get().claudeModels[key];
        if (prev?.status === "checking" && prev.checkedAt && Date.now() - prev.checkedAt < 30_000) return;
        set((s) => ({ claudeModels: { ...s.claudeModels, [key]: { plan: "claude", status: "checking", models: prev?.models ?? [], defaultModel: prev?.defaultModel, checkedAt: Date.now() } } }));
        try {
          const r = await claudeModels(fresh, deviceId);
          if (!Array.isArray(r?.models)) throw new Error("Claude Code didn't list any models");
          set((s) => ({ claudeModels: { ...s.claudeModels, [key]: { plan: "claude", status: "valid", models: r.models, defaultModel: r.defaultModel, checkedAt: r.checkedAt ?? Date.now() } } }));
        } catch (err) {
          set((s) => ({ claudeModels: { ...s.claudeModels, [key]: { plan: "claude", status: "error", error: (err as Error).message, models: s.claudeModels[key]?.models ?? [], defaultModel: s.claudeModels[key]?.defaultModel, checkedAt: Date.now() } } }));
        }
      },
      codexModels: {},
      loadCodexModels: async (deviceId, fresh = false) => {
        const key = deviceId ?? "";
        const prev = get().codexModels[key];
        if (prev?.status === "checking" && prev.checkedAt && Date.now() - prev.checkedAt < 30_000) return;
        set((s) => ({ codexModels: { ...s.codexModels, [key]: { plan: "codex", status: "checking", models: prev?.models ?? [], defaultModel: prev?.defaultModel, checkedAt: Date.now() } } }));
        try {
          // Model discovery must not wait for installation/auth status checks.
          const r = await codexModels(fresh, deviceId);
          if (!Array.isArray(r?.models)) throw new Error("Codex didn't list any models");
          set((s) => ({ codexModels: { ...s.codexModels, [key]: { plan: "codex", status: "valid", models: r.models, defaultModel: r.defaultModel, checkedAt: r.checkedAt ?? Date.now() } } }));
        } catch (err) {
          set((s) => ({ codexModels: { ...s.codexModels, [key]: { plan: "codex", status: "error", error: (err as Error).message, models: s.codexModels[key]?.models ?? [], checkedAt: Date.now() } } }));
        }
      },
      fxModels: {},
      loadFxModels: async (deviceId, fresh = false) => {
        const key = deviceId ?? "";
        const prev = get().fxModels[key];
        if (prev?.status === "checking" && prev.checkedAt && Date.now() - prev.checkedAt < 30_000) return;
        set((s) => ({ fxModels: { ...s.fxModels, [key]: { plan: "fx", status: "checking", models: prev?.models ?? [], defaultModel: prev?.defaultModel, checkedAt: Date.now() } } }));
        try {
          const r = await fxModels(fresh, deviceId);
          if (!Array.isArray(r?.models)) throw new Error("fx didn't list any models");
          set((s) => ({ fxModels: { ...s.fxModels, [key]: { plan: "fx", status: "valid", models: r.models, defaultModel: r.defaultModel, checkedAt: r.checkedAt ?? Date.now() } } }));
        } catch (err) {
          set((s) => ({ fxModels: { ...s.fxModels, [key]: { plan: "fx", status: "error", error: (err as Error).message, models: s.fxModels[key]?.models ?? [], checkedAt: Date.now() } } }));
        }
      },
      loadDeviceModels: async (deviceId, fresh = false) => {
        // Keep the old list on screen while asking again: switching device shouldn't empty the picker.
        const prev = get().remoteModels[deviceId];
        // Launch warm-up and the composer can ask at once; one request is enough.
        if (prev?.status === "checking" && inflightDevices.has(deviceId)) return;
        inflightDevices.add(deviceId);
        set((s) => ({ remoteModels: { ...s.remoteModels, [deviceId]: { plan: "pi", status: "checking", models: prev?.models ?? [], scope: prev?.scope, checkedAt: prev?.checkedAt } } }));
        try {
          const r = await piModels(fresh, deviceId);
          if (!Array.isArray(r?.models)) throw new Error("Pi didn't list any models");
          set((s) => ({ remoteModels: { ...s.remoteModels, [deviceId]: { plan: "pi", status: "valid", models: r.models, scope: r.scope, checkedAt: r.checkedAt ?? Date.now() } } }));
        } catch (err) {
          set((s) => ({
            remoteModels: {
              ...s.remoteModels,
              [deviceId]: { plan: "pi", status: "error", error: (err as Error).message, models: s.remoteModels[deviceId]?.models ?? [], scope: s.remoteModels[deviceId]?.scope, checkedAt: Date.now() },
            },
          }));
        } finally {
          inflightDevices.delete(deviceId);
        }
      },
      loadPiStatus: async (fresh = false, deviceId) => {
        const status = await piStatus(fresh, deviceId);
        set((s) => withPi(s, deviceId, { status }));
      },
      loadPiResources: async (deviceId) => {
        const resources = await piResources(deviceId);
        set((s) => withPi(s, deviceId, { resources }));
        // Problems are secondary: show them when they arrive, and never fail the list over them.
        piProblems(deviceId).then(
          (problems) => set((s) => withPi(s, deviceId, { problems })),
          () => {},
        );
      },
      loadPiProviders: async (deviceId) => {
        const providers = await piProviders(deviceId);
        set((s) => withPi(s, deviceId, { providers }));
      },
      setPiCache: (patch, deviceId) => set((s) => withPi(s, deviceId, patch)),
      loadDevices: async () => {
        let remote: Device[] = [];
        try {
          remote = await listDevices();
        } catch {}
        const cfg = await config;
        const local: Device = {
          id: cfg.serverId ?? "local",
          serverId: cfg.serverId,
          name: cfg.machine ?? "This device",
          machine: cfg.machine,
          mode: "lan",
          urls: [],
          local: true,
          online: true,
        };
        const devices = [local, ...remote];
        setDeviceList(devices);
        set({ devices, devicesLoaded: true });
        get().warmModels();
      },
      warmModels: () => {
        const s = get();
        const due = (d?: Detection) => !d || (d.status !== "checking" && Date.now() - (d.checkedAt ?? 0) > MODELS_STALE);
        for (const device of s.devices) {
          if (!device.local && device.online === false) continue;
          const id = device.local ? undefined : device.id;
          const key = id ?? "";
          if (id && due(s.remoteModels[id])) void s.loadDeviceModels(id, !!s.remoteModels[id]);
          if (due(s.codexModels[key])) void s.loadCodexModels(id, !!s.codexModels[key]);
          if (due(s.cursorModels[key])) void s.loadCursorModels(id, !!s.cursorModels[key]);
          if (due(s.claudeModels[key])) void s.loadClaudeModels(id, !!s.claudeModels[key]);
          if (due(s.opencodeModels[key])) void s.loadOpencodeModels(id, !!s.opencodeModels[key]);
          if (due(s.fxModels[key])) void s.loadFxModels(id, !!s.fxModels[key]);
        }
      },
      loadProjects: async () => {
        if (!get().devicesLoaded) await get().loadDevices().catch(() => {});
        const { devices } = get();
        const local = await listProjects().catch(() => [] as Project[]);
        // This device's projects show at once: a paired device that's asleep must not leave the
        // picker empty while its request hangs on a dead tailnet address.
        set({ projects: local, projectsLoaded: true });
        const remote = await Promise.all(
          devices
            .filter((d) => !d.local)
            .map((device) =>
              withTimeout(listProjects(device.id), 8000).then(
                (list) => list.map((p) => qualifyProject(p, device)),
                () => [] as Project[],
              ),
            ),
        );
        set({ projects: [...local, ...remote.flat()] });
      },

      updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      updateProfile: (patch) => set((s) => ({ settings: { ...s.settings, profile: { ...s.settings.profile, ...patch } } })),

      setView: (patch) => set((s) => ({ view: { ...s.view, ...patch } })),
      toggleSection: (section) => set((s) => ({ sections: { ...s.sections, [section]: !s.sections[section] } })),

      setKeys: async (plan, edits) => {
        let ids: string[];
        try {
          ids = await saveKeys(plan, edits);
        } catch (err) {
          set({ keysError: (err as Error).message });
          return;
        }
        const keys = { ...get().settings.keys };
        if (ids.length) keys[plan] = ids;
        else delete keys[plan];
        // Opencode keys are kept (and synced) for older setups; models come from Pi.
        set((s) => ({ keysError: undefined, settings: { ...s.settings, keys } }));
      },

      setSearchKeys: async (provider, edits) => {
        let list: string[];
        if (SEARCH_PROVIDERS[provider].credential === "url") {
          list = [...new Set(edits.map((e) => ("id" in e ? e.id : e.secret).trim()).filter(Boolean))];
        } else {
          try {
            list = await saveKeys(provider, edits);
          } catch (err) {
            set({ keysError: (err as Error).message });
            return;
          }
        }
        const search = { ...get().settings.search };
        if (list.length) search[provider] = list;
        else delete search[provider];
        set((s) => {
          // Drop the status of removed entries; new ones get checked below.
          const prev = s.searchStatus[provider] ?? {};
          const kept = Object.fromEntries(list.map(keyId).filter((id) => prev[id]).map((id) => [id, prev[id]!]));
          return { keysError: undefined, settings: { ...s.settings, search }, searchStatus: { ...s.searchStatus, [provider]: kept } };
        });
        void get().verifySearch(provider);
      },

      setGithubKeys: async (edits) => {
        try {
          const list = await saveKeys(GITHUB_SCOPE, edits);
          set((s) => ({ keysError: undefined, settings: { ...s.settings, github: list } }));
        } catch (err) {
          set({ keysError: (err as Error).message });
        }
      },

      verifySearch: async (provider, only) => {
        const list = get().settings.search[provider] ?? [];
        const statuses = get().searchStatus[provider] ?? {};
        const targets = list.filter((k) => (only ? only.includes(k) : !statuses[keyId(k)]));
        const setStatus = (k: string, status: KeyStatus) =>
          set((s) => ({ searchStatus: { ...s.searchStatus, [provider]: { ...s.searchStatus[provider], [keyId(k)]: status } } }));
        await Promise.all(
          targets.map(async (k) => {
            const slot = `${provider}:${keyId(k)}`;
            searchControllers.get(slot)?.abort();
            const ctrl = new AbortController();
            searchControllers.set(slot, ctrl);
            setStatus(k, { status: "checking" });
            try {
              const r = await verifySearch(provider, k, ctrl.signal);
              // The entry may have been removed while it was being checked.
              if ((get().settings.search[provider] ?? []).includes(k)) setStatus(k, { status: r.status, error: r.error });
            } catch {
              // Aborted by a newer check.
            } finally {
              if (searchControllers.get(slot) === ctrl) searchControllers.delete(slot);
            }
          }),
        );
      },

      syncKeys: async () => {
        let inventory: KeyInventory | undefined;
        try {
          inventory = await fetchKeys();
        } catch (err) {
          set({ keysError: (err as Error).message });
          return;
        }
        if (!inventory) return; // Server unreachable: keep the cached ids; detection will report it.
        const saved = inventory.keys;
        // Move keys an older version kept in this browser into the vault. They stay in a temporary
        // backup until every one is saved, so a failure loses nothing.
        const legacy = readLegacyKeys();
        if (legacy) {
          let complete = true;
          for (const [scope, secrets] of Object.entries(legacy)) {
            try {
              saved[scope] = await saveKeys(scope as PlanId, [...(saved[scope] ?? []).map((id) => ({ id })), ...secrets.map((secret) => ({ secret }))]);
            } catch (err) {
              complete = false;
              set({ keysError: `Couldn't move your saved ${scope} key into the secure store: ${(err as Error).message}` });
            }
          }
          if (complete) clearLegacyKeys();
        }
        set((s) => {
          const keys: Settings["keys"] = {};
          for (const plan of Object.keys(PLANS) as PlanId[]) if (saved[plan]?.length) keys[plan] = saved[plan];
          // Instance URLs (SearXNG) stay local; key-based providers mirror the server.
          const search: Settings["search"] = {};
          for (const [id, p] of Object.entries(SEARCH_PROVIDERS)) {
            const list = p.credential === "url" ? s.settings.search[id as SearchProviderId] : saved[id];
            if (list?.length) search[id as SearchProviderId] = list;
          }
          return { keyBackend: inventory.backend, settings: { ...s.settings, keys, search, github: saved[GITHUB_SCOPE] ?? [] } };
        });
        ensureSelection();
      },

      // Models come from the installed Pi: the ones its configured providers can use.
      refreshDetection: async () => {
        detectControllers.pi?.abort();
        const ctrl = (detectControllers.pi = new AbortController());
        set((s) => ({ detection: { pi: { plan: "pi", status: "checking", models: s.detection.pi?.models ?? [], scope: s.detection.pi?.scope, checkedAt: s.detection.pi?.checkedAt } } }));
        try {
          const r = await piModels(true);
          if (ctrl.signal.aborted) return;
          if (!Array.isArray(r?.models)) throw new Error("Pi didn't list any models");
          const models = withMissingProviders(get().detection.pi?.models ?? [], r.models);
          set({ detection: { pi: { plan: "pi", status: "valid", models, scope: r.scope, checkedAt: Date.now() } }, piDefault: r.defaultModel });
        } catch (err) {
          if (ctrl.signal.aborted) return;
          // Keep what was known; a transient failure shouldn't empty the model picker.
          set((s) => ({ detection: { pi: { plan: "pi", status: "error", error: (err as Error).message, models: s.detection.pi?.models ?? [], scope: s.detection.pi?.scope, checkedAt: Date.now() } } }));
        }
        ensureSelection();
      },

      openSettings: (section) => set((s) => ({ settingsOpen: true, settingsSection: section ?? s.settingsSection })),
      closeSettings: () => set({ settingsOpen: false }),
      setUsageOpen: (open) => set({ usageOpen: open }),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),

      setSelection: (selection) => {
        const id = get().activeChatId;
        if (id) set((s) => ({ selections: { ...s.selections, [id]: selection } }));
        else if (["fx", "codex", "cursor", "claude", "opencode"].includes(runtimeOf(get()))) {
          const runtime = runtimeOf(get()) as "fx" | "codex" | "cursor" | "claude" | "opencode";
          const key = composerDevice(get()) ?? "";
          const nativeSelections = get().settings.nativeSelections;
          get().updateSettings({ nativeSelections: { ...nativeSelections, [runtime]: { ...nativeSelections?.[runtime], [key]: isAuto(selection) ? undefined : selection } } });
        }
        else get().updateSettings({ selection });
      },
      setEffort: (effort, selection = selectionFor(get())) => {
        if (!selection) return;
        const s = get();
        const key = effortKey(selection);
        const chat = s.chats.find((c) => c.id === s.activeChatId);
        if (chat) {
          const updated = { ...chat, efforts: { ...chat.efforts, [key]: effort } };
          set({ chats: s.chats.map((c) => c.id === chat.id ? updated : c) });
          void saveChat(updated);
        } else {
          s.updateSettings({ modelEfforts: { ...s.settings.modelEfforts, [key]: effort } });
        }
      },
      setSpeed: (speed, selection = selectionFor(get())) => {
        if (!selection || isAuto(selection)) return;
        const s = get();
        const key = effortKey(selection);
        const chat = s.chats.find((c) => c.id === s.activeChatId);
        if (chat) {
          const updated = { ...chat, speeds: { ...chat.speeds, [key]: speed ?? "" } };
          set({ chats: s.chats.map((c) => c.id === chat.id ? updated : c) });
          void saveChat(updated);
        }
        s.updateSettings({ modelSpeeds: { ...get().settings.modelSpeeds, [key]: speed ?? "" } });
      },
      newChat: () => set((s) => ({
        activeChatId: undefined,
        usageOpen: false,
        searchFocus: undefined,
        settings: s.settings.workspace.defaultMode === "last-used"
          ? s.settings
          : { ...s.settings, workspace: { ...s.settings.workspace, mode: s.settings.workspace.defaultMode ?? "worktree", branch: undefined } },
      })),
      selectChat: (id) => {
        set({ activeChatId: id, searchFocus: undefined, usageOpen: false });
        if (get().chats.find((c) => c.id === id)?.unread) get().updateChat(id, { unread: false });
      },
      removeChat: (id) => {
        void deleteChat(id);
        set((s) => {
          const { [id]: _, ...selections } = s.selections;
          return { chats: s.chats.filter((c) => c.id !== id), activeChatId: s.activeChatId === id ? undefined : s.activeChatId, selections };
        });
      },
      removeAllChats: () => {
        void deleteAllChats();
        set({ chats: [], activeChatId: undefined, selections: {} });
      },
      setChats: (chats) => set({ chats, chatsLoaded: true }),
      updateChat: (id, patch) => {
        let updated: Chat | undefined;
        set((s) => ({
          chats: s.chats.map((c) => (c.id === id ? (updated = { ...c, ...patch }) : c)),
          // Archiving the chat you're on leaves you on a new (empty) chat.
          ...(patch.archived && s.activeChatId === id ? { activeChatId: undefined, searchFocus: undefined } : {}),
        }));
        if (updated) void saveChat(updated);
      },
      setSearchFocus: (searchFocus) => set({ searchFocus }),
      upsertChat: (chat, persist = true) => {
        set((s) => {
          const rest = s.chats.filter((c) => c.id !== chat.id);
          return { chats: [chat, ...rest].sort((a, b) => b.updatedAt - a.updatedAt) };
        });
        if (persist) void saveChat(chat);
      },
      patchMessage: (chatId, messageId, patch, persist = false) => {
        let updated: Chat | undefined;
        set((s) => ({
          chats: s.chats.map((c) => {
            if (c.id !== chatId) return c;
            updated = {
              ...c,
              messages: c.messages.map((m) => (m.id === messageId ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m)),
            };
            return updated;
          }),
        }));
        if (persist && updated) void saveChat(updated);
      },
    }),
    {
      name: "openchat",
      // Saved by the local server on disk, so every port and browser sees the same settings.
      storage: createJSONStorage(() => serverStorage),
      version: 5,
      migrate: (persisted, version) => {
        const state = persisted as Partial<State>;
        // v1 shipped sample router chips and the auto router on; reset those to the new defaults.
        if (version < 2 && state.settings) {
          const s = state.settings;
          const isAuto = s.selection && "auto" in s.selection;
          state.settings = {
            ...s,
            autoRouter: false,
            avoid: s.avoid.filter((m) => !["deepseek-v4.1-flash", "gpt-6-luna"].includes(m.id)),
            prioritize: s.prioritize.filter((m) => !["qwen3.8-flash", "claude-opus-5-5"].includes(m.id)),
            selection: isAuto ? undefined : s.selection,
          };
        }
        // v3: one key per plan → an ordered list of keys.
        if (version < 3 && state.settings) {
          const old = state.settings.keys as unknown as Partial<Record<PlanId, string | string[]>>;
          state.settings.keys = Object.fromEntries(
            Object.entries(old ?? {}).map(([plan, k]) => [plan, Array.isArray(k) ? k : k ? [k] : []]),
          ) as Settings["keys"];
        }
        // v4: API keys live in the server's keychain, not here. Anything this browser still holds is
        // backed up until syncKeys has moved it, and only the non-secret parts stay in settings.
        if (version < 4 && state.settings) {
          stashLegacyKeys(state.settings);
          const search: Settings["search"] = {};
          for (const [id, list] of Object.entries(state.settings.search ?? {})) {
            if (SEARCH_PROVIDERS[id as SearchProviderId]?.credential === "url") search[id as SearchProviderId] = list;
          }
          state.settings = { ...state.settings, keys: {}, search };
        }
        // v5: the Pi-only update notice became runtime updates, with a list of runtimes (none saved
        // = all of them) and per-release dismissal.
        if (version < 5 && state.settings) {
          const old = (state.settings.notifications ?? {}) as Partial<Settings["notifications"]> & { piUpdates?: boolean; dismissedPi?: string };
          const { piUpdates, dismissedPi, ...rest } = old;
          state.settings = {
            ...state.settings,
            notifications: {
              builds: rest.builds ?? true,
              runtimeUpdates: piUpdates ?? rest.runtimeUpdates ?? true,
              updateRuntimes: rest.updateRuntimes,
              dismissedUpdates: rest.dismissedUpdates ?? (dismissedPi ? { pi: dismissedPi } : undefined),
            },
          };
        }
        return state as State;
      },
      partialize: (s) => ({
        settings: s.settings,
        detection: s.detection,
        searchStatus: s.searchStatus,
        selections: s.selections,
        sidebarOpen: s.sidebarOpen,
        sections: s.sections,
        view: s.view,
        piCache: s.piCache,
        // Model lists per device and runtime, so switching never waits on a first fetch.
        remoteModels: s.remoteModels,
        fxModels: s.fxModels,
        codexModels: s.codexModels,
        cursorModels: s.cursorModels,
        claudeModels: s.claudeModels,
        opencodeModels: s.opencodeModels,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<State>;
        const detection = { ...(p.detection ?? {}) };
        // Never resume in a "checking" state from a previous session.
        for (const plan of Object.keys(detection) as PlanId[]) {
          const d = detection[plan]!;
          if (d.status === "checking") detection[plan] = { ...d, status: "valid", checkedAt: d.checkedAt ?? 0 };
        }
        // A check interrupted by a reload is dropped, not re-run: entries are only checked when saved.
        const searchStatus: State["searchStatus"] = {};
        for (const [provider, statuses] of Object.entries(p.searchStatus ?? {})) {
          searchStatus[provider as SearchProviderId] = Object.fromEntries(Object.entries(statuses ?? {}).filter(([, v]) => v.status !== "checking"));
        }
        // Same for the per-device lists: a fetch cut off by a reload is just an old list.
        // One that never had models is dropped so it's simply asked again.
        const settle = <T extends Detection>(lists: Record<string, T> | undefined): Record<string, T> =>
          Object.fromEntries(
            Object.entries(lists ?? {}).flatMap(([k, d]) =>
              d.status !== "checking" ? [[k, d]] : d.models?.length ? [[k, { ...d, status: "valid", checkedAt: d.checkedAt ?? 0 }]] : [],
            ),
          );
        return {
          ...current,
          ...p,
          detection,
          remoteModels: settle(p.remoteModels),
          fxModels: settle(p.fxModels),
          codexModels: settle(p.codexModels),
          cursorModels: settle(p.cursorModels),
          claudeModels: settle(p.claudeModels),
          opencodeModels: settle(p.opencodeModels),
          searchStatus,
          piCache: { ...current.piCache, ...p.piCache },
          sidebarOpen: window.innerWidth > 768 ? (p.sidebarOpen ?? true) : false,
          sections: { ...current.sections, ...p.sections },
          view: { ...DEFAULT_VIEW, ...p.view },
          settings: (() => {
            // Retired: Cmd+Enter now starts a thread in the background. Drop a saved toggle so it isn't written back.
            const { cmdEnter: _retired, ...saved } = (p.settings ?? {}) as Settings & { cmdEnter?: boolean };
            return {
              ...DEFAULT_SETTINGS,
              ...saved,
              profile: { ...DEFAULT_SETTINGS.profile, ...saved.profile },
              naming: { ...DEFAULT_SETTINGS.naming, ...saved.naming },
              searchDigest: { ...DEFAULT_SETTINGS.searchDigest, ...saved.searchDigest },
              workspace: { ...DEFAULT_SETTINGS.workspace, ...saved.workspace },
              notifications: { ...DEFAULT_SETTINGS.notifications, ...saved.notifications },
            };
          })(),
        };
      },
    },
  ),
);

export function composerEffort(s: Pick<State, "activeChatId" | "chats" | "selections" | "settings" | "detection">): Effort {
  return effortFor(s.settings, s.chats.find((c) => c.id === s.activeChatId), selectionFor(s));
}

/** The composer's speed for the selected model, before checking what the model offers. */
export function composerSpeed(s: Pick<State, "activeChatId" | "chats" | "selections" | "settings" | "detection">): string | undefined {
  return speedFor(s.settings, s.chats.find((c) => c.id === s.activeChatId), selectionFor(s));
}

const AUTO: Selection = { auto: true };

/** Settle a request within `ms`, so a device that never answers can't hold a caller for ever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("it didn't answer in time")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * The model a device's list falls back to, memoised per list object. `selectionFor` is used as a
 * zustand selector, and zustand compares snapshots by identity: a fresh object on every call
 * re-renders for ever, and React gives up on the page ("the result of getSnapshot should be
 * cached"). Keyed on the list, so two pickers watching different devices don't share an answer.
 */
const deviceDefaults = new WeakMap<Detection, ModelRef | undefined>();
function deviceDefault(detection: Partial<Record<PlanId, Detection>>): ModelRef | undefined {
  const pi = detection.pi;
  if (!pi) return undefined;
  if (!deviceDefaults.has(pi)) deviceDefaults.set(pi, defaultModel(detection));
  return deviceDefaults.get(pi);
}

/**
 * The model the composer sends with: in a chat, the one picked there or else the one its last reply
 * used; on the new-chat screen (or when a chat's model isn't available anymore), the new-chat model.
 * Returns stored objects only, so it's safe as a store selector.
 */
export function selectionFor(
  s: Pick<State, "activeChatId" | "chats" | "selections" | "settings" | "detection"> & Partial<Pick<State, "projects" | "remoteModels" | "fxModels" | "codexModels" | "cursorModels" | "claudeModels" | "opencodeModels">>,
): Selection | undefined {
  const id = s.activeChatId;
  // A thread working on a paired device can only use that device's models.
  const deviceId = composerDevice(s);
  const runtime = runtimeOf(s, id);
  if (runtime === "fx" || runtime === "codex" || runtime === "cursor" || runtime === "claude" || runtime === "opencode") return nativeSelectionFor(s, id, deviceId, runtime);
  const detection = deviceDetection(s, deviceId);
  // Don't drop a chat's model while the device's list is still on its way.
  const pending = deviceId ? !s.remoteModels?.[deviceId] : false;
  if (id) {
    const picked = s.selections[id];
    const reply = s.chats.find((c) => c.id === id)?.messages.findLast((m) => m.role === "assistant" && m.model);
    const sel = picked ?? (reply ? (reply.routed ? AUTO : reply.model) : undefined);
    if (sel && (isAuto(sel) ? s.settings.autoRouter : pending || findModel(detection, sel))) return sel;
  }
  const fallback = s.settings.selection;
  // The new-chat model may belong to this server only: on a paired device, point at one it does have.
  if (deviceId && !pending && fallback && !isAuto(fallback) && !findModel(detection, fallback)) return deviceDefault(detection) ?? fallback;
  return fallback;
}

const fxDefaults = new WeakMap<Detection, ModelRef | undefined>();
/** Native threads: picked model, last reply, new-thread preference, then runtime default. */
function nativeSelectionFor(
  s: Pick<State, "chats" | "selections" | "settings"> & Partial<Pick<State, "fxModels" | "codexModels" | "cursorModels" | "claudeModels" | "opencodeModels">>,
  id: string | undefined,
  deviceId: string | undefined,
  plan: "fx" | "codex" | "cursor" | "claude" | "opencode",
): Selection | undefined {
  const d = (plan === "opencode" ? s.opencodeModels : plan === "claude" ? s.claudeModels : plan === "cursor" ? s.cursorModels : plan === "fx" ? s.fxModels : s.codexModels)?.[deviceId ?? ""];
  const known = (sel: Selection | undefined): sel is ModelRef => !!sel && !isAuto(sel) && sel.plan === plan && (!d || d.status === "checking" || d.models.some((m) => m.id === sel.id));
  if (id) {
    const picked = s.selections[id];
    const reply = s.chats.find((c) => c.id === id)?.messages.findLast((m) => m.role === "assistant" && m.model?.plan === plan)?.model;
    if (known(picked)) return picked;
    if (reply && known(reply)) return reply;
  }
  const preference = s.settings.nativeSelections?.[plan]?.[deviceId ?? ""] ?? (plan === "cursor" ? s.settings.cursorSelection : plan === "fx" ? s.settings.fxSelection : plan === "codex" ? s.settings.codexSelection : undefined);
  if (known(preference)) return preference;
  if (!d?.models.length) return undefined;
  if (!fxDefaults.has(d)) {
    const def = d.models.find((m) => m.id === (d as { defaultModel?: string }).defaultModel) ?? d.models[0]!;
    fxDefaults.set(d, { plan, id: def.id });
  }
  return fxDefaults.get(d);
}

/** Providers a listing left out once already: dropped for real if the next listing agrees. */
let droppedOnce = new Set<string>();

/**
 * A whole provider vanishing from one listing is far more often a slow auth check (claude-code's
 * `claude auth status`) than a logout. Keep its previous models for one listing, so the picker
 * doesn't flicker and chats on that provider aren't switched to another model; if the next listing
 * still lacks it, it goes.
 */
function withMissingProviders(previous: ModelInfo[], next: ModelInfo[]): ModelInfo[] {
  const have = new Set(next.map((m) => m.provider));
  const missing = new Set(previous.map((m) => m.provider).filter((p): p is string => !!p && !have.has(p) && !droppedOnce.has(p)));
  droppedOnce = missing;
  return missing.size ? [...next, ...previous.filter((m) => m.provider && missing.has(m.provider))] : next;
}

/** Keep the composer pointed at a model that actually exists for the configured keys. */
export function ensureSelection() {
  const { settings, detection, updateSettings } = useStore.getState();
  const sel = settings.selection;
  if (isAuto(sel)) {
    if (settings.autoRouter) return;
  } else if (findModel(detection, sel)) return;
  // Don't drop a selection while its plan is still being (re)detected.
  if (sel && !isAuto(sel) && detection[sel.plan]?.status === "checking") return;
  // Pi's own default model first, then the best available one.
  const piDefault = useStore.getState().piDefault;
  const next = piDefault && findModel(detection, { plan: "pi", id: piDefault }) ? { plan: "pi" as const, id: piDefault } : defaultModel(detection);
  if (next || sel) updateSettings({ selection: next });
}
