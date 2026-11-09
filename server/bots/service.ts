// OpenBots' state. SQLite (db.ts) is the record; this is what changes it and tells the app, and
// what decides which bots a message wakes. Running a bot (the Pi process) is runner.ts, which
// registers hooks so this file never imports it.
import { randomLook } from "../../src/lib/bots/looks";
import { isSchedule, nextRun, parseSchedule } from "../../shared/botSchedule";
import type { Author, Bot, BotMessage, BotStatus, BotThreadAccess, BotsEvent, BotsSettings, BotsSnapshot, Conversation, Draft, MemoryItem, PiSetup, Poll, Routine, SideHuddle, TodoChange, TodoItem } from "../../shared/bots";
import { applyTodo, BOT_EFFORTS, castVote, DEFAULT_SETTINGS, fallbackMode, findTags, firstName, huddleLimit, mentionName, isBotEffort, isBotId, marksUnread, PERMISSION_HARNESSES, makePoll, pollWaitingOn, reactionId, toggleReactionIn } from "../../shared/bots";
import type { FriendChat, FriendSummary } from "../../shared/friends";
import { parseFriendAuthor } from "../../shared/friends";
import { computerApi } from "../computers/api";
import { readDevices } from "../devices";
import { findProject } from "../projects";
import { isPermissionId } from "../../shared/types";
import { HTML_RENDER_MAX_TITLE, htmlProblem } from "../../shared/htmlRender";
import { validRuntime } from "../threadRuntime";
import * as db from "./db";

const MESSAGE_LIMIT = 200;

export class BotsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface Wake {
  /** Why the bot is being asked to look. */
  kind: "messages" | "routine" | "heartbeat" | "note" | "reaction";
  conversationId?: string;
  /** Exact user messages assigned to this delivery, independent of conversation cursors. */
  messageIds?: string[];
  text?: string;
  /** For a reaction: dropped if it's taken back before the bot looks. */
  reaction?: { messageId: string; emoji: string; by: string; to?: string };
  /** A request sent to several bots: the one of them that answers it (see pickLead). */
  lead?: string;
}

type Hooks = {
  wake: (botId: string, wake: Wake) => void;
  stop: (botId: string) => void;
  pendingAssignments?: (botId: string) => { conversationId: string; messageIds: string[] }[];
  /** What arrived in a conversation since the bot's turn there showed it, as transcript lines; shown from then on. */
  unseen?: (botId: string, conversationId: string) => string[];
  /** The bot's turn is answering the user in this conversation: a request of theirs, not a bot's message or a note. */
  userWoke?: (botId: string, conversationId: string) => boolean;
};
/** What the friends module (server/friends/) hears about shared chats, so this file never imports it either. */
type FriendHooks = {
  /** One of this side's messages in a shared chat, to pass on to the friend. */
  relay: (c: db.StoredConversation, message: BotMessage) => void;
  /** Which of this side's bots are in a shared chat changed. */
  members: (c: db.StoredConversation) => void;
  /** A shared chat is going away here. */
  left: (c: db.StoredConversation) => void;
  /** The friends, for the snapshot. */
  list: () => FriendSummary[];
};
/** What Pi still needs before a bot can run on it, if anything. `fresh` asks Pi again rather than trusting a cached answer. */
type PiCheck = (fresh: boolean) => Promise<PiSetup | undefined>;

const mem = globalThis as {
  openbotsHooks?: Hooks;
  openbotsListeners?: Set<(e: BotsEvent) => void>;
  openbotsTyping?: Record<string, string[]>;
  openbotsTypingSince?: Map<string, number>;
  openbotsDrafts?: Draft[];
  openbotsStatus?: Map<string, BotStatus>;
  openbotsActivityTimes?: Map<string, { turnStartedAt: number | null; lastActivityAt: number }>;
  openbotsSectionsSwept?: boolean;
  openbotsWaiters?: Waiter[];
  openbotsPiCheck?: PiCheck;
  openbotsSetup?: { value?: PiSetup };
  openbotsFriendHooks?: FriendHooks;
};
let hooks: Hooks = (mem.openbotsHooks ??= { wake() {}, stop() {} });
/** runner.ts registers these at startup. */
export function setHooks(next: Hooks) {
  hooks = mem.openbotsHooks = next;
}

let friendHooks: FriendHooks = (mem.openbotsFriendHooks ??= { relay() {}, members() {}, left() {}, list: () => [] });
/** server/friends/ registers these at startup. */
export function setFriendHooks(next: FriendHooks) {
  friendHooks = mem.openbotsFriendHooks = next;
}
/** Who the friends are, or whether they're online, changed. */
export function emitFriends() {
  emit({ t: "friends", friends: friendHooks.list() });
}

let piCheck: PiCheck = (mem.openbotsPiCheck ??= async () => undefined);
/** runner.ts registers the real check. Without one, Pi counts as ready. */
export function setPiCheck(next: PiCheck) {
  piCheck = mem.openbotsPiCheck = next;
}

const listeners = (mem.openbotsListeners ??= new Set<(e: BotsEvent) => void>());
export function subscribe(listener: (e: BotsEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** Something about apps changed; the app asks for the new state. */
export function emitApps() {
  emit({ t: "apps" });
}
/** A bot added a project: the app asks for the list again. */
export function emitProjects() {
  emit({ t: "projects" });
}

function emit(e: BotsEvent) {
  for (const l of listeners) {
    try {
      l(e);
    } catch (err) {
      console.error("[bots] listener failed:", err);
    }
  }
}

const typing = (mem.openbotsTyping ??= {});
/** When each bot started typing in a conversation, keyed `conversation:bot`. */
const typingSince = (mem.openbotsTypingSince ??= new Map<string, number>());
const drafts = (mem.openbotsDrafts ??= []);
const status = (mem.openbotsStatus ??= new Map<string, BotStatus>());
interface Waiter {
  botId: string;
  conversationId: string;
  afterSeq: number;
  resolve: (m: BotMessage) => void;
  reject: (e: Error) => void;
}
const waiters = (mem.openbotsWaiters ??= []);

function settings(): BotsSettings {
  // `botLoop` was the bot-loop pause, since removed: settings saved with it read as if it was never there.
  const { botLoop: _removed, ...stored } = db.getValue<Partial<BotsSettings> & { botLoop?: unknown }>("settings") ?? {};
  return { ...DEFAULT_SETTINGS, ...stored };
}
export function getSettings(): BotsSettings {
  return settings();
}
/** Up to 8 "provider/model"s, in order, without repeats; undefined when there are none. */
function modelList(value: unknown): string[] | undefined {
  const list = strings(Array.isArray(value) ? value.map((m) => (typeof m === "string" ? m.trim().slice(0, 200) : m)).filter((m) => typeof m === "string" && m.includes("/")) : [], 8);
  return list.length ? list : undefined;
}

/**
 * Drops sections no conversation is filed under any more, once a chat moves or goes: a section only
 * holds chats, so the last one out takes it along. `keep` is the one a chat is being moved into,
 * which the client may have only just added.
 */
function pruneSections(keep?: string) {
  const { sections } = settings();
  const used = new Set(db.listConversations().map((c) => c.section));
  const next = sections.filter((s) => s === keep || used.has(s));
  if (next.length !== sections.length) updateSettings({ sections: next });
}

export function updateSettings(patch: Partial<BotsSettings>): BotsSettings {
  const { botLoop: _removed, ...rest } = patch as Partial<BotsSettings> & { botLoop?: unknown };
  const next: BotsSettings = { ...settings(), ...rest };
  if ("defaultModel" in patch) next.defaultModel = typeof patch.defaultModel === "string" && patch.defaultModel ? patch.defaultModel.slice(0, 200) : undefined;
  if ("defaultFallbackModels" in patch) next.defaultFallbackModels = modelList(patch.defaultFallbackModels);
  if (patch.quietHours) next.quietHours = { from: num(patch.quietHours.from, 0, 23), to: num(patch.quietHours.to, 0, 23) };
  if (patch.sections) next.sections = patch.sections.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()).slice(0, 40);
  if (patch.user) next.user = { name: clip(patch.user.name, 80), context: clip(patch.user.context, 2000) };
  if ("searxng" in patch) next.searxng = [...new Set((Array.isArray(patch.searxng) ? patch.searxng : []).filter((u) => typeof u === "string" && u.trim()).map((u) => u.trim().slice(0, 500)))].slice(0, 8);
  if (patch.customExtensions) next.customExtensions = { enabled: patch.customExtensions.enabled === true, ids: [...new Set((Array.isArray(patch.customExtensions.ids) ? patch.customExtensions.ids : []).filter((id) => typeof id === "string"))].slice(0, 200) };
  if (patch.harnesses) {
    const permissions = patch.harnesses.permissions ?? {};
    next.harnesses = {
      blocked: strings(patch.harnesses.blocked, 20).filter(validRuntime),
      permissions: Object.fromEntries(PERMISSION_HARNESSES.flatMap((h) => (isPermissionId(permissions[h]) ? [[h, permissions[h]]] : []))),
    };
  }
  if ("claude" in patch) {
    const off = strings(patch.claude?.off, 32).filter((id) => /^claude-code(-[a-z0-9_-]{1,40})?$/.test(id));
    next.claude = { off, changedAt: Number.isFinite(patch.claude?.changedAt) ? Number(patch.claude!.changedAt) : Date.now() };
  }
  if ("isolation" in patch) {
    const kinds = Object.entries(patch.isolation && typeof patch.isolation === "object" ? patch.isolation : {}).filter(([device, kind]) => device.length <= 80 && kind === "host");
    next.isolation = kinds.length ? Object.fromEntries(kinds.slice(0, 200)) : undefined;
  }
  db.setValue("settings", next);
  emit({ t: "settings", settings: next });
  return next;
}

const num = (n: unknown, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(n) || 0)));
const strings = (list: unknown, max: number) => [...new Set((Array.isArray(list) ? list : []).filter((s): s is string => typeof s === "string" && !!s))].slice(0, max);
const clip = (s: unknown, max: number) => (typeof s === "string" && s.trim() ? s.trim().slice(0, max) : undefined);

export function fullBot(id: string): Bot | undefined {
  const bot = db.getBot(id);
  return bot ? { ...bot, memory: db.memories(id), routines: db.routines(id) } : undefined;
}
function emitBot(id: string) {
  const bot = fullBot(id);
  if (bot) emit({ t: "bot", bot });
}

export function conversationView(id: string): Conversation | undefined {
  const c = db.getConversation(id);
  if (!c) return;
  const rows = db.messages(id, MESSAGE_LIMIT);
  return { ...withTodos(c), messages: rows.map((r) => r.message), more: rows.length > 0 && db.countBefore(id, rows[0]!.seq) > 0 };
}

/** A conversation as the app gets it: with its to-do list, which db.ts keeps apart. */
function withTodos<T extends db.StoredConversation>(c: T): T & { todos?: TodoItem[] } {
  const todos = db.todos(c.id);
  return todos.length ? { ...c, todos } : c;
}

/** Page by a stable message identity rather than exposing database sequences. */
export function messagePage(id: string, beforeId?: string, beforeSeq?: number) {
  if (!db.getConversation(id)) throw new BotsError("No such conversation.", 404);
  if (beforeId) {
    const cursor = db.getMessage(beforeId);
    if (!cursor || cursor.conversationId !== id) throw new BotsError("No such history cursor.");
    beforeSeq = cursor.seq;
  }
  const rows = db.messages(id, MESSAGE_LIMIT, beforeSeq);
  return { messages: rows.map((r) => r.message), more: rows.length > 0 && db.countBefore(id, rows[0]!.seq) > 0 };
}

export function snapshot(): BotsSnapshot {
  return {
    bots: db.listBots().map((b) => fullBot(b.id)!),
    conversations: db.listConversations().map((c) => conversationView(c.id)!),
    settings: settings(),
    status: Object.fromEntries(status),
    typing: { ...typing },
    drafts: [...drafts],
    setup: setup.value,
    friends: friendHooks.list(),
  };
}

export function getStatus(botId: string): BotStatus | undefined {
  return status.get(botId);
}
const activityTimes = (mem.openbotsActivityTimes ??= new Map<string, { turnStartedAt: number | null; lastActivityAt: number }>());

/** Primary-only metadata projection. Never includes prompts, activity text or credentials. */
export function botWorkStatus(requester: string) {
  if (!db.getBot(requester)?.primary) throw new BotsError("Only the primary bot can read all bots' status.", 403);
  return { bots: db.listBots().map((bot) => {
    const current = getStatus(bot.id);
    const times = activityTimes.get(bot.id);
    return {
      id: bot.id, name: bot.name,
      state: current?.state === "working" ? "working" : "idle",
      runnerState: current?.state ?? "idle",
      turnStartedAt: current?.state === "working" ? times?.turnStartedAt ?? null : null,
      conversationId: current?.state === "working" ? current.conversationId ?? null : null,
      lastActivityAt: times?.lastActivityAt ?? null,
      pendingAssignments: hooks.pendingAssignments?.(bot.id) ?? [],
    };
  }), pendingMeaning: "Exact assigned user-message deliveries still queued or in the current turn; delivery is not proof of an unanswered request.", handoffs: "not_tracked" };
}

export function setStatus(botId: string, next: BotStatus) {
  const previous = getStatus(botId);
  const now = Date.now();
  activityTimes.set(botId, {
    turnStartedAt: next.state === "working" ? (previous?.state === "working" ? activityTimes.get(botId)?.turnStartedAt ?? now : now) : null,
    lastActivityAt: now,
  });
  if (next.state === "idle") status.delete(botId);
  else status.set(botId, next);
  emit({ t: "status", botId, status: next });
}
export function setTyping(conversationId: string, botId: string, on: boolean) {
  const now = new Set(typing[conversationId] ?? []);
  const key = `${conversationId}:${botId}`;
  if (on && !now.has(botId)) typingSince.set(key, Date.now());
  if (!on) typingSince.delete(key);
  if (on) now.add(botId);
  else now.delete(botId);
  typing[conversationId] = [...now];
  emit({ t: "typing", conversationId, botIds: typing[conversationId]! });
}
/** How long a bot has been typing in a conversation, or undefined when it isn't. */
export function typingFor(conversationId: string, botId: string): number | undefined {
  const since = typingSince.get(`${conversationId}:${botId}`);
  return since === undefined ? undefined : Date.now() - since;
}
export function setDraft(draft: Draft | undefined, key: { conversationId: string; botId: string }) {
  const i = drafts.findIndex((d) => d.conversationId === key.conversationId && d.botId === key.botId);
  if (!draft) {
    if (i >= 0) drafts.splice(i, 1);
    emit({ t: "draft", draft: { conversationId: key.conversationId, botId: key.botId, text: "" }, done: true });
    return;
  }
  if (i >= 0) drafts[i] = draft;
  else drafts.push(draft);
  emit({ t: "draft", draft });
}
export function pulse(botId: string, mood?: string) {
  emit({ t: "pulse", botId, mood });
}

function emitConversation(id: string) {
  const c = db.getConversation(id);
  if (c) emit({ t: "conversation", conversation: withTodos(c) });
}

export function directId(botId: string): string | undefined {
  return db.listConversations().find((c) => c.kind === "direct" && c.botIds[0] === botId)?.id;
}

// ------------------------------------------------------------------ lifecycle

/** The bot every install starts with. It runs the others, so its job is written down from the start. */
const PRIMARY = {
  name: "Dr Eggbot",
  look: { shape: "puff", color: "white" },
  instructions:
    "You're the user's primary bot. You orchestrate: you make new bots when the user needs one, give them clear instructions, put them in groups and hand each the work that's theirs. Do quick things yourself; pass bigger jobs to the bot that fits.",
};

/** The starter team the primary bot offers on a new install. */
export const TEAM: { name: string; look: Bot["look"]; instructions: string; threads?: Bot["threads"] }[] = [
  {
    name: "Manager",
    look: { shape: "jelly", color: "amber" },
    instructions:
      "You manage the user's project work in OpenBuild. Start threads in their projects for the work they ask for, follow them and answer what they ask, merge their pull requests once they're green, and close threads when they're done. Ask Researcher when you need something looked up. Keep the user posted with short updates, not every step.",
    threads: { enabled: true, scope: "all", projects: [], merge: true },
  },
  {
    name: "Tracer",
    look: { shape: "pill", color: "blue" },
    instructions:
      "You check the work. Review pull requests and point out real bugs first, style last. Spot bugs, write tests, try to reproduce a reported bug before anyone fixes it, and check a fix didn't break something else. In polls and brainstorms give your honest opinion, with your reasons.",
    threads: { enabled: true, scope: "all", projects: [] },
  },
  {
    name: "Researcher",
    look: { shape: "orb", color: "green" },
    instructions:
      "You find things out. Search the web, find things in repositories, and check GitHub and the status of the user's organisation: pull requests, issues, checks, releases. Say where each answer came from, and say so when you couldn't find something.",
  },
];

export function ensureStarted() {
  // Sections left empty before chats took theirs along when they went; once per server is enough.
  if (!mem.openbotsSectionsSwept) {
    mem.openbotsSectionsSwept = true;
    pruneSections();
  }
  if (db.listBots().length) return;
  const now = Date.now();
  const botId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const bot: db.StoredBot = {
    id: botId,
    ...PRIMARY,
    primary: true,
    createdAt: now,
    proactivity: "normal",
    by: "me",
  };
  db.putBot(bot);
  const conversation: db.StoredConversation = { id: conversationId, kind: "direct", botIds: [botId], pinnedAt: now, createdAt: now, updatedAt: now };
  db.putConversation(conversation);
  updateSettings({ onboarding: "active" });
}

/** How the primary bot offers the starter team, in the first-run note and in its context once the user says they code. */
export const TEAM_OFFER = `offer them a starter team with the question tool and offer "team": ${TEAM.map((m) => m.name).join(", ")}. In a few words, say what each does: Manager runs threads in their projects and merges their PRs, Tracer reviews and tests, Researcher looks things up, and they can change what each may do in its settings. The app makes the team itself if they take it.`;

/** How the primary bot answers a user who doesn't code: only the developer starter team is skipped, never bots or teams in general. */
export const NO_CODE_REPLY = `There's no developer starter team to offer them: it's for people who code, so don't offer it or bring it up again. Say briefly what you can still help with yourself, like looking things up, writing, planning and everyday tasks, and that they can still make their own bots and teams whenever they like, or ask you to make them, which you can do with manage_bot. Never say they have no team, or suggest teams aren't available to them.`;

/** What the user said when the primary bot asked whether they write code: one of its two choices, or their own words. */
export type DeveloperAnswer = { kind: "yes" | "no" } | { kind: "own"; text: string };
const DEVELOPER = "developer";
export const developerAnswer = () => db.getValue<DeveloperAnswer>(DEVELOPER);

/** What the welcome is waiting on, shown in the primary bot's chat until Pi is ready. */
const setup = (mem.openbotsSetup ??= {});
export const piSetup = () => setup.value;
function setSetup(next: PiSetup | undefined) {
  if (JSON.stringify(next) === JSON.stringify(setup.value)) return;
  setup.value = next;
  emit({ t: "setup", setup: next });
}

let checking: Promise<void> | undefined;
let recheck = false;

/**
 * The first time OpenBots is opened, the primary bot is asked to introduce itself and find out
 * whether the user codes, in its own words; only then is the starter team offered. Not before Pi can
 * run it: until then the chat says what's missing, and this is asked again (when Pi's models change,
 * every so often while a tab is open, or from the chat's own button) until it's there.
 */
export function greetOnFirstOpen(fresh = false): Promise<void> {
  if (settings().onboarding !== "active") return Promise.resolve();
  if (checking) {
    recheck = true;
    return checking;
  }
  checking = (async () => {
    try {
      let need: PiSetup | undefined;
      // Something changed while Pi was being asked (a sign-in finished, say): ask again.
      do {
        recheck = false;
        need = await piCheck(fresh).catch((err): PiSetup => ({ need: "unreachable", error: (err as Error).message || String(err) }));
        fresh = true;
      } while (recheck);
      if (settings().onboarding !== "active") return setSetup(undefined);
      setSetup(need);
      if (!need) greet();
    } finally {
      checking = undefined;
    }
  })();
  return checking;
}

function greet() {
  const bot = db.listBots().find((b) => b.primary);
  const conversationId = bot && directId(bot.id);
  if (!bot || !conversationId) return;
  updateSettings({ onboarding: "done" });
  // An install from before this welcome may already be talking; leave that chat alone.
  if (db.messages(conversationId, 1).length) return;
  hooks.wake(bot.id, {
    kind: "note",
    conversationId,
    text: `The user just opened OpenBots for the first time, and this chat is empty. Introduce yourself in a couple of short messages: who you are and that you're their primary bot, who makes the other bots, hands out the work and keeps everyone pointed the same way. Then ask whether they write code, with the question tool and offer "developer": the app sets its choices, and they can type their own answer. Stop there and wait for it. If they say they do, ${TEAM_OFFER} If they say they don't: ${NO_CODE_REPLY}`,
  });
}

/** Makes the starter team, gives the primary a group with them, and notes each new bot in its chat. */
export function createTeam(primaryId: string) {
  const primaryChat = directId(primaryId);
  const ids: string[] = [];
  for (const member of TEAM) {
    const { bot } = createBot({ name: member.name, look: member.look, instructions: member.instructions, by: primaryId });
    if (member.threads) updateBot(bot.id, { threads: member.threads }, { quiet: true });
    ids.push(bot.id);
    if (primaryChat) postMessage(primaryChat, { id: crypto.randomUUID(), author: primaryId, at: Date.now(), text: "", event: { kind: "created", text: "New bot", detail: bot.name, bot: bot.id } });
  }
  const group = createConversation({ kind: "group", name: "Team", botIds: [primaryId, ...ids], instructions: "Work through the user's projects together. Manager runs the threads and merges, Tracer checks the work, Researcher looks things up." });
  updateConversation(group.id, { pinnedAt: Date.now() });
  return { botIds: ids, conversationId: group.id };
}

/** A bot's computers on every machine: this server's and each paired device's. One that can't be reached keeps its own. */
async function destroyComputers(botId: string) {
  await Promise.allSettled(["local", ...readDevices().map((d) => d.id)].map((device) => computerApi(device).call(botId, "destroy", {})));
}

export async function resetAll() {
  for (const bot of db.listBots()) hooks.stop(bot.id);
  for (const bot of db.listBots()) await destroyComputers(bot.id);
  // Reset is about bots and chats. Their default model and its fallbacks, how the user searches the web, which extensions and Claude logins they load, each machine's isolation and the apps they connected aren't those, and the keys stay too.
  const { defaultModel, defaultFallbackModels, searxng, customExtensions, claude, isolation } = settings();
  const apps = db.getValue("apps");
  // Shared chats go too: their friends hear they were left, rather than writing on into nothing.
  for (const c of db.listConversations()) if (c.friend && !c.friend.ended) friendHooks.left(c);
  db.wipe();
  if (defaultModel || defaultFallbackModels || searxng?.length || customExtensions || claude || isolation) db.setValue("settings", { ...settings(), defaultModel, defaultFallbackModels, searxng, customExtensions, claude, isolation });
  if (apps) db.setValue("apps", apps);
  status.clear();
  for (const id of Object.keys(typing)) delete typing[id];
  typingSince.clear();
  drafts.length = 0;
  ensureStarted();
  emit({ t: "snapshot", ...snapshot() });
  await greetOnFirstOpen();
}

// ------------------------------------------------------------------ bots and conversations

export function createBot(input: { id?: string; conversationId?: string; name: string; look?: Bot["look"]; instructions?: string; by?: string }): { bot: Bot; conversationId: string } {
  const name = clip(input.name, 80);
  if (!name) throw new BotsError("A bot needs a name.");
  const id = input.id && isBotId(input.id) ? input.id : crypto.randomUUID();
  if (db.getBot(id)) throw new BotsError("That bot already exists.");
  const conversationId = input.conversationId && isBotId(input.conversationId) ? input.conversationId : crypto.randomUUID();
  if (db.getConversation(conversationId)) throw new BotsError("That conversation already exists.");
  const now = Date.now();
  const primary = db.listBots().length === 0;
  const bot: db.StoredBot = {
    id,
    name,
    look: input.look?.shape && input.look.color ? { shape: String(input.look.shape).slice(0, 40), color: String(input.look.color).slice(0, 40) } : randomLook(),
    primary: primary || undefined,
    instructions: clip(input.instructions, 8000) ?? "",
    createdAt: now,
    proactivity: "normal",
    by: input.by === "me" || (input.by && isBotId(input.by)) ? input.by : "me",
  };
  db.putBot(bot);
  db.putConversation({ id: conversationId, kind: "direct", botIds: [id], createdAt: now, updatedAt: now });
  emitBot(id);
  emitConversation(conversationId);
  return { bot: fullBot(id)!, conversationId };
}

/**
 * `by: "me"` is the user, in the app: the primary hears what changed on its next turn (see noteChanges).
 * Whoever changed it, the bot's chat gets a line saying what did (see announceChanges), unless `quiet`:
 * a bot just made, getting its first settings.
 */
export function updateBot(id: string, patch: Partial<Bot>, opts: { by?: "me"; quiet?: boolean; conversationId?: string } = {}): Bot {
  const bot = db.getBot(id);
  if (!bot) throw new BotsError("No such bot.", 404);
  const before = { ...bot };
  if (typeof patch.name === "string") {
    const name = clip(patch.name, 80);
    if (!name) throw new BotsError("A bot needs a name.");
    bot.name = name;
  }
  if (typeof patch.instructions === "string") bot.instructions = patch.instructions.slice(0, 8000);
  if (patch.look?.shape && patch.look.color) bot.look = { shape: String(patch.look.shape).slice(0, 40), color: String(patch.look.color).slice(0, 40) };
  const newPace = patch.proactivity && patch.proactivity in { off: 1, low: 1, normal: 1, high: 1 } && patch.proactivity !== (bot.proactivity ?? "normal");
  if (newPace) bot.proactivity = patch.proactivity;
  if (patch.model === null || patch.model === "") bot.model = undefined;
  else if (typeof patch.model === "string") bot.model = patch.model.slice(0, 200);
  if (patch.fallbackModels === null || Array.isArray(patch.fallbackModels)) {
    bot.fallbackModels = modelList(patch.fallbackModels);
    // Listing some is choosing a list of its own, unless the same patch says none.
    if (bot.fallbackModels && !("noFallbacks" in patch)) bot.noFallbacks = undefined;
  }
  if (typeof patch.noFallbacks === "boolean" || patch.noFallbacks === null) {
    bot.noFallbacks = patch.noFallbacks || undefined;
  }
  if (patch.effort === null || patch.effort === "") bot.effort = undefined;
  else if (typeof patch.effort === "string") {
    // Pi refuses a level it doesn't know, and the bot couldn't reply at all.
    if (!isBotEffort(patch.effort)) throw new BotsError(`Effort is ${BOT_EFFORTS.join(", ")}, or empty for the default.`);
    bot.effort = patch.effort;
  }
  if (patch.threads) bot.threads = { enabled: patch.threads.enabled === true, scope: patch.threads.scope === "all" || patch.threads.scope === "exclude" ? patch.threads.scope : "choose", projects: strings(patch.threads.projects, 200), excluded: strings(patch.threads.excluded, 200), choosePermission: patch.threads.choosePermission === true, approve: patch.threads.approve === true, merge: patch.threads.merge === true, others: patch.threads.others === true };
  if (patch.primary) {
    for (const other of db.listBots()) if (other.primary && other.id !== id) db.putBot({ ...other, primary: undefined });
    bot.primary = true;
  }
  db.putBot(bot);
  noteChanges(before, bot, opts.by === "me");
  noteRename(before, bot);
  // A reply on the new model isn't a fallback coming back: the line below already says it changed.
  if (bot.model !== before.model) db.setValue(`ran:${id}`, null);
  if (newPace) touchHeartbeat(id);
  for (const other of db.listBots()) if (other.id !== id && patch.primary) emitBot(other.id);
  emitBot(id);
  if (!opts.quiet) announceChanges(before, bot, opts.by, opts.conversationId);
  return fullBot(id)!;
}

// ------------------------------------------------------------------ a bot's settings, in its chat

/** Model names as Pi lists them, for the lines below: ids alone read worse ("gpt-6.1-sol"). extensions.ts fills it. */
const modelNames = new Map<string, string>();
export function rememberModelNames(models: { provider: string; id: string; name?: string }[]) {
  for (const m of models) if (m.name) modelNames.set(`${m.provider}/${m.id}`, String(m.name));
}

/** Fields read whole by settingChanges, and ones that aren't settings worth a line (or are said elsewhere). */
const HANDLED = new Set(["model", "effort", "fallbackModels", "noFallbacks", "proactivity", "computer", "threads", "name", "primary"]);
const UNANNOUNCED = new Set(["id", "createdAt", "by", "memory", "routines", "instructions", "look"]);
const CHECK_INS: Record<string, string> = { off: "off", low: "every 8 hours", normal: "every 3 hours", high: "every hour" };
const THREAD_FLAGS = [
  ["others", "control others' threads"],
  ["choosePermission", "choose permissions"],
  ["approve", "answer permission prompts"],
  ["merge", "merge pull requests"],
] as const;

/**
 * What changed between two saves of a bot, as "model: Grok 4.7 → GPT 6.1 Sol", one per setting that
 * did. Values are what Settings shows: names over ids, "default" for unset. A setting this list doesn't
 * know yet still gets a line, with its value only when that's short and plain.
 */
export function settingChanges(before: db.StoredBot, after: db.StoredBot): string[] {
  const out: string[] = [];
  const line = (what: string, from: string, to: string) => from !== to && out.push(`${what}: ${from} → ${to}`);
  const model = (id: string | undefined, other: string | undefined) => {
    if (!id) return "default";
    const name = modelNames.get(id) ?? id.slice(id.indexOf("/") + 1);
    // Two accounts' copies of one model: their ids tell them apart.
    return other && other !== id && (modelNames.get(other) ?? other.slice(other.indexOf("/") + 1)) === name ? id : name;
  };
  const fallbacks = (bot: db.StoredBot) => {
    const mode = fallbackMode(bot);
    return mode === "none" ? "none" : mode === "inherit" ? "the defaults" : bot.fallbackModels!.map((m) => modelNames.get(m) ?? m).join(", ");
  };
  const project = (id: string) => findProject(id)?.name ?? "a removed project";
  const projectsOf = (t: BotThreadAccess) =>
    t.scope === "all" ? "all" : t.scope === "exclude" ? (t.excluded?.length ? `all but ${t.excluded.map(project).join(", ")}` : "all") : t.projects.length ? t.projects.map(project).join(", ") : "none";
  const onOff = (on: unknown) => (on ? "on" : "off");

  line("name", before.name, after.name);
  line("primary", before.primary ? "yes" : "no", after.primary ? "yes" : "no");
  line("model", model(before.model, after.model), model(after.model, before.model));
  line("effort", before.effort || "default", after.effort || "default");
  line("fallbacks", fallbacks(before), fallbacks(after));
  line("check-ins", CHECK_INS[before.proactivity ?? "normal"] ?? "every 3 hours", CHECK_INS[after.proactivity ?? "normal"] ?? "every 3 hours");
  const was = before.threads ?? { enabled: false, projects: [] };
  const now = after.threads ?? { enabled: false, projects: [] };
  line("OpenBuild", onOff(was.enabled), onOff(now.enabled));
  // While it's off, the rest isn't used, and Settings hides it.
  if (was.enabled || now.enabled) {
    line("OpenBuild projects", projectsOf(was), projectsOf(now));
    for (const [key, label] of THREAD_FLAGS) line(label, onOff(was[key]), onOff(now[key]));
  }
  const plain = (v: unknown) => (v === undefined ? "unset" : typeof v === "boolean" ? onOff(v) : (typeof v === "string" && v.length <= 60) || typeof v === "number" ? String(v) : undefined);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (HANDLED.has(key) || UNANNOUNCED.has(key)) continue;
    const from = (before as Record<string, unknown>)[key];
    const to = (after as Record<string, unknown>)[key];
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    const a = plain(from);
    const b = plain(to);
    if (a !== undefined && b !== undefined) line(key, a, b);
    else out.push(`${key}: changed`);
  }
  return out;
}

/**
 * One activity line in the bot's own chat for a save that changed something, however it was made: the
 * app's settings or the primary's manage_bot. "Juniper's model: Grok 4.7 → GPT 6.1 Sol; effort: high → max".
 * A save that changed nothing says nothing.
 *
 * A new name is also said where it was changed, when that's a chat the bot is in ("Juniper is now Atlas"):
 * the others in it read it with the rest of the chat. It's the user's own line when they changed it, so it
 * doesn't leave the chat unread. Its own chat says it once, there.
 */
function announceChanges(before: db.StoredBot, after: db.StoredBot, by?: "me", conversationId?: string) {
  let changes = settingChanges(before, after);
  const where = directId(after.id);
  if (before.name !== after.name) {
    const here = conversationId && db.getConversation(conversationId)?.botIds.includes(after.id) ? conversationId : where;
    if (here) postMessage(here, { id: crypto.randomUUID(), author: by === "me" ? "me" : after.id, at: Date.now(), text: "", event: { kind: "renamed", text: `${before.name} is now ${after.name}`, bot: after.id } });
    if (here === where) changes = changes.filter((c) => !c.startsWith("name: "));
  }
  if (!changes.length || !where) return;
  postMessage(where, { id: crypto.randomUUID(), author: after.id, at: Date.now(), text: "", event: { kind: "changed", text: `${before.name}'s ${changes.join("; ")}`, bot: after.id } });
}

// ------------------------------------------------------------------ what the user changed

/**
 * A bot setting the user changed in the app that the primary hasn't been told of yet. One per bot and
 * setting: `from` is what the primary last knew, `to` what it is now, so a run of changes reads as one,
 * and changing it back leaves nothing to say. Changes the primary makes itself (manage_bot) aren't
 * noted, and one made after the user's replaces that note: what it set is what it knows.
 *
 * A note changed back is kept, saying nothing, until the primary's next turn ends: the turn before it
 * may have been shown the change, and then it's owed the correction (see settleChangeNotes).
 */
export interface ChangeNote {
  botId: string;
  field: NoteField;
  from: string;
  to: string;
  at: number;
}
type NoteField = "model" | "effort" | "fallbacks" | "instructions";
const CHANGE_NOTES = "change-notes";
const NOTE_FIELDS: NoteField[] = ["model", "effort", "fallbacks", "instructions"];

const changeNotes = () => db.getValue<ChangeNote[]>(CHANGE_NOTES) ?? [];

function describe(bot: db.StoredBot, field: NoteField): string {
  switch (field) {
    case "model":
      return bot.model || "default";
    case "effort":
      return bot.effort || "default";
    case "fallbacks": {
      const mode = fallbackMode(bot);
      return mode === "none" ? "no fallback" : mode === "inherit" ? "the default fallbacks" : bot.fallbackModels!.join(", ");
    }
    case "instructions":
      return bot.instructions;
  }
}

function noteChanges(before: db.StoredBot, after: db.StoredBot, user: boolean) {
  let list = changeNotes();
  const at = Date.now();
  for (const field of NOTE_FIELDS) {
    const to = describe(after, field);
    if (to === describe(before, field)) continue;
    const i = list.findIndex((n) => n.botId === after.id && n.field === field);
    if (!user) {
      if (i >= 0) list = list.filter((_, j) => j !== i);
      continue;
    }
    const from = i >= 0 ? list[i]!.from : describe(before, field);
    list = [...list.filter((_, j) => j !== i), { botId: after.id, field, from, to, at }];
  }
  db.setValue(CHANGE_NOTES, list);
}

// ------------------------------------------------------------------ a bot's new name

/**
 * A rename a bot hasn't been told of yet, whoever made it and whichever bot it is: shown with its next
 * turn, so it stops answering to the old name. One per bot: a run of renames reads as one, and renaming
 * it back leaves nothing to say.
 */
export interface RenameNote {
  botId: string;
  from: string;
  to: string;
}
const RENAME_NOTES = "rename-notes";
const renameNotes = () => db.getValue<RenameNote[]>(RENAME_NOTES) ?? [];

function noteRename(before: db.StoredBot, after: db.StoredBot) {
  if (before.name === after.name) return;
  const list = renameNotes();
  const from = list.find((n) => n.botId === after.id)?.from ?? before.name;
  const rest = list.filter((n) => n.botId !== after.id);
  db.setValue(RENAME_NOTES, from === after.name ? rest : [...rest, { botId: after.id, from, to: after.name }]);
}

export function pendingRenameNotes(botId: string): RenameNote[] {
  return renameNotes().filter((n) => n.botId === botId && db.getBot(botId));
}

export function renameNoteText(notes: RenameNote[]): string {
  if (!notes.length) return "";
  const lines = notes.map((n) => `- You were renamed from ${n.from} to ${n.to}. Go by ${n.to} now, and when people call you ${n.from}, that's you too.`);
  return `Since your last turn:\n${lines.join("\n")}\nThat's just so you know; it needs no reply.`;
}

/** The bot was shown these. One renamed again meanwhile keeps what it hasn't heard. */
export function settleRenameNotes(shown: RenameNote[]) {
  if (!shown.length) return;
  db.setValue(
    RENAME_NOTES,
    renameNotes().flatMap((n) => {
      const seen = shown.find((s) => s.botId === n.botId);
      if (!seen) return [n];
      if (seen.to === n.to) return [];
      return [{ ...n, from: seen.to }];
    }),
  );
}

/** What the user changed since the primary last heard, for its next turn. Only the primary's. */
export function pendingChangeNotes(botId: string): ChangeNote[] {
  if (!db.getBot(botId)?.primary) return [];
  // A note on a bot's computer, from before bots reached every machine, has nothing left to say.
  return changeNotes().filter((n) => n.from !== n.to && NOTE_FIELDS.includes(n.field) && db.getBot(n.botId));
}

export function changeNoteText(botId: string, notes: ChangeNote[]): string {
  if (!notes.length) return "";
  const user = settings().user?.name || "The user";
  const whose = (id: string) => (id === botId ? "your" : `${db.getBot(id)?.name ?? "A bot"}'s`);
  const lines = notes.map((n) => {
    const what = n.field === "fallbacks" ? "fallback models" : n.field;
    return n.field === "instructions" ? `- ${user} changed ${whose(n.botId)} instructions.` : `- ${user} changed ${whose(n.botId)} ${what} from ${n.from} to ${n.to}.`;
  });
  return `Since your last turn, in the app's settings:\n${lines.join("\n")}\nThat's just so you know; it needs no reply, and don't change it back unless asked.`;
}

/** The primary was shown these: they're done, unless one changed again meanwhile, which then starts from what it saw. */
export function settleChangeNotes(botId: string, shown: ChangeNote[]) {
  // Only the primary's turn settles them: another bot's ending says nothing about what the primary heard.
  if (!db.getBot(botId)?.primary) return;
  const list = changeNotes().flatMap((n) => {
    const seen = shown.find((s) => s.botId === n.botId && s.field === n.field);
    // Never shown, and back where the primary knew it: nothing to say.
    if (!seen) return n.from === n.to ? [] : [n];
    // The value it saw is what it knows: timestamps can match across different edits.
    return seen.to === n.to ? [] : [{ ...n, from: seen.to }];
  });
  db.setValue(CHANGE_NOTES, list);
}

export async function deleteBot(id: string) {
  const bot = db.getBot(id);
  if (!bot) throw new BotsError("No such bot.", 404);
  if (bot.primary) throw new BotsError("The primary bot can't be deleted. Make another one primary first.");
  hooks.stop(id);
  await destroyComputers(id);
  for (const c of db.listConversations()) {
    if (!c.botIds.includes(id)) continue;
    if (c.kind === "direct" || c.kind === "side") {
      db.deleteConversation(c.id);
      emit({ t: "conversation-deleted", id: c.id });
    } else {
      const next = { ...c, botIds: c.botIds.filter((b) => b !== id), updatedAt: Date.now() };
      db.putConversation(next);
      db.addMessage(c.id, { id: crypto.randomUUID(), author: id, at: Date.now(), text: "", event: { kind: "left", text: `${bot.name} left` } });
      emitConversation(c.id);
      const last = db.messages(c.id, 1).at(-1);
      if (last) emit({ t: "message", conversationId: c.id, message: last.message });
      settlePolls(c.id);
      if (next.friend) friendHooks.members(next);
    }
  }
  pruneSections();
  db.deleteBot(id);
  db.setValue(CHANGE_NOTES, changeNotes().filter((n) => n.botId !== id));
  db.setValue(RENAME_NOTES, renameNotes().filter((n) => n.botId !== id));
  status.delete(id);
  emit({ t: "bot-deleted", id });
}

/**
 * A group or side chat. With `friend`, a group shared with a friend's server (server/friends/ makes
 * those): it can start with none of this side's bots, since a chat a friend shared waits for the owner
 * to pick which of theirs join.
 */
export function createConversation(input: { id?: string; kind: Conversation["kind"]; name?: string; botIds: string[]; instructions?: string; messages?: BotMessage[]; friend?: FriendChat; huddle?: SideHuddle }): Conversation {
  if (input.kind === "direct") throw new BotsError("A bot's own chat is created with the bot.");
  if (input.friend && input.kind !== "group") throw new BotsError("Only groups are shared with friends.");
  const botIds = [...new Set(input.botIds)].filter((id) => db.getBot(id));
  if (!input.friend && botIds.length < 2) throw new BotsError("Pick at least two bots.");
  if (input.kind === "group" && !clip(input.name, 80)) throw new BotsError("A group needs a name.");
  const now = Date.now();
  const id = input.id && isBotId(input.id) ? input.id : crypto.randomUUID();
  if (db.getConversation(id)) throw new BotsError("That conversation already exists.");
  const c: db.StoredConversation = {
    id,
    kind: input.kind,
    name: clip(input.name, 80),
    instructions: clip(input.instructions, 4000),
    botIds,
    createdAt: now,
    updatedAt: now,
    ...(input.friend ? { friend: input.friend } : {}),
    ...(input.huddle && input.kind === "side" ? { huddle: input.huddle } : {}),
  };
  db.putConversation(c);
  const messages = input.messages?.length
    ? input.messages
    : input.kind === "group"
      ? [{ id: crypto.randomUUID(), author: "me" as const, at: now, text: "", event: { kind: "created" as const, text: "Created the group", detail: c.name } }]
      : [];
  for (const m of messages) {
    if (!isBotId(m.id)) continue;
    db.addMessage(id, { ...m, at: m.at || now });
  }
  if (messages.length) db.putConversation({ ...c, updatedAt: now });
  emitConversation(id);
  for (const m of db.messages(id, 50)) emit({ t: "message", conversationId: id, message: m.message });
  return conversationView(id)!;
}

export function updateConversation(id: string, patch: Partial<Conversation>): Conversation {
  const c = db.getConversation(id);
  if (!c) throw new BotsError("No such conversation.", 404);
  if (typeof patch.name === "string" && c.kind === "group") c.name = clip(patch.name, 80) || c.name;
  if (typeof patch.instructions === "string") c.instructions = patch.instructions.slice(0, 4000);
  if ("pinnedAt" in patch) c.pinnedAt = patch.pinnedAt ? Date.now() : undefined;
  if (typeof patch.hidden === "boolean") c.hidden = patch.hidden || undefined;
  if (typeof patch.unread === "boolean") c.unread = patch.unread || undefined;
  if ("section" in patch) c.section = clip(patch.section, 40);
  const before = c.botIds.join();
  if (patch.botIds && c.kind === "group") {
    const ids = [...new Set(patch.botIds)].filter((b) => db.getBot(b));
    // A shared chat can be down to none of this side's bots: the friend's are still talking in it.
    if (ids.length >= (c.friend ? 0 : 1)) {
      c.botIds = ids;
      const follow = db.groupFollow(id);
      if (follow) db.setGroupFollow(id, { ...follow, ids: follow.ids.filter(botId => ids.includes(botId)) });
    }
  }
  db.putConversation(c);
  emitConversation(id);
  if (patch.botIds && c.kind === "group") settlePolls(id);
  if (c.friend && !c.friend.ended && c.botIds.join() !== before) friendHooks.members(c);
  if ("section" in patch) pruneSections(c.section);
  return conversationView(id)!;
}

/** What the friends module changes about a shared chat: who's in it on the friend's side, and whether it still syncs. */
export function updateSharedChat(id: string, friend: Partial<FriendChat>) {
  const c = db.getConversation(id);
  if (!c?.friend) return;
  db.putConversation({ ...c, friend: { ...c.friend, ...friend } });
  emitConversation(id);
}

export function deleteConversation(id: string) {
  const c = db.getConversation(id);
  if (!c) throw new BotsError("No such conversation.", 404);
  if (c.kind === "direct") throw new BotsError("Delete the bot to remove its chat.");
  if (c.friend && !c.friend.ended) friendHooks.left(c);
  db.deleteConversation(id);
  emit({ t: "conversation-deleted", id });
  pruneSections();
}

export function markRead(id: string) {
  const c = db.getConversation(id);
  if (!c?.unread) return;
  db.putConversation({ ...c, unread: undefined });
  emitConversation(id);
}

// ------------------------------------------------------------------ messages

function checkMessage(m: BotMessage) {
  if (!isBotId(m.id)) throw new BotsError("Bad message id.");
  if (m.text.length > 20_000) throw new BotsError("That message is too long.");
  if ((m.images?.length ?? 0) > 4) throw new BotsError("Up to 4 images.");
  for (const img of m.images ?? []) if (img.length > 2_500_000) throw new BotsError("An image is too large.");
  if (m.html !== undefined) {
    if (m.author === "me") throw new BotsError("Pages are shown by bots.");
    const page = m.html as Partial<BotMessage["html"] & object>;
    if (typeof page?.html !== "string") throw new BotsError("A page needs its HTML.");
    const problem = htmlProblem(page.html);
    if (problem) throw new BotsError(problem);
    const title = typeof page.title === "string" ? page.title.replace(/\s+/g, " ").trim().slice(0, HTML_RENDER_MAX_TITLE) : "";
    const height = typeof page.height === "number" && Number.isFinite(page.height) && page.height > 0 ? Math.round(page.height) : undefined;
    m.html = { title: title || "Page", html: page.html, ...(height ? { height } : {}) };
  }
}

/** A poll as a new message: whatever it came with, it starts with no votes. */
function cleanPoll(raw: Poll): Poll {
  const labels = Array.isArray(raw.options) ? raw.options.map((o) => String(o?.label ?? "")) : [];
  const poll = makePoll(String(raw.question ?? ""), labels, { multiple: !!raw.multiple, blind: !!raw.blind });
  if (!poll.question) throw new BotsError("Write the poll's question.");
  if (poll.options.length < 2) throw new BotsError("A poll needs at least two different options.");
  return poll;
}

/** Who a message should pull in. Events wake nobody. A poll asks everyone. */
function wakeTargets(c: db.StoredConversation, message: BotMessage): string[] {
  if (message.event) return [];
  const members = c.botIds.filter((id) => db.getBot(id));
  if (message.poll) return members.filter((id) => id !== message.author);
  if (message.author === "me") {
    if (c.kind !== "group") return members;
    const mentioned = mentionedBots(message.text, members);
    const reply = message.replyTo ? db.getMessage(message.replyTo) : undefined;
    const replied = reply?.conversationId === c.id && members.includes(reply.message.author) ? [reply.message.author] : [];
    const addressed = [...new Set([...mentioned, ...replied])];
    return addressed; // Untagged group messages follow the last recipients, else the primary (see postMessage).
  }
  const others = members.filter((id) => id !== message.author);
  if (c.kind === "side") return others;
  const mentioned = mentionedBots(message.text, others);
  const reply = message.replyTo ? db.getMessage(message.replyTo) : undefined;
  const replied = reply && others.includes(reply.message.author) ? [reply.message.author] : [];
  return [...new Set([...mentioned, ...replied])];
}

export const GROUP_FOLLOW_MS = 20 * 60_000;
/** How far the clock may have stepped back (an NTP fix after a restart) and a follow still hold. */
const CLOCK_SKEW_MS = 60_000;
// Who the user's last group request went to is kept in the database (db.groupFollow), so a restart
// mid-window doesn't hand the next message to the primary. Only user requests refresh the clock.

/**
 * Who an untagged user message in a group goes to: whoever the last request went to, for 20 minutes
 * after it, or else the primary. Decided on the spot, so the recipients show as busy straight away.
 */
function groupRecipients(c: db.StoredConversation, message: BotMessage): string[] {
  const members = c.botIds.filter(id => db.getBot(id));
  const follow = db.groupFollow(c.id);
  if (follow && message.at >= follow.at - CLOCK_SKEW_MS && message.at - follow.at < GROUP_FOLLOW_MS) {
    const ids = follow.ids.filter(id => members.includes(id));
    if (ids.length) return ids;
  }
  const primary = members.find(id => db.getBot(id)?.primary) ?? members[0];
  return primary ? [primary] : [];
}

const COMMON = new Set("the and for you your are can what that this with have from they about there their would could should just like some then them when which will been were does into also more here know want need make tell please think each every other only very much really thing anyone everyone someone right now still again today all".split(" ").map(stem));
function stem(word: string) {
  return word.replace(/(?:ing|ed|es|s|e)$/, "");
}
const words = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).map(stem).filter((w) => w.length >= 3 && !COMMON.has(w)));

/** What a bot says it's for: the first sentence of its own instructions, where a bot says what it does. The rest often names other bots' jobs. */
const ownRole = (instructions: string) => instructions.trim().split(/(?<=[.!?])\s|\n/)[0] ?? "";

/** Where a bot's name first shows in some text, tagged or just written ("tracer, find bugs"); -1 if it doesn't. */
function namedAt(text: string, bot: db.StoredBot): number {
  const name = mentionName(bot.name).toLowerCase();
  if (!name) return -1;
  return text.toLowerCase().search(new RegExp(`(?<![\\p{L}\\d_])@?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d_])`, "u"));
}

/**
 * Who answers a user's group message that went to several bots, so they don't all say the same thing.
 * A bot the message names, tagged or just written ("tracer, find bugs"), answers. Otherwise, or among
 * several named, the one whose role (the first sentence of its instructions) shares the most words with
 * it. A tie, or nothing in common, goes to the primary if it was asked, else whoever was named first.
 * Decided here, with no model call; the others still get it, to add what's theirs alone.
 */
export function pickLead(text: string, ids: string[]): string | undefined {
  const bots = ids.flatMap((id) => db.getBot(id) ?? []);
  if (bots.length < 2) return bots[0]?.id;
  const named = bots.map((b) => ({ b, at: namedAt(text, b) })).filter((n) => n.at >= 0).sort((x, y) => x.at - y.at).map((n) => n.b);
  if (named.length === 1) return named[0]!.id;
  const pool = named.length ? named : bots;
  // The bots' own names aren't what it's about.
  const names = new Set(bots.flatMap((b) => [...words(mentionName(b.name))]));
  const asked = [...words(text)].filter((w) => !names.has(w));
  const scored = pool.map((b) => {
    const role = words(ownRole(b.instructions));
    return { b, fit: asked.filter((w) => role.has(w)).length };
  }).sort((x, y) => y.fit - x.fit);
  if (scored[0]!.fit && scored[0]!.fit > (scored[1]?.fit ?? 0)) return scored[0]!.b.id;
  return (pool.find((b) => b.primary) ?? bots.find((b) => b.primary) ?? pool[0])!.id;
}

function mentionedBots(text: string, ids: string[]): string[] {
  const bots = ids.flatMap((id) => db.getBot(id) ?? []);
  const tags = findTags(text, bots);
  if (tags.some((t) => !t.bot)) return ids;
  return [...new Set(tags.map((t) => t.bot!.id))];
}

export function postMessage(conversationId: string, message: BotMessage): BotMessage {
  const c = db.getConversation(conversationId);
  if (!c) throw new BotsError("No such conversation.", 404);
  checkMessage(message);
  const existing = db.getMessage(message.id);
  if (existing) {
    if (existing.conversationId !== conversationId || existing.message.author !== message.author) throw new BotsError("That message id already exists.");
    return existing.message;
  }
  // A friend's message only ever comes from server/friends/, into a chat shared with that friend: the
  // app's routes post as "me" and bots post as themselves, so nothing else can write as a friend.
  const fromFriend = parseFriendAuthor(message.author)?.friend;
  const friendHere = !!fromFriend && c.friend?.friend === fromFriend;
  if (message.author !== "me" && !c.botIds.includes(message.author) && !friendHere) throw new BotsError("That bot isn't in this conversation.");
  if (c.huddle && !message.event) {
    if (message.author === "me") throw new BotsError("Side chats are between bots. You can read along.");
    if (c.huddle.closedAt) throw new BotsError(`That side chat has closed.${message.author === c.huddle.by ? " Report back in the chat it came from." : ""}`);
  }
  // The friend's side gets text: a photo or poll would be in this copy alone, so it isn't posted at all.
  if (c.friend && !c.friend.ended && !friendHere && !message.event && (message.images?.length || message.poll || message.html)) throw new BotsError("Photos, polls and pages aren't shared with friends yet.");
  if (message.poll) {
    if (c.kind !== "group") throw new BotsError("Polls are for group chats.");
    const poll = cleanPoll(message.poll);
    message = { ...message, text: poll.question, poll };
  }
  const seq = db.addMessage(conversationId, message);
  const unread = marksUnread(c, message) ? true : c.unread;
  const hidden = message.author !== "me" ? undefined : c.hidden;
  db.putConversation({ ...c, updatedAt: message.at, unread, hidden });
  emitConversation(conversationId);
  emit({ t: "message", conversationId, message });
  if (message.author !== "me" && !message.event && !friendHere) pulse(message.author, "happy");
  if (c.friend && !c.friend.ended && !friendHere && !message.event) friendHooks.relay(c, message);

  const waiting = waiters.filter((w) => w.conversationId === conversationId && w.afterSeq < seq && w.botId !== message.author);
  for (const w of waiting) {
    const i = waiters.indexOf(w);
    if (i >= 0) waiters.splice(i, 1);
    w.resolve(message);
  }
  const skip = new Set(waiting.map((w) => w.botId));
  if (c.kind === "side" && message.author !== "me" && !message.event) noteSideMessage(c, message.author);
  // A huddle closes on its last allowed message, which wakes nobody but the bot that reports back.
  if (c.huddle && !message.event && huddleMessages(conversationId) >= c.huddle.limit) {
    closeHuddle(conversationId, `It reached its ${c.huddle.limit}-message limit.`, message.author);
    return message;
  }

  if (!message.event) {
    let targets = wakeTargets(c, message);
    const groupRequest = message.author === "me" && c.kind === "group";
    if (groupRequest && !message.poll) {
      if (!targets.length) targets = groupRecipients(c, message);
      db.setGroupFollow(conversationId, { ids: targets, at: message.at });
    }
    // Several bots asked at once: one answers, and the others add only what's theirs.
    const lead = groupRequest && targets.length > 1 ? pickLead(message.text, targets) : undefined;
    for (const botId of targets) if (!skip.has(botId)) hooks.wake(botId, { kind: "messages", conversationId, ...(groupRequest ? { messageIds: [message.id], ...(lead ? { lead } : {}) } : {}) });
  }
  return message;
}

/**
 * A line in each bot's own chat saying a message went between them, linking to the side chat. It never
 * says what the message was. A back-and-forth adds one line per chat, not one per message: nothing is
 * added while that chat's latest message is already a line about the same side chat.
 */
function noteSideMessage(side: db.StoredConversation, from: string) {
  const name = (id: string) => db.getBot(id)?.name ?? "a bot";
  for (const botId of side.botIds) {
    const own = directId(botId);
    if (!own || !db.getBot(botId)) continue;
    const latest = db.messages(own, 1)[0]?.message.event;
    if (latest?.kind === "message" && latest.conversationId === side.id) continue;
    const others = side.botIds.filter((id) => id !== botId);
    const other = botId === from ? others[0] : from;
    if (!other) continue;
    const text = botId === from ? `Sent a message to ${name(other)}` : `Received a message from ${name(other)}`;
    postMessage(own, { id: crypto.randomUUID(), author: botId, at: Date.now(), text: "", event: { kind: "message", text, bot: other, conversationId: side.id } });
  }
}

/** What arrived in a conversation since the bot's turn there showed it (see Hooks.unseen). */
export function unseenSince(botId: string, conversationId: string): string[] {
  return hooks.unseen?.(botId, conversationId) ?? [];
}

// ------------------------------------------------------------------ to-do lists

/**
 * Change a conversation's to-do list, as the user (`me`) or one of its bots, and tell the app. Direct
 * and group chats have one; a side chat's work is reported back where it came from.
 */
export function editTodos(conversationId: string, change: TodoChange, by: Author): TodoItem[] {
  const c = db.getConversation(conversationId);
  if (!c) throw new BotsError("No such conversation.", 404);
  if (c.kind === "side") throw new BotsError("Side chats don't have a to-do list. Keep it in the chat you report back to.");
  if (by !== "me" && !c.botIds.includes(by)) throw new BotsError("That bot isn't in this conversation.");
  let next: TodoItem[];
  try {
    next = applyTodo(db.todos(conversationId), change, by);
  } catch (err) {
    throw new BotsError(err instanceof Error ? err.message : String(err));
  }
  db.setTodos(conversationId, next);
  emitConversation(conversationId);
  return next;
}

// ------------------------------------------------------------------ huddles

/** How long a huddle can go without a message, with none of its bots at work, before it closes. */
export const HUDDLE_QUIET_MS = 2 * 60_000;
/** How long a huddle can stay open at all. */
export const HUDDLE_MAX_MS = 5 * 60_000;

const huddleMessages = (conversationId: string) => db.messages(conversationId, 60).filter((r) => r.message.author !== "me" && !r.message.event).length;

/**
 * A temporary side chat `by` opens with other bots to work something out without filling `from`.
 * Its first message is the topic, which asks them all. Only a bot answering the user there can open
 * one, and only while it's in no other open huddle: never from a side chat or a chat shared with a friend.
 */
export function openHuddle(by: string, from: string, botIds: string[], topic: string): db.StoredConversation {
  const origin = db.getConversation(from);
  if (!origin?.botIds.includes(by)) throw new BotsError("You aren't in that conversation.");
  if (origin.kind === "side") throw new BotsError("Open a side chat from the chat that needs the answer, not from another side chat.");
  if (origin.friend) throw new BotsError("Side chats can't report to a chat shared with a friend.");
  if (!hooks.userWoke?.(by, from)) throw new BotsError("Open a side chat only while you're answering the user there.");
  const text = topic.trim().slice(0, 2000);
  if (!text) throw new BotsError("Say what the side chat is for.");
  const others = [...new Set(botIds)].filter((id) => id !== by);
  if (!others.length || others.length > 4) throw new BotsError("Pick one to four other bots.");
  for (const id of others) if (!db.getBot(id)) throw new BotsError("No such bot.");
  if (db.listConversations().some((c) => c.huddle && !c.huddle.closedAt && c.botIds.includes(by))) throw new BotsError("You're already in an open side chat. Finish that one first.");
  const request = hooks.pendingAssignments?.(by).find((a) => a.conversationId === from)?.messageIds;
  const members = [by, ...others];
  const side = createConversation({
    kind: "side",
    name: clip(text.split("\n")[0], 60),
    botIds: members,
    huddle: { by, from, topic: text, limit: huddleLimit(members.length), ...(request?.length ? { request } : {}) },
  });
  const name = (id: string) => mentionName(db.getBot(id)?.name ?? "a bot");
  const list = others.map(name);
  const who = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0];
  postMessage(from, { id: crypto.randomUUID(), author: by, at: Date.now(), text: "", event: { kind: "message", text: `${name(by)} is talking it over with ${who}`, detail: clip(text, 120), conversationId: side.id } });
  postMessage(side.id, { id: crypto.randomUUID(), author: by, at: Date.now(), text });
  return db.getConversation(side.id)!;
}

/** Closes a huddle, once, and asks the bot that opened it to report back where it came from. */
export function closeHuddle(id: string, why: string, author: string) {
  const c = db.getConversation(id);
  if (!c?.huddle || c.huddle.closedAt) return;
  const huddle = { ...c.huddle, closedAt: Date.now() };
  db.putConversation({ ...c, huddle });
  emitConversation(id);
  if (c.botIds.includes(author)) postMessage(id, { id: crypto.randomUUID(), author, at: Date.now(), text: "", event: { kind: "changed", text: "Side chat closed", detail: why } });
  const from = db.getConversation(huddle.from);
  if (!db.getBot(huddle.by) || !from?.botIds.includes(huddle.by)) return;
  hooks.wake(huddle.by, { kind: "note", conversationId: huddle.from, ...(huddle.request?.length ? { messageIds: huddle.request } : {}), text: huddleReport(c, why) });
}

/** What the bot that reports back is told: the whole huddle (it's short) and what to do with it. */
export function huddleReport(c: db.StoredConversation, why: string): string {
  const name = (id: string) => (id === c.huddle!.by ? "you" : mentionName(db.getBot(id)?.name ?? "a bot"));
  const said = db.messages(c.id, 60).filter((r) => !r.message.event && r.message.author !== "me").slice(-16).map((r) => `${name(r.message.author)}: ${r.message.text.slice(0, 600)}`);
  return [
    `Your side chat ${c.id.slice(0, 8)} (“${c.name ?? "side chat"}”) closed. ${why} What was said there:`,
    said.join("\n"),
    "Now report back here, once, for everyone, in one message: the answer or what you decided, not the whole discussion. If nobody here needs to hear it, stay [silent].",
  ].join("\n");
}

/** Huddles close after five minutes, or sooner once nobody has written for a while and none of their bots is at work. */
function closeQuietHuddles(now: number, busy: (botId: string) => boolean) {
  for (const c of db.listConversations()) {
    if (!c.huddle || c.huddle.closedAt) continue;
    if (now - c.createdAt >= HUDDLE_MAX_MS) {
      closeHuddle(c.id, "Its five minutes were up.", c.huddle.by);
      continue;
    }
    const last = db.messages(c.id, 1)[0]?.message.at ?? c.createdAt;
    if (now - last >= HUDDLE_QUIET_MS && !c.botIds.some(busy)) closeHuddle(c.id, "It went quiet.", c.huddle.by);
  }
}

/** Block until another bot writes in this conversation, or the time runs out. */
export function waitForReply(botId: string, conversationId: string, afterSeq: number, timeoutMs: number): Promise<BotMessage> {
  return new Promise((resolve, reject) => {
    const w: Waiter = { botId, conversationId, afterSeq, resolve, reject };
    waiters.push(w);
    const timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      reject(new BotsError("No reply in time."));
    }, timeoutMs);
    timer.unref?.();
    const done = () => clearTimeout(timer);
    const orig = w.resolve;
    w.resolve = (m) => (done(), orig(m));
  });
}

export function patchMessage(conversationId: string, messageId: string, patch: Partial<BotMessage>): BotMessage {
  const row = db.getMessage(messageId);
  if (!row || row.conversationId !== conversationId) throw new BotsError("No such message.", 404);
  const next = { ...row.message, ...patch, id: row.message.id, author: row.message.author, at: row.message.at };
  db.updateMessage(next);
  emit({ t: "message", conversationId, message: next });
  return next;
}

export function removeMessage(conversationId: string, messageId: string) {
  const row = db.getMessage(messageId);
  if (!row || row.conversationId !== conversationId) throw new BotsError("No such message.", 404);
  db.deleteMessage(messageId);
  emit({ t: "message-deleted", conversationId, id: messageId });
}


export function toggleReaction(conversationId: string, messageId: string, emoji: string, by: string, to?: string): BotMessage {
  const row = db.getMessage(messageId);
  if (!row || row.conversationId !== conversationId) throw new BotsError("No such message.", 404);
  const reactions = row.message.reactions ?? [];
  const target = to ? reactions.find((r) => reactionId(r) === to) : undefined;
  if (to && !target) throw new BotsError("No such reaction.", 404);
  const { next, added } = toggleReactionIn(reactions, emoji, by, to);
  const patched = patchMessage(conversationId, messageId, { reactions: next });
  // Whoever the user reacted to hears about it if they're a bot here: the message's author, or the one
  // whose reaction this answers. A bot's reaction is where it leaves things, and never wakes another bot.
  const owner = target ? target.by : row.message.author;
  const bots = db.getConversation(conversationId)?.botIds ?? [];
  if (added && by === "me" && owner !== "me" && !row.message.event && bots.includes(owner)) {
    const who = getSettings().user?.name || "The user";
    const quote = `“${row.message.text.slice(0, 200)}”`;
    const short = messageId.slice(0, 8);
    const text = target
      ? `${who} reacted ${emoji} to your ${target.emoji} reaction on [${short}] ${quote}. That's reaction #${next.length} there; react to it with react's to_reaction if you like. A reaction doesn't need an answer: react back, say something, or stay [silent], whatever a person would do.`
      : `${who} reacted ${emoji} to your message [${short}]: ${quote}. That's reaction #${next.length} there; react to it with react's to_reaction if you like. A reaction doesn't need an answer: react back, say something, or stay [silent], whatever a person would do.`;
    hooks.wake(owner, { kind: "reaction", conversationId, text, reaction: { messageId, emoji, by, to } });
  }
  return patched;
}

export function answerQuestion(conversationId: string, messageId: string, key: string) {
  const row = db.getMessage(messageId);
  const question = row?.conversationId === conversationId ? row.message.question : undefined;
  if (!row || !question) throw new BotsError("That message isn't a question.", 404);
  const patched = patchMessage(conversationId, messageId, { question: { ...question, answer: key.slice(0, 2000) } });
  // The first-run offers are the app's, not the bot's: taking the team makes it here, once, and whether they code is kept for the bot's context.
  const primary = !question.answer && !!db.getBot(row.message.author)?.primary;
  if (primary && question.offer === "team" && key === "A") createTeam(row.message.author);
  if (primary && question.offer === "developer") db.setValue(DEVELOPER, key === "A" ? { kind: "yes" } : key === "B" ? { kind: "no" } : { kind: "own", text: key.slice(0, 300) });
  return patched;
}

/** A changed answer on a closed poll has to stay this long before the poll's author hears of it, so a slip stays quiet. */
export const POLL_CHANGE_SETTLE = 30_000;
const POLL_CHANGES = "poll-changes";
interface PollChange {
  conversationId: string;
  messageId: string;
  by: string;
  /** The answer before this run of changes. */
  from: string[];
  at: number;
}

const pollPerson = (id: string) => (id === "me" ? getSettings().user?.name || "The user" : firstName(db.getBot(id)?.name ?? "A deleted bot"));
const pollTally = (poll: Poll) => poll.options.map((o) => `${o.key}) ${o.label}: ${poll.votes.filter((v) => v.keys.includes(o.key)).map((v) => pollPerson(v.by)).join(", ") || "nobody"}`).join("; ");
const pollAnswer = (poll: Poll, keys: string[]) => poll.options.filter((o) => keys.includes(o.key)).map((o) => o.label).join(", ");

/** Vote in a poll, replacing any earlier vote. No keys takes it back, until the poll closes. */
export function votePoll(conversationId: string, messageId: string, by: string, keys: string[]): BotMessage {
  const row = db.getMessage(messageId);
  const poll = row?.conversationId === conversationId ? row.message.poll : undefined;
  if (!row || !poll) throw new BotsError("That message isn't a poll.", 404);
  const stray = keys.find((key) => !poll.options.some((o) => o.key === key));
  if (stray !== undefined) throw new BotsError(`That poll has no option ${stray.slice(0, 20)}.`);
  if (!poll.multiple && new Set(keys).size > 1) throw new BotsError("That poll takes one answer.");
  if (poll.closedAt && !keys.length) throw new BotsError("That poll has closed. You can change your answer, but not take it back.");
  const before = poll.votes.find((v) => v.by === by)?.keys;
  const next = castVote(poll, by, keys);
  const patched = patchMessage(conversationId, messageId, { poll: next });
  if (poll.closedAt) {
    if (before && row.message.author !== by) trackPollChange({ conversationId, messageId, by, from: before, at: Date.now() }, next.votes.find((v) => v.by === by)!.keys);
    return patched;
  }
  if (!pollWaitingOn(next, row.message.author, db.getConversation(conversationId)?.botIds ?? []).length) return closePoll(conversationId, patched, by);
  return patched;
}

/** Everyone asked has answered: mark it, say so in the chat, and tell the bot that asked. */
function closePoll(conversationId: string, message: BotMessage, by: string): BotMessage {
  const poll: Poll = { ...message.poll!, closedAt: Date.now() };
  const closed = patchMessage(conversationId, message.id, { poll });
  postMessage(conversationId, { id: crypto.randomUUID(), author: by, at: Date.now(), text: "", event: { kind: "poll", text: "Poll closed", detail: poll.question } });
  if (db.getConversation(conversationId)?.botIds.includes(message.author)) {
    hooks.wake(message.author, { kind: "note", conversationId, text: `Everyone has answered your poll [${message.id.slice(0, 8)}] “${poll.question}”, so it's closed. Results: ${pollTally(poll)}. Share the outcome or act on it if that helps; otherwise reply [silent].` });
  }
  return closed;
}

/** Someone left the group: a poll that was only waiting on them is finished. */
function settlePolls(conversationId: string) {
  const botIds = db.getConversation(conversationId)?.botIds ?? [];
  for (const { message } of db.messages(conversationId)) {
    if (message.poll && !message.poll.closedAt && message.poll.votes.length && !pollWaitingOn(message.poll, message.author, botIds).length) closePoll(conversationId, message, "me");
  }
}

/** Starts or restarts the wait on a changed answer. Going back to where it started drops it. */
function trackPollChange(change: PollChange, to: string[]) {
  const list = db.getValue<PollChange[]>(POLL_CHANGES) ?? [];
  const same = (c: PollChange) => c.messageId === change.messageId && c.by === change.by;
  const from = list.find(same)?.from ?? change.from;
  const rest = list.filter((c) => !same(c));
  db.setValue(POLL_CHANGES, from.join() === to.join() ? rest : [...rest, { ...change, from }]);
}

/** Changed answers that have stayed changed: a bot that asked is told, and a user who asked sees it in the chat. */
function reportPollChanges(now: number) {
  const list = db.getValue<PollChange[]>(POLL_CHANGES) ?? [];
  const due = list.filter((c) => now - c.at >= POLL_CHANGE_SETTLE);
  if (!due.length) return;
  db.setValue(POLL_CHANGES, list.filter((c) => !due.includes(c)));
  for (const { conversationId, messageId, by, from } of due) {
    const message = db.getMessage(messageId)?.message;
    const poll = message?.poll;
    const to = poll?.votes.find((v) => v.by === by)?.keys;
    const members = db.getConversation(conversationId)?.botIds ?? [];
    if (!message || !poll || !to || to.join() === from.join()) continue;
    const change = `${pollAnswer(poll, from)} → ${pollAnswer(poll, to)}`;
    if (message.author === "me") {
      if (members.includes(by)) postMessage(conversationId, { id: crypto.randomUUID(), author: by, at: now, text: "", event: { kind: "poll", text: `${db.getBot(by)?.name ?? "A bot"} changed their answer`, detail: `${poll.question} ${change}` } });
    } else if (members.includes(message.author)) {
      hooks.wake(message.author, { kind: "note", conversationId, text: `${pollPerson(by)} changed their answer in your closed poll [${messageId.slice(0, 8)}] “${poll.question}”: ${change}. Results now: ${pollTally(poll)}. Say something or act on it if it matters; otherwise reply [silent].` });
    }
  }
}

// ------------------------------------------------------------------ memory and routines

export function addMemory(botId: string, text: string, by?: string, id?: string): MemoryItem {
  if (!db.getBot(botId)) throw new BotsError("No such bot.", 404);
  if (id && !isBotId(id)) throw new BotsError("Bad memory id.");
  if (id) {
    const existing = db.memories(botId).find((m) => m.id === id);
    if (existing) return existing;
    if (db.listBots().some((b) => b.id !== botId && db.memories(b.id).some((m) => m.id === id))) throw new BotsError("That memory id already exists.");
  }
  const item: MemoryItem = { id: id ?? crypto.randomUUID(), text: text.trim().slice(0, 2000), at: Date.now(), by };
  if (!item.text) throw new BotsError("Write what to remember.");
  db.addMemory(botId, item);
  emitBot(botId);
  return item;
}
export function removeMemory(botId: string, memoryId: string) {
  if (!db.removeMemory(botId, memoryId)) throw new BotsError("No such memory.", 404);
  emitBot(botId);
}

export function saveRoutine(botId: string, routine: Routine): Routine {
  if (!db.getBot(botId)) throw new BotsError("No such bot.", 404);
  const owner = routine.id && db.routineOwner(routine.id);
  if (owner && owner !== botId) throw new BotsError("That routine belongs to another bot.");
  if (routine.conversationId) {
    const conversation = db.getConversation(routine.conversationId);
    if (!conversation?.botIds.includes(botId)) throw new BotsError("That bot isn't in the routine's conversation.");
  }
  const title = clip(routine.title, 120);
  const schedule = clip(routine.schedule, 200);
  if (!title || !schedule) throw new BotsError("A routine needs a title and a schedule.");
  const parsed = parseSchedule(schedule, { once: !!routine.followUp });
  if (!isSchedule(parsed)) throw new BotsError(parsed.error);
  const saved: Routine = {
    ...routine,
    id: routine.id && isBotId(routine.id) ? routine.id : crypto.randomUUID(),
    title,
    schedule,
    enabled: routine.enabled !== false,
    task: clip(routine.task, 4000),
    followUp: routine.followUp || undefined,
    nextRunAt: nextRun(parsed, Date.now()),
    createdAt: routine.createdAt ?? Date.now(),
  };
  db.putRoutine(botId, saved);
  emitBot(botId);
  return saved;
}
export function updateRoutine(botId: string, routineId: string, patch: Partial<Routine>): Routine {
  const current = db.routines(botId).find((r) => r.id === routineId);
  if (!current) throw new BotsError("No such routine.", 404);
  return saveRoutine(botId, { ...current, ...patch, id: routineId });
}
export function removeRoutine(botId: string, routineId: string) {
  const owner = db.routineOwner(routineId);
  if (owner !== botId) throw new BotsError("No such routine.", 404);
  db.removeRoutine(routineId);
  emitBot(botId);
}

// ------------------------------------------------------------------ clock

const SIX_HOURS = 6 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

function quietNow(at: Date): boolean {
  const { from, to } = settings().quietHours;
  const h = at.getHours();
  return from === to ? false : from < to ? h >= from && h < to : h >= from || h < to;
}

/** Routines that are due, and heartbeats for bots with nothing else going on. */
export function tick(busy: (botId: string) => boolean) {
  const now = Date.now();
  reportPollChanges(now);
  db.sweepGroupFollows(now, GROUP_FOLLOW_MS, CLOCK_SKEW_MS);
  closeQuietHuddles(now, busy);
  for (const { botId, routine } of db.dueRoutines(now)) {
    const conversationId = routine.conversationId || directId(botId);
    const conversation = conversationId ? db.getConversation(conversationId) : undefined;
    if (!db.getBot(botId) || !conversation?.botIds.includes(botId)) {
      db.putRoutine(botId, { ...routine, enabled: false, nextRunAt: undefined });
      emitBot(botId);
      continue;
    }
    const late = now - (routine.nextRunAt ?? now);
    const drop = routine.followUp ? late > DAY : late > SIX_HOURS;
    const parsed = parseSchedule(routine.schedule, { once: !!routine.followUp, anchor: routine.createdAt, now: routine.createdAt });
    if (routine.followUp || (isSchedule(parsed) && parsed.kind === "once")) db.removeRoutine(routine.id);
    else if (isSchedule(parsed)) db.putRoutine(botId, { ...routine, lastRunAt: now, nextRunAt: nextRun(parsed, now) });
    else {
      db.putRoutine(botId, { ...routine, enabled: false, nextRunAt: undefined });
      emitBot(botId);
      continue;
    }
    emitBot(botId);
    if (drop) continue;
    if (!conversationId) continue;
    const text = routine.followUp ? routine.task || routine.title : `Routine “${routine.title}”. ${routine.task || routine.schedule}`;
    postMessage(conversationId, {
      id: crypto.randomUUID(),
      author: botId,
      at: now,
      text: "",
      event: { kind: "routine", text: routine.followUp ? "Followed up" : "Ran a routine", detail: routine.title },
    });
    hooks.wake(botId, { kind: "routine", conversationId, text });
  }
  if (settings().onboarding === "active") {
    // Waiting on Pi with a tab open: look again, in case it was set up from a terminal.
    if (setup.value && listeners.size) void greetOnFirstOpen();
    return;
  }
  for (const bot of db.listBots()) {
    const every = { off: 0, low: 8, normal: 3, high: 1 }[bot.proactivity ?? "normal"];
    if (!every || busy(bot.id) || quietNow(new Date(now))) continue;
    const key = `hb:${bot.id}`;
    const due = db.getValue<number>(key) ?? 0;
    if (due && now < due) continue;
    db.setValue(key, now + every * 60 * 60 * 1000 * (0.75 + Math.random() * 0.5));
    hooks.wake(bot.id, {
      kind: "heartbeat",
      conversationId: directId(bot.id),
      text: "Nobody has messaged you in a while. Look at your memory, routines and recent chats. If something is worth telling the user, send it. If not, reply [silent].",
    });
  }
}

/** Push a bot's next heartbeat out after it has just done something. */
export function touchHeartbeat(botId: string) {
  const bot = db.getBot(botId);
  const every = { off: 0, low: 8, normal: 3, high: 1 }[bot?.proactivity ?? "normal"];
  if (every) db.setValue(`hb:${botId}`, Date.now() + every * 60 * 60 * 1000);
}
