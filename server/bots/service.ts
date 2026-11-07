// OpenBots' state. SQLite (db.ts) is the record; this is what changes it and tells the app, and
// what decides which bots a message wakes. Running a bot (the Pi process) is runner.ts, which
// registers hooks so this file never imports it.
import { randomLook } from "../../src/lib/bots/looks";
import { isSchedule, nextRun, parseSchedule } from "../../shared/botSchedule";
import type { Bot, BotMessage, BotStatus, BotsEvent, BotsSettings, BotsSnapshot, Conversation, Draft, MemoryItem, PiSetup, Poll, Routine } from "../../shared/bots";
import { castVote, DEFAULT_SETTINGS, findTags, firstName, isBotId, marksUnread, PERMISSION_HARNESSES, makePoll, pollWaitingOn, reactionDepth, reactionId, toggleReactionIn } from "../../shared/bots";
import { computerApi } from "../computers/api";
import { hasDevice } from "../devices";
import { isPermissionId } from "../../shared/types";
import { validRuntime } from "../threadRuntime";
import * as db from "./db";

const MESSAGE_LIMIT = 200;
const CHAIN_LIMIT = 8;

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
}

type Hooks = {
  wake: (botId: string, wake: Wake) => void;
  stop: (botId: string) => void;
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
  openbotsChains?: Map<string, number>;
  openbotsChainWarned?: Set<string>;
  openbotsWaiters?: Waiter[];
  openbotsPiCheck?: PiCheck;
  openbotsSetup?: { value?: PiSetup };
};
let hooks: Hooks = (mem.openbotsHooks ??= { wake() {}, stop() {} });
/** runner.ts registers these at startup. */
export function setHooks(next: Hooks) {
  hooks = mem.openbotsHooks = next;
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
/** Bot-to-bot replies in a row, per conversation, so two bots can't talk forever. */
const chains = (mem.openbotsChains ??= new Map<string, number>());
let chainWarned = (mem.openbotsChainWarned ??= new Set<string>());
interface Waiter {
  botId: string;
  conversationId: string;
  afterSeq: number;
  resolve: (m: BotMessage) => void;
  reject: (e: Error) => void;
}
const waiters = (mem.openbotsWaiters ??= []);

function settings(): BotsSettings {
  return { ...DEFAULT_SETTINGS, ...db.getValue<Partial<BotsSettings>>("settings") };
}
export function getSettings(): BotsSettings {
  return settings();
}
/** Up to 8 "provider/model"s, in order, without repeats; undefined when there are none. */
function modelList(value: unknown): string[] | undefined {
  const list = strings(Array.isArray(value) ? value.map((m) => (typeof m === "string" ? m.trim().slice(0, 200) : m)).filter((m) => typeof m === "string" && m.includes("/")) : [], 8);
  return list.length ? list : undefined;
}

export function updateSettings(patch: Partial<BotsSettings>): BotsSettings {
  const next: BotsSettings = { ...settings(), ...patch };
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
  return { ...c, messages: rows.map((r) => r.message), more: rows.length > 0 && db.countBefore(id, rows[0]!.seq) > 0 };
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
  };
}

export function getStatus(botId: string): BotStatus | undefined {
  return status.get(botId);
}
export function setStatus(botId: string, next: BotStatus) {
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
  if (c) emit({ t: "conversation", conversation: c });
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
    if (member.threads) updateBot(bot.id, { threads: member.threads });
    ids.push(bot.id);
    if (primaryChat) postMessage(primaryChat, { id: crypto.randomUUID(), author: primaryId, at: Date.now(), text: "", event: { kind: "created", text: "New bot", detail: bot.name, bot: bot.id } });
  }
  const group = createConversation({ kind: "group", name: "Team", botIds: [primaryId, ...ids], instructions: "Work through the user's projects together. Manager runs the threads and merges, Tracer checks the work, Researcher looks things up." });
  updateConversation(group.id, { pinnedAt: Date.now() });
  return { botIds: ids, conversationId: group.id };
}

export async function resetAll() {
  for (const bot of db.listBots()) hooks.stop(bot.id);
  for (const bot of db.listBots()) {
    const device = bot.computer?.device ?? "local";
    await computerApi(device).call(bot.id, "destroy", { kind: bot.computer?.kind }).catch(() => {});
  }
  // Reset is about bots and chats. Their default model and its fallbacks, how the user searches the web, which extensions they load and the apps they connected aren't those, and the keys stay too.
  const { defaultModel, defaultFallbackModels, searxng, customExtensions } = settings();
  const apps = db.getValue("apps");
  db.wipe();
  if (defaultModel || defaultFallbackModels || searxng?.length || customExtensions) db.setValue("settings", { ...settings(), defaultModel, defaultFallbackModels, searxng, customExtensions });
  if (apps) db.setValue("apps", apps);
  status.clear();
  chains.clear();
  chainWarned = mem.openbotsChainWarned = new Set();
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

export function updateBot(id: string, patch: Partial<Bot>): Bot {
  const bot = db.getBot(id);
  if (!bot) throw new BotsError("No such bot.", 404);
  // Before anything changes: a computer only goes somewhere this server can reach as itself.
  if (typeof patch.computer?.device === "string" && patch.computer.device !== "local" && !hasDevice(patch.computer.device)) throw new BotsError("That device isn't paired with this server.");
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
  if (typeof patch.effort === "string") bot.effort = patch.effort.slice(0, 40);
  if (patch.computer && (patch.computer.kind === "container" || patch.computer.kind === "host") && typeof patch.computer.device === "string") {
    bot.computer = { kind: patch.computer.kind, device: patch.computer.device.slice(0, 80) };
  }
  if (patch.threads) bot.threads = { enabled: patch.threads.enabled === true, scope: patch.threads.scope === "all" || patch.threads.scope === "exclude" ? patch.threads.scope : "choose", projects: strings(patch.threads.projects, 200), excluded: strings(patch.threads.excluded, 200), choosePermission: patch.threads.choosePermission === true, approve: patch.threads.approve === true, merge: patch.threads.merge === true, others: patch.threads.others === true };
  if (patch.primary) {
    for (const other of db.listBots()) if (other.primary && other.id !== id) db.putBot({ ...other, primary: undefined });
    bot.primary = true;
  }
  db.putBot(bot);
  if (newPace) touchHeartbeat(id);
  for (const other of db.listBots()) if (other.id !== id && patch.primary) emitBot(other.id);
  emitBot(id);
  return fullBot(id)!;
}

export async function deleteBot(id: string) {
  const bot = db.getBot(id);
  if (!bot) throw new BotsError("No such bot.", 404);
  if (bot.primary) throw new BotsError("The primary bot can't be deleted. Make another one primary first.");
  hooks.stop(id);
  const device = bot.computer?.device ?? "local";
  await computerApi(device).call(id, "destroy", { kind: bot.computer?.kind }).catch(() => {});
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
    }
  }
  db.deleteBot(id);
  status.delete(id);
  emit({ t: "bot-deleted", id });
}

export function createConversation(input: { id?: string; kind: Conversation["kind"]; name?: string; botIds: string[]; instructions?: string; messages?: BotMessage[] }): Conversation {
  if (input.kind === "direct") throw new BotsError("A bot's own chat is created with the bot.");
  const botIds = [...new Set(input.botIds)].filter((id) => db.getBot(id));
  if (botIds.length < 2) throw new BotsError("Pick at least two bots.");
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
  if (patch.botIds && c.kind === "group") {
    const ids = [...new Set(patch.botIds)].filter((b) => db.getBot(b));
    if (ids.length >= 1) {
      c.botIds = ids;
      const follow = db.groupFollow(id);
      if (follow) db.setGroupFollow(id, { ...follow, ids: follow.ids.filter(botId => ids.includes(botId)) });
    }
  }
  db.putConversation(c);
  emitConversation(id);
  if (patch.botIds && c.kind === "group") settlePolls(id);
  return conversationView(id)!;
}

export function deleteConversation(id: string) {
  const c = db.getConversation(id);
  if (!c) throw new BotsError("No such conversation.", 404);
  if (c.kind === "direct") throw new BotsError("Delete the bot to remove its chat.");
  db.deleteConversation(id);
  emit({ t: "conversation-deleted", id });
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
  if (message.author !== "me" && !c.botIds.includes(message.author)) throw new BotsError("That bot isn't in this conversation.");
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
  if (message.author !== "me" && !message.event) pulse(message.author, "happy");

  const waiting = waiters.filter((w) => w.conversationId === conversationId && w.afterSeq < seq && w.botId !== message.author);
  for (const w of waiting) {
    const i = waiters.indexOf(w);
    if (i >= 0) waiters.splice(i, 1);
    w.resolve(message);
  }
  const skip = new Set(waiting.map((w) => w.botId));
  if (c.kind === "side" && message.author !== "me" && !message.event) noteSideMessage(c, message.author);

  if (!message.event) {
    if (message.author === "me") {
      chains.set(conversationId, 0);
      chainWarned.delete(conversationId);
    } else chains.set(conversationId, (chains.get(conversationId) ?? 0) + 1);
    const depth = chains.get(conversationId) ?? 0;
    if (message.author !== "me" && depth > CHAIN_LIMIT) {
      if (!chainWarned.has(conversationId)) {
        chainWarned.add(conversationId);
        postMessage(conversationId, {
          id: crypto.randomUUID(),
          author: message.author,
          at: Date.now(),
          text: "",
          event: { kind: "error", text: "Paused", detail: "The bots were replying to each other for a while, so they stopped. Send a message to continue." },
        });
      }
    } else {
      let targets = wakeTargets(c, message);
      const groupRequest = message.author === "me" && c.kind === "group";
      if (groupRequest && !message.poll) {
        if (!targets.length) targets = groupRecipients(c, message);
        db.setGroupFollow(conversationId, { ids: targets, at: message.at });
      }
      for (const botId of targets) if (!skip.has(botId)) hooks.wake(botId, { kind: "messages", conversationId, ...(groupRequest ? { messageIds: [message.id] } : {}) });
    }
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

/** Bots answering bots' reactions wake each other only this deep, so a chain of them settles. */
const BOT_REACTION_DEPTH = 2;

export function toggleReaction(conversationId: string, messageId: string, emoji: string, by: string, to?: string): BotMessage {
  const row = db.getMessage(messageId);
  if (!row || row.conversationId !== conversationId) throw new BotsError("No such message.", 404);
  const reactions = row.message.reactions ?? [];
  const target = to ? reactions.find((r) => reactionId(r) === to) : undefined;
  if (to && !target) throw new BotsError("No such reaction.", 404);
  const { next, added } = toggleReactionIn(reactions, emoji, by, to);
  const patched = patchMessage(conversationId, messageId, { reactions: next });
  // Whoever was reacted to hears about it if they're a bot here: the message's author, or the one whose reaction this answers.
  const owner = target ? target.by : row.message.author;
  const depth = added ? reactionDepth(next, added) : 0;
  const bots = db.getConversation(conversationId)?.botIds ?? [];
  if (added && owner !== by && owner !== "me" && !row.message.event && bots.includes(owner) && (by === "me" || depth < BOT_REACTION_DEPTH)) {
    const who = by === "me" ? getSettings().user?.name || "The user" : db.getBot(by)?.name || "Another bot";
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
