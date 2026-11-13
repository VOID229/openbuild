// OpenBots' data, shared by the server (server/bots/) and the app (src/lib/bots/). The server owns
// it: bots, the conversations they're in, their memory, routines and computers. The app gets a
// snapshot and then a stream of changes (`BotsEvent`) from /api/bots/stream.
import type { BotLook } from "../src/lib/bots/looks";
import type { FriendChat, FriendFrom, FriendSummary } from "./friends";
import type { BotToolGrants } from "./types";

export type { BotLook };

/**
 * A bot's memory comes in two kinds. Its profile is a small, capped set of lasting facts about the
 * user and how to work with them, and is always in its prompt. Its journal is dated history: only the
 * latest few entries are in the prompt, and search finds the rest.
 */
export type MemoryKind = "profile" | "journal";
export const MEMORY_KINDS: readonly MemoryKind[] = ["profile", "journal"];

/** Longest one fact runs: a sentence or two, not a document. */
export const MEMORY_TEXT_MAX = 500;
/** The profile's hard cap, in bytes of its prompt lines: a write past it is refused, not trimmed. */
export const PROFILE_MAX_BYTES = 1500;
/** How many of the newest journal entries are in the prompt. */
export const JOURNAL_RECENT = 5;

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  text: string;
  /** When it was written, or last confirmed by being written again. */
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

/**
 * Where a bot's one computer ran, from before bots reached every machine at once. Saved bots may
 * still carry it; it's kept as it was and never read. Each machine's isolation is set per machine
 * now (`BotsSettings.isolation`), and a tool call names its machine.
 */
export interface ComputerConfig {
  /** "local" (this server), or a paired device's id. */
  device: string;
  /** A container (Podman or Docker), or a folder on the machine with no isolation. */
  kind: "container" | "host";
}

export interface BotStatus {
  state: "idle" | "working" | "error";
  /**
   * What it's doing right now, as a short phrase: the live step ("Opening example.com", the status the
   * bot wrote for a tool call, "Writing a reply"), or plain working words between steps (WORKING_PHRASES).
   */
  activity?: string;
  /** The conversation it's working in. */
  conversationId?: string;
  /** The OpenBuild thread it's acting on right now (reading, messaging, stopping, closing…), by id or the prefix it named. */
  thread?: string;
  /** Working, but nothing to show in the chat yet (a reaction it may let be, or tidying up after a reply). */
  quiet?: boolean;
  /** Other conversations with messages it'll get to once it's free. They show it holding on, not silence. */
  waiting?: string[];
  /**
   * Woke for a group message and hasn't acted on it yet: every bot in a group reads each message and
   * decides whether it's theirs, so until one types or picks up a tool nothing shows of it, not even
   * its mascot. The chat stays silent while its bots decide.
   */
  deciding?: boolean;
  /** Of `waiting`, the groups whose messages it hasn't decided on yet: they don't show it holding on. */
  undecided?: string[];
  error?: string;
  /** The error is the provider's (every fallback's, say): kept whole, but not for the chat to show. */
  provider?: boolean;
  /**
   * Between turns, with this many tool calls still running in the background: `activity` names what
   * it's waiting on, in the conversation they were started from. It's free to take a message anywhere.
   */
  jobs?: number;
  /**
   * Between turns, waiting on this many OpenBuild threads it started or wrote to that are still
   * working: `activity` says which ("Waiting on <title>", or "Waiting on 3 threads"), in the
   * conversation it was in with them. It's free to take a message anywhere.
   */
  threads?: number;
  since?: number;
}

/** What a bot between turns says while OpenBuild threads it started or wrote to are still working. */
export function waitingOnThreads(titles: string[]): string | undefined {
  if (!titles.length) return undefined;
  if (titles.length > 1) return `Waiting on ${titles.length} threads`;
  const title = titles[0]!.replace(/\s+/g, " ").trim() || "a thread";
  return `Waiting on ${title.length > 40 ? `${title.slice(0, 39).trimEnd()}…` : title}`;
}

/** Between turns: free, and only waiting on background jobs or OpenBuild threads (BotStatus.jobs, .threads). */
export const betweenTurns = (status: Pick<BotStatus, "jobs" | "threads"> | undefined) => !!(status?.jobs || status?.threads);

/**
 * What a working bot's status says while no step of its own is live: the model is working out what to
 * do next, between a turn's start and its first step or from one step to the next. Plain working
 * words, and never a bare "Thinking". The runner moves on to the next one each time a step ends, so
 * the line changes the moment the step is over.
 */
export const WORKING_PHRASES = ["Working on it", "Getting it done", "Making progress", "Sorting it out", "Keeping at it"] as const;
export const workingPhrase = (n = 0): string => WORKING_PHRASES[((Math.trunc(n) % WORKING_PHRASES.length) + WORKING_PHRASES.length) % WORKING_PHRASES.length]!;

/** The status while a bot's words are on their way to the chat: text it's streaming, or a message it's sending. */
export const WRITING_REPLY = "Writing a reply";

/** What a chat shows while a bot is typing a message into it: in the chat, its header and the sidebar's preview. */
export const TYPING = "Typing…";

/**
 * The line a working bot's status shows. One with no activity, or the "Thinking" a paired device's
 * older server still sends, reads as plain work.
 */
export function statusLine(status: Pick<BotStatus, "activity"> | undefined): string {
  const activity = status?.activity?.trim();
  return !activity || /^thinking(?:\.{3}|…)?$/i.test(activity) ? workingPhrase() : activity;
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
  /**
   * What the bot is for, in one short line (at most ROLE_MAX): what its teammates see of it in their
   * always-on roster, and what group lead-picking matches on. Empty or missing (bots from before it
   * existed): the first sentence of its instructions stands in (see roleLine).
   */
  role?: string;
  /** Things the bot keeps across conversations. */
  memory: MemoryItem[];
  routines: Routine[];
  createdAt: number;
  /** "provider/model"; the OpenBots default when unset. */
  model?: string;
  /** "provider/model"s to try in order when the model fails before replying. A provider can be one account of several ("openai-codex-2"). */
  fallbackModels?: string[];
  /** No fallbacks at all: neither its own list nor the defaults'. Without it, and with no list of its own, it follows the defaults'. */
  noFallbacks?: boolean;
  effort?: string;
  proactivity?: Proactivity;
  /** @deprecated Kept from before bots reached every machine; not used. */
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

/** How many questions one card steps through. */
export const QUESTION_STEPS = 5;

/** One question of a card that asks several. */
export interface QuestionStep {
  title: string;
  hint?: string;
  options: { key: string; label: string }[];
  /** The key of the option the user picked, or what they typed instead. Theirs alone until the card is submitted. */
  answer?: string;
}

export interface Question {
  title: string;
  hint?: string;
  options: { key: string; label: string }[];
  /** The key of the option the user picked, or what they typed instead. */
  answer?: string;
  /**
   * Every question of a card that asks several (two to {@link QUESTION_STEPS}), the first one
   * included: title, hint and options above repeat it. The user steps through them, and the
   * answers count only once the card is submitted.
   */
  steps?: QuestionStep[];
  /** A card of several questions was submitted: its answers are final, and the bot has them. */
  submitted?: boolean;
  /** A first-run question the server sets the choices of and acts on itself: "developer" asks whether the user writes code, "team" makes the starter team when taken. */
  offer?: "team" | "developer";
  /** The coding thread's question this card passes on, so the card closes when it's settled in the thread. */
  thread?: { id: string; ask: string };
  /**
   * Closed from its thread, where the question was settled first: "answered" there (answer holds what
   * was answered), or "gone" when the thread stopped waiting on it without an answer.
   */
  closed?: "answered" | "gone";
}

/** An answer as the user reads it: the picked option's label, or what they typed. */
export const answerLabel = (q: Pick<QuestionStep, "options" | "answer">): string | undefined => (q.answer === undefined ? undefined : (q.options.find((o) => o.key === q.answer)?.label ?? q.answer));

/** A submitted card's answers as the one message that delivers them: each under its number, paired with its question. */
export const answersText = (steps: QuestionStep[]): string => steps.map((s, i) => `${i + 1}. ${s.title} → ${answerLabel(s) ?? ""}`).join("\n");

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

export type StepStatus = "todo" | "doing" | "done";

export interface PlanStep {
  text: string;
  /** The bot doing it. */
  bot: string;
  status: StepStatus;
}

/**
 * One item of a conversation's to-do list: the steps of the work going on in a chat, kept by its bots
 * (the todo tool) and shown read-only in the chat's details, so its progress shows at a glance. Unlike a
 * plan message, which is a snapshot in the chat, the list belongs to the conversation and stays current.
 * It's temporary: it clears when bots clear it, when new work follows a finished list, and on its own
 * after a while (todoExpired).
 */
export interface TodoItem {
  id: string;
  text: string;
  status: StepStatus;
  /** The bot on it: whoever marked it doing (and then done). */
  bot?: string;
  /** Who added it. */
  by: Author;
  at: number;
}

export const TODO_LIMIT = 50;
export const TODO_TEXT_LIMIT = 200;
/** A to-do list is temporary: once every item is done, it clears this long after its last change. */
export const TODO_DONE_KEEP_MS = 30 * 60_000;
/** And a list nobody has touched for this long clears whatever state it's in. */
export const TODO_STALE_MS = 12 * 60 * 60_000;

/** Whether a list last changed at `updatedAt` has had its time, by `now`. */
export const todoExpired = (list: readonly TodoItem[], updatedAt: number, now = Date.now()) =>
  list.length > 0 && (now - updatedAt >= TODO_STALE_MS || (list.every((t) => t.status === "done") && now - updatedAt >= TODO_DONE_KEEP_MS));

/** A change to a to-do list, from a bot's todo tool or the user's details panel. */
export type TodoChange =
  | { action: "add"; items: string[]; /** The new items' ids, so the app's own copy matches the server's. */ ids?: string[] }
  | { action: "update"; id: string; status?: StepStatus; text?: string }
  | { action: "remove"; id: string }
  | { action: "clear"; which?: "done" | "all" };

const STEP_STATUSES: readonly StepStatus[] = ["todo", "doing", "done"];
export const isStepStatus = (s: unknown): s is StepStatus => STEP_STATUSES.includes(s as StepStatus);

/** The list after `change`, by `by`. Throws, saying why, when the change doesn't apply. */
export function applyTodo(list: TodoItem[], change: TodoChange, by: Author, now = Date.now(), newId: () => string = () => crypto.randomUUID()): TodoItem[] {
  const clean = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, TODO_TEXT_LIMIT);
  const find = (id: string) => {
    const item = list.find((t) => t.id === id);
    if (!item) throw new Error("No such item on the to-do list.");
    return item;
  };
  switch (change.action) {
    case "add": {
      const texts = (Array.isArray(change.items) ? change.items : []).map(clean).filter(Boolean);
      if (!texts.length) throw new Error("Write the item.");
      // New steps after a finished list start a new one: the old work is over.
      if (list.length && list.every((t) => t.status === "done")) list = [];
      if (list.length + texts.length > TODO_LIMIT) throw new Error(`A to-do list holds up to ${TODO_LIMIT} items. Clear the done ones first.`);
      const ids = Array.isArray(change.ids) ? change.ids : [];
      const taken = new Set(list.map((t) => t.id));
      const added = texts.map((text, i): TodoItem => {
        const given = ids[i];
        const id = isBotId(given) && !taken.has(given) ? given : newId();
        taken.add(id);
        return { id, text, status: "todo", by, at: now };
      });
      return [...list, ...added];
    }
    case "update": {
      const item = find(change.id);
      if (change.status !== undefined && !isStepStatus(change.status)) throw new Error("Status is todo, doing or done.");
      const text = change.text === undefined ? item.text : clean(change.text);
      if (!text) throw new Error("Write the item.");
      const status = change.status ?? item.status;
      // Whoever starts it is on it; back to to-do, nobody is.
      const bot = status === "todo" ? undefined : status !== item.status && by !== "me" ? by : item.bot;
      const next: TodoItem = { ...item, text, status, bot };
      if (!next.bot) delete next.bot;
      return list.map((t) => (t.id === item.id ? next : t));
    }
    case "remove":
      return list.filter((t) => t.id !== find(change.id).id);
    case "clear":
      return change.which === "done" ? list.filter((t) => t.status !== "done") : [];
    default:
      throw new Error("Unknown to-do change.");
  }
}

/** How far along a to-do list is. */
export const todoProgress = (list: readonly TodoItem[] | undefined) => ({ done: list?.filter((t) => t.status === "done").length ?? 0, total: list?.length ?? 0 });

/** A self-contained HTML page a bot showed in the chat (its html_render tool), drawn in a sandboxed frame. */
export interface BotPage {
  title: string;
  html: string;
  /** Its height in CSS pixels until it has loaded and measured itself. */
  height?: number;
}

export type EventKind = "routine" | "memory" | "joined" | "left" | "renamed" | "created" | "changed" | "error" | "computer" | "poll" | "thread" | "message" | "model";

/** A file the user attached, kept on the workspace's server and in each bot's home folder there. */
export interface BotFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Still in the sender's browser: attached but not sent, or uploading as its message goes out. Never stored. */
  local?: boolean;
}

/** A file waiting in a composer, among its pictures (data URLs): the same list holds both. */
const FILE_REF = "obfile:";
export const fileRef = (f: BotFile) => FILE_REF + JSON.stringify({ id: f.id, name: f.name, mime: f.mime, size: f.size, ...(f.local ? { local: true } : {}) });
export function parseFileRef(item: string): BotFile | undefined {
  if (!item.startsWith(FILE_REF)) return undefined;
  try {
    const f = JSON.parse(item.slice(FILE_REF.length));
    return typeof f?.id === "string" && typeof f.name === "string" ? { id: f.id, name: f.name, mime: String(f.mime ?? ""), size: Number(f.size) || 0, ...(f.local ? { local: true } : {}) } : undefined;
  } catch {
    return undefined;
  }
}
export const MAX_BOT_IMAGES = 4;
export const MAX_BOT_FILES = 10;
/** What a composer keeps of what was added: the first pictures and files up to each limit. */
export function capAttached(items: string[]): string[] {
  let images = 0;
  let files = 0;
  return [...new Set(items)].filter((item) => (item.startsWith(FILE_REF) ? ++files <= MAX_BOT_FILES : ++images <= MAX_BOT_IMAGES));
}

export interface BotMessage {
  id: string;
  author: Author;
  at: number;
  text: string;
  images?: string[];
  /** Files from the user that aren't pictures for the model: the bots open them on their computers. */
  files?: BotFile[];
  /** The message this one answers. */
  replyTo?: string;
  reactions?: Reaction[];
  /** Something that happened rather than something said ("Created routine …"), shown as a centred line. */
  event?: { kind: EventKind; text: string; detail?: string; /** The OpenBuild thread this activity concerns. */ threadId?: string; /** The pull request a merge concerns, on GitHub. */ pullUrl?: string; /** The bot the event is about, shown as a link to its thread. */ bot?: string; /** The between-bots conversation a message activity links to. */ conversationId?: string; /** A fallback switch: the "provider/model" it switched to. */ model?: string };
  /** A bot asking the user to pick. */
  question?: Question;
  /** A bot laying out who does what. */
  plan?: { title: string; steps: PlanStep[] };
  /** A page a bot showed: a chart, diagram, demo or small tool. */
  html?: BotPage;
  /** A poll for the group. */
  poll?: Poll;
  /** A bot offering an app for the user to connect, by its catalog id. */
  connect?: { app: string };
  /** For the user's messages: the bots that have read it. */
  seenBy?: string[];
  /** A message from a friend's server in a shared chat: who wrote it there. Its author is a friend author (shared/friends.ts). */
  from?: FriendFrom;
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
  /** A group shared with a friend's server: their bots and they are in it too. */
  friend?: FriendChat;
  /** A side chat a bot opened to work something out with others: see SideHuddle. */
  huddle?: SideHuddle;
  /** Its to-do list, which the server keeps apart from the record (db.ts) and adds to what it sends. */
  todos?: TodoItem[];
}

/**
 * A temporary side chat between several bots. The bot that opened it reports back to the chat it came
 * from; it closes once it reaches `limit` bot messages, goes quiet, or a member closes it.
 */
export interface SideHuddle {
  /** The bot that opened it, and reports back. */
  by: string;
  /** The conversation it reports back to. */
  from: string;
  /** What it's for: the opening question. */
  topic: string;
  /** Bot messages it allows before it closes. */
  limit: number;
  /** The requests in `from` it's working on, so the report answers them. */
  request?: string[];
  closedAt?: number;
}

/** A huddle's message cap: three each, at most twelve. */
export const huddleLimit = (members: number) => Math.min(12, 3 * members);

export interface BotsSettings {
  /** "provider/model" for bots without their own. Pi's default when unset. */
  defaultModel?: string;
  /** "provider/model"s every bot tries in order when its model fails, unless it lists fallbacks of its own or has none. */
  defaultFallbackModels?: string[];
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
  /** Claude logins bots don't use (provider ids, "claude-code-2"), and when that or a sign-in last changed. */
  claude?: { off: string[]; changedAt?: number };
  /**
   * How bots' computers are kept apart on each machine, by device id ("local" for this server), set
   * in Settings → Devices. The host where unset, except on a paired device that doesn't allow
   * Unisolated, which gets a container until the user chooses. Builds before host was the default
   * saved only "host", so an unset machine may be one left at the old default of a container.
   */
  isolation?: Record<string, Isolation>;
}

/** A sign-in through Claude Code's own `claude auth login`, as Settings → Bots shows it. */
export interface BotClaudeSignIn {
  id: string;
  status: "starting" | "waiting" | "verifying" | "connected" | "failed" | "cancelled";
  /** Claude's page to approve on, while waiting for the code it shows there. */
  url?: string;
  error?: string;
  startedAt: number;
}

/** One Claude Code login on this server, and whether bots use it: provider `id` ("claude-code", "claude-code-2"). */
export interface BotClaudeLogin {
  id: string;
  name: string;
  /** Where Claude Code keeps this login, with ~ for home. */
  configDir: string;
  signedIn: boolean;
  /** Bots load it. Off once the user disconnects it here. */
  enabled: boolean;
  email?: string;
  plan?: string;
  method?: string;
  error?: string;
  signIn?: BotClaudeSignIn;
}

/** A container (Podman or Docker), or a folder on the machine with no isolation. */
export type Isolation = "container" | "host";


/** One of the user's Pi extensions or packages, as Settings → Bots lists them. */
export interface BotExtension {
  id: string;
  name: string;
  description?: string;
  kind: "extension" | "package";
}

/** What a bot replies when it has nothing to say. Never shown in a chat. */
export const isSilent = (text: string) => text.trim().toLowerCase() === "[silent]";

/** What a bot's background helper session may use: reading and searching, nothing that writes to a chat or changes the bots. */
export const HELPER_TOOLS = ["bash", "read", "search", "bot_web_search"];

/** The marker anywhere in a reply: "Nothing new. [silent]" is still a bot choosing to say nothing. */
const SILENT_MARK = /\[\s*silent\s*\]/gi;
export const saysSilent = (text: string) => text.search(SILENT_MARK) >= 0;

/** A reply that is only the marker, give or take quotes and punctuation. */
export const onlySilent = (text: string) => saysSilent(text) && !/[\p{L}\p{N}]/u.test(text.replace(SILENT_MARK, ""));

/**
 * A line that reports nothing: "Nothing new", "No updates.", "All quiet, nothing to report". Only
 * short lines that are nothing else: one that goes on to say something isn't empty.
 */
export function emptyUpdate(text: string): boolean {
  const said = text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!said || said.split(" ").length > 9) return !said;
  const part = "(?:nothing (?:new|to report|to add|to share|to say|has changed|changed|of note)(?: here| yet| so far| right now| for now| from me| on my end)?|no (?:updates?|changes?|news)(?: here| yet| so far| right now| for now| from me| on my end)?|all (?:good|quiet|clear)(?: here| on my end)?|still nothing(?: new)?|nothing)";
  return new RegExp(`^${part}(?: (?:and )?${part})*$`).test(said);
}

const LIST_ITEM = /^\s*(?:\d{1,2}[.)]|[A-Ha-h][.)]|[-*•])\s+\S/;

/**
 * A message that puts questions to its reader as a list: several listed questions, or one question
 * with its choices listed under it. That's what the question card is for. A question in a sentence,
 * or a list that isn't asking anything, is just a message.
 */
export function asksInList(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim());
  const first = lines.findIndex((line) => LIST_ITEM.test(line));
  if (first < 0) return false;
  const items = lines.filter((line) => LIST_ITEM.test(line));
  if (items.filter((line) => line.includes("?")).length >= 2) return true;
  return items.length >= 2 && first > 0 && /\?[^\p{L}\p{N}]*$/u.test(lines[first - 1]!);
}

const STOP_LEAD = "(?:ok|okay|hey|no|nah|oh|wait|actually|sorry|please|pls|just|hmm)";
const STOP_TAIL = "(?:please|pls|now|right now|for now|thanks|thank you|thx|already)";
const STOP_CORE = [
  "stop(?: stop)*(?: (?:it|that|this|everything|all (?:of )?(?:that|this)|working(?: on (?:it|that|this))?|what (?:you're|youre|you are) doing|doing (?:that|this)))?",
  "cancel(?: (?:it|that|this|everything|all (?:of )?(?:that|this)|the (?:task|job|request)))?",
  "abort(?: (?:it|that|this|everything))?",
  "halt",
  "never ?mind",
  "nvm",
  "forget (?:about )?(?:it|that|this)",
  "drop (?:it|that)",
  "scrap (?:it|that)",
  "kill (?:it|that)",
  "(?:that's|thats|that is) enough",
  "enough",
  "quit it",
  "don't bother|dont bother",
].join("|");
// One stop or several running together ("never mind, stop", "stop, please stop"), and nothing more.
const STOP_REQUEST = new RegExp(`^(?:${STOP_LEAD} )*(?:${STOP_CORE})(?: (?:(?:and|${STOP_LEAD}) )*(?:${STOP_CORE}))*(?: ${STOP_TAIL})*$`);

/**
 * The user telling a bot to stop what it's doing, however they put it: "stop", "cancel that", "never
 * mind", "ok forget it please". The whole message has to be that and nothing else, so "stop the dev
 * server", "never mind the tests, do the docs" and "don't stop" are ordinary messages for the bot to
 * read. A leading or trailing @mention doesn't count as something else.
 */
export function isStopRequest(text: string): boolean {
  const said = text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/^(?:\s*@[^\s,:]+[,:]?)+/, " ")
    .replace(/(?:\s+@[^\s,:]+)+\s*[.!]*\s*$/, " ")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return said.length <= 60 && STOP_REQUEST.test(said);
}

/** A bot's plain reply as chat bubbles, one per paragraph. */
export const replyBubbles = (text: string) =>
  text
    .split(/\n{2,}/)
    // The marker closing a paragraph ("Done.[silent]", a reply and then silence run together) goes; the words stay.
    .map((s) => s.replace(/(?:\s*\[\s*silent\s*\])+\s*$/i, "").trim())
    .filter((s) => s && !onlySilent(s))
    .slice(0, 6);

export const DEFAULT_SETTINGS: BotsSettings = { quietHours: { from: 22, to: 8 }, sections: [] };

/** A bot that's streaming a message into a conversation: the text so far. */
export interface Draft {
  conversationId: string;
  botId: string;
  text: string;
}

/**
 * What OpenBots still needs before the primary bot can say hello: Pi installed ("missing"), a
 * provider connected so Pi has models ("no-provider"), or a Pi that answers ("unreachable", with
 * its error). Undefined once Pi is ready, or when nobody is waiting on the welcome.
 */
export type PiSetup = { need: "missing" } | { need: "no-provider" } | { need: "unreachable"; error: string };

export interface BotsSnapshot {
  bots: Bot[];
  conversations: Conversation[];
  settings: BotsSettings;
  status: Record<string, BotStatus>;
  typing: Record<string, string[]>;
  drafts: Draft[];
  setup?: PiSetup;
  /** Other people's OpenBuilds this one is friends with. */
  friends?: FriendSummary[];
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
  | { t: "setup"; setup?: PiSetup }
  /** The connected apps changed: ask /api/bots/apps for them. */
  | { t: "apps" }
  /** A bot added a project: ask /api/projects for them. */
  | { t: "projects" }
  | { t: "friends"; friends: FriendSummary[] };

/** The first line of every OpenBots stream: the workspace (its server's id) the rest comes from. */
export interface BotsHello {
  t: "hello";
  workspace: string;
}

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
  /** The machine's server id and name, so a caller can tell it's the one it meant. */
  serverId?: string;
  machine?: string;
  /** What this machine allows the asking server's bots. Only given to a paired server. */
  grants?: BotToolGrants;
}

/** A machine bots can reach (this server or a paired device), with what it allows them now. */
export interface ComputerTarget {
  /** "local" (this server), or a paired device's id. */
  device: string;
  name: string;
  /**
   * ready: it allows at least one kind of tool. access: paired, but it hasn't allowed this server's
   * bots anything yet. The rest say why nothing can run there now; nothing falls back elsewhere.
   */
  status: "ready" | "access" | "offline" | "revoked" | "outdated" | "mismatch" | "unpaired";
  /** What it allows (everything, for this server). */
  grants?: BotToolGrants;
  /** Container engines there (this server only: probing a device's takes seconds). */
  engines?: ("podman" | "docker")[];
  message?: string;
  /** How this server's bots are kept apart there (Settings → Devices). */
  isolation?: Isolation;
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

/** Longest a bot's role runs: what's stored, and what teammates' rosters show of it. */
export const ROLE_MAX = 100;

/** A role as it's stored: one line, spaces collapsed, at most ROLE_MAX. Anything but text is empty. */
export const cleanRole = (role: unknown): string => (typeof role === "string" ? role.replace(/\s+/g, " ").trim().slice(0, ROLE_MAX).trimEnd() : "");

/** Abbreviations whose dot doesn't end a sentence ("for trips, e.g. Lisbon"). Lowercase. */
const ABBREVIATIONS = new Set(["e.g.", "eg.", "i.e.", "ie.", "etc.", "vs.", "cf.", "viz.", "approx.", "incl.", "esp.", "mr.", "mrs.", "ms.", "dr.", "st.", "no."]);

/**
 * The first sentence of some text, on its first line: up to the first ., ! or ? that a space or the end
 * follows, but not an abbreviation's dot (e.g., i.e., etc.). Spaces collapsed.
 */
export function firstSentence(text: string): string {
  const line = (text.trim().split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  const end = /[.!?](?= |$)/g;
  for (let m: RegExpExecArray | null; (m = end.exec(line)); ) {
    const word = /\S*$/.exec(line.slice(0, m.index + 1))![0].replace(/^[^\p{L}]+/u, "").toLowerCase();
    if (m[0] === "." && ABBREVIATIONS.has(word)) continue;
    return line.slice(0, m.index + 1);
  }
  return line;
}

/** What a bot is for, in a line: its role when it has one, else its instructions' first sentence, cut to ROLE_MAX. Empty with neither. */
export function roleLine(bot: { role?: string; instructions: string }): string {
  const role = cleanRole(bot.role);
  if (role) return role;
  const first = firstSentence(bot.instructions);
  return first.length > ROLE_MAX ? `${first.slice(0, ROLE_MAX - 1).trimEnd()}…` : first;
}

/**
 * An activity line's text. Older follow-ups were saved as "Wrote to a thread" or "Wrote a prompt"; they
 * read as "Wrote a prompt in", before the thread's title, now.
 */
export const eventText = (event: { kind?: string; text: string }) =>
  event.text === "Wrote to a thread" || event.text === "Wrote a prompt" ? "Wrote a prompt in"
  : event.kind === "model" ? event.text.replace(LEGACY_SWITCH, "Switched to ")
  : event.text;

/** A model switch as saved before: "Switched to fallback model GPT 6.1 Sol", "Switched to first priority model Grok 4.7". */
const LEGACY_SWITCH = /^Switched to (?:fallback model|\S+ priority model) /;

/** What a lapsed sign-in says in the chat: the fix, without the provider's error. */
export const MODEL_SIGN_IN = "The sign-in for this model has expired. Sign in again in Settings → Providers.";

/** What the chat says of a bot's model that Pi, with the extensions bots load, doesn't have: switched off with its extension, say. */
export const modelUnavailable = (model: string) => `${model} isn't available to bots. Its extension may be switched off in Settings → Bots.`;

/** A provider's error with anything that looks like a key or token taken out, for the server log. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 [redacted]")
    .replace(/((?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, "[redacted]")
    .replace(/\b(?:sk|pk|rk|xai|gsk|ghp|gho|ghs|github_pat)[-_][\w-]{8,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]");
}


/** Provider diagnostics are useful in chat too; redact before storing and again for legacy data. */
export function shownReplyError(detail: string | undefined, _provider?: boolean): string | undefined {
  if (!detail?.trim()) return;
  if (detail.includes(MODEL_SIGN_IN)) return MODEL_SIGN_IN;
  return redactSecrets(detail).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 4000);
}

/**
 * An activity line's detail, as shown. A model switch saved before named the model's provider as its
 * detail every time; one now names it only to tell two of the same model apart.
 */
export function eventDetail(event: { kind: string; text: string; detail?: string }): string | undefined {
  if (event.kind === "model") return LEGACY_SWITCH.test(event.text) ? undefined : event.detail;
  if (event.kind === "error" && event.text === "Couldn't reply") return shownReplyError(event.detail);
  return event.detail;
}

/** Activity texts that are nouns, as the verb they read as after a bot's name. Routines saved these before. */
const AUTHORED_PHRASES: Record<string, string> = {
  "New bot": "made a new bot",
  "Follow-up set": "set a follow-up",
  "Follow-up": "followed up",
};

/**
 * What a bot-authored activity line says after the bot's name: "Closed a thread" → "closed a thread".
 * Undefined when the line keeps its own wording: a message between bots, a model switch or a change of
 * settings, which name a bot already, and a pause or a poll closing, which no one bot did.
 */
export function authoredEventText(event: { kind: string; text: string; detail?: string }): string | undefined {
  if (event.kind === "message" || event.kind === "model" || event.kind === "changed" || event.kind === "renamed" || event.kind === "poll" || event.text === "Paused") return;
  // A routine being set and one running were both saved as "Routine" once; only setting one had a schedule.
  if (event.text === "Routine") return event.detail?.includes(" · ") ? "set a routine" : "ran a routine";
  const text = eventText(event);
  // "Couldn't reply" → "couldn't reply", but an acronym ("PR …") keeps its capitals.
  return AUTHORED_PHRASES[text] ?? (/^\p{Lu}\p{Lu}/u.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1));
}

/**
 * A routine or follow-up being set, from its activity line: what it's called and when it runs, as the
 * line's detail put them ("Standup · Weekdays at 9:00"). Undefined for any other line, and for one ran.
 */
export function routineSet(event: { kind: string; text: string; detail?: string }): { title: string; schedule: string; followUp: boolean } | undefined {
  if (event.kind !== "routine" || !event.detail) return;
  const followUp = event.text === "Set a follow-up" || event.text === "Follow-up set";
  // "Routine" was both, once; only setting one had a schedule after its title.
  if (!followUp && event.text !== "Set a routine" && event.text !== "Routine") return;
  const at = event.detail.lastIndexOf(" · ");
  if (at <= 0) return;
  return { title: event.detail.slice(0, at), schedule: event.detail.slice(at + 3), followUp };
}

/** The name an @mention uses: "Dr Eggbot · notes" → "Dr Eggbot". */
export const mentionName = (name: string) => name.split(" · ")[0]!.trim();

/**
 * How well a typed @query fits a bot's mention name, lower being better; -1 when it doesn't fit.
 * Exact, then prefix, then a word start ("manager" in "ob-manager"), then a substring, then a tight
 * subsequence ("obmgr"), which needs three letters so a stray pair never drags in everyone.
 */
export function mentionRank(name: string, query: string): number {
  const hay = mentionName(name).toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 1;
  if (hay === q) return 0;
  if (hay.startsWith(q)) return 1;
  const at = hay.indexOf(q);
  if (at > 0) return /[\s_\-.·/]/.test(hay[at - 1]!) ? 2 : 3;
  if (q.length < 3) return -1;
  let last = -1;
  let first = -1;
  for (const ch of q) {
    last = hay.indexOf(ch, last + 1);
    if (last === -1) return -1;
    if (first === -1) first = last;
  }
  return last - first + 1 <= q.length * 2 ? 4 : -1;
}

/** The bots a typed @query could mean, best match first. Ties go to the shorter name, then A to Z, then the order given. */
export function matchMentionBots<B extends Pick<Bot, "name">>(bots: B[], query: string): B[] {
  // A bare "@" lists everyone in the order given.
  if (!query) return [...bots];
  return bots
    .map((bot, i) => ({ bot, i, rank: mentionRank(bot.name, query), name: mentionName(bot.name).toLowerCase() }))
    .filter((m) => m.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.i - b.i)
    .map((m) => m.bot);
}

/**
 * Where "All bots" goes among the ranked bot suggestions, as a count of bots ahead of it; -1 when the
 * query isn't toward @all or @everyone. A bot named for the query (exact or prefix) still comes first,
 * but a bot that merely contains it ("Wallace" for "@all") never outranks the broadcast. A bare "@"
 * puts everyone last, so Enter still picks one bot.
 */
export function mentionBroadcastAt<B extends Pick<Bot, "name">>(ranked: B[], query: string): number {
  const q = query.toLowerCase();
  if (!["all", "everyone"].some((w) => w.startsWith(q))) return -1;
  if (!q) return ranked.length;
  const lead = ranked.findIndex((b) => mentionRank(b.name, q) > 1);
  return lead === -1 ? ranked.length : lead;
}

/**
 * Where each @mention of a bot sits in some text. A bot is mentioned by its whole name, spaces and all
 * ("@Dr Eggbot"); "@Dr" alone isn't Dr Eggbot, so a half-typed name never tags it.
 */
export function findMentions<B extends Pick<Bot, "name">>(text: string, bots: B[]): { start: number; end: number; bot: B }[] {
  const names = bots
    .map((bot) => ({ name: mentionName(bot.name).toLowerCase(), bot }))
    .filter(({ name }) => name)
    // Longest first, so "@Dr Eggbot" isn't taken for a bot called "Dr".
    .sort((a, b) => b.name.length - a.name.length);
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

/**
 * Whether a new message leaves its conversation unread. Anything a bot writes does, except an activity
 * line in a one-to-one chat: there it's history to look back on, not something to come back for.
 */
export const marksUnread = (c: Pick<Conversation, "kind">, m: Pick<BotMessage, "author" | "event">) => m.author !== "me" && !(c.kind === "direct" && m.event);

/** A conversation's name: the group's, the bot's, or its bots' for a side chat (a huddle goes by its topic). */
export function conversationTitle(c: Pick<Conversation, "kind" | "name" | "botIds">, bots: Pick<Bot, "id" | "name">[]): string {
  if (c.kind === "group") return c.name || "Untitled group";
  if (c.kind === "side" && c.name) return c.name;
  const names = c.botIds.map((id) => bots.find((b) => b.id === id)?.name ?? "Deleted bot");
  return c.kind === "side" ? names.map((n) => n.split(" · ")[0]).join(" & ") : (names[0] ?? "Bot");
}

/** The thinking levels a bot's effort can be, as Pi names them. Unset is Pi's own default. */
export const BOT_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const isBotEffort = (value: unknown): value is (typeof BOT_EFFORTS)[number] => BOT_EFFORTS.includes(value as (typeof BOT_EFFORTS)[number]);

/** Where a bot's fallbacks come from: the defaults in Settings → Bots, its own list, or none at all. */
export type FallbackMode = "inherit" | "own" | "none";
export function fallbackMode(bot: Pick<Bot, "fallbackModels" | "noFallbacks"> | undefined): FallbackMode {
  return bot?.noFallbacks ? "none" : bot?.fallbackModels?.length ? "own" : "inherit";
}

/**
 * The models a bot tries, in order: its own (undefined: the default, or Pi's), then its fallbacks. Every
 * bot, on Default or on a model of its own, takes the default fallbacks unless it lists its own (which
 * replace them) or is set to none. A fallback that repeats one already in the list is skipped.
 */
export function botModelChain(bot: Pick<Bot, "model" | "fallbackModels" | "noFallbacks"> | undefined, settings: Pick<BotsSettings, "defaultModel" | "defaultFallbackModels">): (string | undefined)[] {
  const primary = bot?.model || settings.defaultModel || undefined;
  const mode = fallbackMode(bot);
  const fallbacks = mode === "none" ? [] : mode === "own" ? bot!.fallbackModels! : (settings.defaultFallbackModels ?? []);
  const seen = new Set(primary ? [primary] : []);
  return [primary, ...fallbacks.filter((m) => m.includes("/") && !seen.has(m) && (seen.add(m), true))];
}

/**
 * The models bots are set to that aren't among `known` (what bots can use now, as "provider/model"),
 * each with who uses it: a bot's name, "default" or "default fallbacks", or "<name> fallbacks".
 * A model that came from an extension that's since been switched off shows up here.
 */
export function unavailableModels(bots: Pick<Bot, "name" | "model" | "fallbackModels" | "noFallbacks">[], settings: Pick<BotsSettings, "defaultModel" | "defaultFallbackModels">, known: ReadonlySet<string>): { model: string; usedBy: string[] }[] {
  const users = new Map<string, string[]>();
  const note = (model: string | undefined, who: string) => {
    if (!model || known.has(model)) return;
    const list = users.get(model) ?? [];
    if (!list.includes(who)) users.set(model, [...list, who]);
  };
  note(settings.defaultModel, "default");
  for (const model of settings.defaultFallbackModels ?? []) note(model, "default fallbacks");
  for (const bot of bots) {
    note(bot.model, bot.name);
    if (fallbackMode(bot) === "own") for (const model of bot.fallbackModels!) note(model, `${bot.name} fallbacks`);
  }
  return [...users].map(([model, usedBy]) => ({ model, usedBy }));
}
