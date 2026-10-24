import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { GITHUB_SCOPE, PLANS, SEARCH_PROVIDERS, type Device, type KeyEdit, type KeyInventory, type PlanId, type Project, type SearchProviderId, type ThreadRuntime } from "../../shared/types";
import { verifySearch } from "./api";
import { listDevices, listProjects, piModels, piProblems, piProviders, piResources, piStatus, type PiProblem, type PiProvider, type PiResource, type PiStatus } from "./pi";
import { qualifyProject, setDeviceList } from "./devices";
import { config } from "./runtime";
import { deleteAllChats, deleteChat, saveChat } from "./db";
import { defaultModel, findModel, isAuto } from "./models";
import { keyId } from "./keys";
import { effortFor, effortKey } from "./effort";
import type { Effort } from "../../shared/types";
import { serverStorage } from "./stateStorage";
import { clearLegacyKeys, fetchKeys, readLegacyKeys, saveKeys, stashLegacyKeys } from "./keyStore";
import type { Chat, Detection, KeyStatus, Message, Selection, Settings } from "./types";

export type SettingsSection = "security" | "account" | "profile" | "general" | "pi" | "keys" | "projects" | "search" | "appearance" | "plugins" | `plugin:${string}`;

const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  font: "fun",
  autoScroll: true,
  cmdEnter: false,
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

interface State {
  settings: Settings;
  detection: Partial<Record<PlanId, Detection>>;
  /** Per search provider, the result of checking each saved key or instance (by keyId). */
  searchStatus: Partial<Record<SearchProviderId, Record<string, KeyStatus>>>;
  chats: Chat[];
  chatsLoaded: boolean;
  activeChatId?: string;
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
  loadPiStatus: (fresh?: boolean) => Promise<void>;
  loadPiResources: () => Promise<void>;
  loadPiProviders: () => Promise<void>;

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
  setSidebarOpen: (open: boolean) => void;
  /** Point the composer at a model: for the open chat only, or (on the new-chat screen) for new chats. */
  setSelection: (selection: Selection) => void;
  setEffort: (effort: Effort, selection?: Selection) => void;
  newChat: () => void;
  selectChat: (id: string) => void;
  removeChat: (id: string) => void;
  removeAllChats: () => void;
  setChats: (chats: Chat[]) => void;
  upsertChat: (chat: Chat, persist?: boolean) => void;
  /** Update chat metadata (title, pinned, archived, workspace) without changing its recency. */
  updateChat: (id: string, patch: Partial<Pick<Chat, "title" | "pinned" | "archived" | "titleSource" | "unread" | "workspace">>) => void;
  setSearchFocus: (focus: State["searchFocus"]) => void;
  patchMessage: (chatId: string, messageId: string, patch: Partial<Message> | ((m: Message) => Partial<Message>), persist?: boolean) => void;
}

const detectControllers: Partial<Record<PlanId, AbortController>> = {};
const searchControllers = new Map<string, AbortController>();

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
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
      projects: [],
      projectsLoaded: false,
      devices: [],
      devicesLoaded: false,
      piCache: {},
      loadPiStatus: async (fresh = false) => {
        const status = await piStatus(fresh);
        set((s) => ({ piCache: { ...s.piCache, status } }));
      },
      loadPiResources: async () => {
        const resources = await piResources();
        set((s) => ({ piCache: { ...s.piCache, resources } }));
        // Problems are secondary: show them when they arrive, and never fail the list over them.
        piProblems().then(
          (problems) => set((s) => ({ piCache: { ...s.piCache, problems } })),
          () => {},
        );
      },
      loadPiProviders: async () => {
        const providers = await piProviders();
        set((s) => ({ piCache: { ...s.piCache, providers } }));
      },
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
      },
      loadProjects: async () => {
        if (!get().devicesLoaded) await get().loadDevices().catch(() => {});
        const { devices } = get();
        const local = await listProjects().catch(() => [] as Project[]);
        const remote = await Promise.all(
          devices
            .filter((d) => !d.local)
            .map((device) => listProjects(device.id).then((list) => list.map((p) => qualifyProject(p, device)), () => [] as Project[])),
        );
        set({ projects: [...local, ...remote.flat()], projectsLoaded: true });
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
        set((s) => ({ detection: { pi: { plan: "pi", status: "checking", models: s.detection.pi?.models ?? [], checkedAt: s.detection.pi?.checkedAt } } }));
        try {
          const r = await piModels(true);
          if (ctrl.signal.aborted) return;
          if (!Array.isArray(r?.models)) throw new Error("Pi didn't list any models");
          set({ detection: { pi: { plan: "pi", status: "valid", models: r.models, checkedAt: Date.now() } }, piDefault: r.defaultModel });
        } catch (err) {
          if (ctrl.signal.aborted) return;
          // Keep what was known; a transient failure shouldn't empty the model picker.
          set((s) => ({ detection: { pi: { plan: "pi", status: "error", error: (err as Error).message, models: s.detection.pi?.models ?? [], checkedAt: Date.now() } } }));
        }
        ensureSelection();
      },

      openSettings: (section) => set((s) => ({ settingsOpen: true, settingsSection: section ?? s.settingsSection })),
      closeSettings: () => set({ settingsOpen: false }),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),

      setSelection: (selection) => {
        const id = get().activeChatId;
        if (id) set((s) => ({ selections: { ...s.selections, [id]: selection } }));
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
      newChat: () => set((s) => ({
        activeChatId: undefined,
        searchFocus: undefined,
        settings: s.settings.workspace.defaultMode === "last-used"
          ? s.settings
          : { ...s.settings, workspace: { ...s.settings.workspace, mode: s.settings.workspace.defaultMode ?? "worktree", branch: undefined } },
      })),
      selectChat: (id) => {
        set({ activeChatId: id, searchFocus: undefined });
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
      version: 4,
      migrate: (persisted, version) => {
        const state = persisted as Partial<State>;
        // v1 shipped sample router chips and Cmd+Enter / auto router on; reset those to the new defaults.
        if (version < 2 && state.settings) {
          const s = state.settings;
          const isAuto = s.selection && "auto" in s.selection;
          state.settings = {
            ...s,
            cmdEnter: false,
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
        return {
          ...current,
          ...p,
          detection,
          searchStatus,
          piCache: { ...current.piCache, ...p.piCache },
          sidebarOpen: window.innerWidth > 768 ? (p.sidebarOpen ?? true) : false,
          sections: { ...current.sections, ...p.sections },
          view: { ...DEFAULT_VIEW, ...p.view },
          settings: {
            ...DEFAULT_SETTINGS,
            ...p.settings,
            profile: { ...DEFAULT_SETTINGS.profile, ...p.settings?.profile },
            naming: { ...DEFAULT_SETTINGS.naming, ...p.settings?.naming },
            searchDigest: { ...DEFAULT_SETTINGS.searchDigest, ...p.settings?.searchDigest },
            workspace: { ...DEFAULT_SETTINGS.workspace, ...p.settings?.workspace },
          },
        };
      },
    },
  ),
);

export function composerEffort(s: Pick<State, "activeChatId" | "chats" | "selections" | "settings" | "detection">): Effort {
  return effortFor(s.settings, s.chats.find((c) => c.id === s.activeChatId), selectionFor(s));
}

const AUTO: Selection = { auto: true };

/**
 * The model the composer sends with: in a chat, the one picked there or else the one its last reply
 * used; on the new-chat screen (or when a chat's model isn't available anymore), the new-chat model.
 * Returns stored objects only, so it's safe as a store selector.
 */
export function selectionFor(s: Pick<State, "activeChatId" | "chats" | "selections" | "settings" | "detection">): Selection | undefined {
  const id = s.activeChatId;
  if (id) {
    const picked = s.selections[id];
    const reply = s.chats.find((c) => c.id === id)?.messages.findLast((m) => m.role === "assistant" && m.model);
    const sel = picked ?? (reply ? (reply.routed ? AUTO : reply.model) : undefined);
    if (sel && (isAuto(sel) ? s.settings.autoRouter : findModel(s.detection, sel))) return sel;
  }
  return s.settings.selection;
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
