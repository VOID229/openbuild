// Minions: a bot's temporary workers, in place of the coding agent threads it used to start.
//
// A bot hands one task to a minion with its `minion` tool and carries on. The minion is a bot like any
// other to the harness (a record, a session, a turn in the runner, tool calls through the same door)
// and differs by its prompt alone: do the task, sum up the result, send it back. The bot that made it
// is its owner. The minion talks only to its owner, in the one side chat they share. Its owner closes
// it when the work is done and can reopen it for more; the primary bot can close and reopen any bot's
// minions. A closed minion runs nothing (runner.ts drops its wakes, service.ts refuses its chat, and
// every call of its own is refused here), and one closed for a week is deleted (service.ts).
//
// "Closed", not "retired": a retired bot is a team member the user paused (Bot.retiredAt). The tool
// still takes retire and retired: true, the words KodBot's minions use.
//
// This file is the tool, the two prompts (the minion's, and what an owner is told) and what a minion
// may call. Making, closing, reopening and waking are the service's (service.ts, "minions").
import { fitWords, liveMinion, mayCreateMinions, mentionName, MINION_LIMIT, MINION_TOOLS, type Bot } from "../../shared/bots";
import * as db from "./db";
import * as svc from "./service";

const short = (id: string) => id.slice(0, 8);

/** What `openbuild start` answers a bot now: where that work goes instead. */
export const NO_THREAD_START = "Bots don't start coding agent threads any more: Build is the user's own. Hand the work to a minion instead: minion start, with the whole task and a name for what it does.";

/**
 * The minions `botId` may name, closed ones too: its own, and every bot's for the primary, which runs
 * the team. None of another bot's, for any other bot.
 */
function reachable(botId: string): db.StoredBot[] {
  const all = db.listBots().filter((b) => b.minion);
  if (db.getBot(botId)?.primary) return all;
  return all.filter((b) => b.minion!.owner === botId);
}

/** One of the minions the bot may name, by short id or name. */
function findMinion(botId: string, ref: unknown): db.StoredBot {
  const wanted = String(ref ?? "").trim().replace(/^@/, "").toLowerCase();
  if (!wanted) throw new svc.BotsError("Say which minion: its short id or name, from minion list.");
  const mine = reachable(botId);
  const byId = mine.filter((b) => b.id === wanted || (wanted.length >= 6 && b.id.startsWith(wanted)));
  const hits = byId.length ? byId : mine.filter((b) => [b.name, mentionName(b.name)].some((n) => n.toLowerCase() === wanted));
  if (hits.length === 1) return hits[0]!;
  throw new svc.BotsError(hits.length ? "That minion name is ambiguous. Use its short id." : "You have no such minion. minion list shows yours.", hits.length ? 400 : 404);
}

function view(bot: db.StoredBot, botId: string, names: Map<string, string>) {
  const { owner, task, chat, closedAt } = bot.minion!;
  return {
    minion: short(bot.id),
    name: bot.name,
    // The primary sees every bot's: whose each one is.
    ...(owner !== botId ? { owner: names.get(owner) ?? "a deleted bot" } : {}),
    task: fitWords(task, 160),
    state: closedAt ? "closed" : svc.getStatus(bot.id)?.state === "working" ? "working" : "idle",
    conversation: short(chat),
  };
}

/**
 * The `minion` tool, for the bot that calls it: start one on a task, list them, write to one, or close
 * or reopen one. `from`: the chat the bot is working in, where a minion's answer wakes it.
 */
export function tool(botId: string, p: Record<string, unknown>, from?: string): unknown {
  const action = String(p.action ?? "");
  if (action === "start") {
    const { bot, conversationId } = svc.createMinion(botId, { task: String(p.task ?? ""), name: typeof p.name === "string" ? p.name : undefined, from: from ?? svc.homeId(botId) });
    return {
      minion: short(bot.id),
      name: bot.name,
      conversation: short(conversationId),
      note: "Started, with your task as its first message. Don't wait for it: carry on, or end this turn with a short line to the user if they should know. What it writes wakes you here. Close it with minion close once its work is done.",
    };
  }
  if (action === "list") {
    const all = p.closed === true || p.retired === true;
    const shown = reachable(botId).filter((b) => all || liveMinion(b));
    const names = new Map(db.listBots().map((b) => [b.id, mentionName(b.name)]));
    return { minions: shown.map((b) => view(b, botId, names)), limit: MINION_LIMIT, ...(shown.length ? {} : { note: all ? "There are no minions." : "No minions are open now. closed: true lists the closed ones." }) };
  }
  if (action === "send") {
    const bot = findMinion(botId, p.minion);
    if (bot.minion!.owner !== botId) throw new svc.BotsError("Only its owner writes to a minion. You can close or reopen it.", 403);
    const text = String(p.text ?? "").trim().slice(0, 8000);
    if (!text) throw new svc.BotsError("Say what to tell it, in text.");
    // Refused for a closed minion (service.ts postMessage): it's reopened first.
    svc.postMessage(bot.minion!.chat, { id: crypto.randomUUID(), author: botId, at: Date.now(), text }, { from });
    return { minion: short(bot.id), note: "Sent. Don't wait for it: carry on or end this turn. What it writes wakes you." };
  }
  if (action === "close" || action === "retire") {
    const bot = findMinion(botId, p.minion);
    if (bot.minion!.closedAt) return { minion: short(bot.id), note: "It's closed already." };
    svc.closeMinion(botId, bot.id);
    return { minion: short(bot.id), closed: true, note: "Closed: it stopped where it was. Reopen it with minion reopen if it's needed again; a minion closed for a week is deleted." };
  }
  if (action === "reopen") {
    const bot = findMinion(botId, p.minion);
    if (!bot.minion!.closedAt) return { minion: short(bot.id), note: "It's open already." };
    svc.reopenMinion(botId, bot.id);
    const own = bot.minion!.owner === botId;
    return { minion: short(bot.id), reopened: true, note: own ? "Reopened, with its chat as it was. Write to it with minion send." : "Reopened. Its owner was told, and writes to it." };
  }
  throw new svc.BotsError("action is start, list, send, close or reopen.");
}

/**
 * A minion's whole context, in place of a bot's (agent.ts contextSections): who it works for, the one
 * task, the report, and whose computers it's on. No team, memory, routines or chats: it has none.
 */
export function sections(bot: Bot): Record<string, string> {
  const owner = db.getBot(bot.minion!.owner);
  const boss = owner ? mentionName(owner.name) : "your owner";
  const user = svc.getSettings().user?.name || "the user";
  const lines = [
    `You are ${bot.name}, a minion in OpenBots: a temporary worker that ${boss}, one of ${user}'s bots, made for one task. ${boss} is your owner: the only one you talk to, in the one conversation you have. You can't reach ${user} or any other bot, and none of them can reach you.`,
    `Do the task ${boss} gave you: all of it, and nothing else. When it's done, send ${boss} one send_message that sums up the result, so it can act on it without asking again: what you found or did, the exact facts (paths, commands, numbers, links), and what failed or is still open. If you can't do it, or it needs a decision that is ${boss}'s, say that in a message instead of guessing. Every message you send wakes ${boss}, so send no progress notes: one report when you're done, or one question when you're stuck.`,
    `After your report your work is over until ${boss} writes again: what it asks then is more of the same task, done and reported the same way. ${boss} closes you once it needs nothing more, and may reopen you later for more of the same. You keep nothing but this conversation.`,
    "Every tool with a status parameter needs a short custom status (a few plain words, at most 50 characters) naming what the call is for. A tool call that runs long carries on as a background job: you get its number at once and its result wakes you, so never wait on one or run it again.",
  ];
  return {
    openbots: lines.join("\n\n"),
    openbots_machines: `You work on ${boss}'s computers, not ones of your own: on each machine below, its home folder, files and terminal (bash, read, write, edit). ${boss} and its other minions may be working there too, so change only what your task is about, and say in your report where you put what you made. Opening a pull request is yours to do when the task asks for one; merging it is ${boss}'s call, with the user's.`,
  };
}

/**
 * What a bot's own context says of minions (a section of its own, so making or closing one re-sends
 * only this): the ones it has now, and nothing when it has none. That it can make them isn't said
 * here on every turn: the minion tool's line in load_tools' catalog says so, and its description the rest.
 */
export function brief(bot: Pick<Bot, "id" | "spawnMinions" | "minion" | "retiredAt">): string {
  if (!mayCreateMinions(bot)) return "";
  const mine = svc.minionsOf(bot.id);
  if (!mine.length) return "";
  return `Your minions now (minion send writes to one, minion close ends one whose work is done):\n${mine.map((m) => `- ${mentionName(m.name)} (${short(m.id)}): ${fitWords(m.minion!.task, 100)}`).join("\n")}`;
}

/** Calls every bot's Pi makes for itself, whatever its tools: its context, and the notes that ride with a tool it loads. */
const PLUMBING = ["context", "tool_notes"];

/**
 * Why a call of a minion's is refused, or nothing when it may run (and nothing for a bot that isn't
 * one). A minion has MINION_TOOLS and writes only in its chat with its owner; a closed one has nothing.
 */
export function refusal(bot: Pick<Bot, "minion"> | undefined, method: string, p: Record<string, unknown>): string | undefined {
  const minion = bot?.minion;
  if (!minion || PLUMBING.includes(method)) return undefined;
  if (minion.closedAt) return "You are closed: your owner needs nothing more from you for now, and you run nothing.";
  if (!MINION_TOOLS.includes(method)) return `You're a minion: ${method} isn't one of your tools. Do your task with the ones you have, and say in your report what you couldn't do.`;
  if (method === "send_message") {
    if (typeof p.conversation === "string" && p.conversation && !minion.chat.startsWith(p.conversation)) return "You're a minion: you write only to your owner, in this conversation.";
    if (p.attach_screenshot) return "You're a minion: you have no browser to take a screenshot with. Send a file with images instead, or describe it.";
  }
  if (method === "apps" && p.action === "connect") return "You're a minion: you can't show the user a card. Say in your report which app needs connecting.";
  return undefined;
}
