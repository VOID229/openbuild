// OpenBots' state in the app. A workspace (a server's OpenBots, by that server's id: this one's or a
// paired host's, see workspace.ts) owns its bots, conversations, memory and routines; this keeps a
// copy of the one this tab shows, received on its stream, and sends what the user does there.
//
// Everything this keeps is the workspace's own: the layout (which chat is open, folded sections),
// the cached snapshot, the last confirmed state, the write queue and the changes that weren't
// confirmed. Nothing is merged or copied between workspaces, and an answer or event for a workspace
// (or a visit to it) the tab has since left is dropped. Bots and the workspace itself are managed in
// the host's own session; another device's tab only uses the conversations that are there.
import { create } from "zustand";
import { abortable } from "../abort";
import { uid } from "../id";
import { useApps } from "./apps";
import { createStore, get as cacheGet, set as cacheSet } from "../kv";
import type { BotLook, Mood } from "./looks";
import { useStore } from "../store";
import type { Author, Bot, BotMessage, BotsEvent, Conversation, Draft as LiveDraft, Routine } from "./types";
import { castVote, marksUnread, toggleReactionIn, type BotHarnessSettings, type BotsHello } from "../../../shared/bots";
import { isLocalWorkspace, localWorkspace, problemFrom, rememberWorkspace, useWorkspace, useWorkspaceName, workspaceName, workspacePath } from "./workspace";

export interface Draft {
  text: string;
  images?: string[];
  replyTo?: string;
}

const NO_EXTENSIONS = { enabled: false, ids: [] as string[] };
const NO_MODELS: string[] = [];

/** How to tell, from a snapshot of its own workspace, whether a write that wasn't confirmed landed. */
export type WriteCheck =
  | { kind: "post"; conversationId: string; messageId: string }
  | { kind: "delete"; conversationId: string; messageId: string }
  | { kind: "reaction"; conversationId: string; messageId: string; emoji: string; to?: string; on: boolean }
  | { kind: "vote"; conversationId: string; messageId: string; keys: string[] }
  | { kind: "answer"; conversationId: string; messageId: string; answer: string };

/** A change that failed or whose answer never came, kept with the workspace it was sent to. */
export interface Unconfirmed {
  id: string;
  workspace: string;
  at: number;
  label: string;
  method: string;
  path: string;
  body?: unknown;
  check: WriteCheck;
  error: string;
  /** The workspace answered and refused it, so it didn't run. Otherwise it's uncertain: it may still land. */
  rejected?: boolean;
  /** That workspace's next snapshot showed it isn't there. Every write here is idempotent, so it can be sent again there. */
  missing?: boolean;
  /** That workspace's next snapshot couldn't tell (the message isn't among those it holds). */
  unknown?: boolean;
}

interface BotsState {
  /** The workspace (a server id) everything below is from. Undefined until the tab has chosen one. */
  workspace?: string;
  /** Changes not confirmed by this workspace, until its snapshot shows them or they're dismissed. */
  unconfirmed: Unconfirmed[];
  retryUnconfirmed: (id: string) => void;
  dismissUnconfirmed: (id: string) => void;
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
  /** "provider/model" for bots without their own. Pi's default when unset. */
  defaultModel?: string;
  /** What a bot on the default model tries when it fails, unless the bot lists its own. */
  defaultFallbackModels: string[];
  /** SearXNG instances for web search. The other providers' keys are in the vault. */
  searxng: string[];
  /** The user's own Pi extensions to load into bots as well. */
  customExtensions: { enabled: boolean; ids: string[] };
  harnesses: BotHarnessSettings;

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
  setDefaultModel: (model: string) => void;
  setDefaultFallbackModels: (models: string[]) => void;
  setSearxng: (urls: string[]) => void;
  setCustomExtensions: (custom: { enabled: boolean; ids: string[] }) => Promise<unknown>;
  setHarnesses: (harnesses: BotHarnessSettings) => void;
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
  (set, get) => ({
    unconfirmed: [],
    retryUnconfirmed: (id) => retry(id),
    dismissUnconfirmed: (id) => {
      const entry = get().unconfirmed.find((e) => e.id === id);
      if (entry) saveUnconfirmed(entry.workspace, (list) => list.filter((e) => e.id !== id));
    },
    bots: [],
    conversations: [],
    pending: 0,
    status: {},
    connected: true,
    loaded: false,
    clearError: () => set({ error: undefined }),
    loadOlder: async (id) => {
      const visit = session;
      const c = get().conversations.find((c) => c.id === id);
      if (!visit || !c?.more || !c.messages[0]) return;
      try {
        const path = workspacePath(visit.id, `/api/bots/conversations/${encodeURIComponent(id)}/messages?beforeId=${encodeURIComponent(c.messages[0].id)}`);
        const page = await bounded(deadlines.read, async (signal) => {
          const res = await fetch(path, { signal });
          if (!res.ok) throw new Error(`Could not load older messages (${res.status})`);
          return await res.json() as { messages: BotMessage[]; more: boolean };
        });
        if (!live(visit)) return;
        set((s) => ({ conversations: mapConversation(s.conversations, id, (current) => {
          const ids = new Set(current.messages.map((m) => m.id));
          return { ...current, messages: [...page.messages.filter((m) => !ids.has(m.id)), ...current.messages], more: page.more };
        }) }));
      } catch (error) {
        if (live(visit)) set({ error: error instanceof Error ? error.message : "Could not load older messages" });
      }
    },
    sections: [],
    folded: ["hidden"],
    detailsOpen: false,
    seeded: false,
    defaultFallbackModels: NO_MODELS,
    searxng: [],
    customExtensions: NO_EXTENSIONS,
    harnesses: {},
    typing: {},
    drafts: [],
    pulses: {},

    ensureSeeded: () => connect(),
    reset: () => {
      set({ bots: [], conversations: [], sections: [], folded: ["hidden"], typing: {}, drafts: [], pulses: {}, focus: undefined, seeded: true });
      void send("POST", "/api/bots/reset");
    },
    setDefaultModel: (model) => {
      set({ defaultModel: model || undefined });
      void send("PATCH", "/api/bots/settings", { defaultModel: model });
    },
    setDefaultFallbackModels: (defaultFallbackModels) => {
      set({ defaultFallbackModels });
      void send("PATCH", "/api/bots/settings", { defaultFallbackModels });
    },
    setSearxng: (searxng) => {
      set({ searxng });
      void send("PATCH", "/api/bots/settings", { searxng });
    },
    setHarnesses: (harnesses) => {
      set({ harnesses });
      void send("PATCH", "/api/bots/settings", { harnesses });
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
      void send("POST", `/api/bots/conversations/${encodeURIComponent(id)}/read`, undefined, {});
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
          unread: marksUnread(c, message) && s.activeId !== conversationId ? true : c.unread,
          hidden: message.author !== "me" ? false : c.hidden,
        })),
      }));
      const acknowledged = await send("POST", `/api/bots/conversations/${encodeURIComponent(conversationId)}/messages`, full, {
        label: full.text.trim() ? `Message “${full.text.trim().slice(0, 60)}${full.text.trim().length > 60 ? "…" : ""}”` : "Message",
        check: { kind: "post", conversationId, messageId: full.id },
      });
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
      if (answer)
        void send("PATCH", messagePath(conversationId, messageId), { question: { answer } }, { label: "Answer", check: { kind: "answer", conversationId, messageId, answer } });
    },
    deleteMessage: (conversationId, messageId) => {
      set((s) => ({ conversations: mapConversation(s.conversations, conversationId, (c) => ({ ...c, messages: c.messages.filter((m) => m.id !== messageId) })) }));
      void send("DELETE", messagePath(conversationId, messageId), undefined, { label: "Deleted message", check: { kind: "delete", conversationId, messageId } });
    },
    toggleReaction: (conversationId, messageId, emoji, by, to) => {
      const had = hasReaction(get().conversations, conversationId, messageId, emoji, to);
      get().patchMessage(conversationId, messageId, (m) => ({ reactions: toggleReactionIn(m.reactions ?? [], emoji, by, to).next }));
      if (by === "me")
        // `on` makes it a set, not a toggle: sending it again, even while the first may still land, can't undo it.
        void send("PATCH", messagePath(conversationId, messageId), { emoji, to, on: !had }, { label: `${emoji} reaction${had ? " taken back" : ""}`, check: { kind: "reaction", conversationId, messageId, emoji, to, on: !had } });
    },
    votePoll: (conversationId, messageId, keys) => {
      get().patchMessage(conversationId, messageId, (m) => (m.poll ? { poll: castVote(m.poll, "me", keys) } : {}));
      void send("PATCH", messagePath(conversationId, messageId), { vote: keys }, { label: keys.length ? "Vote" : "Vote taken back", check: { kind: "vote", conversationId, messageId, keys } });
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
type Cached = Pick<BotsState, "bots" | "conversations" | "sections">;

const messagePath = (conversationId: string, messageId: string) => `/api/bots/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`;
const hasReaction = (conversations: Conversation[], conversationId: string, messageId: string, emoji: string, to?: string) =>
  !!conversations.find((c) => c.id === conversationId)?.messages.find((m) => m.id === messageId)?.reactions?.some((r) => r.by === "me" && r.emoji === emoji && r.to === to);

// ------------------------------------------------------------------ visits

/**
 * The tab's time in one workspace, from choosing it until it leaves. A response, event or cached
 * copy that arrives for a visit that's over is dropped, so a slow answer from the workspace the tab
 * just left never lands in the one it's in now.
 */
interface Visit {
  id: string;
  ctrl: AbortController;
  /** The state the workspace last confirmed, which a failed write rolls back to. */
  confirmed: Cached;
  streaming?: boolean;
}

let session: Visit | undefined;
const live = (visit: Visit) => session === visit && !visit.ctrl.signal.aborted;

/** Whether the stream was asked for (OpenBots opened), so a workspace the tab moves to gets one too. */
let streamWanted = false;

/** Each workspace's writes, in order. They keep running to the end when the tab moves elsewhere. */
interface Queue {
  tail: Promise<unknown>;
  pending: number;
}
const queues = new Map<string, Queue>();
const queueListeners = new Set<() => void>();
function queueOf(id: string): Queue {
  let q = queues.get(id);
  if (!q) queues.set(id, (q = { tail: Promise.resolve(), pending: 0 }));
  return q;
}
function queueChanged(id: string) {
  if (session?.id === id) useBots.setState({ pending: queueOf(id).pending });
  for (const fn of [...queueListeners]) fn();
}
/** How many of a workspace's changes are still on their way. */
export const pendingWrites = (id: string) => queues.get(id)?.pending ?? 0;

const EMPTY: Cached = { bots: [], conversations: [], sections: [] };

// ------------------------------------------------------------------ layout, per workspace

const LAYOUT = "openbuild.bots.layout:";
type Layout = Pick<BotsState, "folded" | "activeId" | "detailsOpen">;
function readLayout(id: string): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT + id) ?? "null") as Partial<Layout> | null;
    if (raw) return { folded: Array.isArray(raw.folded) ? raw.folded : ["hidden"], activeId: typeof raw.activeId === "string" ? raw.activeId : undefined, detailsOpen: raw.detailsOpen === true };
  } catch {}
  return { folded: ["hidden"], activeId: undefined, detailsOpen: false };
}
useBots.subscribe((s, prev) => {
  if (!s.workspace || s.workspace !== prev.workspace || (s.folded === prev.folded && s.activeId === prev.activeId && s.detailsOpen === prev.detailsOpen)) return;
  try {
    localStorage.setItem(LAYOUT + s.workspace, JSON.stringify({ folded: s.folded, activeId: s.activeId, detailsOpen: s.detailsOpen }));
  } catch {}
});

// ------------------------------------------------------------------ not confirmed, per workspace

const UNCONFIRMED = "openbuild.bots.unconfirmed:";
function readUnconfirmed(id: string): Unconfirmed[] {
  try {
    const list = JSON.parse(localStorage.getItem(UNCONFIRMED + id) ?? "[]") as Unconfirmed[];
    return Array.isArray(list) ? list.filter((e) => e && e.workspace === id) : [];
  } catch {
    return [];
  }
}
function saveUnconfirmed(id: string, change: (list: Unconfirmed[]) => Unconfirmed[]) {
  const next = change(readUnconfirmed(id));
  try {
    if (next.length) localStorage.setItem(UNCONFIRMED + id, JSON.stringify(next));
    else localStorage.removeItem(UNCONFIRMED + id);
  } catch {}
  if (session?.id === id) useBots.setState({ unconfirmed: next });
}

/**
 * Changes this browser keeps for workspaces other than the one this tab is in: left from when a tab
 * could open a paired host's. Only read here, to say they exist and to save a copy; never sent,
 * moved or removed, since the workspace they were sent to is the only one that can settle them.
 */
export function keptElsewhere(): { workspace: string; entries: Unconfirmed[] }[] {
  const current = useBots.getState().workspace;
  const ids: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(UNCONFIRMED)) ids.push(key.slice(UNCONFIRMED.length));
    }
  } catch {}
  return ids
    .filter((id) => id && id !== current)
    .sort()
    .map((workspace) => ({ workspace, entries: readUnconfirmed(workspace) }))
    .filter((k) => k.entries.length);
}

/** Whether a write shows in a workspace's conversations: true, false, or undefined when they can't tell. */
function landed(check: WriteCheck, conversations: Conversation[]): boolean | undefined {
  const c = conversations.find((x) => x.id === check.conversationId);
  if (!c) return check.kind === "delete" ? true : undefined;
  const m = c.messages.find((x) => x.id === check.messageId);
  if (check.kind === "post") return m ? true : c.more ? undefined : false;
  // Absent from a page that holds only the latest messages proves nothing: it may be further back.
  if (check.kind === "delete") return m ? false : c.more ? undefined : true;
  if (!m) return undefined;
  if (check.kind === "reaction") return !!m.reactions?.some((r) => r.by === "me" && r.emoji === check.emoji && r.to === check.to) === check.on;
  if (check.kind === "answer") return m.question?.answer === check.answer;
  const mine = m.poll?.votes.find((v) => v.by === "me")?.keys ?? [];
  return mine.length === check.keys.length && mine.every((k) => check.keys.includes(k));
}

/** Compare a workspace's not-confirmed changes with its own snapshot, and only ever its own. */
function reconcile(id: string, conversations: Conversation[]) {
  if (!readUnconfirmed(id).length) return;
  saveUnconfirmed(id, (list) =>
    list.flatMap((e) => {
      const seen = landed(e.check, conversations);
      return seen ? [] : [{ ...e, missing: seen === false, unknown: seen === undefined }];
    }),
  );
}

/**
 * Send a change that wasn't confirmed again, to its own workspace, once its snapshot shows it's
 * missing there. Missing doesn't mean the first try is over: it may still land. That's safe because
 * every write here is idempotent: a message keeps its id, and a reaction, vote or answer is sent as
 * the state it should end in, not a toggle.
 */
function retry(entryId: string) {
  const visit = session;
  const entry = useBots.getState().unconfirmed.find((e) => e.id === entryId);
  if (!visit || !entry || entry.workspace !== visit.id || !entry.missing) return;
  saveUnconfirmed(visit.id, (list) => list.filter((e) => e.id !== entryId));
  // What the workspace shows now: one that landed since needs nothing.
  if (landed(entry.check, useBots.getState().conversations)) return;
  void send(entry.method, entry.path, entry.body, { label: entry.label, check: entry.check });
}

// ------------------------------------------------------------------ writes

/**
 * How long a write, or a read the tab waits on, gets for its headers and body. A request that ignores
 * its abort is let go anyway, so a stalled workspace can't hold the write queue (and a switch) forever.
 */
export const deadlines = { write: 20_000, read: 15_000 };

/** `work` with a bound, whether or not what it awaits heeds the abort. */
async function bounded<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException(`No answer in ${Math.round(ms / 1000)}s`, "TimeoutError")), ms);
  try {
    return await abortable(work(ctrl.signal), ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** A workspace that answered and refused a write: it didn't run. */
class Refused extends Error {}

interface Write {
  /** Shown in the not-confirmed list. */
  label?: string;
  /** Kept as not confirmed when it fails. Without one (read markers) a failure is only rolled back. */
  check?: WriteCheck;
}

const errorText = (detail: string) => {
  try {
    return (JSON.parse(detail) as { error?: string }).error ?? detail;
  } catch {
    return detail;
  }
};

/**
 * Send a write to the workspace this tab is in, after the ones before it, so a failed write is
 * reconciled before the next is sent. Every write goes to that workspace's bound route, so it runs
 * only on the server it means. `write` marks one in a conversation; without it, it's managing the
 * workspace, which only this server's own session does (and the receiver allows no one else).
 */
function send(method: string, path: string, body?: unknown, write?: Write): Promise<Response | undefined> {
  const visit = session;
  if (!visit) {
    useBots.setState({ error: "OpenBots hasn't connected to a workspace yet." });
    return Promise.resolve(undefined);
  }
  if (!write && !isLocalWorkspace(visit.id)) {
    useBots.setState({ ...visit.confirmed, error: `Bots and chats are managed on ${workspaceName(visit.id)} itself.` });
    return Promise.resolve(undefined);
  }
  const id = visit.id;
  const q = queueOf(id);
  q.pending++;
  queueChanged(id);
  const task = q.tail.then(async () => {
    try {
      return await bounded(deadlines.write, async (signal) => {
        const res = await fetch(workspacePath(id, path), {
          method,
          headers: body === undefined ? undefined : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
        // Another server answered at this address (409 from the bound route): nothing ran, and the tab stops here.
        if (res.status === 409 || (res.headers.get("x-openbuild-server") ?? id) !== id) gone(visit);
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          const text = errorText(detail) || `Request failed (${res.status})`;
          // Refused by the workspace itself. Anything from the way there (the viewer's 502s) leaves it uncertain.
          throw res.status >= 400 && res.status < 500 && res.headers.get("x-openbuild-server") === id ? new Refused(text) : new Error(text);
        }
        return res;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network error";
      // A network failure or a timeout can happen after acceptance. Never claim success, and never
      // send it anywhere else: it's kept with this workspace until its snapshot shows whether it landed.
      if (write?.check) {
        const entry: Unconfirmed = { id: uid(), workspace: id, at: Date.now(), label: write.label ?? "Change", method, path, body, check: write.check, error: message, rejected: error instanceof Refused || undefined };
        saveUnconfirmed(id, (list) => [...list, entry]);
      }
      if (live(visit)) {
        // Restore the workspace's view, or the last confirmed snapshot while it's unreachable.
        const snap = await fetchSnapshot(visit).catch(() => undefined);
        if (snap) apply(visit, { t: "snapshot", ...snap });
        else if (live(visit)) useBots.setState(visit.confirmed);
        // A read marker is sent again whenever the chat is opened, so its failure isn't worth a word.
        if (live(visit) && (!write || write.check)) useBots.setState({ error: `Change not confirmed on ${workspaceName(id)}: ${message}. Check the conversation before retrying.` });
      }
      return undefined;
    } finally {
      q.pending--;
      queueChanged(id);
    }
  });
  q.tail = task;
  return task;
}

/** A workspace's snapshot, from that workspace only: an answer naming another server is refused. */
function fetchSnapshot(visit: Visit): Promise<Omit<Extract<BotsEvent, { t: "snapshot" }>, "t"> | undefined> {
  return bounded(deadlines.read, async (signal) => {
    const res = await fetch(workspacePath(visit.id, "/api/bots"), { signal });
    if (!live(visit)) return undefined;
    if (!res.ok) {
      const problem = problemFrom(visit.id, res.status, await res.json().catch(() => undefined));
      if (live(visit)) useWorkspace.setState({ problem });
      return undefined;
    }
    if (res.headers.get("x-openbuild-server") !== visit.id) {
      gone(visit);
      return undefined;
    }
    const snap = await res.json();
    return live(visit) ? snap : undefined;
  });
}

/** The workspace answered as another server: say so, stop, and never take on what's there now. */
function gone(visit: Visit) {
  if (!live(visit)) return;
  // Nothing the tab did optimistically stays either: none of it ran.
  useBots.setState(visit.confirmed);
  useWorkspace.setState({
    problem: isLocalWorkspace(visit.id) || !useWorkspace.getState().localId
      ? { workspace: visit.id, kind: "gone", message: "This workspace is no longer here." }
      : { workspace: visit.id, kind: "mismatch", message: `${workspaceName(visit.id)}'s address answered as a different OpenBuild. Nothing ran.` },
  });
  visit.ctrl.abort();
}

// ------------------------------------------------------------------ the cache, per workspace

// The last state a workspace confirmed, kept in this browser so a reload paints straight away. Only
// ever a stale copy to look at: the next snapshot replaces all of it.
const cache = createStore("openbuild-bots", "cache");
const cacheKey = (id: string) => `snapshot:${id}`;
const CACHE_MESSAGES = 50;

let saving: ReturnType<typeof setTimeout> | undefined;
useBots.subscribe((s, prev) => {
  if (!s.loaded || !session || (s.bots === prev.bots && s.conversations === prev.conversations && s.sections === prev.sections)) return;
  const visit = session;
  clearTimeout(saving);
  saving = setTimeout(() => {
    const conversations = visit.confirmed.conversations.map((c) => ({ ...c, messages: c.messages.slice(-CACHE_MESSAGES), more: c.more || c.messages.length > CACHE_MESSAGES }));
    void cacheSet(cacheKey(visit.id), { ...visit.confirmed, conversations }, cache).catch(() => {});
  }, 1000);
});

// ------------------------------------------------------------------ choosing a workspace

/** Show a workspace in this tab, from blank, without asking it for anything yet. */
export const enterWorkspace = (id: string) => void enter(id);

/** Start a visit to a workspace: everything shown is that workspace's own, from blank. */
function enter(id: string): Visit {
  session?.ctrl.abort();
  clearTimeout(saving);
  const visit: Visit = { id, ctrl: new AbortController(), confirmed: EMPTY };
  session = visit;
  useWorkspace.setState((w) => ({ problem: undefined, switching: w.switching?.to === id ? undefined : w.switching }));
  useBots.setState({
    workspace: id,
    ...EMPTY,
    ...readLayout(id),
    unconfirmed: readUnconfirmed(id),
    pending: queueOf(id).pending,
    error: undefined,
    loaded: false,
    connected: true,
    status: {},
    typing: {},
    drafts: [],
    pulses: {},
    focus: undefined,
    defaultModel: undefined,
    defaultFallbackModels: NO_MODELS,
    searxng: [],
    customExtensions: NO_EXTENSIONS,
    harnesses: {},
  });
  rememberWorkspace(id);
  return visit;
}

/** Paint a visit from its workspace's cache, and ask that workspace for its snapshot. */
function load(visit: Visit): Promise<void> {
  void fetchSnapshot(visit)
    .then((snap) => {
      if (snap && !useBots.getState().loaded) apply(visit, { t: "snapshot", ...snap });
    })
    .catch(() => { /* The stream retries once OpenBots is open. */ });
  return cacheGet<Cached>(cacheKey(visit.id), cache).then((cached) => {
    if (!cached || !live(visit) || useBots.getState().loaded) return;
    visit.confirmed = cached;
    useBots.setState((s) => ({ ...cached, activeId: openable(cached.conversations, s.activeId) }));
  }, () => {});
}

/**
 * Have the bots ready before anyone opens OpenBots. Resolves once the cached copy is in, which is
 * worth holding the first render for. The snapshot is a one-off request because the stream holds a
 * connection for as long as the page is open, and browsers share six per host across all tabs: that
 * stays for pages that have actually opened OpenBots.
 *
 * Every tab opens on this server's workspace, whatever another device's it was on before (see
 * workspace.ts): that one's cache and not-confirmed changes stay where they are, and nothing is sent there.
 */
export async function preloadBots(): Promise<void> {
  const local = await localWorkspace();
  if (!session) {
    if (!local.id) return;
    enter(local.id);
  }
  return load(session!);
}

/**
 * Move this tab to another workspace. Its current one's changes finish first: the switch waits
 * for them (useWorkspace's `switching` says how many) and can be called off with cancelSwitch.
 * What was sent runs to completion either way. False when it was called off.
 */
export async function switchWorkspace(to: string): Promise<boolean> {
  const from = session?.id;
  if (from === to) return true;
  if (from && queueOf(from).pending) {
    const ticket = ++switchTicket;
    const settled = await new Promise<boolean>((resolve) => {
      const check = () => {
        if (switchTicket !== ticket) return done(false);
        const waiting = queueOf(from).pending;
        if (!waiting) return done(true);
        useWorkspace.setState({ switching: { to, waiting } });
      };
      const done = (ok: boolean) => {
        queueListeners.delete(check);
        resolve(ok);
      };
      queueListeners.add(check);
      check();
    });
    if (!settled) return false;
  }
  useWorkspace.setState({ switching: undefined });
  const visit = enter(to);
  void load(visit);
  if (streamWanted) void stream(visit);
  return true;
}

let switchTicket = 0;
/** Stay in this workspace instead. Its changes keep going. */
export function cancelSwitch() {
  switchTicket++;
  useWorkspace.setState({ switching: undefined });
  for (const fn of [...queueListeners]) fn();
}

/** Start this tab's stream, for the workspace it's in and any it moves to. */
let introduced = false;
function connect() {
  streamWanted = true;
  const visit = session;
  if (!visit || visit.streaming) return;
  if (!introduced && isLocalWorkspace(visit.id)) {
    introduced = true;
    const profile = useStore.getState().settings.profile;
    const context = [profile.bio, profile.location, profile.language].filter(Boolean).join("\n");
    // Not the user's edit, so no "Saving changes…" and nothing to reconcile if it fails.
    void fetch(workspacePath(visit.id, "/api/bots/settings"), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: { name: profile.name, context } }), signal: AbortSignal.timeout(deadlines.write) }).catch(() => {});
  }
  void stream(visit);
}

/**
 * The server pings every 20s. Quiet this long, the connection is dead even if the browser hasn't
 * noticed (a network change, a phone or tab waking from sleep): without this bound the reader
 * waits forever, and typing, status and replies only show after a reload.
 */
export const STREAM_SILENCE = 45_000;

async function stream(visit: Visit) {
  if (visit.streaming) return;
  visit.streaming = true;
  let delay = 400;
  while (live(visit)) {
    const ctrl = new AbortController();
    const leave = () => ctrl.abort();
    visit.ctrl.signal.addEventListener("abort", leave, { once: true });
    let heard = Date.now();
    let slow = false;
    // Wall-clock, so a timer that was frozen with the tab still sees how long it's been.
    const check = () => {
      if (Date.now() - heard > STREAM_SILENCE) ctrl.abort(new DOMException("The OpenBots stream went quiet", "TimeoutError"));
    };
    const onVisible = () => document.visibilityState === "visible" && check();
    const watchdog = setInterval(check, 5_000);
    globalThis.addEventListener?.("online", check);
    globalThis.addEventListener?.("pageshow", check);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const res = await abortable(fetch(workspacePath(visit.id, "/api/bots/stream"), { signal: ctrl.signal }), ctrl.signal);
      if (!res.ok || !res.body) {
        const problem = problemFrom(visit.id, res.status, await res.json().catch(() => undefined));
        if (live(visit)) useWorkspace.setState({ problem });
        if (problem.kind === "gone") visit.ctrl.abort();
        slow = problem.kind !== "offline";
        throw new Error(String(res.status));
      }
      heard = Date.now();
      delay = 400;
      reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      // The first line names the workspace. Anything else, or another one, isn't this workspace.
      let greeted = false;
      for (;;) {
        const { value, done } = await abortable(reader.read(), ctrl.signal);
        if (done) break;
        heard = Date.now();
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let event: BotsEvent | BotsHello | { t: "ping" };
          try {
            event = JSON.parse(line);
          } catch {
            // A bad line is skipped; the next snapshot puts things back.
            continue;
          }
          if (!greeted) {
            if (event.t !== "hello" || event.workspace !== visit.id) return gone(visit);
            greeted = true;
            if (live(visit)) {
              useBots.setState({ connected: true });
              if (useWorkspace.getState().problem?.workspace === visit.id) useWorkspace.setState({ problem: undefined });
            }
            continue;
          }
          if (event.t !== "ping" && event.t !== "hello") apply(visit, event);
        }
      }
    } catch {
      // The server is restarting, it isn't up yet, or the connection went quiet. The next
      // connection's snapshot brings back whatever was missed.
    } finally {
      clearInterval(watchdog);
      visit.ctrl.signal.removeEventListener("abort", leave);
      globalThis.removeEventListener?.("online", check);
      globalThis.removeEventListener?.("pageshow", check);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      // Close the dead connection too: browsers share six per host across all tabs.
      ctrl.abort();
      void reader?.cancel().catch(() => {});
    }
    if (!live(visit)) break;
    useBots.setState({ connected: false });
    await new Promise((r) => setTimeout(r, slow ? 5000 : delay));
    delay = Math.min(delay * 2, 2000);
  }
  visit.streaming = false;
}

/** An event from a workspace, for the visit it was received on. One for a visit that's over is dropped. */
function apply(visit: Visit, e: BotsEvent) {
  if (!live(visit)) return;
  const get = useBots.getState;
  const set = useBots.setState;
  // Reduce server events separately from the optimistic UI. A failed offline write
  // must not roll back successfully acknowledged stream events (or keep other phantoms).
  let authoritative = { ...get(), ...visit.confirmed };
  applyEvent(e, () => authoritative, (patch) => {
    authoritative = { ...authoritative, ...(typeof patch === "function" ? patch(authoritative) : patch) };
  }, true);
  visit.confirmed = { bots: authoritative.bots, conversations: authoritative.conversations, sections: authoritative.sections };
  applyEvent(e, get, set);
  if (e.t === "snapshot") reconcile(visit.id, e.conversations);
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
      defaultModel: e.settings.defaultModel,
      defaultFallbackModels: e.settings.defaultFallbackModels ?? NO_MODELS,
      searxng: e.settings.searxng ?? [],
      customExtensions: e.settings.customExtensions ?? NO_EXTENSIONS,
      harnesses: e.settings.harnesses ?? {},
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
    if (!authoritativeOnly && e.conversation.unread && get().activeId === e.conversation.id) void send("POST", `/api/bots/conversations/${encodeURIComponent(e.conversation.id)}/read`, undefined, {});
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
        // Old messages change too (a bot marking early prompts seen once @all wakes it, a vote on a
        // closed poll). One from before what's loaded stays for "Load older messages" to bring:
        // appending it would put old history at the bottom of the chat.
        const first = c.messages[0];
        if (!exists && c.more && first && e.message.at < first.at) return c;
        const last = c.messages.at(-1);
        const fresh = !exists && (!last || e.message.at >= last.at);
        const messages = exists
          ? c.messages.map((m) => (m.id === e.message.id ? e.message : m))
          : fresh
            ? [...c.messages, e.message]
            : [...c.messages.filter((m) => m.at <= e.message.at), e.message, ...c.messages.filter((m) => m.at > e.message.at)];
        return {
          ...c,
          messages,
          updatedAt: Math.max(c.updatedAt, e.message.at),
          unread: fresh && marksUnread(c, e.message) && s.activeId !== c.id ? true : c.unread,
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
  if (e.t === "apps") {
    // Apps are this server's own session's to manage; another workspace's aren't shown here.
    if (!authoritativeOnly && isLocalWorkspace(session?.id)) void useApps.getState().load().catch(() => {});
    return;
  }
  if (e.t === "settings") {
    set({ sections: e.settings.sections, defaultModel: e.settings.defaultModel, defaultFallbackModels: e.settings.defaultFallbackModels ?? NO_MODELS, searxng: e.settings.searxng ?? [], customExtensions: e.settings.customExtensions ?? NO_EXTENSIONS, harnesses: e.settings.harnesses ?? {} });
  }
}

/** The host's name while this tab is in another device's workspace, where only its conversations are used. */
export function useRemoteWorkspace(): string | undefined {
  const workspace = useBots((s) => s.workspace);
  const localId = useWorkspace((s) => s.localId);
  const name = useWorkspaceName(workspace);
  return workspace && localId && workspace !== localId ? name : undefined;
}
