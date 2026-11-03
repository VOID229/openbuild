// OpenBots' data, shared by the server (server/bots/) and the app (src/lib/bots/). The server owns
// it: bots, the conversations they're in, their memory, routines and computers. The app gets a
// snapshot and then a stream of changes (`BotsEvent`) from /api/bots/stream.
import type { BotLook } from "../src/lib/bots/looks";

export type { BotLook };

export interface MemoryItem {
  id: string;
  text: string;
  at: number;
  /** "me" when the user added it; otherwise the bot that did (itself, or the primary). */
  by?: string;
}

/**
 * Something a bot does on its own: a routine on a schedule ("Weekdays at 8:00"), or a follow-up it
 * set itself ("in 2 hours"), which runs once.
 */
export interface Routine {
  id: string;
  title: string;
  /** How it repeats, as the user (or bot) said it. */
  schedule: string;
  enabled: boolean;
  /** What to do, when the title alone doesn't say. */
  task?: string;
  /** Where it reports. The bot's chat with the user when unset. */
  conversationId?: string;
  /** A follow-up the bot set for itself: runs once, then it's gone. */
  followUp?: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  /** "me", or the bot that made it. */
  by?: string;
  createdAt?: number;
}

/** How often a bot looks in on its own, with nobody messaging it: to follow up, or tell you something. */
export type Proactivity = "off" | "low" | "normal" | "high";
export const PROACTIVITY: Record<Proactivity, { label: string; hours: number }> = {
  off: { label: "Only when asked", hours: 0 },
  low: { label: "A couple of times a day", hours: 8 },
  normal: { label: "Every few hours", hours: 3 },
  high: { label: "About hourly", hours: 1 },
};

/** Where a bot's computer runs and how it's kept apart from the rest of the machine. */
export interface ComputerConfig {
  /** "local" (this server), or a paired device's id. */
  device: string;
  /** A container (Podman or Docker), or a folder on the machine with no isolation. */
  kind: "container" | "host";
}

export interface BotStatus {
  state: "idle" | "working" | "error";
  /** What it's doing right now, as a short phrase ("browsing example.com"). */
  activity?: string;
  /** The conversation it's working in. */
  conversationId?: string;
  /** Working, but nothing to show in the chat yet (a reaction it may let be, or tidying up after a reply). */
  quiet?: boolean;
  error?: string;
  since?: number;
}

export interface Bot {
  id: string;
  name: string;
  look: BotLook;
  /** The bot in charge of the others. Exactly one bot is primary. */
  primary?: boolean;
  /** What the bot is for and how it should behave. */
  instructions: string;
  /** Things the bot keeps across conversations. */
  memory: MemoryItem[];
  routines: Routine[];
  createdAt: number;
  /** "provider/model"; the OpenBots default when unset. */
  model?: string;
  effort?: string;
  proactivity?: Proactivity;
  computer?: ComputerConfig;
  /** Who made it: "me", or the primary bot's id. */
  by?: string;
}

/** "me" is the user; anything else is a bot's id. */
export type Author = "me" | (string & {});

export interface Reaction {
  emoji: string;
  by: Author;
  at: number;
}

export interface Question {
  title: string;
  hint?: string;
  options: { key: string; label: string }[];
  /** The key of the option the user picked, or what they typed instead. */
  answer?: string;
}

export interface PlanStep {
  text: string;
  /** The bot doing it. */
  bot: string;
  status: "todo" | "doing" | "done";
}

export type EventKind = "routine" | "memory" | "joined" | "left" | "renamed" | "created" | "changed" | "error" | "computer";

export interface BotMessage {
  id: string;
  author: Author;
  at: number;
  text: string;
  images?: string[];
  /** The message this one answers. */
  replyTo?: string;
  reactions?: Reaction[];
  /** Something that happened rather than something said ("Created routine …"), shown as a centred line. */
  event?: { kind: EventKind; text: string; detail?: string };
  /** A bot asking the user to pick. */
  question?: Question;
  /** A bot laying out who does what. */
  plan?: { title: string; steps: PlanStep[] };
  /** For the user's messages: the bots that have read it. */
  seenBy?: string[];
}

/**
 * A chat with one bot, a group of bots, or a side chat between bots that the user can read along.
 * A bot's direct conversation is how the sidebar lists the bot itself.
 */
export type ConversationKind = "direct" | "group" | "side";

export interface Conversation {
  id: string;
  kind: ConversationKind;
  botIds: string[];
  /** Groups are named; direct and side chats take their bots' names. */
  name?: string;
  /** For groups: what the group is working towards. */
  instructions?: string;
  /** When it was pinned, for the order of the pinned tiles. */
  pinnedAt?: number;
  hidden?: boolean;
  unread?: boolean;
  /** A section the user filed it under. */
  section?: string;
  createdAt: number;
  updatedAt: number;
  messages: BotMessage[];
  /** Older messages exist on the server than the ones here. */
  more?: boolean;
}

export interface BotsSettings {
  /** "provider/model" for bots without their own. Pi's default when unset. */
  defaultModel?: string;
  /** Bots don't look in on their own between these hours (24h clock, server time). */
  quietHours: { from: number; to: number };
  /** The user, as bots know them. */
  user?: { name?: string; context?: string };
  /** Sections the user made in the sidebar, in order. */
  sections: string[];
  /** Bots may react to messages with emoji. */
  reactions: boolean;
  /** The primary bot is still welcoming the user (naming itself, setting up bots). */
  onboarding?: "active" | "done";
}

/** What a bot replies when it has nothing to say. Never shown in a chat. */
export const isSilent = (text: string) => text.trim().toLowerCase() === "[silent]";

/** A bot's plain reply as chat bubbles, one per paragraph. */
export const replyBubbles = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s && !isSilent(s))
    .slice(0, 6);

export const DEFAULT_SETTINGS: BotsSettings = { quietHours: { from: 22, to: 8 }, sections: [], reactions: true };

/** A bot that's streaming a message into a conversation: the text so far. */
export interface Draft {
  conversationId: string;
  botId: string;
  text: string;
}

export interface BotsSnapshot {
  bots: Bot[];
  conversations: Conversation[];
  settings: BotsSettings;
  status: Record<string, BotStatus>;
  typing: Record<string, string[]>;
  drafts: Draft[];
}

export type BotsEvent =
  | ({ t: "snapshot" } & BotsSnapshot)
  | { t: "bot"; bot: Bot }
  | { t: "bot-deleted"; id: string }
  | { t: "conversation"; conversation: Omit<Conversation, "messages"> }
  | { t: "conversation-deleted"; id: string }
  | { t: "message"; conversationId: string; message: BotMessage }
  | { t: "message-deleted"; conversationId: string; id: string }
  | { t: "typing"; conversationId: string; botIds: string[] }
  | { t: "draft"; draft: Draft; done?: boolean }
  | { t: "status"; botId: string; status: BotStatus }
  | { t: "pulse"; botId: string; mood?: string }
  | { t: "settings"; settings: BotsSettings };

// ------------------------------------------------------------------ computers

export interface ComputerCapabilities {
  device: string;
  /** Container engines that work here, best first. */
  engines: ("podman" | "docker")[];
  /** A Chromium for host computers' browsers. */
  hostBrowser: boolean;
  /** The container image bots' computers use. */
  image: "missing" | "building" | "ready" | "failed";
  imageLog?: string;
}

export interface ComputerInfo {
  id: string;
  kind: "container" | "host";
  device: string;
  state: "stopped" | "starting" | "running" | "error";
  error?: string;
  /** The bot's home folder, as seen inside the computer. */
  home: string;
  /** Container engine, for containers. */
  engine?: string;
  browser?: { running: boolean; tabs: { title: string; url: string; active: boolean }[] };
  procs: ProcInfo[];
}

export interface ProcInfo {
  id: string;
  name: string;
  command: string;
  state: "running" | "exited";
  exitCode?: number | null;
  startedAt: number;
  endedAt?: number;
}

export interface FileEntry {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
}

// ------------------------------------------------------------------ helpers

export const isBotId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(id);

/** A bot's first name: "Juniper · notes" → "Juniper". */
export const firstName = (name: string) => name.split(" · ")[0]!.split(/\s+/)[0]!;

/** A conversation's name: the group's, the bot's, or both bots' for a side chat. */
export function conversationTitle(c: Pick<Conversation, "kind" | "name" | "botIds">, bots: Pick<Bot, "id" | "name">[]): string {
  if (c.kind === "group") return c.name || "Untitled group";
  const names = c.botIds.map((id) => bots.find((b) => b.id === id)?.name ?? "Deleted bot");
  return c.kind === "side" ? names.map((n) => n.split(" · ")[0]).join(" & ") : (names[0] ?? "Bot");
}
