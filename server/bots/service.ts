// OpenBots' state. SQLite (db.ts) is the record; this is what changes it and tells the app, and
// what decides which bots a message wakes. Running a bot (the Pi process) is runner.ts, which
// registers hooks so this file never imports it.
import { randomLook } from "../../src/lib/bots/looks";
import { isSchedule, nextRun, parseSchedule } from "../../shared/botSchedule";
import type { Bot, BotMessage, BotStatus, BotsEvent, BotsSettings, BotsSnapshot, Conversation, Draft, MemoryItem, Routine } from "../../shared/bots";
import { DEFAULT_SETTINGS, firstName, isBotId, reactionDepth, reactionId, toggleReactionIn } from "../../shared/bots";
import { computerApi } from "../computers/api";
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
  text?: string;
  /** For a reaction: dropped if it's taken back before the bot looks. */
  reaction?: { messageId: string; emoji: string; by: string; to?: string };
}

type Hooks = {
  wake: (botId: string, wake: Wake) => void;
  stop: (botId: string) => void;
};

const mem = globalThis as {
  openbotsHooks?: Hooks;
  openbotsListeners?: Set<(e: BotsEvent) => void>;
  openbotsTyping?: Record<string, string[]>;
  openbotsDrafts?: Draft[];
  openbotsStatus?: Map<string, BotStatus>;
  openbotsChains?: Map<string, number>;
  openbotsChainWarned?: Set<string>;
  openbotsWaiters?: Waiter[];
};
let hooks: Hooks = (mem.openbotsHooks ??= { wake() {}, stop() {} });
/** runner.ts registers these at startup. */
export function setHooks(next: Hooks) {
  hooks = mem.openbotsHooks = next;
}

const listeners = (mem.openbotsListeners ??= new Set<(e: BotsEvent) => void>());
export function subscribe(listener: (e: BotsEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
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
export function updateSettings(patch: Partial<BotsSettings>): BotsSettings {
  const next: BotsSettings = { ...settings(), ...patch };
  if (patch.quietHours) next.quietHours = { from: num(patch.quietHours.from, 0, 23), to: num(patch.quietHours.to, 0, 23) };
  if (patch.sections) next.sections = patch.sections.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()).slice(0, 40);
  if (patch.user) next.user = { name: clip(patch.user.name, 80), context: clip(patch.user.context, 2000) };
  db.setValue("settings", next);
  emit({ t: "settings", settings: next });
  return next;
}

const num = (n: unknown, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(n) || 0)));
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
  };
}

export function setStatus(botId: string, next: BotStatus) {
  if (next.state === "idle") status.delete(botId);
  else status.set(botId, next);
  emit({ t: "status", botId, status: next });
}
export function setTyping(conversationId: string, botId: string, on: boolean) {
  const now = new Set(typing[conversationId] ?? []);
  if (on) now.add(botId);
  else now.delete(botId);
  typing[conversationId] = [...now];
  emit({ t: "typing", conversationId, botIds: typing[conversationId]! });
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

export function ensureStarted() {
  if (db.listBots().length) return;
  const now = Date.now();
  const botId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const bot: db.StoredBot = {
    id: botId,
    name: "Assistant",
    look: { shape: "puff", color: "white" },
    primary: true,
    instructions: "",
    createdAt: now,
    proactivity: "normal",
    by: "me",
  };
  db.putBot(bot);
  const conversation: db.StoredConversation = { id: conversationId, kind: "direct", botIds: [botId], pinnedAt: now, createdAt: now, updatedAt: now };
  db.putConversation(conversation);
  updateSettings({ onboarding: "active" });
}

/** The first time OpenBots is opened, the primary bot writes its own welcome. A failed try is retried on a later open. */
export function greetOnFirstOpen() {
  if (settings().onboarding !== "active") return;
  const bot = db.listBots().find((b) => b.primary);
  const conversationId = bot && directId(bot.id);
  if (!bot || !conversationId || status.get(bot.id)?.state === "working") return;
  const rows = db.messages(conversationId, MESSAGE_LIMIT);
  if (rows.some((r) => !r.message.event || Date.now() - r.message.at < 60_000)) return;
  for (const r of rows) removeMessage(conversationId, r.message.id);
  hooks.wake(bot.id, { kind: "note", conversationId, text: "The user just opened OpenBots for the first time. Say hello now." });
}

export async function resetAll() {
  for (const bot of db.listBots()) hooks.stop(bot.id);
  for (const bot of db.listBots()) {
    const device = bot.computer?.device ?? "local";
    await computerApi(device).call(bot.id, "destroy", { kind: bot.computer?.kind }).catch(() => {});
  }
  db.wipe();
  status.clear();
  chains.clear();
  chainWarned = mem.openbotsChainWarned = new Set();
  for (const id of Object.keys(typing)) delete typing[id];
  drafts.length = 0;
  ensureStarted();
  emit({ t: "snapshot", ...snapshot() });
  greetOnFirstOpen();
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
  if (typeof patch.effort === "string") bot.effort = patch.effort.slice(0, 40);
  if (patch.computer && (patch.computer.kind === "container" || patch.computer.kind === "host") && typeof patch.computer.device === "string") {
    bot.computer = { kind: patch.computer.kind, device: patch.computer.device.slice(0, 80) };
  }
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
    if (ids.length >= 1) c.botIds = ids;
  }
  db.putConversation(c);
  emitConversation(id);
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

/** Who a message should pull in. Events wake nobody. */
function wakeTargets(c: db.StoredConversation, message: BotMessage): string[] {
  if (message.event) return [];
  const members = c.botIds.filter((id) => db.getBot(id));
  if (message.author === "me") {
    if (c.kind !== "group") return members;
    const mentioned = mentionedBots(message.text, members);
    if (mentioned.length) return mentioned;
    const primary = members.find((id) => db.getBot(id)?.primary);
    return primary ? [primary] : members.slice(0, 1);
  }
  const others = members.filter((id) => id !== message.author);
  if (c.kind === "side") return others;
  const mentioned = mentionedBots(message.text, others);
  const reply = message.replyTo ? db.getMessage(message.replyTo) : undefined;
  const replied = reply && others.includes(reply.message.author) ? [reply.message.author] : [];
  return [...new Set([...mentioned, ...replied])];
}

function mentionedBots(text: string, ids: string[]): string[] {
  if (/@(all|everyone)\b/i.test(text)) return ids;
  return ids.filter((id) => {
    const bot = db.getBot(id);
    if (!bot) return false;
    const name = firstName(bot.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`@${name}\\b`, "i").test(text);
  });
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
  const seq = db.addMessage(conversationId, message);
  const unread = message.author !== "me" ? true : c.unread;
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
      for (const botId of wakeTargets(c, message)) if (!skip.has(botId)) hooks.wake(botId, { kind: "messages", conversationId });
    }
  }
  return message;
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
  if (!row?.message.question) throw new BotsError("That message isn't a question.", 404);
  return patchMessage(conversationId, messageId, { question: { ...row.message.question, answer: key.slice(0, 2000) } });
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
      event: { kind: "routine", text: routine.followUp ? "Follow-up" : "Routine", detail: routine.title },
    });
    hooks.wake(botId, { kind: "routine", conversationId, text });
  }
  if (settings().onboarding === "active") return;
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
