import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { PLANS, SEARCH_PROVIDERS, type KeyEdit, type KeyInventory, type PlanId, type SearchProviderId } from "../../shared/types";
import { detectModels } from "./api";
import { deleteAllChats, deleteChat, saveChat } from "./db";
import { defaultModel, findModel, isAuto } from "./models";
import { keyId } from "./keys";
import { serverStorage } from "./stateStorage";
import { clearLegacyKeys, fetchKeys, readLegacyKeys, saveKeys, stashLegacyKeys } from "./keyStore";
import type { Chat, Detection, Message, Settings } from "./types";

export type SettingsSection = "account" | "profile" | "general" | "keys" | "search" | "appearance";

const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  font: "normal",
  autoScroll: true,
  cmdEnter: false,
  autoRouter: false,
  avoid: [],
  prioritize: [],
  profile: { name: "", bio: "", location: "", language: "" },
  keys: {},
  webSearch: true,
  search: {},
  effort: "medium",
  naming: { enabled: true, models: [] },
  syncApiKeys: false,
};

type SidebarSections = { pinned: boolean; archived: boolean };

/** Sidebar list options from the filter menu. */
export interface SidebarView {
  sort: "updated" | "created";
  /** Model ids to show; empty = all models. */
  models: string[];
  includePinned: boolean;
}

export const DEFAULT_VIEW: SidebarView = { sort: "updated", models: [], includePinned: true };

interface State {
  settings: Settings;
  detection: Partial<Record<PlanId, Detection>>;
  chats: Chat[];
  chatsLoaded: boolean;
  activeChatId?: string;
  /** Set when a chat is opened from a search result, so the matching message can be highlighted. */
  searchFocus?: { chatId: string; messageId: string; words: string[] };
  sidebarOpen: boolean;
  /** Expanded state of the collapsible sidebar sections. */
  sections: SidebarSections;
  view: SidebarView;
  settingsOpen: boolean;
  settingsSection: SettingsSection;

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
  /** Load the saved key ids from the server, first moving any keys a previous version left in this browser. */
  syncKeys: () => Promise<void>;
  toggleSection: (section: keyof SidebarSections) => void;
  setView: (patch: Partial<SidebarView>) => void;
  refreshDetection: (plan?: PlanId) => Promise<void>;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSidebarOpen: (open: boolean) => void;
  newChat: () => void;
  selectChat: (id: string) => void;
  removeChat: (id: string) => void;
  removeAllChats: () => void;
  setChats: (chats: Chat[]) => void;
  upsertChat: (chat: Chat, persist?: boolean) => void;
  /** Update chat metadata (title, pinned, archived) without changing its recency. */
  updateChat: (id: string, patch: Partial<Pick<Chat, "title" | "pinned" | "archived" | "titleSource" | "unread">>) => void;
  setSearchFocus: (focus: State["searchFocus"]) => void;
  patchMessage: (chatId: string, messageId: string, patch: Partial<Message> | ((m: Message) => Partial<Message>), persist?: boolean) => void;
}

const detectControllers: Partial<Record<PlanId, AbortController>> = {};

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      detection: {},
      chats: [],
      chatsLoaded: false,
      sidebarOpen: typeof window === "undefined" || window.innerWidth > 768,
      sections: { pinned: true, archived: false },
      view: DEFAULT_VIEW,
      settingsOpen: false,
      settingsSection: "profile",

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
        set((s) => ({ keysError: undefined, settings: { ...s.settings, keys } }));
        if (keys[plan]) void get().refreshDetection(plan);
        else {
          detectControllers[plan]?.abort();
          set((s) => {
            const detection = { ...s.detection };
            delete detection[plan];
            return { detection };
          });
          ensureSelection();
        }
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
        set((s) => ({ keysError: undefined, settings: { ...s.settings, search } }));
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
          return { keyBackend: inventory.backend, settings: { ...s.settings, keys, search } };
        });
        ensureSelection();
      },

      refreshDetection: async (only) => {
        const { keys } = get().settings;
        const plans = only ? [only] : (Object.keys(keys) as PlanId[]);
        await Promise.all(
          plans.map(async (plan) => {
            const list = keys[plan];
            if (!list?.length) return;
            detectControllers[plan]?.abort();
            const ctrl = (detectControllers[plan] = new AbortController());
            set((s) => {
              const prev = s.detection[plan];
              return {
                detection: {
                  ...s.detection,
                  // Keep previously detected models usable while re-checking.
                  [plan]: {
                    plan,
                    status: "checking",
                    models: prev?.models ?? [],
                    checkedAt: prev?.checkedAt,
                    keys: Object.fromEntries(list.map((k) => [keyId(k), { ...prev?.keys?.[keyId(k)], status: "checking" as const }])),
                  },
                },
              };
            });
            try {
              const results = await Promise.all(list.map((k) => detectModels(plan, k, ctrl.signal)));
              // Merge models across the plan's keys (the first key's order wins).
              const seen = new Set<string>();
              const merged = results
                .filter((r) => r.status === "valid")
                .flatMap((r) => r.models)
                .filter((m) => !seen.has(m.id) && seen.add(m.id));
              const status = results.some((r) => r.status === "valid") ? "valid" : results.every((r) => r.status === "invalid") ? "invalid" : "error";
              // A transient failure shouldn't wipe a previously good model list.
              const prev = get().detection[plan];
              const models = status === "error" && prev?.models.length ? prev.models : merged;
              const detection: Detection = {
                plan,
                status,
                models,
                checkedAt: Date.now(),
                error: status === "valid" ? undefined : results.find((r) => r.error)?.error,
                keys: Object.fromEntries(results.map((r, i) => [keyId(list[i]!), { status: r.status, error: r.error, models: r.models.length }])),
              };
              set((s) => ({ detection: { ...s.detection, [plan]: detection } }));
              ensureSelection();
            } catch {
              // Aborted by a newer request.
            }
          }),
        );
      },

      openSettings: (section) => set((s) => ({ settingsOpen: true, settingsSection: section ?? s.settingsSection })),
      closeSettings: () => set({ settingsOpen: false }),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),

      newChat: () => set({ activeChatId: undefined, searchFocus: undefined }),
      selectChat: (id) => {
        set({ activeChatId: id, searchFocus: undefined });
        if (get().chats.find((c) => c.id === id)?.unread) get().updateChat(id, { unread: false });
      },
      removeChat: (id) => {
        void deleteChat(id);
        set((s) => ({ chats: s.chats.filter((c) => c.id !== id), activeChatId: s.activeChatId === id ? undefined : s.activeChatId }));
      },
      removeAllChats: () => {
        void deleteAllChats();
        set({ chats: [], activeChatId: undefined });
      },
      setChats: (chats) => set({ chats, chatsLoaded: true }),
      updateChat: (id, patch) => {
        let updated: Chat | undefined;
        set((s) => ({ chats: s.chats.map((c) => (c.id === id ? (updated = { ...c, ...patch }) : c)) }));
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
      partialize: (s) => ({ settings: s.settings, detection: s.detection, sidebarOpen: s.sidebarOpen, sections: s.sections, view: s.view }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<State>;
        const detection = { ...(p.detection ?? {}) };
        // Never resume in a "checking" state from a previous session.
        for (const plan of Object.keys(detection) as PlanId[]) {
          const d = detection[plan]!;
          if (d.status === "checking") detection[plan] = { ...d, status: "valid", checkedAt: d.checkedAt ?? 0 };
        }
        return {
          ...current,
          ...p,
          detection,
          sidebarOpen: window.innerWidth > 768 ? (p.sidebarOpen ?? true) : false,
          sections: { ...current.sections, ...p.sections },
          view: { ...DEFAULT_VIEW, ...p.view },
          settings: {
            ...DEFAULT_SETTINGS,
            ...p.settings,
            profile: { ...DEFAULT_SETTINGS.profile, ...p.settings?.profile },
            naming: { ...DEFAULT_SETTINGS.naming, ...p.settings?.naming },
          },
        };
      },
    },
  ),
);

/** Keep the composer pointed at a model that actually exists for the configured keys. */
export function ensureSelection() {
  const { settings, detection, updateSettings } = useStore.getState();
  const sel = settings.selection;
  if (isAuto(sel)) {
    if (settings.autoRouter) return;
  } else if (findModel(detection, sel)) return;
  // Don't drop a selection while its plan is still being (re)detected.
  if (sel && !isAuto(sel) && detection[sel.plan]?.status === "checking") return;
  const next = defaultModel(detection);
  if (next || sel) updateSettings({ selection: next });
}
