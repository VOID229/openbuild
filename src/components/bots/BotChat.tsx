// An OpenBots conversation, chat style: bubbles grouped by who sent them, a time between messages
// far apart, reactions both ways, replies that quote what they answer, and bots typing. Group
// chats name each bot over its messages; side chats between bots are read-only.
import { ArrowDown, ArrowUp, Bookmark, Check, ChevronLeft, ChevronRight, CircleDashed, CircleDot, Copy, CornerUpLeft, ImagePlus, ListChecks, Plus, SmilePlus, Square, TextSelect, X } from "lucide-react";
import { createPortal } from "react-dom";
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { noticeAnswer, noticeReaction, respond } from "../../lib/bots/engine";
import { elsewhere, holding, showWorking, stoppable, workingHere } from "../../lib/bots/activity";
import { colorOf } from "../../lib/bots/looks";
import { conversationName, directOf, useBots, useRemoteWorkspace } from "../../lib/bots/store";
import { isLocalWorkspace, workspacePath } from "../../lib/bots/workspace";
import type { Bot, BotMessage, Conversation, Reaction } from "../../lib/bots/types";
import { authoredEventText, eventDetail, eventText, findTags, matchMentionBots, mentionBroadcastAt, mentionName, pollVotesVisible, pollWaitingOn, reactionId } from "../../../shared/bots";
import { RELOAD_THREADS } from "../../lib/pulls";
import { threadPath } from "../../lib/routes";
import { useStore } from "../../lib/store";
import { accountName } from "../../lib/models";
import { PULL_REF_RE, conversationRepo, pullRefHref, pullRefUrl } from "../../lib/bots/pullRefs";
import { useShallow } from "zustand/react/shallow";
import { closeBotsLayer, holdLayout, openBotsDetails, useBubbleTouch } from "../../lib/gestures";
import { copyText, cx, useMediaQuery, usePresence } from "../../lib/ui";
import { Linkify, WebLink } from "../Linkify";
import { openLightbox } from "../Lightbox";
import { DictationButton } from "../DictationButton";
import { useFieldDictation } from "../../lib/useFieldDictation";
import { Avatar, IconButton, Popover, Sheet } from "../primitives";
import { StashTray } from "../StashTray";
import { uid } from "../../lib/id";
import { botStashOf, imageFiles, pasteBotStash, stashAction, type Stashed } from "../../lib/stash";
import { SHORTCUT_EVENT, type ShortcutEventDetail } from "../../lib/shortcuts";
import { botDraftKey, draftsReady, getBotDraft, onRemoteDraft, saveBotDraft } from "../../lib/drafts";
import { rememberDraftSelection, restoreDraftSelection } from "../../lib/draftSelection";
import { HtmlRender } from "../HtmlRender";
import { botPagesOld } from "../../lib/pagePreviews";
import type { ToolPart } from "../../lib/types";
import { ConnectCard } from "./BotApps";
import { HeadTasks } from "./BotTodos";
import { BotAvatar } from "./BotAvatar";
import { BotProfileHover } from "./BotProfileCard";

/** A friend's bot whose look didn't come across. */
const FRIEND_LOOK = { shape: "orb", color: "gray" };
import { PollDialog } from "./BotDialogs";
import { PiSetupNotice } from "./PiSetupNotice";
import { authorName, ConversationAvatar, dividerTime, messageLine, messageText, useBusyBots } from "./common";

const QUICK = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
const MORE = ["🎉", "🙏", "👀", "💯", "✅", "🤔", "😍", "👏", "🙌", "😅", "🤯", "💡", "🚀", "⭐", "😎", "🥲", "🫡", "👋", "❌", "➕", "🤝", "😴", "🍕", "☕"];

/** Messages this far apart get a time between them. */
const DIVIDER_GAP = 45 * 60 * 1000;
/** A bot or the user's messages this close together share one group. */
const GROUP_GAP = 5 * 60 * 1000;

const EMPTY: string[] = [];
const NO_BOTS: Bot[] = [];
/** Who an @all reaches. Only group chats have one. */
const everyoneIn = (c: Conversation, bots: Bot[]) => (c.kind === "group" ? bots.filter((b) => c.botIds.includes(b.id)) : NO_BOTS);
/** The mentions to draw in some text: bots, and @all where there's a group for it to mean. */
const tagsIn = (text: string, bots: Bot[], everyone: Bot[]) => findTags(text, bots).filter((t) => t.bot || everyone.length);
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
/** The composer's text box, if it's what has focus (and so what has the keyboard up). */
const composerField = () => {
  const el = document.activeElement;
  return el instanceof HTMLTextAreaElement && el.closest(".bots-composer") ? el : undefined;
};
const firstName = (b: Bot) => b.name.split(/\s+/)[0]!;
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️){1,12}$/u;

/** A bot named in the chat, with its mascot, linking to its thread. */
function BotLink({ bot }: { bot: Bot }) {
  const thread = useBots((s) => directOf(s.conversations, bot.id)?.id);
  if (!thread) return <>{bot.name}</>;
  return (
    <button type="button" className="bm-bot-link" onClick={() => useBots.getState().select(thread)}>
      <BotAvatar look={bot.look} size={14} alive={false} />
      <span>{bot.name}</span>
    </button>
  );
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const namedBots = (bots: Bot[]) => bots.filter((b) => b.name.trim()).sort((a, b) => b.name.length - a.name.length);

/** Matches any of these bots' names as a whole word, longest first. */
const botNames = (named: Bot[]) => new RegExp(`(?<![\\p{L}\\d])(?:${named.map((b) => escapeRegExp(b.name)).join("|")})(?![\\p{L}\\d])`, "gu");

/** Whether the text already names one of these bots ("Juniper left"). */
/** What a settings line says after the bot's name: the "'s " just before its first setting ends the name. */
function settingsChange(text: string): string | undefined {
  const at = text.lastIndexOf("'s ", text.indexOf(": "));
  return at > 0 ? text.slice(at + 3) : undefined;
}

const namesBot = (text: string, bots: Bot[]) => {
  const named = namedBots(bots);
  return named.length > 0 && botNames(named).test(text);
};

/** Text with every bot it names linked, and its threads and pull requests. Longer names first, so "Sage Two" wins over "Sage". */
function WithBotLinks({ text, bots }: { text: string; bots: Bot[] }) {
  const named = namedBots(bots);
  if (!named.length) return <ThreadReferences text={text} />;
  const pattern = botNames(named);
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (start > last) parts.push(<ThreadReferences key={last} text={text.slice(last, start)} />);
    parts.push(<BotLink key={start} bot={named.find((b) => b.name === m[0])!} />);
    last = start + m[0].length;
  }
  if (last < text.length) parts.push(<ThreadReferences key={last} text={text.slice(last)} />);
  return <>{parts}</>;
}

/** The @ of a mention, drawn as the bot's mascot. The @ stays in the text, so copying keeps it. */
function MentionAt({ bot }: { bot: Bot }) {
  return (
    <span className="bm-mention-at">
      @
      <BotAvatar look={bot.look} size={16} alive={false} />
    </span>
  );
}

/** Bots' mascots side by side, as many as fit a tag. */
function Mascots({ bots, size }: { bots: Bot[]; size: number }) {
  return (
    <span className="bm-mascots">
      {bots.slice(0, 5).map((b) => (
        <span key={b.id} className="bm-mascot">
          <BotAvatar look={b.look} size={size} alive={false} />
        </span>
      ))}
    </span>
  );
}

/** An @all: the group's mascots in place of the @, which stays in the text so copying keeps it. */
function MentionAll({ everyone, text }: { everyone: Bot[]; text: string }) {
  return (
    <span className="bm-mention bm-mention-all">
      <span className="bm-mention-all-at">@</span>
      <Mascots bots={everyone} size={16} />
      {text.slice(1)}
    </span>
  );
}

/**
 * An @mention in the bot's colour, opening its thread. `tail` is the rest of the bot's full name
 * (" · notes") when the message spelled it out after the mention: it stays in the text for copying,
 * but the chip reads as the name alone.
 */
function Mention({ bot, text, tail }: { bot: Bot; text: string; tail?: string }) {
  const thread = useBots((s) => directOf(s.conversations, bot.id)?.id);
  const style = { "--mention": colorOf(bot.look).hex } as React.CSSProperties;
  const body = (
    <>
      <MentionAt bot={bot} />
      {text.slice(1)}
      {tail && <span className="bm-mention-tail">{tail}</span>}
    </>
  );
  if (!thread) return <span className="bm-mention" style={style}>{body}</span>;
  return (
    <button type="button" className="bm-mention bm-mention-link" style={style} onClick={() => useBots.getState().select(thread)}>
      {body}
    </button>
  );
}

/** Keep normal browser link actions while plain clicks open the thread inside OpenBots. */
function ThreadLink({ id, children }: { id: string; children: React.ReactNode }) {
  return <a className="link" href={threadPath(id)} onClick={(e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    // An event row toggles open on click; following its link shouldn't do that as well.
    e.stopPropagation();
    useStore.getState().openThreadInBots(id);
    // A thread a bot has only just started may not have reached this tab yet; it opens once it does.
    if (!useStore.getState().chats.some((c) => c.id === id)) window.dispatchEvent(new Event(RELOAD_THREADS));
  }}>{children}</a>;
}

/** Opens a conversation in OpenBots, such as the side chat a message between bots went to. */
function ConversationLink({ id, children }: { id: string; children: React.ReactNode }) {
  const known = useBots((s) => s.conversations.some((c) => c.id === id));
  if (!known) return <>{children}</>;
  return (
    <button type="button" className="link bm-conversation-link" onClick={(e) => {
      // An event row toggles open on click; following its link shouldn't do that as well.
      e.stopPropagation();
      useBots.getState().select(id);
    }}>{children}</button>
  );
}

/** A message between bots, from one side: the bot links to its thread, the rest to the side chat. */
function MessageActivity({ event, other }: { event: NonNullable<BotMessage["event"]>; other: Bot }) {
  const sent = event.text.startsWith("Sent");
  return (
    <>
      <ConversationLink id={event.conversationId!}>{sent ? "Sent a message" : "Received a message"}</ConversationLink> {sent ? "to" : "from"} <BotLink bot={other} />
    </>
  );
}

/** Opens on GitHub on any click: OpenBots has no pull requests tab to keep it in. */
function PullLink({ url, children }: { url: string; children: React.ReactNode }) {
  // An event row toggles open on click; following its link shouldn't do that as well.
  return <a className="link" href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{children}</a>;
}

/** The repository the open conversation's "#n" are in, when it can be told (conversationRepo). */
const PullRepo = createContext<string | undefined>(undefined);

/**
 * The thread an activity is about. Closes and merges recorded before they carried an id fall back to
 * the one thread with that title, or that pull request, so older history links too.
 */
function useEventThread(event: NonNullable<BotMessage["event"]>): string | undefined {
  return useStore((s) => {
    if (event.threadId || event.kind !== "thread" || !event.detail) return event.threadId;
    const pull = event.text === "Merged a pull request" ? /^#(\d+) /.exec(event.detail) : null;
    const matches = s.chats.filter((c) => (pull ? c.pullRequest?.number === Number(pull[1]) : c.title === event.detail));
    return matches.length === 1 ? matches[0]!.id : undefined;
  });
}

/** Where a merge's "#n" goes: the URL it was recorded with, else the pull request that number names. */
function useEventPull(event: NonNullable<BotMessage["event"]>, threadId: string | undefined): string | undefined {
  const pull = event.text === "Merged a pull request" ? /^#(\d+) /.exec(event.detail ?? "") : null;
  return useStore((s) => {
    if (!pull) return;
    if (event.pullUrl) return event.pullUrl;
    const own = threadId ? s.chats.find((c) => c.id === threadId)?.pullRequest : undefined;
    if (own?.number === Number(pull[1])) return own.url;
    return pullRefUrl(Number(pull[1]), s.chats.flatMap((c) => (c.pullRequest ? [c.pullRequest] : [])));
  });
}

/**
 * An activity's detail: a link to the thread it's about, when there is one. A merge's "#n" is its own
 * link, to the pull request on GitHub, with the title after it opening the thread.
 */
function EventThread({ event }: { event: NonNullable<BotMessage["event"]> }) {
  const host = useRemoteWorkspace();
  return host ? <RemoteEventThread event={event} host={host} /> : <LocalEventThread event={event} />;
}

/**
 * Another device's activity: its thread is on that device, never looked up among this one's, so it
 * says it can't be opened here. A merge's "#n" still links when the activity recorded its URL.
 */
function RemoteEventThread({ event, host }: { event: NonNullable<BotMessage["event"]>; host: string }) {
  const detail = event.detail ?? "";
  const ref = event.pullUrl ? /^#\d+ /.exec(detail)?.[0] : undefined;
  const title = ref ? detail.slice(ref.length) : detail;
  const thread = <span className="bm-unavailable" title={`This thread is on ${host}. Open it there.`}>{title} <span className="bm-unavailable-note">(on {host})</span></span>;
  if (!ref) return thread;
  return <><PullLink url={event.pullUrl!}>{ref.trimEnd()}</PullLink> {thread}</>;
}

function LocalEventThread({ event }: { event: NonNullable<BotMessage["event"]> }) {
  const id = useEventThread(event);
  const pullUrl = useEventPull(event, id);
  const detail = event.detail ?? "";
  const ref = pullUrl ? /^#\d+ /.exec(detail)?.[0] : undefined;
  const title = ref ? detail.slice(ref.length) : detail;
  const thread = id ? <ThreadLink id={id}>{title}</ThreadLink> : <>{title}</>;
  if (!ref) return thread;
  return <><PullLink url={pullUrl!}>{ref.trimEnd()}</PullLink> {thread}</>;
}

/**
 * Only link IDs that resolve uniquely to a known thread, and "#n" in the conversation's repository or
 * one a thread opened (pullRefHref); ordinary hex text, colours and labels like a model's "#2" stay text.
 * `pulls={false}` (code) links no "#n".
 */
function ThreadReferences({ text, fileHref, pulls = true }: { text: string; fileHref?: (url: string) => string; pulls?: boolean }) {
  // Another device's threads aren't this tab's to look up: ids and "#n" there stay text.
  if (useRemoteWorkspace()) return <Linkify text={text} fileHref={fileHref} bare />;
  return <LocalThreadReferences text={text} fileHref={fileHref} withPulls={pulls} />;
}

function LocalThreadReferences({ text, fileHref, withPulls }: { text: string; fileHref?: (url: string) => string; withPulls: boolean }) {
  const chats = useStore((s) => s.chats);
  const repo = useContext(PullRepo);
  const pulls = useMemo(() => chats.flatMap((c) => (c.pullRequest ? [c.pullRequest] : [])), [chats]);
  const parts: React.ReactNode[] = [];
  let last = 0;
  const refs = new RegExp(`\\b(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{8})\\b|${PULL_REF_RE.source}`, "gi");
  for (const m of text.matchAll(refs)) {
    // Let the URL renderer own IDs inside URLs.
    const token = text.slice(0, m.index).match(/[^\s]*$/)?.[0] ?? "";
    if (/[/:]/.test(token)) continue;
    let link: React.ReactNode;
    if (m[1]) {
      const url = withPulls ? pullRefHref(text, m.index, m.index + m[0].length, Number(m[1]), { repo, pulls }) : undefined;
      if (!url) continue;
      link = <PullLink key={m.index + "-pull"} url={url}>{m[0]}</PullLink>;
    } else {
      const matches = chats.filter((c) => c.id.toLowerCase() === m[0].toLowerCase() || c.id.toLowerCase().startsWith(m[0].toLowerCase() + "-"));
      if (matches.length !== 1) continue;
      link = <ThreadLink key={m.index + "-thread"} id={matches[0]!.id}>{m[0]}</ThreadLink>;
    }
    parts.push(<Linkify key={last} text={text.slice(last, m.index)} fileHref={fileHref} bare />);
    parts.push(link);
    last = m.index + m[0].length;
  }
  parts.push(<Linkify key="end" text={text.slice(last)} fileHref={fileHref} bare />);
  return <>{parts}</>;
}

/** What follows a bot's mention name in its full name ("Dr Eggbot · notes" → " · notes"), if the text goes on with it at `at`. */
function nameTail(text: string, at: number, bot: Bot): string | undefined {
  const tail = bot.name.slice(mentionName(bot.name).length);
  if (!tail.trim() || text.slice(at, at + tail.length).toLowerCase() !== tail.toLowerCase()) return;
  return text.slice(at, at + tail.length);
}

/** Plain text with @mentions and links. */
function WithMentions({ text, bots, everyone, fileHref }: { text: string; bots: Bot[]; everyone: Bot[]; fileHref?: (url: string) => string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const { start, end, bot } of tagsIn(text, bots, everyone)) {
    if (start > last) parts.push(<ThreadReferences key={last} text={text.slice(last, start)} fileHref={fileHref} />);
    const tail = bot && nameTail(text, end, bot);
    parts.push(bot ? <Mention key={start} bot={bot} text={text.slice(start, end)} tail={tail} /> : <MentionAll key={start} everyone={everyone} text={text.slice(start, end)} />);
    last = end + (tail?.length ?? 0);
  }
  if (last < text.length) parts.push(<ThreadReferences key={last} text={text.slice(last)} fileHref={fileHref} />);
  return <>{parts}</>;
}

/** Bold, inline code, [Markdown](https://links), bare links and @mentions (in the mentioned bot's colour). */
const RichText = memo(function RichText({ text, bots, everyone, botId }: { text: string; bots: Bot[]; everyone: Bot[]; botId?: string }) {
  // A bot's files are on its own workspace's computer, so they're fetched from that workspace.
  const workspace = useBots((s) => s.workspace);
  const fileHref = botId && workspace ? (url: string) => workspacePath(workspace, `/api/bots/${encodeURIComponent(botId)}/file?url=${encodeURIComponent(url)}`) : undefined;
  const parts: React.ReactNode[] = [];
  let last = 0;
  // A fenced block shows as it was written, with no "#n" in it linked, as in inline code.
  for (const m of text.matchAll(/```[\s\S]*?(?:```|$)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
    const start = m.index ?? 0;
    if (start > last) parts.push(<WithMentions key={last} text={text.slice(last, start)} bots={bots} everyone={everyone} fileHref={fileHref} />);
    if (m[0].startsWith("```")) parts.push(<ThreadReferences key={start} text={m[0]} fileHref={fileHref} pulls={false} />);
    else if (m[1]) parts.push(<code key={start}><ThreadReferences text={m[1]} fileHref={fileHref} pulls={false} /></code>);
    else if (m[2]) parts.push(<strong key={start}><WithMentions text={m[2]} bots={bots} everyone={everyone} fileHref={fileHref} /></strong>);
    else parts.push(<WebLink key={start} url={m[4]!}>{m[3]}</WebLink>);
    last = start + m[0].length;
  }
  if (last < text.length) parts.push(<WithMentions key={last} text={text.slice(last)} bots={bots} everyone={everyone} fileHref={fileHref} />);
  return <>{parts}</>;
});

type Block = { kind: "divider"; at: number; key: string } | { kind: "events"; messages: BotMessage[] } | { kind: "group"; author: string; messages: BotMessage[] };

/** An activity line that stands on its own rather than folding into a run: an error is news. */
const standsAlone = (m: BotMessage) => m.event?.kind === "error";

function blocksOf(all: BotMessage[]): Block[] {
  // Memory happens in the background; older chats can still hold these.
  const messages = all.filter((m) => m.event?.kind !== "memory");
  const blocks: Block[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    if (!prev || m.at - prev.at > DIVIDER_GAP || !sameDay(prev.at, m.at)) blocks.push({ kind: "divider", at: m.at, key: `d-${m.id}` });
    if (m.event) {
      // Activity lines in a row fold into one run, between the messages around them.
      const run = blocks.at(-1);
      if (run?.kind === "events" && !standsAlone(m) && !standsAlone(run.messages.at(-1)!)) run.messages.push(m);
      else blocks.push({ kind: "events", messages: [m] });
      return;
    }
    const group = blocks.at(-1);
    if (group?.kind === "group" && group.author === m.author && m.at - group.messages.at(-1)!.at < GROUP_GAP) group.messages.push(m);
    else blocks.push({ kind: "group", author: m.author, messages: [m] });
  });
  return blocks;
}

interface Picker {
  messageId: string;
  mine: boolean;
  what: "react";
  /** Answering this reaction, by id, rather than the message. */
  to?: string;
  /** The bot whose reaction is answered, to perk up at it. */
  answering?: string;
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? "Copied" : "Copy"}
      tooltip={false}
      className="bm-action"
      disabled={!text}
      onClick={() => {
        void copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </IconButton>
  );
}

/** Saves a copy of a message I sent to the stash. The message itself stays as it is. */
function StashAction({ text, images }: { text: string; images: string[] }) {
  const crossStash = useStore((s) => s.settings.crossStash);
  const [stashed, setStashed] = useState(false);
  return (
    <IconButton
      label={stashed ? "Stashed" : "Stash"}
      tooltip={false}
      className="bm-action"
      onClick={() => {
        botStashOf(crossStash).add(text, imageFiles(images));
        setStashed(true);
        setTimeout(() => setStashed(false), 1400);
      }}
    >
      {stashed ? <Check size={16} /> : <Bookmark size={16} />}
    </IconButton>
  );
}

function QuestionCard({ conversation, message }: { conversation: Conversation; message: BotMessage }) {
  const q = message.question!;
  const [own, setOwn] = useState("");
  const answer = (key: string, text: string, label: string) => {
    if (q.answer) return;
    const st = useBots.getState();
    st.patchMessage(conversation.id, message.id, (m) => ({ question: { ...m.question!, answer: key } }));
    st.post(conversation.id, { author: "me", text, replyTo: message.id });
    noticeAnswer(conversation.id, message.author, label);
  };
  return (
    <div className="bm-question">
      <div className="bm-question-title">{q.title}</div>
      {q.hint && <div className="bm-question-hint">{q.hint}</div>}
      <div className="bm-options">
        {q.options.map((o) => (
          <button
            key={o.key}
            type="button"
            className={cx("bm-option", q.answer === o.key && "bm-option-on", q.answer && q.answer !== o.key && "bm-option-off")}
            disabled={!!q.answer}
            onClick={() => answer(o.key, `${o.key}: ${o.label}`, o.label)}
          >
            <span className="bm-option-key">{q.answer === o.key ? <Check size={13} strokeWidth={3} /> : o.key}</span>
            <span className="bm-option-label">{o.label}</span>
          </button>
        ))}
        {q.answer && !q.options.some((o) => o.key === q.answer) && (
          <div className="bm-option bm-option-on">
            <span className="bm-option-key">
              <Check size={13} strokeWidth={3} />
            </span>
            <span className="bm-option-label">{q.answer}</span>
          </div>
        )}
      </div>
      {!q.answer && (
        <form
          className="bm-own"
          onSubmit={(e) => {
            e.preventDefault();
            if (own.trim()) answer(own.trim(), own.trim(), own.trim());
          }}
        >
          <input className="input input-sm" value={own} maxLength={2000} placeholder="Type your own answer…" aria-label="Your own answer" onChange={(e) => setOwn(e.target.value)} />
          <IconButton label="Send answer" tooltip={false} type="submit" disabled={!own.trim()}>
            <ArrowUp size={16} />
          </IconButton>
        </form>
      )}
    </div>
  );
}

function PollCard({ conversation, message, bots }: { conversation: Conversation; message: BotMessage; bots: Bot[] }) {
  const poll = message.poll!;
  const mine = poll.votes.find((v) => v.by === "me")?.keys ?? EMPTY;
  const visible = pollVotesVisible(poll, "me");
  const waiting = pollWaitingOn(poll, message.author, conversation.botIds).map((id) => (id === "me" ? "you" : firstName(bots.find((b) => b.id === id) ?? { name: "A bot" } as Bot)));
  const vote = (key: string) => {
    const others = mine.filter((k) => k !== key);
    const next = mine.includes(key) ? others : poll.multiple ? [...mine, key] : [key];
    // A closed poll keeps everyone's answer: it can change, but not go.
    if (poll.closedAt && !next.length) return;
    useBots.getState().votePoll(conversation.id, message.id, next);
  };
  const count = poll.votes.length === 1 ? "1 vote" : poll.votes.length ? `${poll.votes.length} votes` : "No votes yet";
  const foot = poll.closedAt
    ? ["Closed", count, mine.length ? "You can still change your answer" : ""]
    : [count, waiting.length ? `Waiting on ${waiting.join(", ")}` : "", visible ? "" : "Answers show once you've voted"];
  return (
    <div className="bm-poll">
      <div className="bm-question-title">{poll.question}</div>
      <div className="bm-question-hint">{poll.multiple ? "Pick any" : "Pick one"}</div>
      <div className="bm-options" role={poll.multiple ? "group" : "radiogroup"} aria-label={poll.question}>
        {poll.options.map((o) => {
          const by = visible ? poll.votes.filter((v) => v.keys.includes(o.key)).map((v) => v.by) : EMPTY;
          const on = mine.includes(o.key);
          const voters = by.flatMap((id) => bots.find((b) => b.id === id) ?? []);
          return (
            <button
              key={o.key}
              type="button"
              role={poll.multiple ? "checkbox" : "radio"}
              aria-checked={on}
              className={cx("bm-option", "bm-poll-option", on && "bm-option-on")}
              style={{ "--share-x": poll.votes.length ? by.length / poll.votes.length : 0 } as React.CSSProperties}
              data-tooltip={by.length ? by.map((id) => authorName(id, bots).split(" ·")[0]).join(", ") : undefined}
              onClick={() => vote(o.key)}
            >
              <span className={cx("bm-option-key", poll.multiple && "bm-poll-key-multi")}>{on ? <Check size={13} strokeWidth={3} /> : o.key}</span>
              <span className="bm-option-label">{o.label}</span>
              {by.length > 0 && (
                <span className="bm-poll-tally">
                  {voters.slice(0, 3).map((b) => (
                    <BotAvatar key={b.id} look={b.look} size={18} alive={false} mood="happy" />
                  ))}
                  <span className="bm-poll-count">{by.length}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="bm-poll-foot">{foot.filter(Boolean).join(" · ")}</div>
    </div>
  );
}

/**
 * A page a bot showed (its html_render): OpenBuild's own in-thread page, drawn the same way from the
 * message instead of a tool call, in the same sandbox, with its download and full-screen view.
 */
function PageCard({ message, old }: { message: BotMessage; old: boolean }) {
  const page = message.html!;
  const part = useMemo<ToolPart>(() => ({ type: "tool", id: message.id, name: "html_render", status: "done", args: { html: page.html, title: page.title, height: page.height } }), [message.id, page.html, page.title, page.height]);
  return <HtmlRender part={part} old={old} />;
}

function PlanCard({ message, bots }: { message: BotMessage; bots: Bot[] }) {
  const plan = message.plan!;
  const done = plan.steps.filter((s) => s.status === "done").length;
  return (
    <div className="bm-plan">
      <div className="bm-plan-head">
        <span className="bm-plan-title">{plan.title}</span>
        <span className="bm-plan-count">
          {done}/{plan.steps.length} done
        </span>
      </div>
      <ol className="bm-plan-steps">
        {plan.steps.map((s, i) => {
          const bot = bots.find((b) => b.id === s.bot);
          return (
            <li key={i} className={cx("bm-step", `bm-step-${s.status}`)}>
              <span className="bm-step-icon" aria-label={s.status === "done" ? "Done" : s.status === "doing" ? "In progress" : "To do"}>
                {s.status === "done" ? <Check size={13} strokeWidth={3} /> : s.status === "doing" ? <CircleDot size={14} /> : <CircleDashed size={14} />}
              </span>
              <span className="bm-step-text">{s.text}</span>
              {bot && (
                <span className="bm-step-bot" title={bot.name}>
                  <BotAvatar look={bot.look} size={18} alive={s.status === "doing"} mood={s.status === "doing" ? "thinking" : s.status === "done" ? "happy" : "idle"} />
                  {firstName(bot)}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

interface ReactionGroup {
  key: string;
  emoji: string;
  /** The reaction this group answers, if any. */
  to?: string;
  /** Ids of the reactions in it, so answers to them can find it. */
  ids: string[];
  by: string[];
}

/** Reactions on the message come first, each followed by the chain of reactions answering it. */
function reactionThreads(reactions: Reaction[]): { group: ReactionGroup; parent?: ReactionGroup }[][] {
  const groups = new Map<string, ReactionGroup>();
  for (const r of reactions) {
    const key = `${r.to ?? ""}|${r.emoji}`;
    const g = groups.get(key) ?? { key, emoji: r.emoji, to: r.to, ids: [], by: [] };
    g.ids.push(reactionId(r));
    g.by.push(r.by);
    groups.set(key, g);
  }
  const all = [...groups.values()];
  const owner = (id: string) => all.find((g) => g.ids.includes(id));
  const threads: { group: ReactionGroup; parent?: ReactionGroup }[][] = [];
  const walk = (group: ReactionGroup, into: { group: ReactionGroup; parent?: ReactionGroup }[], parent?: ReactionGroup) => {
    into.push({ group, parent });
    for (const child of all) if (child.to && group.ids.includes(child.to) && !into.some((x) => x.group === child)) walk(child, into, group);
  };
  for (const g of all) {
    const parent = g.to ? owner(g.to) : undefined;
    if (parent && parent !== g) continue;
    const thread: { group: ReactionGroup; parent?: ReactionGroup }[] = [];
    walk(g, thread);
    threads.push(thread);
  }
  return threads;
}

/** A little hooked arrow pointing back at the reaction the next chip answers. */
function ReactionArrow() {
  return (
    <svg className="bm-reaction-arrow" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M12 2.5c0 5-3 7.5-9 7.5" />
      <path d="M6 6.8 3 10l3 3.2" />
    </svg>
  );
}

function Reactions({ message, conversation, bots, mine, onPicker }: { message: BotMessage; conversation: Conversation; bots: Bot[]; mine: boolean; onPicker?: RowProps["onPicker"] }) {
  const threads = useMemo(() => reactionThreads(message.reactions ?? []), [message.reactions]);
  if (!threads.length) return null;
  const names = (by: string[]) => by.map((b) => authorName(b, bots)).join(", ");
  return (
    <div className={cx("bm-reactions", mine && "bm-reactions-mine")}>
      {threads.map((thread) => (
        <span key={thread[0]!.group.key} className="bm-reaction-thread">
          {thread.map(({ group, parent }) => {
            const { emoji, by, to } = group;
            const reactors = by.filter((b) => b !== "me").map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
            const answered = parent ? parent.by.find((b) => b !== "me") : message.author !== "me" ? message.author : undefined;
            // A bot's reaction can be answered with one of the user's own, which then hangs off it with an arrow.
            const bot = by.findIndex((b) => b !== "me");
            return (
              <span key={group.key} className="bm-reaction-link">
                {parent && <ReactionArrow />}
                <button
                  type="button"
                  className={cx("bm-reaction", parent && "bm-reaction-answer")}
                  data-tooltip={parent ? `${names(by)} → ${names(parent.by)}'s ${parent.emoji}` : names(by)}
                  data-tooltip-side="bottom"
                  onClick={() => {
                    useBots.getState().toggleReaction(conversation.id, message.id, emoji, "me", to);
                    if (!by.includes("me") && answered) noticeReaction(answered, emoji);
                  }}
                >
                  <span className="bm-reaction-pill">
                    <span className="bm-reaction-emoji">{emoji}</span>
                    {by.length > 1 && <span className="bm-reaction-count">{by.length}</span>}
                  </span>
                  {/* Who reacted hangs off the pill's lower corner, part of the same button; the count says how many. */}
                  {reactors.length > 0 && (
                    <span className="bm-reaction-mascots" aria-hidden="true">
                      {reactors.slice(0, 3).map((b) => (
                        <BotAvatar key={b.id} look={b.look} size={14} alive={false} mood="happy" />
                      ))}
                    </span>
                  )}
                </button>
                {onPicker && bot >= 0 && (
                  <button
                    type="button"
                    className="bm-reaction-reply"
                    aria-label={`React to ${names(by.filter((b) => b !== "me"))}'s ${emoji}`}
                    data-tooltip="React to this"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => onPicker({ messageId: message.id, mine, what: "react", to: group.ids[bot], answering: by[bot] }, e.currentTarget)}
                  >
                    <SmilePlus size={10} strokeWidth={2.4} />
                  </button>
                )}
              </span>
            );
          })}
        </span>
      ))}
    </div>
  );
}

interface RowProps {
  message: BotMessage;
  conversation: Conversation;
  bots: Bot[];
  pos: "single" | "first" | "middle" | "last";
  fresh: boolean;
  readonly: boolean;
  onReply: (id: string) => void;
  onPicker: (p: Picker, anchor: HTMLElement) => void;
  /** Touch screens: this message's actions, by holding its bubble. */
  onHold: (id: string, bubble: HTMLElement) => void;
  seen?: React.ReactNode;
  /** Shown, but not confirmed by the workspace yet. */
  sending?: boolean;
  /** Its page is a few turns back, so it starts collapsed (src/lib/pagePreviews.ts). */
  oldPage?: boolean;
}

/**
 * A row reads only the conversation's id, kind and bots, and the message it quotes. Each new message
 * is a new conversation, and comparing that whole would draw every row again on every send.
 */
const sameRow = (a: RowProps, b: RowProps) => {
  for (const k of Object.keys(a) as (keyof RowProps)[]) if (k !== "conversation" && a[k] !== b[k]) return false;
  const c = a.conversation, d = b.conversation;
  if (c.id !== d.id || c.kind !== d.kind || c.botIds !== d.botIds) return false;
  const quoted = a.message.replyTo;
  return !quoted || c.messages.find((x) => x.id === quoted) === d.messages.find((x) => x.id === quoted);
};

const MessageRow = memo(function MessageRow({ message: m, conversation, bots, pos, fresh, readonly, onReply, onPicker, onHold, seen, sending, oldPage }: RowProps) {
  const mine = m.author === "me";
  const quoted = m.replyTo ? conversation.messages.find((x) => x.id === m.replyTo) : undefined;
  const emojiOnly = !m.images?.length && !m.question && !m.plan && !m.poll && !m.connect && !m.html && EMOJI_ONLY.test(m.text.replace(/\s/g, ""));
  const card = !!(m.question || m.plan || m.poll || m.connect || m.html);
  const everyone = useMemo(() => everyoneIn(conversation, bots), [conversation.kind, conversation.botIds, bots]);
  const react = (emoji: string) => {
    const had = m.reactions?.some((r) => r.by === "me" && r.emoji === emoji && !r.to);
    useBots.getState().toggleReaction(conversation.id, m.id, emoji, "me");
    if (!had && !mine) noticeReaction(m.author, emoji);
  };
  const lastDoubleTap = useRef(0);
  const bubble = useRef<HTMLDivElement>(null);
  const fingers = useBubbleTouch({
    onHold: () => bubble.current && onHold(m.id, bubble.current),
    onReply: readonly ? undefined : () => onReply(m.id),
    onDoubleTap: readonly
      ? undefined
      : () => {
          lastDoubleTap.current = Date.now();
          react("❤️");
        },
  });
  return (
    <div className={cx("bm-row", fresh && (mine ? "bm-send" : "bm-recv"), sending && "bm-sending")} data-pos={pos} data-id={m.id} aria-busy={sending || undefined} {...fingers}>
      {!readonly && (
        <span className="bm-swipe-icon" aria-hidden>
          <CornerUpLeft size={18} />
        </span>
      )}
      {quoted && (
        <button type="button" className="bm-quote" onClick={() => useBots.getState().focusMessage(conversation.id, quoted.id)}>
          <CornerUpLeft size={12} />
          <span className="bm-quote-who">{authorName(quoted.author, bots, quoted.from).split(" ·")[0]}</span>
          <span className="bm-quote-text">{messageLine(quoted)}</span>
        </button>
      )}
      <div className="bm-line">
        <div
          ref={bubble}
          className={cx("bm-bubble", emojiOnly && "bm-emoji", card && "bm-card", m.html && "bm-page")}
          onDoubleClick={readonly ? undefined : (e) => {
            // Two taps also make a dblclick, but useBubbleTouch has already answered them.
            if (Date.now() - lastDoubleTap.current < 600 || (e.target as Element).closest("button, a")) return;
            window.getSelection()?.removeAllRanges();
            react("❤️");
          }}
        >
          {!!m.images?.length && (
            <div className="bm-images">
              {m.images.map((src, i) => (
                <button key={i} type="button" className="bm-image" onClick={() => openLightbox(m.images!.map((src, j) => ({ id: `${m.id}-${j}`, name: "Image", dataUrl: src })), `${m.id}-${i}`)}>
                  <img src={src} alt="" />
                </button>
              ))}
            </div>
          )}
          {m.text && !m.question && !m.poll && !m.connect && (
            <div className="bm-text">
              <RichText text={m.text} bots={bots} everyone={everyone} botId={m.author === "me" ? undefined : m.author} />
            </div>
          )}
          {m.question && <QuestionCard conversation={conversation} message={m} />}
          {m.poll && <PollCard conversation={conversation} message={m} bots={bots} />}
          {m.plan && <PlanCard message={m} bots={bots} />}
          {m.html && <PageCard message={m} old={!!oldPage} />}
          {m.connect && <ConnectCard appId={m.connect.app} />}
        </div>
        {!readonly && (
          <div className="bm-actions">
            <IconButton label="React" tooltip={false} className="bm-action" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => onPicker({ messageId: m.id, mine, what: "react" }, e.currentTarget)}>
              <SmilePlus size={16} />
            </IconButton>
            <IconButton label="Reply" tooltip={false} className="bm-action" onClick={() => onReply(m.id)}>
              <CornerUpLeft size={16} />
            </IconButton>
            {mine && !m.poll && (m.text.trim() || !!m.images?.length) && <StashAction text={m.text} images={m.images ?? []} />}
            <CopyAction text={m.html ? m.html.html : m.text || messageText(m)} />
          </div>
        )}
      </div>
      <Reactions message={m} conversation={conversation} bots={bots} mine={mine} onPicker={readonly ? undefined : onPicker} />
      {seen}
    </div>
  );
}, sameRow);

/** The computed styles a bubble gets from where it sits in the conversation, which its lifted copy has to carry along. */
const LIFTED_STYLES = [
  "background-color",
  "background-image",
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  ...["top", "right", "bottom", "left"].flatMap((side) => [`padding-${side}`, `border-${side}-width`, `border-${side}-style`, `border-${side}-color`]),
  ...["top-left", "top-right", "bottom-right", "bottom-left"].map((corner) => `border-${corner}-radius`),
];

/**
 * A bubble's box as it stands, before the press that's sinking it. Its rounded offsetWidth could make
 * the copy one pixel narrower and wrap its text differently.
 */
function unpressedBox(bubble: HTMLElement) {
  const r = bubble.getBoundingClientRect();
  const transform = getComputedStyle(bubble).transform;
  const scale = transform && transform !== "none" ? new DOMMatrix(transform).a || 1 : 1;
  const width = r.width / scale;
  const height = r.height / scale;
  return { left: r.left + (r.width - width) / 2, top: r.top + (r.height - height) / 2, width, height };
}

/** Room left between the lifted bubble, its reactions and its actions. */
const HOLD_GAP = 8;

/**
 * What holding a bubble brings up on a touch screen: the bubble lifted where it was over the blurred
 * conversation, its reactions just above and what else can be done with it just below.
 */
function MessageMenu({ held, conversation, readonly, onClose, onReply }: { held?: { message: BotMessage; bubble: HTMLElement }; conversation: Conversation; readonly: boolean; onClose: () => void; onReply: (id: string) => void }) {
  // Kept through the menu's exit, so it doesn't go blank as it fades away.
  const last = useRef(held);
  if (held) last.current = held;
  const shown = last.current?.message;
  const bubble = last.current?.bubble;
  const { mounted, visible } = usePresence(!!held, 280);
  const root = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const lifted = useRef<HTMLElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number; right: number; flipped: boolean; shift: number }>();
  const [more, setMore] = useState(false);
  const [done, setDone] = useState<"copied" | "stashed">();
  const [selecting, setSelecting] = useState(false);
  const crossStash = useStore((s) => s.settings.crossStash);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!held) return;
    setMore(false);
    setDone(undefined);
    setSelecting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held?.message.id]);

  // A copy of the bubble, styled as it was in its row, rises over the blur while the real one makes way.
  useLayoutEffect(() => {
    if (!mounted || !bubble || !holder.current) return;
    const copy = bubble.cloneNode(true) as HTMLElement;
    const from = getComputedStyle(bubble);
    for (const prop of LIFTED_STYLES) copy.style.setProperty(prop, from.getPropertyValue(prop));
    copy.classList.add("bm-hold-bubble");
    copy.setAttribute("aria-hidden", "true");
    copy.style.boxSizing = "border-box";
    copy.style.width = `${unpressedBox(bubble).width}px`;
    copy.style.maxWidth = "none";
    copy.style.transform = "none";
    copy.style.transition = "none";
    holder.current.replaceChildren(copy);
    lifted.current = copy;
    bubble.style.visibility = "hidden";
    return () => {
      bubble.style.removeProperty("visibility");
      copy.remove();
      lifted.current = null;
    };
  }, [mounted, bubble]);

  useLayoutEffect(() => {
    if (!mounted || !bubble) return;
    const layout = () => {
      const page = root.current;
      const copy = lifted.current;
      if (!page || !copy) return;
      const { left, top, width, height } = unpressedBox(bubble);
      const pad = getComputedStyle(page);
      const at = holdLayout({
        bubbleTop: top,
        bubbleHeight: height,
        bar: bar.current?.offsetHeight ?? 0,
        menu: menu.current?.offsetHeight ?? 0,
        viewTop: parseFloat(pad.paddingTop),
        viewBottom: page.clientHeight - parseFloat(pad.paddingBottom),
        gap: HOLD_GAP,
      });
      copy.style.maxHeight = `${at.bubbleHeight}px`;
      copy.toggleAttribute("data-clipped", at.bubbleHeight < height);
      // The column hangs from the bubble's outer edge: the right for the user's own, the left for a bot's.
      const mine = shown?.author === "me";
      setPlace({
        top: at.top,
        left: mine ? parseFloat(pad.paddingLeft) : left,
        right: mine ? page.clientWidth - left - width : parseFloat(pad.paddingRight),
        flipped: at.flipped,
        shift: at.shift,
      });
    };
    layout();
    // Taking focus puts the keyboard away, and the conversation moves with it.
    window.addEventListener("resize", layout);
    window.visualViewport?.addEventListener("resize", layout);
    return () => {
      window.removeEventListener("resize", layout);
      window.visualViewport?.removeEventListener("resize", layout);
    };
  }, [mounted, bubble, more, shown?.author]);

  const open = !!held;
  useLayoutEffect(() => {
    if (open && mounted) root.current?.focus({ preventScroll: true });
  }, [open, mounted]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);
  useEffect(() => {
    if (!open && selecting) window.getSelection()?.removeAllRanges();
  }, [open, selecting]);

  if (!mounted || !shown) return null;
  const act = (next: "copied" | "stashed") => {
    setDone(next);
    setTimeout(onClose, 500);
  };
  const react = (emoji: string) => {
    const had = shown.reactions?.some((r) => r.by === "me" && r.emoji === emoji && !r.to);
    useBots.getState().toggleReaction(conversation.id, shown.id, emoji, "me");
    if (!had && shown.author !== "me") noticeReaction(shown.author, emoji);
    onClose();
  };
  // The lifted bubble takes the stage alone, its text all selected so the handles can trim it.
  const select = () => {
    const copy = lifted.current;
    if (!copy) return;
    copy.setAttribute("data-selecting", "");
    setSelecting(true);
    const range = document.createRange();
    range.selectNodeContents(copy.querySelector(".bm-text") ?? copy);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };
  const mine = shown.author === "me";
  const text = shown.text || messageText(shown);
  const reacted = (emoji: string) => shown.reactions?.some((r) => r.by === "me" && r.emoji === emoji && !r.to);
  return createPortal(
    <div
      ref={root}
      className="bm-hold-root"
      data-state={visible && place ? "open" : "closed"}
      data-selecting={selecting ? "" : undefined}
      role="dialog"
      aria-modal="true"
      aria-label="Message actions"
      tabIndex={-1}
    >
      <div className="bm-hold-scrim" onClick={onClose} aria-hidden />
      <div
        className="bm-hold-stack"
        data-mine={mine ? "" : undefined}
        data-flipped={place?.flipped ? "" : undefined}
        style={place ? ({ top: place.top, left: place.left, right: place.right, "--hold-shift": `${-place.shift}px` } as React.CSSProperties) : { visibility: "hidden" }}
      >
        {!readonly && (
          <div ref={bar} className="bm-hold-reactions">
            <div className="bm-hold-quick">
              {QUICK.map((e) => (
                <button key={e} type="button" className={cx("bm-react-btn", reacted(e) && "bm-react-btn-on")} onClick={() => react(e)}>
                  {e}
                </button>
              ))}
              <button type="button" className="bm-react-btn bm-react-more" aria-label="More reactions" aria-expanded={more} onClick={() => setMore(!more)}>
                <SmilePlus size={22} />
              </button>
            </div>
            {more && (
              <div className="bm-hold-grid">
                {MORE.map((e) => (
                  <button key={e} type="button" className="bm-react-btn" onClick={() => react(e)}>
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div ref={holder} className="bm-hold-holder" />
        <div ref={menu} className="bm-hold-menu" role="menu">
          {!readonly && (
            <button
              type="button"
              role="menuitem"
              className="bm-hold-item"
              onClick={() => {
                onClose();
                onReply(shown.id);
              }}
            >
              Reply <CornerUpLeft size={18} />
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="bm-hold-item"
            disabled={!text}
            onClick={() => {
              void copyText(text);
              act("copied");
            }}
          >
            {done === "copied" ? "Copied" : "Copy"} {done === "copied" ? <Check size={18} /> : <Copy size={18} />}
          </button>
          {!!shown.text.trim() && !shown.question && !shown.poll && !shown.connect && (
            <button type="button" role="menuitem" className="bm-hold-item" onClick={select}>
              Select <TextSelect size={18} />
            </button>
          )}
          {!readonly && mine && !shown.poll && (shown.text.trim() || !!shown.images?.length) && (
            <button
              type="button"
              role="menuitem"
              className="bm-hold-item"
              onClick={() => {
                botStashOf(crossStash).add(shown.text, imageFiles(shown.images ?? []));
                act("stashed");
              }}
            >
              {done === "stashed" ? "Stashed" : "Stash"} {done === "stashed" ? <Check size={18} /> : <Bookmark size={18} />}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** What a bot says in a chat while it finishes replying in another. Stable per chat, so it doesn't flicker. */
const HOLDING = ["Hold on a second", "Finishing up something", "One moment, wrapping something up", "Be right with you"];
export function holdingLine(conversationId: string, botId: string): string {
  let hash = 0;
  for (const ch of conversationId + botId) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return HOLDING[Math.abs(hash) % HOLDING.length]!;
}

/** Bots at work here but not writing yet: their mascot, fidgeting, and what they're up to. */
function Working({ conversationId, direct, botIds, bots }: { conversationId: string; direct: boolean; botIds: string[]; bots: Bot[] }) {
  const statuses = useBots((s) => s.status);
  return (
    <>
      {botIds.map((id) => {
        const bot = bots.find((b) => b.id === id);
        const activity = holding(statuses[id], conversationId) ? holdingLine(conversationId, id) : statuses[id]?.activity || "Thinking";
        if (!bot) return null;
        // In groups the mascot sits in the avatar column, so the text starts where bubbles do.
        const avatar = <BotAvatar look={bot.look} size={direct ? 30 : 28} busy pulse={{ key: activity, mood: "idle", action: "squish" }} />;
        return (
          <div key={id} className="bm-working" role="status" aria-label={`${bot.name}: ${activity}`}>
            {direct ? avatar : <span className="bm-avatar">{avatar}</span>}
            <span key={activity} className="bm-working-text shimmer">
              {activity}
            </span>
          </div>
        );
      })}
    </>
  );
}

function Typing({ conversation, botIds, bots }: { conversation: Conversation; botIds: string[]; bots: Bot[] }) {
  const drafts = useBots((s) => s.drafts);
  return (
    <>
      {botIds.map((id) => {
        const bot = bots.find((b) => b.id === id);
        if (!bot) return null;
        const draft = drafts.find((d) => d.conversationId === conversation.id && d.botId === id)?.text;
        return (
          // No name: names belong to sent messages. Same avatar column and row as those, so it lines up.
          <div key={id} className="bm-group bm-theirs">
            <div className="bm-group-row">
              {conversation.kind !== "direct" && (
                <span className="bm-avatar">
                  <BotAvatar look={bot.look} size={28} mood="thinking" />
                </span>
              )}
              <div className="bm-stack">
                <div className="bm-row bm-recv" data-pos="single">
                  <div className="bm-line">
                    {draft ? (
                      <div className="bm-bubble">
                        <div className="bm-text">
                          <RichText text={draft} bots={bots} everyone={everyoneIn(conversation, bots)} botId={id} />
                        </div>
                      </div>
                    ) : (
                      <div className="bm-typing" role="status" aria-label={`${bot.name} is typing`}>
                        <i />
                        <i />
                        <i />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

/** A message the conversation is held by while scrolled up: where its top is from an edge of the view. */
type Spot = { id: string; offset: number };
/**
 * Which edge: while the chat is open, the bottom, so the last line you could see stays put as the
 * composer or keyboard changes the view. Opened again, the top, so it reads from where it was left
 * even when the view is a different height now (a status bar above it, say).
 */
type Edge = "top" | "bottom";

/**
 * Where each chat was left in this tab, by workspace and conversation: at its latest message, or at
 * the message the user had scrolled up to. Opening it again goes back there, and never to another
 * chat's place, or to the place of a chat with the same id in another workspace.
 */
const places = new Map<string, { stick: boolean; top?: Spot }>();

/** Where `row` starts in `scroller`'s content, from layout alone, so a bubble animating in doesn't throw it off. */
function contentTop(row: HTMLElement, scroller: HTMLElement) {
  const top = (el: HTMLElement | null) => {
    let y = 0;
    for (; el; el = el.offsetParent as HTMLElement | null) y += el.offsetTop;
    return y;
  };
  return top(row) - top(scroller);
}

const edgeOf = (scroller: HTMLElement, edge: Edge) => scroller.scrollTop + (edge === "bottom" ? scroller.clientHeight : 0);

// A folded run of activity holds its lines hidden, with no place of their own: its toggle stands for them.
const SPOT_ROWS = ".bm-row[data-id], .bm-event[data-id], .bm-events-toggle[data-id]";

/**
 * The last message starting above the bottom of the view, or the first still showing at its top.
 * Found by the chat's blocks first, then only among the rows of the blocks at that edge: blocks out of
 * view skip layout (content-visibility), and reading a row inside one lays it out there and then.
 */
function spotIn(scroller: HTMLElement, edge: Edge): Spot | undefined {
  const at = edgeOf(scroller, edge);
  const blocks = [...(scroller.querySelector(".bots-messages-inner")?.children ?? [])] as HTMLElement[];
  const rowsOf = (block: HTMLElement) => (block.matches(SPOT_ROWS) ? [block] : [...block.querySelectorAll<HTMLElement>(SPOT_ROWS)]).filter((r) => r.offsetParent);
  if (edge === "bottom") {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]!;
      if (!block.offsetParent || contentTop(block, scroller) >= at) continue;
      const row = rowsOf(block).findLast((r) => contentTop(r, scroller) < at);
      if (row) return { id: row.dataset.id!, offset: contentTop(row, scroller) - at };
    }
    return undefined;
  }
  for (const block of blocks) {
    if (!block.offsetParent || contentTop(block, scroller) + block.offsetHeight <= at) continue;
    const row = rowsOf(block).find((r) => contentTop(r, scroller) + r.offsetHeight > at);
    if (row) return { id: row.dataset.id!, offset: contentTop(row, scroller) - at };
  }
  return undefined;
}

/** Scrolls the spot's message back to where it was from that edge. False when its message is gone. */
function putBack(scroller: HTMLElement, spot: Spot | undefined, edge: Edge) {
  const row = spot && scroller.querySelector<HTMLElement>(`[data-id="${CSS.escape(spot.id)}"]`);
  if (!row) return false;
  scroller.scrollTop = contentTop(row, scroller) - spot!.offset - (edge === "bottom" ? scroller.clientHeight : 0);
  return true;
}

/**
 * Lets the chat's rows out of view skip rendering (bots.css, bots-messages-settled), once a frame has
 * laid them all out while it showed: each then keeps that height while skipped, so nothing is placed
 * by an estimate. A frame that sees the chat shown is followed by the one that sets it.
 */
function settleRows(scroller: HTMLElement) {
  let seen = false;
  const step = () => {
    if (!scroller.isConnected) return;
    if (seen) return void scroller.classList.add("bots-messages-settled");
    seen = scroller.clientHeight > 0;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** `since`: messages after it are new, and animate in. */
const Messages = memo(function Messages({ conversation, since, onReply }: { conversation: Conversation; since: number; onReply: (id: string) => void }) {
  const bots = useBots((s) => s.bots);
  const pulses = useBots((s) => s.pulses);
  const typing = useBots((s) => s.typing[conversation.id] ?? EMPTY);
  const draftCount = useBots((s) => s.drafts.filter((d) => d.conversationId === conversation.id).length);
  const working = useBots(useShallow((s) => showWorking(conversation.id, s.status, typing)));
  // In a group, the mascots beside messages doze unless their bot is at work, as the huddle's do.
  const busy = useBusyBots(conversation.kind === "direct" ? undefined : conversation);
  const focus = useBots((s) => (s.focus?.conversationId === conversation.id ? s.focus : undefined));
  // Until Pi can run it, the primary bot's chat says what's missing instead of the bot saying hello.
  const setup = useBots((s) => s.setup);
  const primary = setup && conversation.kind === "direct" ? bots.find((b) => b.id === conversation.botIds[0] && b.primary) : undefined;
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  // The chat is keyed by its workspace too (see BotsView), so this one's is fixed for its life.
  const [place] = useState(() => `${useBots.getState().workspace ?? ""}:${conversation.id}`);
  const [left] = useState(() => places.get(place));
  /** Attached: keep to the bottom as things arrive. Any scroll up by the user detaches, and from then on
   *  only they move the view; scrolling all the way back down attaches it again. */
  const stick = useRef(left?.stick ?? true);
  /** Where the chat last moved the view itself, so that scroll isn't taken for the user's. */
  const moved = useRef(-1);
  const lastTop = useRef(0);
  /** Off the bottom, the message the view keeps in place as content above or below it changes. */
  const spot = useRef<Spot>(undefined);
  /** And the one at the top of the view, for opening the chat here again. */
  const top = useRef(left?.stick === false ? left.top : undefined);
  const [away, setAway] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const [picker, setPicker] = useState<Picker>();
  const [showAll, setShowAll] = useState(false);
  const [held, setHeld] = useState<{ id: string; bubble: HTMLElement }>();
  // The same functions every render, so a row that hasn't changed isn't drawn again.
  const onHold = useCallback((id: string, bubble: HTMLElement) => setHeld({ id, bubble }), []);
  const onPicker = useCallback((p: Picker, el: HTMLElement) => {
    anchor.current = el;
    setShowAll(false);
    setPicker((cur) => (cur?.messageId === p.messageId && cur.what === p.what && cur.to === p.to ? undefined : p));
  }, []);
  const sending = useBots((s) => s.sending);
  const touchY = useRef(0);
  const readonly = conversation.kind === "side";
  const group = conversation.kind !== "direct";
  // A bot's error ("couldn't reply") is news, not history: it shows for a minute, then goes.
  const [now, setNow] = useState(Date.now);
  const shown = useMemo(() => conversation.messages.filter((m) => !(m.event?.kind === "error" && now - m.at >= ERROR_SHOWN_MS)), [conversation.messages, now]);
  useEffect(() => {
    const due = conversation.messages.filter((m) => m.event?.kind === "error" && now - m.at < ERROR_SHOWN_MS).map((m) => m.at + ERROR_SHOWN_MS);
    if (!due.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(...due) - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [conversation.messages, now]);
  const blocks = useMemo(() => blocksOf(shown), [shown]);
  const oldPages = useMemo(() => botPagesOld(conversation.messages), [conversation.messages]);
  const lastMine = conversation.messages.findLast((m) => m.author === "me" && !m.event);
  const last = conversation.messages.at(-1);
  const lastSeen = useRef(last?.id);

  const restore = () => {
    const el = scroller.current;
    if (!el) return false;
    const back = putBack(el, spot.current, "bottom");
    moved.current = el.scrollTop;
    return back;
  };
  const detach = () => {
    if (stick.current) remember();
    stick.current = false;
  };
  const remember = () => {
    const el = scroller.current;
    // Hidden (behind a thread, say), there's no layout to read a place from.
    if (!el?.clientHeight) return;
    // A run opening or folding holds its toggle still until it has finished moving.
    if (!(pin.current && performance.now() < pin.current.until)) spot.current = spotIn(el, "bottom");
    top.current = spotIn(el, "top");
  };
  /** A toggle being held still on screen while its run opens or folds, and until when. */
  const pin = useRef<{ until: number }>(undefined);
  /** Room kept below the chat after a run folds near its end, so the view doesn't drop with it. */
  const spacer = useRef<HTMLDivElement>(null);
  const slack = useRef(0);
  const setSlack = (px: number) => {
    slack.current = px;
    if (spacer.current) spacer.current.style.height = px ? `${px}px` : "";
  };
  /** Following the bottom: the room kept after a fold isn't needed any more. */
  const followBottom = (el: HTMLElement) => {
    if (slack.current) setSlack(0);
    el.scrollTop = el.scrollHeight;
  };
  /** Down to just the room the view stands on now: nothing on screen moves, and none is left to scroll into. */
  const trimSlack = () => {
    const el = scroller.current;
    if (!el || !slack.current || (pin.current && performance.now() < pin.current.until)) return;
    const need = Math.max(0, Math.ceil(el.scrollTop + el.clientHeight - (el.scrollHeight - slack.current)));
    if (need < slack.current) setSlack(need);
  };
  useEffect(() => () => void places.set(place, { stick: stick.current, top: top.current }), [place]);
  // Opening or folding a run of activity (EventRun) keeps the view where it is, even at the bottom:
  // the lines open under their toggle, which stays put, rather than the chat following them down.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    keepViews.set(el, (toggle, folding, body) => {
      stick.current = false;
      // Not the line at the bottom of the view (it may be in the run that's folding away), but the toggle.
      if (el.clientHeight) {
        spot.current = { id: toggle.dataset.id!, offset: contentTop(toggle, el) - (el.scrollTop + el.clientHeight) };
        pin.current = { until: performance.now() + 700 };
      }
      // Folding near the end would leave the view nothing to stand on, and the browser would pull it up:
      // keep that room, down to what the view needs once the fold is done, and less as the reader scrolls up.
      if (folding && body) {
        setSlack(slack.current + body.offsetHeight);
        setTimeout(trimSlack, 720);
      }
    });
    return () => void keepViews.delete(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow new messages while at the bottom, and always after the user's own. New bubbles animate
  // in, so the jump itself can be instant. Scrolled up, what's in view stays there, whatever comes in
  // above it (older messages, a snapshot from the server) or below. Opened again, it's where it was left.
  const count = conversation.messages.length + typing.length + draftCount + working.length;
  const opened = useRef(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (last?.author === "me" && last.id !== lastSeen.current) stick.current = true;
    lastSeen.current = last?.id;
    if (!opened.current) {
      // Hidden from the start, it's opened once it's shown.
      if (!el.clientHeight) return;
      opened.current = true;
      settleRows(el);
      if (!stick.current && !putBack(el, top.current, "top")) stick.current = true;
      moved.current = el.scrollTop;
    } else if (!stick.current) restore();
    if (stick.current) followBottom(el);
    // Held from here on by what's now in view, so the resize observer's first look doesn't undo it.
    remember();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, conversation.messages]);
  // Content that changes afterwards (an image loading, a reaction, "Seen", the reply bar shrinking the
  // view) keeps it there too.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !inner.current) return;
    const coarse = window.matchMedia("(pointer: coarse)");
    let height = el.clientHeight;
    let windowHeight = window.innerHeight;
    const observer = new ResizeObserver(() => {
      if (!el.clientHeight) return;
      const changed = el.clientHeight !== height;
      const resized = window.innerHeight !== windowHeight;
      height = el.clientHeight;
      windowHeight = window.innerHeight;
      if (stick.current) followBottom(el);
      // The keyboard coming up, or the composer growing and shrinking with the draft, keeps the last line
      // you could see above it, as it does in any messaging app. A desktop window resized keeps its top.
      else if (changed && resized && !coarse.matches) remember();
      else restore();
    });
    observer.observe(inner.current);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A quote followed scrolls to its message once. Done with, so the chat opened again, or shown again
  // from behind a thread, is where the user left it rather than back at the quote.
  useEffect(() => {
    if (!focus) return;
    useBots.setState((s) => (s.focus?.key === focus.key ? { focus: undefined } : {}));
    const el = scroller.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(focus.messageId)}"]`);
    if (!el) return;
    stick.current = false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("bm-flash");
    void el.offsetWidth;
    el.classList.add("bm-flash");
  }, [focus]);

  const picked = picker ? conversation.messages.find((m) => m.id === picker.messageId) : undefined;
  const heldMessage = held ? conversation.messages.find((m) => m.id === held.id) : undefined;
  const closePicker = () => setPicker(undefined);
  /** Toggles the user's `emoji` on the picked message, or on the reaction it answers. */
  const pick = (emoji: string) => {
    if (!picked || !picker) return;
    const had = picked.reactions?.some((r) => r.by === "me" && r.emoji === emoji && r.to === picker.to);
    st.toggleReaction(conversation.id, picked.id, emoji, "me", picker.to);
    const author = picker.to ? picker.answering : picked.author;
    if (!had && author && author !== "me") noticeReaction(author, emoji);
    closePicker();
  };
  const st = useBots.getState();

  return (
    <div
      ref={scroller}
      className="bots-messages"
      // Detach on intent, before the browser's own smooth scrolling starts, so following never fights it.
      onWheel={(e) => e.deltaY < 0 && detach()}
      onTouchStart={(e) => (touchY.current = e.touches[0]!.clientY)}
      onTouchMove={(e) => {
        const y = e.touches[0]!.clientY;
        // A finger moving down scrolls the chat up.
        if (y > touchY.current) detach();
        // Dragging the conversation down puts the keyboard away, to read more of it.
        if (y - touchY.current > 24) composerField()?.blur();
      }}
      // So does tapping somewhere in it that isn't a control. Only touch screens have a keyboard to put away.
      onClick={(e) => {
        if (window.matchMedia("(pointer: coarse)").matches && !(e.target as Element).closest("button, a, input, textarea")) composerField()?.blur();
      }}
      onKeyDown={(e) => (["ArrowUp", "PageUp", "Home"].includes(e.key) || (e.key === " " && e.shiftKey)) && detach()}
      onScroll={(e) => {
        const el = e.currentTarget;
        if (!el.clientHeight) return;
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        const ours = Math.abs(el.scrollTop - moved.current) < 1;
        moved.current = -1;
        const delta = el.scrollTop - lastTop.current;
        lastTop.current = el.scrollTop;
        // All the way down attaches; any way up detaches (a scrollbar drag too, which sends nothing else).
        // The chat's own moves only ever keep the view where it was, so they decide neither. The end of the
        // room kept after a fold isn't the bottom of the chat: it doesn't attach until that room is gone.
        if (!ours && gap <= 2 && !slack.current) stick.current = true;
        else if (!ours && delta < 0) stick.current = false;
        // The room kept after a fold goes as the reader moves up, a pixel for a pixel: never all at once.
        trimSlack();
        remember();
        setAway(gap > 400);
      }}
    >
      <div ref={inner} className="bots-messages-inner">
        {conversation.more && <button type="button" className="btn bots-btn" disabled={loadingOlder} onClick={async () => {
          if (loadingOlder || !scroller.current) return;
          setLoadingOlder(true);
          // What's in view stays there as the older messages come in above it.
          stick.current = false;
          remember();
          await useBots.getState().loadOlder(conversation.id);
          setLoadingOlder(false);
        }}>{loadingOlder ? "Loading older messages…" : "Load older messages"}</button>}
        {blocks.map((b) => {
          if (b.kind === "divider")
            return (
              <div key={b.key} className="bm-divider">
                {dividerTime(b.at)}
              </div>
            );
          if (b.kind === "events") {
            const key = b.messages[0]!.id;
            if (b.messages.length === 1) return <EventLine key={key} message={b.messages[0]!} bots={bots} fresh={b.messages[0]!.at > since} />;
            return <EventRun key={key} messages={b.messages} bots={bots} since={since} />;
          }
          const mine = b.author === "me";
          const bot = mine ? undefined : bots.find((x) => x.id === b.author);
          // A friend's message: their bot, named with its friend, or the friend themselves.
          const from = mine || bot ? undefined : b.messages[0]!.from;
          return (
            <div key={b.messages[0]!.id} className={cx("bm-group", mine ? "bm-mine" : "bm-theirs")}>
              {group && !mine && (
                <div className="bm-name">
                  {from ? (
                    <>
                      {from.owner ? from.friendName : from.name}
                      <span className="bm-name-friend">{from.owner ? " · friend" : ` · ${from.friendName}`}</span>
                    </>
                  ) : (
                    bot?.name ?? "Deleted bot"
                  )}
                </div>
              )}
              <div className="bm-group-row">
                {group && !mine && <BotProfileHover bot={bot}>
                  <span className="bm-avatar">
                    {bot ? <BotAvatar look={bot.look} size={28} asleep={!busy.includes(bot.id)} pulse={pulses[bot.id]} /> : from?.owner ? <Avatar name={from.friendName} size={28} /> : from ? <BotAvatar look={from.look ?? FRIEND_LOOK} size={28} alive={false} /> : null}
                  </span>
                </BotProfileHover>}
                <div className="bm-stack">
                  {b.messages.map((m, i) => {
                    const n = b.messages.length;
                    const seenBy = m === lastMine && m.seenBy?.length ? m.seenBy : undefined;
                    return (
                      <MessageRow
                        key={m.id}
                        message={m}
                        conversation={conversation}
                        bots={bots}
                        pos={n === 1 ? "single" : i === 0 ? "first" : i === n - 1 ? "last" : "middle"}
                        fresh={m.at > since}
                        readonly={readonly}
                        onReply={onReply}
                        onHold={onHold}
                        onPicker={onPicker}
                        sending={mine && sending.includes(m.id)}
                        oldPage={oldPages.has(m.id)}
                        seen={
                          seenBy && (
                            <div className="bm-seen">
                              {group ? (
                                <>
                                  Seen by
                                  {seenBy.map((id) => {
                                    const r = bots.find((x) => x.id === id);
                                    return r ? <BotAvatar key={id} look={r.look} size={14} alive={false} /> : null;
                                  })}
                                </>
                              ) : (
                                "Seen"
                              )}
                            </div>
                          )
                        }
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
        {setup && primary && <PiSetupNotice setup={setup} bot={primary} />}
        <Working conversationId={conversation.id} direct={conversation.kind === "direct"} botIds={working} bots={bots} />
        <Typing conversation={conversation} botIds={typing} bots={bots} />
        <div ref={spacer} className="bm-slack" aria-hidden />
      </div>
      {away && (
        <button type="button" className="bm-jump" aria-label="Jump to latest" onClick={() => {
            stick.current = true;
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
          }}>
          <ArrowDown size={16} />
        </button>
      )}
      <Popover open={!!picker && picker.what === "react"} onClose={closePicker} anchor={anchor} className="bm-react-pop" role="menu" label="React" fixed="up" align={picker?.mine ? "end" : "start"}>
        <div className="bm-react-quick">
          {QUICK.map((e) => (
            <button
              key={e}
              type="button"
              className={cx("bm-react-btn", picked?.reactions?.some((r) => r.by === "me" && r.emoji === e && r.to === picker?.to) && "bm-react-btn-on")}
              onClick={() => pick(e)}
            >
              {e}
            </button>
          ))}
          <button type="button" className="bm-react-btn bm-react-more" aria-label="More reactions" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
            <SmilePlus size={17} />
          </button>
        </div>
        {showAll && (
          <div className="bm-react-grid">
            {MORE.map((e) => (
              <button
                key={e}
                type="button"
                className="bm-react-btn"
                onClick={() => pick(e)}
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </Popover>
      <MessageMenu held={heldMessage && held && { message: heldMessage, bubble: held.bubble }} conversation={conversation} readonly={readonly} onClose={() => setHeld(undefined)} onReply={onReply} />
    </div>
  );
});

/** One activity line: who did what, and what it was about. */
const EventLine = memo(function EventLine({ message: m, bots, fresh, hidden, index, times = 1 }: { message: BotMessage; bots: Bot[]; fresh: boolean; hidden?: boolean; index?: number; times?: number }) {
  const event = m.event!;
  // The bot the detail names, by id, so it still links after a rename. A thread's detail is a
  // PR or thread title, not a mention, so a bot name inside it stays plain text.
  const eventBot = event.bot ? bots.find((x) => x.id === event.bot) : undefined;
  // A bot's own activity names it first, looked up by author so a rename shows up on old lines
  // too. A line that already names a bot ("Juniper left", a message, a model switch) keeps its words.
  const author = m.author === "me" ? undefined : bots.find((x) => x.id === m.author);
  const authored = author && !namesBot(eventText(event), bots) ? authoredEventText(event) : undefined;
  // A message between bots names the other bot by id, so a rename shows up on old lines too.
  const messaged = event.kind === "message" && event.conversationId ? eventBot : undefined;
  // A side chat several bots went off to ("Dr is talking it over with Tracer and Manager") links to it.
  const huddled = event.kind === "message" && event.conversationId && !event.bot ? event.conversationId : undefined;
  // A change of model names the bot and the model it moved to, with its account only when the bot has two of that model.
  const switcher = event.kind === "model" ? bots.find((x) => x.id === m.author) : undefined;
  const detail = eventDetail(event);
  const switchedTo = eventText(event).replace(/^Switched to /, "") + (event.kind === "model" && detail ? ` (${accountName(detail)})` : "");
  // A change of settings ("Juniper's model: A → B") names its bot by id too, so a rename shows up on old lines.
  const changed = event.kind === "changed" && eventBot ? settingsChange(event.text) : undefined;
  return (
    // A long one (an error's whole path, say) shows a few lines on a phone; tapping it shows the rest.
    <div className={cx("bm-event", fresh && "bm-recv")} data-id={m.id} hidden={hidden} style={index === undefined ? undefined : ({ "--i": index } as React.CSSProperties)} onClick={(e) => e.currentTarget.classList.toggle("bm-event-open")}>
      <span className="bm-event-text">
        {authored ? <><BotLink bot={author!} /> {authored}</> : huddled ? <><WithBotLinks text={eventText(event)} bots={bots} /> · <ConversationLink id={huddled}>Read along</ConversationLink></> : messaged ? <MessageActivity event={event} other={messaged} /> : switcher ? <><BotLink bot={switcher} /> switched to {switchedTo}</> : changed ? <><BotLink bot={eventBot!} />'s {changed}</> : <WithBotLinks text={eventText(event)} bots={bots} />}
      </span>
      {event.kind !== "model" && detail && (
        <span className="bm-event-detail">
          {event.threadId || event.kind === "thread" ? <EventThread event={event} /> : eventBot ? <BotLink bot={eventBot} /> : <WithBotLinks text={detail} bots={bots} />}
        </span>
      )}
      {times > 1 && (
        <span className="bm-event-times" aria-label={`${times} times`}>
          ×{times}
        </span>
      )}
    </div>
  );
});

/**
 * A run's lines with repeats folded: each line that does just what the one before it did (same bot, same
 * words, same detail) gets times 0, and the first of them how many there are in a row.
 */
function repeats(messages: BotMessage[]): { m: BotMessage; times: number }[] {
  const key = (m: BotMessage) => JSON.stringify([m.author, m.event?.kind, m.event?.text, m.event?.detail, m.event?.bot, m.event?.threadId, m.event?.conversationId]);
  const out: { m: BotMessage; times: number }[] = [];
  let first: { m: BotMessage; times: number } | undefined;
  for (const m of messages) {
    if (first && key(first.m) === key(m)) {
      first.times++;
      out.push({ m, times: 0 });
    } else {
      first = { m, times: 1 };
      out.push(first);
    }
  }
  return out;
}

/** How long a bot's error line stays in the chat. */
export const ERROR_SHOWN_MS = 60_000;

/** Each chat's way to hold its view still, for a run's toggle to call as it opens or folds (Messages). */
const keepViews = new WeakMap<HTMLElement, (toggle: HTMLElement, folding: boolean, body: HTMLElement | null) => void>();
/** How long a run takes to fold away (bots.css, .bm-events-body). */
const RUN_FOLD_MS = 260;

/**
 * Activity lines in a row, folded into one: the bots behind them and how many things they did. Opened,
 * each line shows as it would on its own. Folded, they're still there (hidden), so finding a line by
 * its id, or reading its words, works either way.
 */
const EventRun = memo(function EventRun({ messages, bots, since }: { messages: BotMessage[]; bots: Bot[]; since: number }) {
  const [open, setOpen] = useState(false);
  // Folding, the lines stay for as long as they take to fold away (bots.css), then hide.
  const [folding, setFolding] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!folding) return;
    const timer = setTimeout(() => setFolding(false), RUN_FOLD_MS);
    return () => clearTimeout(timer);
  }, [folding]);
  const who = [...new Set(messages.map((m) => m.author))].flatMap((id) => bots.find((b) => b.id === id) ?? []);
  const fresh = messages.every((m) => m.at > since);
  return (
    <div className={cx("bm-events", fresh && "bm-recv")} data-open={open || undefined} data-folding={folding || undefined}>
      <button
        type="button"
        className="bm-events-toggle"
        aria-expanded={open}
        data-id={`run-${messages[0]!.id}`}
        onClick={(e) => {
          const chat = e.currentTarget.closest<HTMLElement>(".bots-messages");
          if (chat) keepViews.get(chat)?.(e.currentTarget, open, body.current);
          setFolding(open && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
          setOpen(!open);
        }}
      >
        {who.length > 0 && <Mascots bots={who.slice(0, 3)} size={14} />}
        <span>{messages.length} background actions</span>
        <ChevronRight className="bm-events-chevron" size={13} strokeWidth={2} aria-hidden />
      </button>
      {/* The same thing done again and again, with nothing between, shows once with how many times. The
          repeats stay in the page, hidden, so finding a line by its id still works. */}
      <div ref={body} className="bm-events-body">
        <div>
          {repeats(messages).map(({ m, times }, i) =>
            times === 0 ? (
              <EventLine key={m.id} message={m} bots={bots} fresh={false} hidden />
            ) : (
              <EventLine key={m.id} message={m} bots={bots} fresh={open && m.at > since} hidden={!open && !folding} index={i} times={times} />
            ),
          )}
        </div>
      </div>
    </div>
  );
});

/** The longest edge a picked image keeps: a full-HD screenshot stays 1:1, a Retina one is halved. */
const IMAGE_EDGE = 2048;
/** A data URL's length to stay under, leaving room below the server's 2.5 MB limit per image. */
const IMAGE_BUDGET = 2_000_000;

/**
 * Fit a picked image into what the bot receives. Screenshots stay sharp enough to read: one that
 * already fits is kept as it is, a PNG stays a PNG (text compresses well losslessly), and only an
 * image over the budget becomes a JPEG, at the highest quality that fits.
 */
async function shrink(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Couldn't read that image");
  }
  try {
    const original = Math.max(bitmap.width, bitmap.height) <= IMAGE_EDGE && /^image\/(png|jpeg|webp|gif)$/.test(file.type) && (await readAsDataUrl(file));
    if (original && original.length <= IMAGE_BUDGET) return original;
    let edge = Math.min(IMAGE_EDGE, Math.max(bitmap.width, bitmap.height));
    for (;;) {
      const k = edge / Math.max(bitmap.width, bitmap.height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * k));
      canvas.height = Math.max(1, Math.round(bitmap.height * k));
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (file.type === "image/png") {
        const png = canvas.toDataURL("image/png");
        if (png.length <= IMAGE_BUDGET) return png;
      }
      for (const quality of [0.92, 0.85, 0.75]) {
        const jpeg = canvas.toDataURL("image/jpeg", quality);
        if (jpeg.length <= IMAGE_BUDGET || edge <= 512) return jpeg;
      }
      edge = Math.round(edge * 0.75);
    }
  } finally {
    bitmap.close();
  }
}

function readAsDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** The draft drawn behind the (transparent) textarea, so @mentions show as tags while you type. */
function DraftBackdrop({ text, bots, everyone, scroll }: { text: string; bots: Bot[]; everyone: Bot[]; scroll: React.RefObject<HTMLDivElement | null> }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const { start, end, bot } of tagsIn(text, bots, everyone)) {
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      bot ? (
        <span key={start} className="bots-draft-mention" style={{ "--mention": colorOf(bot.look).hex } as React.CSSProperties}>
          <MentionAt bot={bot} />
          {text.slice(start + 1, end)}
        </span>
      ) : (
        // The textarea's caret needs the tag exactly as wide as its text, so the mascots squeeze into that.
        <span key={start} className="bots-draft-mention bots-draft-all">
          {text.slice(start, end)}
          <Mascots bots={everyone} size={12} />
        </span>
      ),
    );
    last = end;
  }
  // A trailing newline needs something after it to take up its line.
  parts.push(text.slice(last) + "\u200b");
  return (
    <div ref={scroll} className="bots-composer-input bots-draft" aria-hidden>
      {parts}
    </div>
  );
}

/** A draft from another device doesn't replace the text while you've typed within this long. */
const TYPING_PAUSE = 3000;

/** How far each chat's draft was scrolled, for the text it was scrolled in. Local to this page, as the caret is. */
const draftScrolls = new Map<string, { text: string; top: number }>();

type Unsent = { text: string; images: string[] };
/** A message that didn't go, put back in front of what's been typed since. */
const withUnsent = (sent: Unsent, now: Unsent): Unsent => ({
  text: !sent.text.trim() ? now.text : !now.text.trim() ? sent.text : `${sent.text}\n${now.text}`,
  images: [...sent.images, ...now.images.filter((src) => !sent.images.includes(src))],
});
/** The other way round: a draft saved with a message in it, once the message has gone. */
const withoutSent = (draft: Unsent, sent: Unsent): Unsent => {
  const at = draft.text === sent.text ? 0 : sent.text.trim() ? draft.text.indexOf(`${sent.text}\n`) : -1;
  const text = at < 0 ? draft.text : draft.text.slice(0, at) + draft.text.slice(at + sent.text.length + 1);
  return { text: draft.text === sent.text ? "" : text, images: draft.images.filter((src) => !sent.images.includes(src)) };
};
const sameImages = (a: string[], b: string[]) => a.length === b.length && a.every((src, i) => src === b[i]);
/**
 * Messages that didn't reach the workspace and went back to their composer, by draft key. Sent again
 * as they were, each keeps its id, and the workspace takes a message only once, so a retry of one that
 * did land after all (or of one also retried from the not-confirmed list) can't make a second.
 */
const unsent = new Map<string, (Unsent & { id: string })[]>();

function Composer({ conversation, replyTo, onReply }: { conversation: Conversation; replyTo?: string; onReply: (id?: string) => void }) {
  const bots = useBots((s) => s.bots);
  // With nothing typed and a bot at work, the send button is the stop button.
  const canStop = useBots((s) => stoppable(conversation, s.status).length > 0);
  // Unsent text is the workspace's, like the conversation it's for.
  const [workspace] = useState(() => useBots.getState().workspace ?? "");
  const local = isLocalWorkspace(workspace);
  const draftKey = botDraftKey(workspace, conversation.id);
  const [text, setText] = useState(() => getBotDraft(workspace, conversation.id, local)?.text ?? "");
  const [images, setImages] = useState<string[]>(() => getBotDraft(workspace, conversation.id, local)?.images ?? []);
  const lastTyped = useRef(0);
  /** Sent and cleared from the box, not confirmed yet. Kept in the saved draft until then, so a reload can't lose one. */
  const flying = useRef<Unsent[]>([]);
  const [landed, setLanded] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const replyRef = useRef(replyTo);
  replyRef.current = replyTo;
  /** What's in the box. A send empties it here at once, so a second Enter before the next render sends nothing. */
  const box = useRef<Unsent>({ text, images });
  box.current = { text, images };
  const [mention, setMention] = useState<{ query: string; index: number }>();
  const [notice, setNotice] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const dictation = useFieldDictation({ value: text, setValue: setText, field: input, onError: setNotice, fallback: true });
  const file = useRef<HTMLInputElement>(null);
  const touch = useMediaQuery("(pointer: coarse)");
  const phone = useMediaQuery("(max-width: 768px)");
  const [adding, setAdding] = useState(false);
  // A chat shared with a friend carries text only: photos and polls would stay on this side.
  const textOnly = !!conversation.friend;
  const name = conversationName(conversation, bots);
  const quoted = replyTo ? conversation.messages.find((m) => m.id === replyTo) : undefined;
  const members = bots.filter((b) => conversation.botIds.includes(b.id));
  const everyone = everyoneIn(conversation, bots);
  const query = mention?.query.toLowerCase();
  // The whole group comes last, so a bare "@" and Enter still picks one bot rather than waking them all.
  const ranked = query === undefined || conversation.kind !== "group" ? [] : matchMentionBots(members, query);
  const everyoneAt = query !== undefined && conversation.kind === "group" && members.length > 1 ? mentionBroadcastAt(ranked, query) : -1;
  const matches = ranked.map((b) => ({ id: b.id, tag: mentionName(b.name), label: b.name, bots: [b] }));
  if (everyoneAt >= 0) matches.splice(everyoneAt, 0, { id: "all", tag: "all", label: "All bots", bots: members });
  const stash = botStashOf(useStore((s) => s.settings.crossStash));
  const stashed = stash.use((s) => s.items);
  const [stashOpen, setStashOpen] = useState(false);
  const [stashIndex, setStashIndex] = useState(0);
  const [polling, setPolling] = useState(false);
  const stashList = stashOpen ? stashed : [];

  // Right after a reload the saved drafts may still be loading; fill them in unless typing has started.
  useEffect(() => {
    let live = true;
    void draftsReady.then(() => {
      const d = getBotDraft(workspace, conversation.id, local);
      if (!live || !d) return;
      setText((t) => t || d.text);
      setImages((i) => (i.length ? i : d.images));
    });
    // An edit from another device shows up here, unless you're typing in this box right now.
    const off = onRemoteDraft((key) => {
      if (key !== botDraftKey(workspace, conversation.id) || Date.now() - lastTyped.current < TYPING_PAUSE) return;
      const d = getBotDraft(workspace, conversation.id, local);
      setText(d?.text ?? "");
      setImages(d?.images ?? []);
    });
    return () => {
      live = false;
      off();
    };
  }, [conversation.id]);
  // Save the draft as it changes (not on mount, which would stamp an untouched draft as fresh).
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) {
      const d = flying.current.reduceRight((now, sent) => withUnsent(sent, now), { text, images });
      saveBotDraft(workspace, conversation.id, d.text, d.images, local);
    }
    mounted.current = true;
  }, [text, images, landed]);

  // Measuring lays out the whole page, and coming back to OpenBots runs this again: skipped when the text is the same.
  const sized = useRef<{ el: HTMLTextAreaElement; text: string }>(undefined);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || (sized.current?.el === el && sized.current.text === text)) return;
    sized.current = { el, text };
    // The row holds its height while the box is measured. Collapsing it for a moment would make the
    // conversation taller, and the browser would pull it up off the bottom to fit, a line per keystroke.
    // (Not the field: the box stretches to fill that, and would measure as tall as it was.)
    const row = el.closest<HTMLElement>(".bots-composer-row");
    if (row) row.style.minHeight = `${row.offsetHeight}px`;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    if (row) row.style.minHeight = "";
  }, [text]);
  // Back in a chat, its caret and selection are where they were left, also when the saved draft loads
  // after mount. Typing and selecting save the live caret first, so restoring keeps it.
  useLayoutEffect(() => {
    if (input.current) restoreDraftSelection(draftKey, input.current);
  }, [text]);
  // And a draft taller than the box is scrolled where it was. Again on showing OpenBots, which hides it.
  useLayoutEffect(() => {
    const el = input.current;
    const saved = draftScrolls.get(draftKey);
    if (el && saved?.text === el.value) el.scrollTop = saved.top;
  }, []);
  const keepPlace = (el: HTMLTextAreaElement) => {
    rememberDraftSelection(draftKey, el);
    draftScrolls.set(draftKey, { text: el.value, top: el.scrollTop });
  };
  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) input.current?.focus();
  }, []);
  // A transcript belongs to the conversation it was started in.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => dictation.cancel(), [conversation.id]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(undefined), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  /**
   * The message shows in the conversation and the box empties at once, in the same frame. If the
   * workspace doesn't take it, it comes back to the box, ahead of anything typed since.
   */
  const send = () => {
    const sent = box.current;
    const { images } = sent;
    const body = sent.text.trim();
    if (!body && !images.length) return;
    box.current = { text: "", images: [] };
    dictation.cancel();
    const conversationId = conversation.id;
    const key = draftKey;
    const quoting = replyTo;
    const again = unsent.get(key)?.find((u) => u.text === body && sameImages(u.images, images));
    if (again) unsent.set(key, unsent.get(key)!.filter((u) => u !== again));
    const id = again?.id ?? uid();
    flying.current = [...flying.current, sent];
    setText("");
    setImages([]);
    setMention(undefined);
    onReply(undefined);
    void useBots.getState().post(conversationId, { id, author: "me", text: body, images: images.length ? images : undefined, replyTo: quoting }).then((acknowledged) => {
      flying.current = flying.current.filter((f) => f !== sent);
      // Not confirmed, but the workspace's own snapshot shows it arrived after all.
      const m = acknowledged ?? useBots.getState().conversations.find((c) => c.id === conversationId)?.messages.find((x) => x.id === id);
      if (m) {
        if (alive.current) setLanded((n) => n + 1);
        else {
          // Its chat was left meanwhile, with the message still in the saved draft.
          const d = getBotDraft(workspace, conversationId, local);
          const next = d && withoutSent(d, sent);
          if (d && next && (next.text !== d.text || next.images.length !== d.images.length)) saveBotDraft(workspace, conversationId, next.text, next.images, local);
        }
        respond(conversationId, m);
        return;
      }
      unsent.set(key, [...(unsent.get(key) ?? []), { id, text: body, images }]);
      // A chat that was left keeps the message in its saved draft already.
      if (!alive.current) return;
      const el = input.current;
      const caret = el && document.activeElement === el ? { el, start: el.selectionStart, end: el.selectionEnd } : undefined;
      let shift = 0;
      setText((now) => {
        const next = withUnsent(sent, { text: now, images: [] }).text;
        shift = next.length - now.length;
        return next;
      });
      setImages((now) => withUnsent({ text: "", images }, { text: "", images: now }).images);
      if (quoting && !replyRef.current) onReply(quoting);
      setNotice("Not sent. It's back in the box to send again.");
      // The caret stays in what was being typed, or goes to the end of the message put back.
      requestAnimationFrame(() => {
        if (caret && document.activeElement === caret.el) caret.el.setSelectionRange(caret.start + shift, caret.end + shift);
      });
    });
  };
  const pasteStashed = (item: Stashed) => {
    dictation.cancel();
    const next = pasteBotStash({ text, images }, item);
    setText(next.text);
    setImages(next.images);
    if (next.left > 0) setNotice(next.left === 1 ? "Left out 1 file OpenBots can't take." : `Left out ${next.left} files OpenBots can't take.`);
    stash.remove(item.id);
    setStashOpen(false);
    setMention(undefined);
    requestAnimationFrame(() => {
      const el = input.current;
      el?.focus();
      el?.setSelectionRange(next.text.length, next.text.length);
    });
  };
  const toggleStash = () => {
    setStashIndex(0);
    setStashOpen((open) => !open);
  };
  /** The stash shortcut, while OpenBots is showing. */
  const onStashShortcut = () => {
    const action = stashAction(!!text.trim() || images.length > 0, stashed.length);
    if (action === "stash") {
      dictation.cancel();
      stash.add(text, imageFiles(images));
      setText("");
      setImages([]);
      setMention(undefined);
      setStashOpen(false);
      input.current?.focus();
    } else if (action === "use") {
      pasteStashed(stashed[0]!);
    } else if (action === "open") {
      toggleStash();
      input.current?.focus();
    }
  };
  const stashShortcut = useRef(onStashShortcut);
  stashShortcut.current = onStashShortcut;
  useEffect(() => {
    const onShortcut = (e: Event) => {
      if ((e as CustomEvent<ShortcutEventDetail>).detail?.action === "stashDraft" && useStore.getState().botsOpen) stashShortcut.current();
    };
    window.addEventListener(SHORTCUT_EVENT, onShortcut);
    return () => window.removeEventListener(SHORTCUT_EVENT, onShortcut);
  }, []);
  const findMention = (value: string, caret: number) => {
    // The query can run over spaces ("@Dr Eg") for as long as it still starts someone's name.
    const m = /(?:^|\s)@([^@\n]*)$/u.exec(value.slice(0, caret));
    const query = m?.[1];
    const open = query !== undefined && (/^[\p{L}\d_-]*$/u.test(query) || matchMentionBots(members, query).length > 0);
    setMention(open ? { query, index: 0 } : undefined);
  };
  const insertMention = (tag: string) => {
    const el = input.current!;
    const caret = el.selectionStart;
    const after = text.slice(caret);
    // Step over a space that's already there rather than doubling it.
    const spaced = /^\s/.test(after);
    const before = text.slice(0, caret).replace(/@([^@\n]*)$/u, () => `@${tag}${spaced ? after[0] : " "}`);
    const next = before + (spaced ? after.slice(1) : after);
    setText(next);
    setMention(undefined);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  return (
    <div className="bots-dock">
      {polling && <PollDialog conversationId={conversation.id} onClose={() => setPolling(false)} />}
      <Sheet open={adding} onClose={() => setAdding(false)} label="Add to message">
        <button
          type="button"
          className="sheet-item"
          onClick={() => {
            setAdding(false);
            file.current?.click();
          }}
        >
          <ImagePlus size={20} /> Add images
        </button>
        <button
          type="button"
          className="sheet-item"
          onClick={() => {
            setAdding(false);
            setPolling(true);
          }}
        >
          <ListChecks size={20} /> New poll
        </button>
      </Sheet>
      {stashed.length > 0 && (
        <StashTray items={stashed} open={stashList.length > 0} active={Math.min(stashIndex, stashed.length - 1)} onToggle={toggleStash} onClose={() => setStashOpen(false)} onHover={setStashIndex} onUse={pasteStashed} onRemove={stash.remove} />
      )}
      <form
        className="bots-composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          if (textOnly) return;
          const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
          if (!files.length) return;
          e.preventDefault();
          void Promise.all(files.slice(0, 4).map((f) => shrink(f))).then((urls) => setImages((cur) => [...cur, ...urls].slice(0, 4)));
        }}
      >
        {matches.length > 0 && (
          <div className="bots-mentions" role="listbox" aria-label="Mention a bot">
            {matches.map((m, i) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={i === mention!.index % matches.length}
                className="menu-item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertMention(m.tag)}
              >
                <Mascots bots={m.bots} size={22} />
                <span className="menu-item-label">{m.label}</span>
              </button>
            ))}
          </div>
        )}
        {quoted && (
          <div className="bots-reply-bar">
            <CornerUpLeft size={14} />
            <span className="bots-reply-who">Replying to {authorName(quoted.author, bots, quoted.from).split(" ·")[0]}</span>
            <span className="bots-reply-text">{messageLine(quoted)}</span>
            <IconButton label="Cancel reply" tooltip={false} className="bots-reply-x" onClick={() => onReply(undefined)}>
              <X size={14} />
            </IconButton>
          </div>
        )}
        {notice && <div className="bots-composer-notice">{notice}</div>}
        {images.length > 0 && (
          <div className="bots-composer-images">
            {images.map((src, i) => (
              <span key={i} className="bots-composer-image">
                <button type="button" className="bots-composer-image-open" aria-label="Preview image" onClick={() => openLightbox(images.map((src, j) => ({ id: `draft-${j}`, name: "Image", dataUrl: src })), `draft-${i}`)}>
                  <img src={src} alt="" />
                </button>
                <button type="button" className="bots-composer-image-remove" aria-label="Remove image" onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="bots-composer-row">
          {textOnly ? null : phone ? (
            // One button, so the text gets the width. Only a group has more than images to offer.
            <IconButton
              label={conversation.kind === "group" ? "Add to message" : "Add images"}
              tooltip={false}
              className="bots-composer-btn bots-composer-add"
              onClick={() => (conversation.kind === "group" ? setAdding(true) : file.current?.click())}
            >
              <Plus size={22} />
            </IconButton>
          ) : (
            <>
              <IconButton label="Add images" tooltip="Add images" tooltipSide="top" className="bots-composer-btn" onClick={() => file.current?.click()}>
                <ImagePlus size={18} />
              </IconButton>
              {conversation.kind === "group" && (
                <IconButton label="New poll" tooltip="New poll" tooltipSide="top" className="bots-composer-btn" onClick={() => setPolling(true)}>
                  <ListChecks size={18} />
                </IconButton>
              )}
            </>
          )}
          <input
            ref={file}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])].slice(0, 4);
              e.target.value = "";
              void Promise.all(files.map((f) => shrink(f))).then((urls) => setImages((cur) => [...cur, ...urls].slice(0, 4)));
            }}
          />
          <div className="bots-composer-field">
          <DraftBackdrop text={text} bots={bots} everyone={everyone} scroll={backdrop} />
          <textarea
            ref={input}
            className="bots-composer-input bots-composer-textarea"
            rows={1}
            value={text}
            placeholder={`Message ${name}`}
            aria-label={`Message ${name}`}
            autoCapitalize="sentences"
            autoCorrect="on"
            enterKeyHint={touch ? "enter" : "send"}
            {...dictation.fieldProps}
            onChange={(e) => {
              lastTyped.current = Date.now();
              keepPlace(e.currentTarget);
              setText(e.target.value);
              setStashOpen(false);
              findMention(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => keepPlace(e.currentTarget)}
            onScroll={(e) => {
              if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop;
              // Not while OpenBots is hidden, which takes the box's scroll away.
              if (e.currentTarget.offsetParent) keepPlace(e.currentTarget);
            }}
            onPaste={(e) => {
              if (textOnly) return;
              const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
              if (!files.length) return;
              e.preventDefault();
              void Promise.all(files.slice(0, 4).map((f) => shrink(f))).then((urls) => setImages((cur) => [...cur, ...urls].slice(0, 4)));
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (stashList.length) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const n = stashList.length;
                  setStashIndex((i) => (Math.min(i, n - 1) + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  pasteStashed(stashList[Math.min(stashIndex, stashList.length - 1)]!);
                  return;
                }
              }
              if (matches.length && mention) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setMention({ ...mention, index: (mention.index + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length });
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  insertMention(matches[mention.index % matches.length]!.tag);
                  return;
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setMention(undefined);
                  return;
                }
              }
              // A mention goes as one piece: backspacing into it selects the whole tag, and the native delete removes it.
              if (e.key === "Backspace" && !e.altKey && !e.metaKey && !e.ctrlKey) {
                const el = e.currentTarget;
                const caret = el.selectionStart;
                const hit = caret === el.selectionEnd ? tagsIn(text, bots, everyone).find((m) => m.end === caret) : undefined;
                if (hit) el.setSelectionRange(hit.start, caret);
              }
              if (e.key === "Escape" && replyTo) {
                e.stopPropagation();
                onReply(undefined);
              }
              // On touch screens Enter is a new line and the send button sends.
              if (e.key === "Enter" && !e.shiftKey && !touch) {
                e.preventDefault();
                send();
              }
            }}
          />
          </div>
          <DictationButton dictation={dictation} className="icon-btn bots-composer-btn bots-mic" size={18} />
          {canStop && !text.trim() && !images.length ? (
            <button type="button" className="bots-send bots-send-on bots-stop" aria-label="Stop" title="Stop" onMouseDown={(e) => e.preventDefault()} onClick={() => useBots.getState().stopWork(conversation.id)}>
              <Square size={13} strokeWidth={0} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              className={cx("bots-send", (!!text.trim() || images.length > 0) && "bots-send-on")}
              aria-label="Send"
              disabled={!text.trim() && !images.length}
              // Keep focus (and the keyboard) in the field, ready for the next message.
              onMouseDown={(e) => e.preventDefault()}
            >
              <ArrowUp size={18} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

export function BotChat({ conversation }: { conversation: Conversation }) {
  const bots = useBots((s) => s.bots);
  // The details panel is where a bot is set up, which another device's workspace keeps to itself.
  const remote = !!useRemoteWorkspace();
  const detailsOpen = useBots((s) => s.detailsOpen) && !remote;
  const typing = useBots((s) => (s.typing[conversation.id]?.length ?? 0) > 0);
  // What the other side is up to, under the name on a phone, where there's a bar for it.
  const activity = useBots((s) => {
    const working = conversation.botIds.map((id) => s.status[id]).find((st) => workingHere(st, conversation.id) && !st!.quiet);
    if (working) return working.activity || "Thinking";
    const held = conversation.botIds.find((id) => holding(s.status[id], conversation.id));
    return held ? holdingLine(conversation.id, held) : undefined;
  });
  // Its mascot fidgets while it's busy, here or elsewhere, as the sidebar's does; a group's others doze.
  const working = useBusyBots(conversation);
  const busy = working.length > 0;
  // Busy in another chat: said as that, never as thinking here.
  const away = useBots((s) => {
    const first = elsewhere(conversation, s.status)[0];
    if (!first) return undefined;
    const there = s.conversations.find((c) => c.id === first.conversationId);
    const where = there && !there.hidden ? `Busy in ${conversationName(there, s.bots)}` : "Busy in another chat";
    if (conversation.kind === "direct") return where;
    const bot = s.bots.find((b) => b.id === first.botId);
    // In a group, a bot busy in its own 1:1 would read "Researcher: busy in Researcher".
    if (there?.kind === "direct") return `${bot ? firstName(bot) : "A bot"} is busy in another chat`;
    return `${bot ? firstName(bot) : "A bot"}: ${where[0]!.toLowerCase()}${where.slice(1)}`;
  });
  // Waiting elsewhere, on the back button.
  const unread = useBots((s) => s.conversations.filter((c) => c.unread && c.id !== conversation.id && !c.hidden).length);
  const mobile = useMediaQuery("(max-width: 768px)");
  const [replyTo, setReplyTo] = useState<string>();
  // Kept here, not in Messages: a new bot's first message mounts the list, and should still animate in.
  const [openedAt] = useState(Date.now);
  const name = conversationName(conversation, bots);
  const sideBots = conversation.kind === "side" ? conversation.botIds.map((id) => bots.find((b) => b.id === id)?.name.split(" ·")[0] ?? "A bot") : [];
  const members = conversation.kind === "direct" ? "" : [...conversation.botIds.map((id) => firstName(bots.find((b) => b.id === id) ?? ({ name: "A bot" } as Bot))), ...(conversation.friend?.members.map((m) => m.name.split(/\s+/)[0]!) ?? [])].join(", ");
  const sub = typing ? "typing…" : activity ?? away ?? members;
  const repo = useStore((s) => conversationRepo(conversation, s.chats));
  return (
    <div className="bots-chat">
      <div className="bots-head">
        {mobile && (
          <IconButton label={unread ? `Back to chats, ${unread} unread` : "Back to chats"} tooltip={false} className="bots-head-side" onClick={() => closeBotsLayer("chat")}>
            <ChevronLeft size={28} />
            {unread > 0 && <span className="bots-head-unread">{unread}</span>}
          </IconButton>
        )}
        <button type="button" className="bots-head-pill" aria-expanded={remote ? undefined : detailsOpen} disabled={remote} onClick={() => (mobile ? openBotsDetails() : useBots.getState().setDetailsOpen(!detailsOpen))}>
          {mobile ? (
            <>
              <ConversationAvatar conversation={conversation} size={36} busy={busy} working={working} mood={typing ? "thinking" : undefined} badge={false} />
              <span className="bots-head-text">
                <span className="bots-head-name">{name}</span>
                {sub && <span className={cx("bots-head-sub", (typing || activity) && "bots-head-sub-live")}>{sub}</span>}
              </span>
              {!remote && <HeadTasks conversation={conversation} mobile />}
            </>
          ) : (
            <>
              {/* The bots one by one; their name and a chevron to the details open out from them on hover
                  (bots.css, .bots-head-reveal), and stay while the details are open. */}
              <ConversationAvatar conversation={conversation} size={20} busy={busy} working={working} mood={typing ? "thinking" : undefined} badge={false} lineup />
              <span className="bots-head-reveal">
                <span>
                  <span>
                    <span className="bots-head-name">{name}</span>
                    {!typing && !activity && away && <span className="bots-head-away">{away}</span>}
                  </span>
                </span>
              </span>
              {!remote && <HeadTasks conversation={conversation} mobile={false} />}
              {!remote && (
                <span className="bots-head-reveal bots-head-reveal-chevron">
                  <span>
                    <span>
                      <ChevronRight className="bots-head-chevron" size={15} strokeWidth={2} aria-hidden />
                    </span>
                  </span>
                </span>
              )}
            </>
          )}
        </button>
      </div>
      <PullRepo.Provider value={repo}>
        <Messages conversation={conversation} since={openedAt} onReply={setReplyTo} />
      </PullRepo.Provider>
      {conversation.kind === "side" ? (
        <div className="bots-dock">
          <div className="bots-side-note">
            {conversation.huddle?.closedAt
              ? `This side chat has closed. ${sideBots[conversation.botIds.indexOf(conversation.huddle.by)] ?? "The bot that opened it"} reports back.`
              : `${sideBots.length > 2 ? `${sideBots.slice(0, -1).join(", ")} and ${sideBots.at(-1)}` : sideBots.join(" and ")} are talking between themselves. You can read along; they'll bring anything you need to decide back to you.`}
          </div>
        </div>
      ) : (
        <Composer conversation={conversation} replyTo={replyTo} onReply={setReplyTo} />
      )}
    </div>
  );
}
