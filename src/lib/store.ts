import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PlanId } from "../../shared/types";
import { detectModels } from "./api";
import { deleteAllChats, deleteChat, saveChat } from "./db";
import { defaultModel, findModel, isAuto } from "./models";
import type { Chat, Detection, Message, Settings } from "./types";

export type SettingsSection = "profile" | "general" | "keys" | "appearance";

const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  autoScroll: true,
  cmdEnter: true,
  autoRouter: true,
  // Defaults as drawn in the wireframe.
  avoid: [
    { id: "deepseek-v4.1-flash", name: "Deepseek v4.1 flash" },
    { id: "gpt-6-luna", name: "GPT 6 Luna" },
  ],
  prioritize: [
    { id: "qwen3.8-flash", name: "Qwen3.8 flash", tag: "Speed" },
    { id: "claude-opus-5-5", name: "claude Opus 5.5", tag: "complex" },
  ],
  profile: { name: "", bio: "", location: "", language: "" },
  keys: {},
  effort: "medium",
};

interface State {
  settings: Settings;
  detection: Partial<Record<PlanId, Detection>>;
  chats: Chat[];
  chatsLoaded: boolean;
  activeChatId?: string;
  sidebarOpen: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSection;

  updateSettings: (patch: Partial<Settings>) => void;
  updateProfile: (patch: Partial<Settings["profile"]>) => void;
  setKey: (plan: PlanId, key: string | undefined) => void;
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
      settingsOpen: false,
      settingsSection: "profile",

      updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      updateProfile: (patch) => set((s) => ({ settings: { ...s.settings, profile: { ...s.settings.profile, ...patch } } })),

      setKey: (plan, key) => {
        const keys = { ...get().settings.keys };
        if (key?.trim()) keys[plan] = key.trim();
        else delete keys[plan];
        set((s) => ({ settings: { ...s.settings, keys } }));
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

      refreshDetection: async (only) => {
        const { keys } = get().settings;
        const plans = only ? [only] : (Object.keys(keys) as PlanId[]);
        await Promise.all(
          plans.map(async (plan) => {
            const key = keys[plan];
            if (!key) return;
            detectControllers[plan]?.abort();
            const ctrl = (detectControllers[plan] = new AbortController());
            set((s) => ({
              detection: {
                ...s.detection,
                // Keep previously detected models usable while re-checking.
                [plan]: { plan, status: "checking", models: s.detection[plan]?.models ?? [], checkedAt: s.detection[plan]?.checkedAt },
              },
            }));
            try {
              const result = await detectModels(plan, key, ctrl.signal);
              // A transient failure shouldn't wipe a previously good model list.
              const prev = get().detection[plan];
              const models = result.status === "error" && prev?.models.length ? prev.models : result.models;
              set((s) => ({ detection: { ...s.detection, [plan]: { ...result, models } } }));
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

      newChat: () => set({ activeChatId: undefined }),
      selectChat: (id) => set({ activeChatId: id }),
      removeChat: (id) => {
        void deleteChat(id);
        set((s) => ({ chats: s.chats.filter((c) => c.id !== id), activeChatId: s.activeChatId === id ? undefined : s.activeChatId }));
      },
      removeAllChats: () => {
        void deleteAllChats();
        set({ chats: [], activeChatId: undefined });
      },
      setChats: (chats) => set({ chats, chatsLoaded: true }),
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
      version: 1,
      partialize: (s) => ({ settings: s.settings, detection: s.detection, sidebarOpen: s.sidebarOpen }),
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
          settings: { ...DEFAULT_SETTINGS, ...p.settings, profile: { ...DEFAULT_SETTINGS.profile, ...p.settings?.profile } },
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
