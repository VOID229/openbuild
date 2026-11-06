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

export type BotProjectScope = "all" | "choose" | "exclude";

/** What a bot may do with the user's OpenBuild threads. Only the user can change this. */
export interface BotThreadAccess {
  enabled: boolean;
  /** Which projects it can work in. Grants from before this existed have none, and mean "choose". */
  scope?: BotProjectScope;
  /** "choose": the projects it can work in, by id. */
  projects: string[];
  /** "exclude": the projects it can't work in, by id. */
  excluded?: string[];
  /** It picks each thread's permission mode. Otherwise threads get the harness's default from BotsSettings. */
  choosePermission?: boolean;
  /** It can answer permission prompts, not just the questions threads ask. */
  approve?: boolean;
  /** It can merge pull requests. */
  merge?: boolean;
  /** It can control threads it didn't start: the user's and other bots'. Otherwise it can only see them. */
  others?: boolean;
}

/** Whether a grant covers a project. Something that isn't in a project is never covered. */
export function coversProject(access: Pick<BotThreadAccess, "scope" | "projects" | "excluded">, projectId: string | undefined): boolean {
  if (!projectId) return false;
  if (access.scope === "all") return true;
  if (access.scope === "exclude") return !access.excluded?.includes(projectId);
  return access.projects.includes(projectId);
}

/** The harnesses with permission modes OpenBuild can set for a thread. */
export const PERMISSION_HARNESSES = ["codex", "cursor", "claude"] as const;
export type PermissionHarness = (typeof PERMISSION_HARNESSES)[number];

export interface BotHarnessSettings {
  /** Harnesses bots may not start threads with. */
  blocked?: string[];
  /** The mode a thread gets when its bot can't choose. Absent: the harness's own configured default. */
  permissions?: Partial<Record<PermissionHarness, string>>;
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
  /** Off when unset. */
  threads?: BotThreadAccess;
  /** Who made it: "me", or the primary bot's id. */
  by?: string;
}

/** "me" is the user; anything else is a bot's id. */
export type Author = "me" | (string & {});

export interface Reaction {
  emoji: string;
  by: Author;
  at: number;
  /** Older reactions have none; see reactionId. */
  id?: string;
  /** The reaction this one answers, by id, rather than the message itself. */
  to?: string;
}

export const reactionId = (r: Reaction) => r.id ?? String(r.at);

/** How many reactions deep this one is: 0 on the message, 1 answering a reaction, and so on. */
export function reactionDepth(list: Reaction[], r: Reaction): number {
  let depth = 0;
  for (let at = r; at.to && depth < list.length; depth++) {
    const up = list.find((x) => reactionId(x) === at.to);
    if (!up) break;
    at = up;
  }
  return depth;
}

/** Adds or takes back `by`'s emoji (on the message, or answering reaction `to`). Taking one back takes its answers with it. */
export function toggleReactionIn(list: Reaction[], emoji: string, by: Author, to?: string): { next: Reaction[]; added?: Reaction } {
  const had = list.find((r) => r.by === by && r.emoji === emoji && r.to === to);
  if (!had) {
    const added: Reaction = { id: Math.random().toString(36).slice(2, 10), emoji: emoji.slice(0, 16), by, at: Date.now(), ...(to ? { to } : {}) };
    return { next: [...list, added], added };
  }
  const gone = new Set([reactionId(had)]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of list) if (r.to && gone.has(r.to) && !gone.has(reactionId(r))) gone.add(reactionId(r)), (grew = true);
  }
  return { next: list.filter((r) => !gone.has(reactionId(r))) };
}

export interface Question {
  title: string;
  hint?: string;
  options: { key: string; label: string }[];
  /** The key of the option the user picked, or what they typed instead. */
  answer?: string;
  /** A first-run offer the server acts on itself when the user takes it: "team" makes the starter team. */
  offer?: "team";
}

/** Up to A–J. */
export const POLL_OPTIONS = 10;

export interface PollVote {
  by: Author;
  /** The options picked: one, or any number if the poll takes several. */
  keys: string[];
  at: number;
}

/** A question for a whole group, from the user or a bot, that everyone answers. */
export interface Poll {
  question: string;
  /** Voters can pick several options rather than one. */
  multiple?: boolean;
  options: { key: string; label: string }[];
  votes: PollVote[];
  /** Nobody sees others' answers until they've answered themselves, or the poll closes. */
  blind?: boolean;
  /** When everyone it asks had answered. Answers can still change, but not be taken back. */
  closedAt?: number;
}

/** A new poll: blank and repeated options dropped, the rest lettered A, B, C… */
export function makePoll(question: string, labels: string[], { multiple, blind }: { multiple?: boolean; blind?: boolean } = {}): Poll {
  const seen = new Set<string>();
  const unique = labels
    .map((label) => label.trim().slice(0, 200))
    .filter((label) => label && !seen.has(label.toLowerCase()) && seen.add(label.toLowerCase()))
    .slice(0, POLL_OPTIONS);
  return { question: question.trim().slice(0, 300), ...(multiple ? { multiple: true } : {}), ...(blind ? { blind: true } : {}), options: unique.map((label, i) => ({ key: String.fromCharCode(65 + i), label })), votes: [] };
}

/** `by`'s vote replaced with `keys`. No keys takes the vote back. */
export function castVote(poll: Poll, by: Author, keys: string[]): Poll {
  const picked = poll.options.map((o) => o.key).filter((key) => keys.includes(key));
  const rest = poll.votes.filter((v) => v.by !== by);
  return { ...poll, votes: picked.length ? [...rest, { by, keys: poll.multiple ? picked : picked.slice(0, 1), at: Date.now() }] : rest };
}

/** Who a poll is still waiting on: the other bots in the group, and the user if a bot asked. */
export function pollWaitingOn(poll: Poll, author: Author, botIds: string[]): Author[] {
  const asked = [...botIds.filter((id) => id !== author), ...(author === "me" ? [] : ["me"])];
  return asked.filter((id) => !poll.votes.some((v) => v.by === id));
}

export const pollVotesVisible = (poll: Poll, viewer: Author) => !poll.blind || !!poll.closedAt || poll.votes.some((v) => v.by === viewer);

export interface PlanStep {
  text: string;
  /** The bot doing it. */
  bot: string;
  status: "todo" | "doing" | "done";
}

export type EventKind = "routine" | "memory" | "joined" | "left" | "renamed" | "created" | "changed" | "error" | "computer" | "poll" | "thread";

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
  event?: { kind: EventKind; text: string; detail?: string; /** The OpenBuild thread this activity concerns. */ threadId?: string; /** The bot the event is about, shown as a link to its thread. */ bot?: string };
  /** A bot asking the user to pick. */
  question?: Question;
  /** A bot laying out who does what. */
  plan?: { title: string; steps: PlanStep[] };
  /** A poll for the group. */
  poll?: Poll;
  /** A bot offering an app for the user to connect, by its catalog id. */
  connect?: { app: string };
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
  /** The primary bot is still welcoming the user (naming itself, setting up bots). */
  onboarding?: "active" | "done";
  /** SearXNG instances for bot_web_search, in priority order. Other providers' keys live in the vault. */
  searxng?: string[];
  /** The user's own Pi extensions and packages to load into bots as well. All off until picked. */
  customExtensions?: { enabled: boolean; ids: string[] };
  /** How bots' OpenBuild threads use each harness. */
  harnesses?: BotHarnessSettings;
}

/** One of the user's Pi extensions or packages, as Settings → Bots lists them. */
export interface BotExtension {
  id: string;
  name: string;
  description?: string;
  kind: "extension" | "package";
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

export const DEFAULT_SETTINGS: BotsSettings = { quietHours: { from: 22, to: 8 }, sections: [] };

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
  | { t: "settings"; settings: BotsSettings }
  /** The connected apps changed: ask /api/bots/apps for them. */
  | { t: "apps" };

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

/** The name an @mention uses: "Dr Eggbot · notes" → "Dr Eggbot". */
export const mentionName = (name: string) => name.split(" · ")[0]!.trim();

/**
 * Where each @mention of a bot sits in some text. The full name wins ("@Dr Eggbot"),
 * and the first name alone ("@Dr") still counts, as bots and older messages write it.
 */
export function findMentions<B extends Pick<Bot, "name">>(text: string, bots: B[]): { start: number; end: number; bot: B }[] {
  const names = bots
    .flatMap((bot) => [mentionName(bot.name), firstName(bot.name)].filter(Boolean).map((name, i) => ({ name: name.toLowerCase(), bot, full: i === 0 })))
    // Longest first; on a tie, a bot's whole name beats another's first name.
    .sort((a, b) => b.name.length - a.name.length || Number(b.full) - Number(a.full));
  const lower = text.toLowerCase();
  const out: { start: number; end: number; bot: B }[] = [];
  for (let i = lower.indexOf("@"); i !== -1; i = lower.indexOf("@", i + 1)) {
    if (i > 0 && /[\p{L}\d_]/u.test(text[i - 1]!)) continue; // an email address
    const hit = names.find(({ name }) => lower.startsWith(name, i + 1) && !/[\p{L}\d_-]/u.test(text[i + 1 + name.length] ?? ""));
    if (!hit) continue;
    out.push({ start: i, end: i + 1 + hit.name.length, bot: hit.bot });
    i += hit.name.length;
  }
  return out;
}

/**
 * Every @mention in some text, in order: bots as findMentions finds them, and "@all" or "@everyone",
 * which have no `bot` because they name the whole conversation. They beat a bot called "All", but
 * "@All Stars" is still that bot.
 */
export function findTags<B extends Pick<Bot, "name">>(text: string, bots: B[]): { start: number; end: number; bot?: B }[] {
  const named = findMentions(text, bots);
  const all = [...text.matchAll(/(?<![\p{L}\d_])@(?:all|everyone)(?![\p{L}\d_-])/giu)]
    .map((m) => ({ start: m.index, end: m.index + m[0].length }))
    .filter((a) => !named.some((m) => m.start === a.start && m.end > a.end));
  return [...named.filter((m) => !all.some((a) => a.start === m.start)), ...all].sort((a, b) => a.start - b.start);
}

/** A conversation's name: the group's, the bot's, or both bots' for a side chat. */
export function conversationTitle(c: Pick<Conversation, "kind" | "name" | "botIds">, bots: Pick<Bot, "id" | "name">[]): string {
  if (c.kind === "group") return c.name || "Untitled group";
  const names = c.botIds.map((id) => bots.find((b) => b.id === id)?.name ?? "Deleted bot");
  return c.kind === "side" ? names.map((n) => n.split(" · ")[0]).join(" & ") : (names[0] ?? "Bot");
}
