// OpenBots' state in the app. The server (server/bots/) owns the bots, conversations, memory and
// routines; this keeps a copy it receives on /api/bots/stream, and sends what the user does. The
// layout (which chat is open, folded sections) stays in this browser.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { uid } from "../id";
import { createStore, get as cacheGet, set as cacheSet } from "../kv";
import type { BotLook, Mood } from "./looks";
import { useStore } from "../store";
import type { Author, Bot, BotMessage, BotsEvent, Conversation, Draft as LiveDraft, Routine } from "./types";
import { castVote, toggleReactionIn } from "../../../shared/bots";

export interface Draft {
  text: string;
  images?: string[];
  replyTo?: string;
}

const NO_EXTENSIONS = { enabled: false, ids: [] as string[] };

interface BotsState {
  bots: Bot[];
  conversations: Conversation[];
  error?: string;
  pending: number;
  status: Record<string, Extract<BotsEvent, { t: "status" }>["status"]>;
  /** The stream hasn't been lost. Only a failed connection clears it, so opening OpenBots doesn't flash "Reconnecting". */
  connected: boolean;
  /** The server's state has arrived. Until then an empty list means "not known yet", not "no bots". */
  loaded: boolean;
  clearError: () => void;
  loadOlder: (conversationId: string) => Promise<void>;
  /** Sections the user made, in order. */
  sections: string[];
  /** Sidebar sections folded shut, by name (custom ones, "hidden", "side"). */
  folded: string[];
  activeId?: string;
  detailsOpen: boolean;
  /** The starter bots were added (once per browser). */
  seeded: boolean;
  /** SearXNG instances for web search. The other providers' keys are in the vault. */
  searxng: string[];
  /** The user's own Pi extensions to load into bots as well. */
  customExtensions: { enabled: boolean; ids: string[] };

  /** Bots typing right now, by conversation. */
  typing: Record<string, string[]>;
  /** Text a bot is still writing, shown in place of the typing dots. */
  drafts: LiveDraft[];
  /** The last reaction each bot was asked to show (BotAvatar's `pulse`). */
  pulses: Record<string, { key: number; mood?: Mood }>;
  /** A message to scroll to and flash (from a reply's quote). */
  focus?: { conversationId: string; messageId: string; key: number };

  ensureSeeded: () => void;
  /** Throw everything away and start again from the starter bots. */
  reset: () => void;
  setSearxng: (urls: string[]) => void;
  setCustomExtensions: (custom: { enabled: boolean; ids: string[] }) => Promise<unknown>;
  select: (id: string) => void;
  setDetailsOpen: (open: boolean) => void;
  createBot: (bot: { name: string; look: BotLook; instructions?: string }) => string;
  updateBot: (id: string, patch: Partial<Omit<Bot, "id">>) => void;
  makePrimary: (id: string) => void;
  deleteBot: (id: string) => void;
  createGroup: (group: { name: string; botIds: string[]; instructions?: string }) => string;
  updateConversation: (id: string, patch: Partial<Omit<Conversation, "id" | "messages">>) => void;
  deleteConversation: (id: string) => void;
  togglePin: (id: string) => void;
  addSection: (name: string) => void;
  toggleFolded: (name: string) => void;

  /** Add a message (the user's or a bot's) and bump the conversation. */
  post: (conversationId: string, message: Omit<BotMessage, "id" | "at"> & { at?: number }) => Promise<BotMessage | undefined>;
  patchMessage: (conversationId: string, messageId: string, patch: (m: BotMessage) => Partial<BotMessage>) => void;
  deleteMessage: (conversationId: string, messageId: string) => void;
  /** Add or take back a reaction. */
  /** `to` answers that reaction (by id) instead of the message. */
  toggleReaction: (conversationId: string, messageId: string, emoji: string, by: Author, to?: string) => void;
  /** Replace the user's vote in a poll. No keys takes it back. */
  votePoll: (conversationId: string, messageId: string, keys: string[]) => void;
  setTyping: (conversationId: string, botId: string, typing: boolean) => void;
  pulse: (botId: string, mood?: Mood) => void;
  focusMessage: (conversationId: string, messageId: string) => void;

  updateRoutine: (botId: string, routineId: string, patch: Partial<Routine>) => void;
  removeRoutine: (botId: string, routineId: string) => void;
}

const mapBot = (bots: Bot[], id: string, fn: (b: Bot) => Bot) => bots.map((b) => (b.id === id ? fn(b) : b));
const mapConversation = (list: Conversation[], id: string, fn: (c: Conversation) => Conversation) => list.map((c) => (c.id === id ? fn(c) : c));

/** A bot's own conversation with the user. */
export const directOf = (conversations: Conversation[], botId: string) => conversations.find((c) => c.kind === "direct" && c.botIds[0] === botId);

export const useBots = create<BotsState>()(
  persist(
    (set, get) => ({
      bots: [],
      conversations: [],
      pending: 0,
      status: {},
      connected: true,
      loaded: false,
      clearError: () => set({ error: undefined }),
      loadOlder: async (id) => {
        const c = get().conversations.find((c) => c.id === id);
        if (!c?.more || !c.messages[0]) return;
        try {
          const res = await fetch(`/api/bots/conversations/${id}/messages?beforeId=${encodeURIComponent(c.messages[0].id)}`);
          if (!res.ok) throw new Error(`Could not load older messages (${res.status})`);
          const page = await res.json() as { messages: BotMessage[]; more: boolean };
          set((s) => ({ conversations: mapConversation(s.conversations, id, (current) => {
            const ids = new Set(current.messages.map((m) => m.id));
            return { ...current, messages: [...page.messages.filter((m) => !ids.has(m.id)), ...current.messages], more: page.more };
          }) }));
        } catch (error) {
          set({ error: error instanceof Error ? error.message : "Could not load older messages" });
        }
      },
      sections: [],
      folded: ["hidden"],
      detailsOpen: false,
      seeded: false,
      searxng: [],
      customExtensions: NO_EXTENSIONS,
      typing: {},
      drafts: [],
      pulses: {},

      ensureSeeded: () => connect(get, set),
      reset: () => {
        set({ bots: [], conversations: [], sections: [], folded: ["hidden"], typing: {}, drafts: [], pulses: {}, focus: undefined, seeded: true });
        void send("POST", "/api/bots/reset");
      },
      setSearxng: (searxng) => {
        set({ searxng });
        void send("PATCH", "/api/bots/settings", { searxng });
      },
      setCustomExtensions: (customExtensions) => {
        set({ customExtensions });
        return send("PATCH", "/api/bots/settings", { customExtensions });
      },
      select: (id) => {
        set((s) => ({
          activeId: id,
          conversations: s.conversations.some((c) => c.id === id && c.unread) ? mapConversation(s.conversations, id, (c) => ({ ...c, unread: false })) : s.conversations,
        }));
        void send("POST", `/api/bots/conversations/${id}/read`);
      },
      setDetailsOpen: (detailsOpen) => set({ detailsOpen }),

      createBot: ({ name, look, instructions = "" }) => {
        const now = Date.now();
        const bot: Bot = { id: uid(), name, look, instructions, memory: [], routines: [], createdAt: now, primary: !get().bots.length || undefined };
        const conversation: Conversation = { id: uid(), kind: "direct", botIds: [bot.id], createdAt: now, updatedAt: now, messages: [] };
        set((s) => ({ bots: [...s.bots, bot], conversations: [conversation, ...s.conversations], activeId: conversation.id }));
        void send("POST", "/api/bots", { id: bot.id, conversationId: conversation.id, name: bot.name, look: bot.look, instructions: bot.instructions });
        return conversation.id;
      },
      updateBot: (id, patch) => {
        set((s) => ({ bots: mapBot(s.bots, id, (b) => ({ ...b, ...patch })) }));
        void send("PATCH", `/api/bots/${id}`, patch);
      },
      makePrimary: (id) => {
        set((s) => ({ bots: s.bots.map((b) => ({ ...b, primary: b.id === id || undefined })) }));
        void send("PATCH", `/api/bots/${id}`, { primary: true });
      },
      deleteBot: (id) => {
        set((s) => {
          const bots = s.bots.filter((b) => b.id !== id);
          // Direct and side chats go with the bot; groups carry on without it.
          const conversations = s.conversations
            .filter((c) => !(c.botIds.includes(id) && (c.kind === "direct" || c.kind === "side")))
            .map((c) => (c.botIds.includes(id) ? { ...c, botIds: c.botIds.filter((b) => b !== id) } : c));
          if (s.bots.find((b) => b.id === id)?.primary && bots[0]) bots[0] = { ...bots[0], primary: true };
          return { bots, conversations, activeId: conversations.some((c) => c.id === s.activeId) ? s.activeId : conversations[0]?.id };
        });
        void send("DELETE", `/api/bots/${id}`);
      },

      createGroup: ({ name, botIds, instructions }) => {
        const now = Date.now();
        const conversation: Conversation = {
          id: uid(),
          kind: "group",
          name,
          instructions,
          botIds,
          createdAt: now,
          updatedAt: now,
          messages: [{ id: uid(), author: "me", at: now, text: "", event: { kind: "created", text: "Created the group", detail: name } }],
        };
        set((s) => ({ conversations: [conversation, ...s.conversations], activeId: conversation.id }));
        void send("POST", "/api/bots/conversations", conversation);
        return conversation.id;
      },
      updateConversation: (id, patch) => {
        set((s) => ({ conversations: mapConversation(s.conversations, id, (c) => ({ ...c, ...patch })) }));
        const wire = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === undefined && (key === "section" || key === "pinnedAt") ? null : value]));
        void send("PATCH", `/api/bots/conversations/${id}`, wire);
      },
      deleteConversation: (id) => {
        const c = get().conversations.find((x) => x.id === id);
        if (c?.kind === "direct") return get().deleteBot(c.botIds[0]!);
        set((s) => {
          const conversations = s.conversations.filter((x) => x.id !== id);
          return { conversations, activeId: s.activeId === id ? conversations[0]?.id : s.activeId };
        });
        void send("DELETE", `/api/bots/conversations/${id}`);
      },
      togglePin: (id) => {
        const pinned = !get().conversations.find((c) => c.id === id)?.pinnedAt;
        set((s) => ({ conversations: mapConversation(s.conversations, id, (c) => ({ ...c, pinnedAt: c.pinnedAt ? undefined : Date.now(), hidden: false })) }));
        void send("PATCH", `/api/bots/conversations/${id}`, { pinnedAt: pinned ? Date.now() : null, hidden: false });
      },
      addSection: (name) => {
        if (get().sections.includes(name)) return;
        const sections = [...get().sections, name];
        set({ sections });
        void send("PATCH", "/api/bots/settings", { sections });
      },
      toggleFolded: (name) => set((s) => ({ folded: s.folded.includes(name) ? s.folded.filter((f) => f !== name) : [...s.folded, name] })),

      post: async (conversationId, message) => {
        const full: BotMessage = { ...message, id: uid(), at: message.at ?? Date.now() };
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) => ({
            ...c,
            messages: [...c.messages, full],
            updatedAt: full.at,
            // A bot writing in a conversation that isn't open leaves it unread; hidden ones come back.
            unread: message.author !== "me" && s.activeId !== conversationId ? true : c.unread,
            hidden: message.author !== "me" ? false : c.hidden,
          })),
        }));
        const acknowledged = await send("POST", `/api/bots/conversations/${conversationId}/messages`, full);
        return acknowledged ? full : undefined;
      },
      patchMessage: (conversationId, messageId, patch) => {
        let answer: string | undefined;
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) => ({
            ...c,
            messages: c.messages.map((m) => {
              if (m.id !== messageId) return m;
              const next = { ...m, ...patch(m) };
              answer = next.question?.answer;
              return next;
            }),
          })),
        }));
        if (answer) void send("PATCH", `/api/bots/conversations/${conversationId}/messages/${messageId}`, { question: { answer } });
      },
      deleteMessage: (conversationId, messageId) => {
        set((s) => ({ conversations: mapConversation(s.conversations, conversationId, (c) => ({ ...c, messages: c.messages.filter((m) => m.id !== messageId) })) }));
        void send("DELETE", `/api/bots/conversations/${conversationId}/messages/${messageId}`);
      },
      toggleReaction: (conversationId, messageId, emoji, by, to) => {
        get().patchMessage(conversationId, messageId, (m) => ({ reactions: toggleReactionIn(m.reactions ?? [], emoji, by, to).next }));
        if (by === "me") void send("PATCH", `/api/bots/conversations/${conversationId}/messages/${messageId}`, { emoji, to });
      },
      votePoll: (conversationId, messageId, keys) => {
        get().patchMessage(conversationId, messageId, (m) => (m.poll ? { poll: castVote(m.poll, "me", keys) } : {}));
        void send("PATCH", `/api/bots/conversations/${conversationId}/messages/${messageId}`, { vote: keys });
      },
      setTyping: (conversationId, botId, typing) =>
        set((s) => {
          const now = s.typing[conversationId] ?? [];
          const next = typing ? [...new Set([...now, botId])] : now.filter((b) => b !== botId);
          return { typing: { ...s.typing, [conversationId]: next } };
        }),
      pulse: (botId, mood) => set((s) => ({ pulses: { ...s.pulses, [botId]: { key: (s.pulses[botId]?.key ?? 0) + 1, mood } } })),
      focusMessage: (conversationId, messageId) => set((s) => ({ focus: { conversationId, messageId, key: (s.focus?.key ?? 0) + 1 } })),

      updateRoutine: (botId, routineId, patch) => {
        set((s) => ({ bots: mapBot(s.bots, botId, (b) => ({ ...b, routines: b.routines.map((r) => (r.id === routineId ? { ...r, ...patch } : r)) })) }));
        void send("PATCH", `/api/bots/${botId}/routines/${routineId}`, patch);
      },
      removeRoutine: (botId, routineId) => {
        set((s) => ({ bots: mapBot(s.bots, botId, (b) => ({ ...b, routines: b.routines.filter((r) => r.id !== routineId) })) }));
        void send("DELETE", `/api/bots/${botId}/routines/${routineId}`);
      },
    }),
    {
      name: "openbuild.bots",
      storage: createJSONStorage(() => localStorage),
      version: 3,
      partialize: (s) => ({
        folded: s.folded,
        activeId: s.activeId,
        detailsOpen: s.detailsOpen,
      }),
      // Bots used to live in this browser. The server owns them now; keep only the layout.
      migrate: (persisted) => {
        const p = { ...(persisted as object) } as Partial<BotsState>;
        delete p.bots;
        delete p.conversations;
        delete p.sections;
        delete p.seeded;
        delete (p as { prefs?: unknown }).prefs;
        return p as BotsState;
      },
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<BotsState>;
        return { ...current, ...p, bots: current.bots, conversations: current.conversations, typing: current.typing, drafts: current.drafts };
      },
    },
  ),
);

/** A conversation's name: the group's, the bot's, or both bots' for a side chat. */
export function conversationName(c: Conversation, bots: Bot[]): string {
  if (c.kind === "group") return c.name || "Untitled group";
  const names = c.botIds.map((id) => bots.find((b) => b.id === id)?.name ?? "Deleted bot");
  // A side chat goes by its bots' first names ("Scout & Tally"), without their " · tags".
  return c.kind === "side" ? names.map((n) => n.split(" · ")[0]).join(" & ") : (names[0] ?? "Bot");
}

const openable = (conversations: Conversation[], activeId?: string) =>
  conversations.some((c) => c.id === activeId) ? activeId : (conversations.find((c) => c.pinnedAt) ?? conversations[0])?.id;

type StoreGet = () => BotsState;
type StoreSet = (partial: Partial<BotsState> | ((s: BotsState) => Partial<BotsState>)) => void;

let mutationQueue: Promise<unknown> = Promise.resolve();
let confirmed: Pick<BotsState, "bots" | "conversations" | "sections"> = { bots: [], conversations: [], sections: [] };

/** Serialize writes so a failed write is reconciled before the next one is sent. */
function send(method: string, path: string, body?: unknown): Promise<Response | undefined> {
  useBots.setState((s) => ({ pending: s.pending + 1 }));
  const task = mutationQueue.then(async () => {
    try {
      const res = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail || `Request failed (${res.status})`);
      }
      return res;
    } catch (error) {
      // A network failure can happen after acceptance. Never claim success; restore the
      // server's view, or the last confirmed snapshot while the server is unreachable.
      try {
        const res = await fetch("/api/bots");
        if (!res.ok) throw new Error(String(res.status));
        apply({ t: "snapshot", ...await res.json() }, useBots.getState, useBots.setState);
      } catch {
        useBots.setState(confirmed);
      }
      useBots.setState({ error: `Change not confirmed: ${error instanceof Error ? error.message : "Network error"}. Check the conversation before retrying.` });
      return undefined;
    } finally {
      useBots.setState((s) => ({ pending: s.pending - 1 }));
    }
  });
  mutationQueue = task;
  return task;
}

// The last state the server confirmed, kept in this browser so a reload paints straight away. Only
// ever a stale copy to look at: the next snapshot replaces all of it.
const cache = createStore("openbuild-bots", "cache");
const CACHE_KEY = "snapshot";
const CACHE_MESSAGES = 50;
type Cached = typeof confirmed;

let saving: ReturnType<typeof setTimeout> | undefined;
useBots.subscribe((s, prev) => {
  if (!s.loaded || (s.bots === prev.bots && s.conversations === prev.conversations && s.sections === prev.sections)) return;
  clearTimeout(saving);
  saving = setTimeout(() => {
    const conversations = confirmed.conversations.map((c) => ({ ...c, messages: c.messages.slice(-CACHE_MESSAGES), more: c.more || c.messages.length > CACHE_MESSAGES }));
    void cacheSet(CACHE_KEY, { ...confirmed, conversations }, cache).catch(() => {});
  }, 1000);
});

/**
 * Have the bots ready before anyone opens OpenBots. Resolves once the cached copy is in, which is
 * worth holding the first render for. The snapshot is a one-off request because the stream holds a
 * connection for as long as the page is open, and browsers share six per host across all tabs: that
 * stays for pages that have actually opened OpenBots.
 */
export function preloadBots(): Promise<void> {
  void fetch("/api/bots")
    .then(async (res) => {
      if (!res.ok) return;
      const snapshot = await res.json();
      if (!useBots.getState().loaded) apply({ t: "snapshot", ...snapshot }, useBots.getState, useBots.setState);
    })
    .catch(() => { /* The stream retries once OpenBots is open. */ });
  return cacheGet<Cached>(CACHE_KEY, cache).then((cached) => {
    if (!cached || useBots.getState().loaded) return;
    confirmed = cached;
    useBots.setState((s) => ({ ...cached, activeId: openable(cached.conversations, s.activeId) }));
  }, () => {});
}

let connected = false;
function connect(get: StoreGet, set: StoreSet) {
  if (connected) return;
  connected = true;
  const profile = useStore.getState().settings.profile;
  const context = [profile.bio, profile.location, profile.language].filter(Boolean).join("\n");
  // Not the user's edit, so no "Saving changes…" and nothing to reconcile if it fails.
  void fetch("/api/bots/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: { name: profile.name, context } }) }).catch(() => {});
  void stream(get, set);
}

async function stream(get: StoreGet, set: StoreSet) {
  let delay = 400;
  for (;;) {
    try {
      const res = await fetch("/api/bots/stream");
      if (!res.ok || !res.body) throw new Error(String(res.status));
      delay = 400;
      set({ connected: true });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as BotsEvent | { t: "ping" };
            if (event.t !== "ping") apply(event, get, set);
          } catch {
            // A bad line is skipped; the next snapshot puts things back.
          }
        }
      }
    } catch {
      // The server is restarting, or it isn't up yet.
    }
    set({ connected: false });
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 2000);
  }
}

function apply(e: BotsEvent, get: StoreGet, set: StoreSet) {
  // Reduce server events separately from the optimistic UI. A failed offline write
  // must not roll back successfully acknowledged stream events (or keep other phantoms).
  let authoritative = { ...get(), ...confirmed };
  applyEvent(e, () => authoritative, (patch) => {
    authoritative = { ...authoritative, ...(typeof patch === "function" ? patch(authoritative) : patch) };
  }, true);
  confirmed = { bots: authoritative.bots, conversations: authoritative.conversations, sections: authoritative.sections };
  applyEvent(e, get, set);
}

function applyEvent(e: BotsEvent, get: StoreGet, set: StoreSet, authoritativeOnly = false) {
  if (e.t === "snapshot") {
    set((s) => ({
      loaded: true,
      bots: e.bots,
      conversations: e.conversations,
      sections: e.settings.sections,
      typing: e.typing,
      drafts: e.drafts,
      status: e.status,
      searxng: e.settings.searxng ?? [],
      customExtensions: e.settings.customExtensions ?? NO_EXTENSIONS,
      activeId: openable(e.conversations, s.activeId),
    }));
    return;
  }
  if (e.t === "status") {
    set((s) => ({ status: { ...s.status, [e.botId]: e.status } }));
    return;
  }
  if (e.t === "bot") {
    set((s) => ({ bots: s.bots.some((b) => b.id === e.bot.id) ? s.bots.map((b) => (b.id === e.bot.id ? e.bot : b)) : [...s.bots, e.bot] }));
    return;
  }
  if (e.t === "bot-deleted") {
    set((s) => {
      const conversations = s.conversations.filter((c) => !(c.botIds.includes(e.id) && (c.kind === "direct" || c.kind === "side"))).map((c) => (c.botIds.includes(e.id) ? { ...c, botIds: c.botIds.filter((b) => b !== e.id) } : c));
      return { bots: s.bots.filter((b) => b.id !== e.id), conversations, activeId: conversations.some((c) => c.id === s.activeId) ? s.activeId : conversations[0]?.id };
    });
    return;
  }
  if (e.t === "conversation") {
    set((s) => {
      const i = s.conversations.findIndex((c) => c.id === e.conversation.id);
      if (i < 0) return { conversations: [{ ...e.conversation, messages: [] }, ...s.conversations] };
      // The server sends the whole record, and JSON drops cleared fields (unread, pinnedAt, hidden),
      // so replace rather than merge. The open conversation stays read.
      return {
        conversations: s.conversations.map((c) =>
          c.id === e.conversation.id ? { ...e.conversation, unread: s.activeId === c.id ? undefined : e.conversation.unread, messages: c.messages, more: c.more } : c,
        ),
      };
    });
    if (!authoritativeOnly && e.conversation.unread && get().activeId === e.conversation.id) void send("POST", `/api/bots/conversations/${e.conversation.id}/read`);
    return;
  }
  if (e.t === "conversation-deleted") {
    set((s) => {
      const conversations = s.conversations.filter((c) => c.id !== e.id);
      return { conversations, activeId: s.activeId === e.id ? conversations[0]?.id : s.activeId };
    });
    return;
  }
  if (e.t === "message") {
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== e.conversationId) return c;
        const exists = c.messages.some((m) => m.id === e.message.id);
        return {
          ...c,
          messages: exists ? c.messages.map((m) => (m.id === e.message.id ? e.message : m)) : [...c.messages, e.message],
          updatedAt: e.message.at,
          unread: !exists && e.message.author !== "me" && s.activeId !== c.id ? true : c.unread,
          hidden: e.message.author !== "me" ? false : c.hidden,
        };
      }),
      drafts: e.message.author === "me" ? s.drafts : s.drafts.filter((d) => !(d.conversationId === e.conversationId && d.botId === e.message.author)),
    }));
    return;
  }
  if (e.t === "message-deleted") {
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === e.conversationId ? { ...c, messages: c.messages.filter((m) => m.id !== e.id) } : c)) }));
    return;
  }
  if (e.t === "typing") {
    set((s) => ({ typing: { ...s.typing, [e.conversationId]: e.botIds } }));
    return;
  }
  if (e.t === "draft") {
    set((s) => ({ drafts: e.done ? s.drafts.filter((d) => !(d.conversationId === e.draft.conversationId && d.botId === e.draft.botId)) : [...s.drafts.filter((d) => !(d.conversationId === e.draft.conversationId && d.botId === e.draft.botId)), e.draft] }));
    return;
  }
  if (e.t === "pulse") {
    if (!authoritativeOnly) get().pulse(e.botId, e.mood as Mood | undefined);
    return;
  }
  if (e.t === "settings") {
    set({ sections: e.settings.sections, searxng: e.settings.searxng ?? [], customExtensions: e.settings.customExtensions ?? NO_EXTENSIONS });
  }
}
