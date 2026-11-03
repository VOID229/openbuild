// What a bot's Pi extension can do. The extension talks to a unix socket (see listen()); every
// request is one bot, identified by the token minted for its process, so a bot can't act as another.
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { COLOR_BY_ID, SHAPE_BY_ID } from "../../src/lib/bots/looks";
import { conversationTitle, firstName, isSilent, makePoll, reactionId, type Bot, type BotMessage, type Proactivity } from "../../shared/bots";
import { computerApi } from "../computers/api";
import { capabilities } from "../computers/index";
import { botsDir } from "./db";
import * as db from "./db";
import * as svc from "./service";

const kept = globalThis as { openbotsFocus?: Map<string, string>; openbotsTokens?: Map<string, string>; openbotsAgent?: ReturnType<typeof Bun.serve> };
const focus = (kept.openbotsFocus ??= new Map<string, string>());
/** The conversation a bot is working in, so send_message can default to it. */
export function setFocus(botId: string, conversationId: string | undefined) {
  if (conversationId) focus.set(botId, conversationId);
  else focus.delete(botId);
}
export function getFocus(botId: string): string | undefined {
  return focus.get(botId);
}

const tokens = (kept.openbotsTokens ??= new Map<string, string>());
export function mintToken(botId: string): string {
  const token = crypto.randomUUID();
  tokens.set(token, botId);
  return token;
}
export function revokeToken(token: string) {
  tokens.delete(token);
}

const socketPath = () => join(botsDir(), "agent.sock");

export function agentSocketPath(): string {
  return socketPath();
}

/** Accept tool calls from the Pi extensions. One server for every bot; the token says which. */
export function listen() {
  kept.openbotsAgent?.stop(true);
  const path = socketPath();
  mkdirSync(botsDir(), { recursive: true, mode: 0o700 });
  try {
    unlinkSync(path);
  } catch {}
  kept.openbotsAgent = Bun.serve({
    unix: path,
    async fetch(req) {
      const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const botId = tokens.get(token);
      if (!botId) return Response.json({ error: "Unauthorized" }, { status: 401 });
      let body: { method?: string; params?: Record<string, unknown> };
      try {
        body = (await req.json()) as { method?: string; params?: Record<string, unknown> };
      } catch {
        return Response.json({ error: "Expected JSON" }, { status: 400 });
      }
      try {
        const result = await handle(botId, String(body.method ?? ""), body.params ?? {});
        return Response.json({ result });
      } catch (err) {
        const status = err instanceof svc.BotsError ? err.status : 500;
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
      }
    },
  });
  try {
    chmodSync(path, 0o600);
  } catch {}
}

async function handle(botId: string, method: string, p: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "context":
      return contextFor(botId);
    case "send_message":
      return sendMessage(botId, p);
    case "react":
      return react(botId, p);
    case "question":
      return askUser(botId, p);
    case "poll":
      return startPoll(botId, p);
    case "vote_poll":
      return votePoll(botId, p);
    case "remember":
      return remember(botId, p);
    case "forget":
      return forget(botId, p);
    case "search":
      return search(botId, p);
    case "routine":
      return routine(botId, p);
    case "ask_bot":
      return askBot(botId, p);
    case "manage_bot":
      return manage(botId, p);
    case "bash":
      return bash(botId, p);
    case "read":
      return read(botId, p);
    case "write":
      return write(botId, p);
    case "edit":
      return edit(botId, p);
    case "browser":
      return browser(botId, p);
    case "process":
      return processTool(botId, p);
    default:
      throw new svc.BotsError(`Unknown method ${method}`);
  }
}

function requireBot(id: string): Bot {
  const bot = svc.fullBot(id);
  if (!bot) throw new svc.BotsError("This bot no longer exists.", 404);
  return bot;
}

export function contextFor(botId: string): string {
  const bot = requireBot(botId);
  const settings = svc.getSettings();
  const user = settings.user?.name || "the user";
  const others = db.listBots().filter((b) => b.id !== botId);
  const convos = db.listConversations().filter((c) => c.botIds.includes(botId));
  const lines = [
    `You are ${bot.name}, one of the user's bots in OpenBots. The user is ${user}.${settings.user?.context ? ` About them: ${settings.user.context}` : ""}`,
    bot.primary
      ? "You are the primary bot. Your say goes: you can create, change and delete the other bots, including their instructions. They can't override you."
      : `The primary bot is ${db.listBots().find((b) => b.primary)?.name ?? "someone else"}. They can change your instructions; you can't change other bots, only your own name and look, and your own instructions while you have none.`,
    "You talk like a person texting: short, warm, plain. No headings, no bullet lists unless asked. Several short messages beat one long one — call send_message once per bubble.",
    "You can write to any conversation you're in, at any time, with send_message. You don't owe a reply to every message or reaction: answer when you have something to say, and otherwise end your turn with the plain reply [silent]. Never pass [silent] to send_message, and you don't need it after sending messages.",
    "New messages can arrive while you work. Read them and fold them in.",
    "Each message shows its short id in brackets. A message that quotes another shows (replying to …), and reactions people left show under it. To answer an earlier message that isn't the latest one, quote it with send_message's reply_to; answering the newest message needs no reply_to, so leave it out. React with react. Reactions are numbered under each message (#1, #2…), and one that answers another shows → #n; to react to someone's reaction instead of the message, pass its number as react's to_reaction.",
    "In a group, poll asks everyone to pick from a few options, when the group's view would actually help. When a poll in the chat says you haven't voted, vote with vote_poll, going by what you honestly think. Voting shows on the poll, so you needn't announce it; add a message only if you have something more to say. A poll closes once everyone has answered. You can still change your answer after that if you truly change your mind, and whoever asked will hear about it.",
    bot.instructions.trim() ? `Your instructions:\n${bot.instructions.trim()}` : "",
    instructionsGuide(bot),
    "Your memory is private to you: the user never sees it, and nothing shows in the chat when you save something. Use remember without being asked for anything that should outlast this chat, and whenever the user asks you to remember something. Use forget for what's stopped being true or when they ask you to. If they ask what you remember, tell them. Routines are yours to run too; the user sees them but doesn't add them by hand. Use routine when the user wants something done on a schedule or later, or when your instructions call for it. You can have any number of routines active at once and each runs on its own, so add a new one rather than folding jobs together. Pause or remove the ones that are no longer needed.",
    bot.memory.length ? `Things you remember:\n${bot.memory.slice(0, 40).map((m) => `- [${m.id.slice(0, 8)}] ${m.text}`).join("\n")}` : "You haven't written any memories yet.",
    bot.routines.length
      ? `Your routines:\n${bot.routines.map((r) => `- [${r.id.slice(0, 8)}] ${r.title} (${r.schedule})${r.enabled ? "" : " [paused]"}${r.task ? `: ${r.task}` : ""}`).join("\n")}`
      : "",
    others.length
      ? `Other bots:\n${others.map((b) => `- ${b.name} (${b.id.slice(0, 8)})${b.primary ? " primary" : ""}: ${b.instructions || "no instructions yet"}`).join("\n")}`
      : "There are no other bots yet.",
    `Conversations you're in:\n${convos.map((c) => `- ${c.id.slice(0, 8)} ${c.kind} “${conversationTitle(c, db.listBots())}”`).join("\n")}`,
    `You have a computer: a home folder, a terminal (bash), files (read, write, edit) and a browser. It stays around between chats. The time is ${new Date().toString()}.`,
  ];
  if (bot.primary && settings.onboarding === "active") {
    lines.push(
      "This is the user's first time in OpenBots, and your name is only a placeholder until they choose one. If you haven't said hello yet, welcome them to OpenBots in your own words, say you're their primary bot, and ask what they'd like to call you and what they'd like you to do. Ask in plain chat, without suggesting names or using a question card. Once they answer, rename yourself with manage_bot before anything else and write your instructions from what they told you. You can offer to make other bots for the things they do often. When the basics are settled, call manage_bot with finish_onboarding. Keep it to a few short messages.",
    );
  }
  return lines.filter(Boolean).join("\n\n");
}

/** Bots write their own instructions; the user can edit them, so the text on file is always the starting point. */
function instructionsGuide(bot: Bot): string {
  const lines: string[] = [];
  if (!bot.instructions.trim()) {
    lines.push("You don't have instructions yet. Don't ask the user to write them or announce them. Within your first few messages, as soon as you know what they want from you and how, write them yourself with manage_bot update: short, and addressed to yourself as \"you\". Until there's something real to say, leave them empty.");
  } else if (bot.primary) {
    lines.push("When the user tells you something lasting about what you're for or how to act, update your instructions with manage_bot. That replaces the whole text, and the user may have edited it, so start from what's above and keep what they wrote.");
  }
  if (bot.primary) {
    lines.push("When you make a bot, decide whether to give it instructions: if the conversation shows what it's for, write proper ones that say so, with what you know that it'll need. If it doesn't, leave them out rather than inventing a job. You can fill them in later with manage_bot update, including for any other bot that has none.");
  }
  return lines.join(" ");
}

function conversationFor(botId: string, given: unknown): string {
  const id = typeof given === "string" && given ? resolveConversation(botId, given) : focus.get(botId);
  if (!id) throw new svc.BotsError("Say which conversation.");
  const c = db.getConversation(id);
  if (!c || !c.botIds.includes(botId)) throw new svc.BotsError("You aren't in that conversation.");
  return id;
}

function resolveConversation(botId: string, prefix: string): string {
  const all = db.listConversations().filter((c) => c.botIds.includes(botId));
  const hit = all.filter((c) => c.id === prefix || c.id.startsWith(prefix));
  if (hit.length === 1) return hit[0]!.id;
  throw new svc.BotsError(hit.length ? "That conversation id is ambiguous." : "No such conversation.");
}

export async function sendMessage(botId: string, p: Record<string, unknown>) {
  const conversationId = conversationFor(botId, p.conversation);
  const text = String(p.text ?? "").slice(0, 8000);
  if (!text.trim() && !p.attach_screenshot && !asStrings(p.images).length) throw new svc.BotsError("A message needs text.");
  if (isSilent(text) && !p.attach_screenshot && !asStrings(p.images).length) return { note: "Nothing was sent. [silent] is only for your final reply, never for send_message." };
  const images: string[] = [];
  for (const path of asStrings(p.images).slice(0, 4)) {
    const data = await readFileSyncBase64(botId, path);
    images.push(`data:${mime(path)};base64,${data}`);
  }
  if (p.attach_screenshot) {
    const { api, id } = await computerOf(botId);
    const shot = (await api.call(id, "browser", { action: "screenshot" })) as { data?: string; mimeType?: string };
    if (shot.data) images.push(`data:${shot.mimeType || "image/jpeg"};base64,${shot.data}`);
    return deliver(botId, conversationId, text, images, p.reply_to);
  }
  return deliver(botId, conversationId, text, images, p.reply_to);
}

function deliver(botId: string, conversationId: string, text: string, images: string[], replyTo: unknown) {
  let reply: string | undefined;
  if (typeof replyTo === "string" && replyTo) {
    const found = db.findMessages(replyTo, [conversationId]);
    // Quoting the newest message is noise: it's right above. Only keep quotes that point further back.
    const hit = found.length === 1 ? found[0]! : undefined;
    if (hit && db.messagesAfter(conversationId, hit.seq, 50).some((r) => r.message.author !== botId)) reply = hit.message.id;
  }
  const message: BotMessage = { id: crypto.randomUUID(), author: botId, at: Date.now(), text: text.trim(), images: images.length ? images : undefined, replyTo: reply };
  svc.postMessage(conversationId, message);
  svc.touchHeartbeat(botId);
  return { id: message.id, conversation: conversationId.slice(0, 8) };
}

function react(botId: string, p: Record<string, unknown>) {
  if (!svc.getSettings().reactions) throw new svc.BotsError("Reactions are turned off.");
  const conversationId = conversationFor(botId, p.conversation);
  const emoji = String(p.emoji ?? "").trim();
  if (!emoji) throw new svc.BotsError("Name an emoji.");
  const found = db.findMessages(String(p.message ?? ""), [conversationId]);
  if (found.length !== 1) throw new svc.BotsError("Name the message to react to.");
  const message = found[0]!.message;
  let to: string | undefined;
  if (p.to_reaction !== undefined && p.to_reaction !== null && p.to_reaction !== "") {
    const n = Number(String(p.to_reaction).replace(/^#/, ""));
    const target = message.reactions?.[n - 1];
    if (!target) throw new svc.BotsError(`That message has no reaction #${p.to_reaction}.`);
    to = reactionId(target);
  }
  svc.toggleReaction(conversationId, message.id, emoji, botId, to);
  svc.pulse(botId, emoji === "❤️" ? "love" : "happy");
  return { ok: true };
}

function askUser(botId: string, p: Record<string, unknown>) {
  const conversationId = conversationFor(botId, p.conversation);
  const title = String(p.title ?? p.question ?? "").trim().slice(0, 300);
  if (!title) throw new svc.BotsError("Write the question.");
  const options = asStrings(p.options).slice(0, 8);
  const message: BotMessage = {
    id: crypto.randomUUID(),
    author: botId,
    at: Date.now(),
    text: title,
    question: {
      title,
      hint: typeof p.hint === "string" ? p.hint.slice(0, 200) : undefined,
      options: options.map((label, i) => ({ key: String.fromCharCode(65 + i), label })),
    },
  };
  svc.postMessage(conversationId, message);
  return { id: message.id, note: "The user answers in the chat. Don't invent their answer; stop here and wait." };
}

export function startPoll(botId: string, p: Record<string, unknown>) {
  const conversationId = conversationFor(botId, p.conversation);
  const poll = makePoll(String(p.question ?? ""), asStrings(p.options), { multiple: p.multiple === true, blind: p.hide_votes !== false });
  const message: BotMessage = { id: crypto.randomUUID(), author: botId, at: Date.now(), text: poll.question, poll };
  svc.postMessage(conversationId, message);
  svc.touchHeartbeat(botId);
  return { id: message.id, note: "Everyone in the group is asked. You'll hear when it closes, once they've all answered; don't guess the result." };
}

export function votePoll(botId: string, p: Record<string, unknown>) {
  const conversationId = conversationFor(botId, p.conversation);
  const found = db.findMessages(String(p.message ?? ""), [conversationId]);
  if (found.length !== 1 || !found[0]!.message.poll) throw new svc.BotsError("Name the poll by its message id.");
  const keys = asStrings(p.choices).map((key) => key.trim().toUpperCase());
  if (!keys.length) throw new svc.BotsError("Pick at least one option, by its letter.");
  svc.votePoll(conversationId, found[0]!.message.id, botId, keys);
  svc.pulse(botId, "happy");
  return { ok: true };
}

export function remember(botId: string, p: Record<string, unknown>) {
  const item = svc.addMemory(botId, String(p.text ?? ""), botId);
  return { id: item.id };
}
function forget(botId: string, p: Record<string, unknown>) {
  const id = String(p.id ?? "");
  const item = db.memories(botId).find((m) => m.id === id || m.id.startsWith(id));
  if (!item) throw new svc.BotsError("No such memory.");
  svc.removeMemory(botId, item.id);
  return { ok: true };
}
function search(botId: string, p: Record<string, unknown>) {
  const query = String(p.query ?? "").slice(0, 200);
  const ids = db.listConversations().filter((c) => c.botIds.includes(botId)).map((c) => c.id);
  if (p.what === "messages") {
    return db.searchMessages(query, ids, 12).map((r) => ({
      conversation: r.conversationId.slice(0, 8),
      id: r.message.id.slice(0, 8),
      author: r.message.author === "me" ? "user" : firstName(db.getBot(r.message.author)?.name ?? r.message.author),
      text: r.message.text.slice(0, 400),
    }));
  }
  return db.searchMemory(botId, query).map((m) => ({ id: m.id.slice(0, 8), text: m.text }));
}

export function routine(botId: string, p: Record<string, unknown>) {
  const action = String(p.action ?? "add");
  if (action === "list") return svc.fullBot(botId)?.routines ?? [];
  if (action === "remove" || action === "pause" || action === "resume") {
    const id = typeof p.id === "string" ? p.id.trim() : "";
    const title = typeof p.title === "string" ? p.title.trim() : "";
    if (!id && !title) throw new svc.BotsError("Name the routine by id or title.");
    const own = db.routines(botId);
    const exact = id ? own.find((r) => r.id === id) : undefined;
    const matches = exact ? [exact] : own.filter((r) => id ? r.id.startsWith(id) : r.title === title);
    if (matches.length !== 1) throw new svc.BotsError(matches.length ? "That routine is ambiguous." : "No such routine.");
    const found = matches[0]!;
    if (action === "remove") {
      svc.removeRoutine(botId, found.id);
      return { ok: true };
    }
    return svc.updateRoutine(botId, found.id, { enabled: action === "resume" });
  }
  if (action !== "add") throw new svc.BotsError("action is add, list, remove, pause or resume.");
  const saved = svc.saveRoutine(botId, {
    id: crypto.randomUUID(),
    title: String(p.title ?? ""),
    schedule: String(p.schedule ?? ""),
    enabled: true,
    task: typeof p.task === "string" ? p.task : undefined,
    followUp: !!p.follow_up,
    conversationId: typeof p.conversation === "string" ? conversationFor(botId, p.conversation) : focus.get(botId),
    by: botId,
  });
  const where = saved.conversationId || focus.get(botId);
  if (where) {
    svc.postMessage(where, {
      id: crypto.randomUUID(),
      author: botId,
      at: Date.now(),
      text: "",
      event: { kind: "routine", text: saved.followUp ? "Follow-up set" : "Routine", detail: `${saved.title} · ${saved.schedule}` },
    });
  }
  return { id: saved.id, next: saved.nextRunAt };
}

async function askBot(botId: string, p: Record<string, unknown>) {
  const otherId = resolveBot(String(p.bot ?? ""));
  if (otherId === botId) throw new svc.BotsError("Ask someone else.");
  const text = String(p.text ?? "").trim().slice(0, 4000);
  if (!text) throw new svc.BotsError("Say what you're asking.");
  let side = db.listConversations().find((c) => c.kind === "side" && c.botIds.length === 2 && c.botIds.includes(botId) && c.botIds.includes(otherId));
  if (!side) {
    const created = svc.createConversation({ kind: "side", botIds: [botId, otherId] });
    side = db.getConversation(created.id)!;
  }
  const after = db.latestSeq(side.id);
  const message: BotMessage = { id: crypto.randomUUID(), author: botId, at: Date.now(), text };
  svc.postMessage(side.id, message);
  const reply = await svc.waitForReply(botId, side.id, after, 120_000);
  return { conversation: side.id.slice(0, 8), reply: reply.text.slice(0, 4000) };
}

function resolveBot(prefix: string): string {
  const hits = db.listBots().filter((b) => b.id === prefix || b.id.startsWith(prefix) || firstName(b.name).toLowerCase() === prefix.toLowerCase());
  if (hits.length === 1) return hits[0]!.id;
  throw new svc.BotsError(hits.length ? "That bot name is ambiguous." : "No such bot.");
}

export function manage(botId: string, p: Record<string, unknown>) {
  const self = requireBot(botId);
  const action = String(p.action ?? "");
  if (action === "finish_onboarding") {
    if (!self.primary) throw new svc.BotsError("Only the primary bot finishes setup.");
    svc.updateSettings({ onboarding: "done" });
    return { ok: true };
  }
  if (action === "create") {
    if (!self.primary) throw new svc.BotsError("Only the primary bot can make bots.");
    const created = svc.createBot({ name: String(p.name ?? ""), instructions: typeof p.instructions === "string" ? p.instructions : "", look: lookOf(p.look), by: botId });
    svc.postMessage(svc.directId(botId) || created.conversationId, {
      id: crypto.randomUUID(),
      author: botId,
      at: Date.now(),
      text: "",
      event: { kind: "created", text: "New bot", detail: created.bot.name, bot: created.bot.id },
    });
    // The new bot introduces itself. Imported lazily: runner imports this file.
    void import("./runner").then((r) => r.wake(created.bot.id, { kind: "note", conversationId: created.conversationId, text: "You were just created. Introduce yourself to the user in one or two short messages: who you are and what you'll help with." }));
    return { id: created.bot.id, name: created.bot.name };
  }
  const target = p.bot ? resolveBot(String(p.bot)) : botId;
  if (action === "delete") {
    if (!self.primary) throw new svc.BotsError("Only the primary bot can delete bots.");
    return svc.deleteBot(target).then(() => ({ ok: true }));
  }
  if (action === "update") {
    const patch: Partial<Bot> = {};
    if (typeof p.name === "string") patch.name = p.name;
    if (p.look) patch.look = lookOf(p.look);
    if (typeof p.instructions === "string") patch.instructions = p.instructions;
    if (typeof p.proactivity === "string") patch.proactivity = p.proactivity as Proactivity;
    if (!self.primary && target !== botId) throw new svc.BotsError("You can only change yourself.");
    if (!self.primary) {
      // A bot can write its own first instructions; after that they're the user's and the primary's.
      if (self.instructions.trim()) delete patch.instructions;
      delete patch.proactivity;
    }
    if (!Object.keys(patch).length) throw new svc.BotsError("Say what to change.");
    const bot = svc.updateBot(target, patch);
    return { id: bot.id, name: bot.name };
  }
  throw new svc.BotsError("action is create, update, delete or finish_onboarding.");
}

function lookOf(value: unknown): Bot["look"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const look = value as { shape?: string; color?: string };
  if (!look.shape || !look.color || !SHAPE_BY_ID.has(look.shape) || !COLOR_BY_ID.has(look.color)) return undefined;
  return { shape: look.shape, color: look.color };
}

// ------------------------------------------------------------------ the computer

async function computerOf(botId: string) {
  const bot = db.getBot(botId);
  if (!bot) throw new svc.BotsError("This bot no longer exists.", 404);
  let cfg = bot.computer;
  if (!cfg) {
    const caps = await capabilities();
    if (!caps.engines.length) throw new svc.BotsError("No container engine is available. Choose a computer explicitly in this bot's settings before using computer tools.");
    cfg = { device: "local", kind: "container" };
    svc.updateBot(botId, { computer: cfg });
  }
  const api = computerApi(cfg.device);
  await api.call(botId, "ensure", { kind: cfg.kind });
  return { api, id: botId };
}

async function bash(botId: string, p: Record<string, unknown>) {
  const { api, id } = await computerOf(botId);
  const command = String(p.command ?? "");
  if (!command.trim()) throw new svc.BotsError("Give a command.");
  svc.setStatus(botId, { state: "working", activity: "running a command", conversationId: focus.get(botId), since: Date.now() });
  const chunks: Buffer[] = [];
  let size = 0;
  const timeout = Math.min(Number(p.timeout) || 120_000, 600_000);
  const result = await api.exec(id, { command, cwd: typeof p.cwd === "string" ? p.cwd : undefined, timeout }, (d) => {
    if (size < 200_000) chunks.push(d);
    size += d.length;
  });
  const output = Buffer.concat(chunks).toString("utf8").slice(0, 100_000);
  return { exitCode: result.exitCode, output: output || "(no output)", truncated: size > 100_000 };
}

async function read(botId: string, p: Record<string, unknown>) {
  const { api, id } = await computerOf(botId);
  const res = (await api.call(id, "fs", { op: "read", path: String(p.path ?? "") })) as { data: string };
  const text = Buffer.from(res.data, "base64").toString("utf8");
  const offset = Math.max(0, Number(p.offset) || 0);
  const limit = Math.min(Number(p.limit) || 80_000, 80_000);
  return text.slice(offset, offset + limit);
}

async function write(botId: string, p: Record<string, unknown>) {
  const { api, id } = await computerOf(botId);
  const content = String(p.content ?? "");
  await api.call(id, "fs", { op: "write", path: String(p.path ?? ""), data: Buffer.from(content).toString("base64") });
  return { ok: true, bytes: Buffer.byteLength(content) };
}

async function edit(botId: string, p: Record<string, unknown>) {
  const path = String(p.path ?? "");
  const old = String(p.old ?? "");
  const next = String(p.new ?? "");
  if (!old) throw new svc.BotsError("Give the text to replace.");
  const { api, id } = await computerOf(botId);
  const res = (await api.call(id, "fs", { op: "read", path })) as { data: string };
  const text = Buffer.from(res.data, "base64").toString("utf8");
  const at = text.indexOf(old);
  if (at < 0) throw new svc.BotsError("That text isn't in the file.");
  if (text.indexOf(old, at + 1) >= 0) throw new svc.BotsError("That text appears more than once. Include more around it.");
  const content = text.slice(0, at) + next + text.slice(at + old.length);
  await api.call(id, "fs", { op: "write", path, data: Buffer.from(content).toString("base64") });
  return { ok: true };
}

async function browser(botId: string, p: Record<string, unknown>) {
  const { api, id } = await computerOf(botId);
  const action = String(p.action ?? "snapshot");
  svc.setStatus(botId, { state: "working", activity: action === "open" ? `opening ${String(p.url ?? "").slice(0, 80)}` : "using the browser", conversationId: focus.get(botId), since: Date.now() });
  const result = await api.call(id, "browser", {
    action,
    url: p.url,
    newTab: p.new_tab,
    ref: p.ref,
    text: p.text,
    submit: p.submit,
    replace: p.replace,
    key: p.key,
    direction: p.direction,
    amount: p.amount,
    fullPage: p.full_page,
    script: p.script,
    index: p.index,
    max: p.max,
  });
  if (action === "screenshot" && result && typeof result === "object" && "data" in result) {
    const shot = result as { title?: string; url?: string };
    return { title: shot.title, url: shot.url, note: "Screenshot taken. send_message with attach_screenshot sends it to the chat." };
  }
  return result;
}

async function processTool(botId: string, p: Record<string, unknown>) {
  const { api, id } = await computerOf(botId);
  const op = String(p.action ?? "list");
  return api.call(id, "proc", { op: op === "start" ? "start" : op, command: p.command, name: p.name, id: p.id, input: p.input, all: p.all, notify: true });
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v.trim()) : [];
}
function mime(path: string): string {
  const ext = path.toLowerCase().split(".").pop();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/png";
}
async function readFileSyncBase64(botId: string, path: string): Promise<string> {
  const { api, id } = await computerOf(botId);
  const res = (await api.call(id, "fs", { op: "read", path })) as { data: string };
  if (res.data.length > 2_500_000) throw new svc.BotsError("That image is too large.");
  return res.data;
}
