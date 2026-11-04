// An OpenBots conversation, chat style: bubbles grouped by who sent them, a time between messages
// far apart, reactions both ways, replies that quote what they answer, and bots typing. Group
// chats name each bot over its messages; side chats between bots are read-only.
import { ArrowDown, ArrowUp, Bookmark, Check, CircleDashed, CircleDot, Copy, CornerUpLeft, ImagePlus, ListChecks, PanelLeft, SmilePlus, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { noticeAnswer, noticeReaction, respond } from "../../lib/bots/engine";
import { colorOf } from "../../lib/bots/looks";
import { conversationName, directOf, useBots } from "../../lib/bots/store";
import type { Bot, BotMessage, Conversation, Reaction } from "../../lib/bots/types";
import { findTags, mentionName, pollVotesVisible, pollWaitingOn, reactionId } from "../../../shared/bots";
import { threadPath } from "../../lib/routes";
import { useStore } from "../../lib/store";
import { useShallow } from "zustand/react/shallow";
import { copyText, cx, useMediaQuery } from "../../lib/ui";
import { Linkify, WebLink } from "../Linkify";
import { openLightbox } from "../Lightbox";
import { DictationButton } from "../DictationButton";
import { useFieldDictation } from "../../lib/useFieldDictation";
import { IconButton, Popover } from "../primitives";
import { StashTray } from "../StashTray";
import { botStashOf, imageFiles, pasteBotStash, stashAction, type Stashed } from "../../lib/stash";
import { SHORTCUT_EVENT, type ShortcutEventDetail } from "../../lib/shortcuts";
import { BotAvatar } from "./BotAvatar";
import { PollDialog } from "./BotDialogs";
import { authorName, ConversationAvatar, dividerTime, messageText } from "./common";

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
const firstName = (b: Bot) => b.name.split(/\s+/)[0]!;
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️){1,12}$/u;

/** A bot named in the chat, with its mascot, linking to its thread. */
function BotLink({ bot }: { bot: Bot }) {
  const thread = useBots((s) => directOf(s.conversations, bot.id)?.id);
  if (!thread) return <>{bot.name}</>;
  return (
    <button type="button" className="bm-bot-link" onClick={() => useBots.getState().select(thread)}>
      <BotAvatar look={bot.look} size={16} alive={false} />
      <span>{bot.name}</span>
    </button>
  );
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text with every bot it names linked. Longer names first, so "Sage Two" wins over "Sage". */
function WithBotLinks({ text, bots }: { text: string; bots: Bot[] }) {
  const named = bots.filter((b) => b.name.trim()).sort((a, b) => b.name.length - a.name.length);
  if (!named.length) return <>{text}</>;
  const pattern = new RegExp(`(?<![\\p{L}\\d])(?:${named.map((b) => escapeRegExp(b.name)).join("|")})(?![\\p{L}\\d])`, "gu");
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(<BotLink key={start} bot={named.find((b) => b.name === m[0])!} />);
    last = start + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
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

/** An @mention in the bot's colour, opening its thread. */
function Mention({ bot, text }: { bot: Bot; text: string }) {
  const thread = useBots((s) => directOf(s.conversations, bot.id)?.id);
  const style = { "--mention": colorOf(bot.look).hex } as React.CSSProperties;
  const body = (
    <>
      <MentionAt bot={bot} />
      {text.slice(1)}
    </>
  );
  if (!thread) return <span className="bm-mention" style={style}>{body}</span>;
  return (
    <button type="button" className="bm-mention bm-mention-link" style={style} onClick={() => useBots.getState().select(thread)}>
      {body}
    </button>
  );
}

/** Keep normal browser link actions while plain clicks use the app's thread navigation. */
function ThreadLink({ id, children }: { id: string; children: React.ReactNode }) {
  return <a className="link" href={threadPath(id)} onClick={(e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    useStore.getState().selectChat(id);
  }}>{children}</a>;
}

/** Only link IDs that resolve uniquely to a known thread; ordinary hex text stays text. */
function ThreadReferences({ text, fileHref }: { text: string; fileHref?: (url: string) => string }) {
  const chats = useStore((s) => s.chats);
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/\b(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{8})\b/gi)) {
    const matches = chats.filter((c) => c.id.toLowerCase() === m[0].toLowerCase() || c.id.toLowerCase().startsWith(m[0].toLowerCase() + "-"));
    if (matches.length !== 1) continue;
    // Let the URL renderer own IDs inside URLs.
    const token = text.slice(0, m.index).match(/[^\s]*$/)?.[0] ?? "";
    if (/[/:]/.test(token)) continue;
    parts.push(<Linkify key={last} text={text.slice(last, m.index)} fileHref={fileHref} bare />);
    parts.push(<ThreadLink key={m.index + "-thread"} id={matches[0]!.id}>{m[0]}</ThreadLink>);
    last = m.index + m[0].length;
  }
  parts.push(<Linkify key="end" text={text.slice(last)} fileHref={fileHref} bare />);
  return <>{parts}</>;
}

/** Plain text with @mentions and links. */
function WithMentions({ text, bots, everyone, fileHref }: { text: string; bots: Bot[]; everyone: Bot[]; fileHref?: (url: string) => string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const { start, end, bot } of tagsIn(text, bots, everyone)) {
    if (start > last) parts.push(<ThreadReferences key={last} text={text.slice(last, start)} fileHref={fileHref} />);
    parts.push(bot ? <Mention key={start} bot={bot} text={text.slice(start, end)} /> : <MentionAll key={start} everyone={everyone} text={text.slice(start, end)} />);
    last = end;
  }
  if (last < text.length) parts.push(<ThreadReferences key={last} text={text.slice(last)} fileHref={fileHref} />);
  return <>{parts}</>;
}

/** Bold, inline code, [Markdown](https://links), bare links and @mentions (in the mentioned bot's colour). */
const RichText = memo(function RichText({ text, bots, everyone, botId }: { text: string; bots: Bot[]; everyone: Bot[]; botId?: string }) {
  const fileHref = botId ? (url: string) => `/api/bots/${encodeURIComponent(botId)}/file?url=${encodeURIComponent(url)}` : undefined;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
    const start = m.index ?? 0;
    if (start > last) parts.push(<WithMentions key={last} text={text.slice(last, start)} bots={bots} everyone={everyone} fileHref={fileHref} />);
    if (m[1]) parts.push(<code key={start}><ThreadReferences text={m[1]} fileHref={fileHref} /></code>);
    else if (m[2]) parts.push(<strong key={start}><WithMentions text={m[2]} bots={bots} everyone={everyone} fileHref={fileHref} /></strong>);
    else parts.push(<WebLink key={start} url={m[4]!}>{m[3]}</WebLink>);
    last = start + m[0].length;
  }
  if (last < text.length) parts.push(<WithMentions key={last} text={text.slice(last)} bots={bots} everyone={everyone} fileHref={fileHref} />);
  return <>{parts}</>;
});

type Block = { kind: "divider"; at: number; key: string } | { kind: "event"; message: BotMessage } | { kind: "group"; author: string; messages: BotMessage[] };

function blocksOf(all: BotMessage[]): Block[] {
  // Memory happens in the background; older chats can still hold these.
  const messages = all.filter((m) => m.event?.kind !== "memory");
  const blocks: Block[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    if (!prev || m.at - prev.at > DIVIDER_GAP || !sameDay(prev.at, m.at)) blocks.push({ kind: "divider", at: m.at, key: `d-${m.id}` });
    if (m.event) return blocks.push({ kind: "event", message: m });
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
              style={{ "--share": `${poll.votes.length ? (by.length / poll.votes.length) * 100 : 0}%` } as React.CSSProperties}
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

function Reactions({ message, conversation, bots, mine }: { message: BotMessage; conversation: Conversation; bots: Bot[]; mine: boolean }) {
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
                  <span className="bm-reaction-emoji">{emoji}</span>
                  {reactors.slice(0, 2).map((b) => (
                    <BotAvatar key={b.id} look={b.look} size={14} alive={false} mood="happy" />
                  ))}
                  {by.length > 1 && <span className="bm-reaction-count">{by.length}</span>}
                </button>
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
  seen?: React.ReactNode;
}

const MessageRow = memo(function MessageRow({ message: m, conversation, bots, pos, fresh, readonly, onReply, onPicker, seen }: RowProps) {
  const mine = m.author === "me";
  const quoted = m.replyTo ? conversation.messages.find((x) => x.id === m.replyTo) : undefined;
  const emojiOnly = !m.images?.length && !m.question && !m.plan && !m.poll && EMOJI_ONLY.test(m.text.replace(/\s/g, ""));
  const card = !!(m.question || m.plan || m.poll);
  const everyone = useMemo(() => everyoneIn(conversation, bots), [conversation.kind, conversation.botIds, bots]);
  const react = (emoji: string) => {
    const had = m.reactions?.some((r) => r.by === "me" && r.emoji === emoji && !r.to);
    useBots.getState().toggleReaction(conversation.id, m.id, emoji, "me");
    if (!had && !mine) noticeReaction(m.author, emoji);
  };
  return (
    <div className={cx("bm-row", fresh && (mine ? "bm-send" : "bm-recv"))} data-pos={pos} data-id={m.id}>
      {quoted && (
        <button type="button" className="bm-quote" onClick={() => useBots.getState().focusMessage(conversation.id, quoted.id)}>
          <CornerUpLeft size={12} />
          <span className="bm-quote-who">{authorName(quoted.author, bots).split(" ·")[0]}</span>
          <span className="bm-quote-text">{messageText(quoted)}</span>
        </button>
      )}
      <div className="bm-line">
        <div
          className={cx("bm-bubble", emojiOnly && "bm-emoji", card && "bm-card")}
          onDoubleClick={readonly ? undefined : (e) => {
            if ((e.target as Element).closest("button, a")) return;
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
          {m.text && !m.question && !m.poll && (
            <div className="bm-text">
              <RichText text={m.text} bots={bots} everyone={everyone} botId={m.author === "me" ? undefined : m.author} />
            </div>
          )}
          {m.question && <QuestionCard conversation={conversation} message={m} />}
          {m.poll && <PollCard conversation={conversation} message={m} bots={bots} />}
          {m.plan && <PlanCard message={m} bots={bots} />}
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
            <CopyAction text={m.text || messageText(m)} />
          </div>
        )}
      </div>
      <Reactions message={m} conversation={conversation} bots={bots} mine={mine} />
      {seen}
    </div>
  );
});

/** Bots at work here but not writing yet: their mascot, fidgeting, and what they're up to. */
function Working({ botIds, bots }: { botIds: string[]; bots: Bot[] }) {
  const statuses = useBots((s) => s.status);
  return (
    <>
      {botIds.map((id) => {
        const bot = bots.find((b) => b.id === id);
        const activity = statuses[id]?.activity || "Thinking";
        if (!bot) return null;
        return (
          <div key={id} className="bm-working" role="status" aria-label={`${bot.name}: ${activity}`}>
            <BotAvatar look={bot.look} size={30} busy pulse={{ key: activity, mood: "idle", action: "squish" }} />
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
          <div key={id} className="bm-group bm-theirs bm-typing-group">
            {conversation.kind !== "direct" && (
              <div className="bm-name" style={{ "--who": colorOf(bot.look).hex } as React.CSSProperties}>
                {bot.name}
              </div>
            )}
            <div className="bm-group-row">
              {conversation.kind !== "direct" && (
                <span className="bm-avatar">
                  <BotAvatar look={bot.look} size={28} mood="thinking" />
                </span>
              )}
              <div className="bm-stack">
                <div className="bm-row bm-recv" data-pos="single">
                  {draft ? (
                    <div className="bm-bubble">
                      <div className="bm-text">
                        <RichText text={draft} bots={bots} everyone={everyoneIn(conversation, bots)} botId={id} />
                      </div>
                    </div>
                  ) : (
                    <div className="bm-bubble bm-typing" role="status" aria-label={`${bot.name} is typing`}>
                      <i />
                      <i />
                      <i />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

/** `since`: messages after it are new, and animate in. */
function Messages({ conversation, since, onReply }: { conversation: Conversation; since: number; onReply: (id: string) => void }) {
  const bots = useBots((s) => s.bots);
  const pulses = useBots((s) => s.pulses);
  const typing = useBots((s) => s.typing[conversation.id] ?? EMPTY);
  const draftCount = useBots((s) => s.drafts.filter((d) => d.conversationId === conversation.id).length);
  const working = useBots(
    useShallow((s) => Object.entries(s.status).filter(([id, st]) => st.state === "working" && st.conversationId === conversation.id && !st.quiet && !typing.includes(id)).map(([id]) => id)),
  );
  const focus = useBots((s) => (s.focus?.conversationId === conversation.id ? s.focus : undefined));
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  /** Keep to the bottom as things arrive. Off once the user scrolls up, on again when they're back down. */
  const stick = useRef(true);
  const userScrolled = useRef(0);
  const [away, setAway] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const prepend = useRef<{ height: number; top: number } | undefined>(undefined);
  const anchor = useRef<HTMLElement | null>(null);
  const [picker, setPicker] = useState<Picker>();
  const [showAll, setShowAll] = useState(false);
  const readonly = conversation.kind === "side";
  const group = conversation.kind !== "direct";
  const blocks = useMemo(() => blocksOf(conversation.messages), [conversation.messages]);
  const lastMine = conversation.messages.findLast((m) => m.author === "me" && !m.event);

  // Follow new messages while at the bottom, and always after the user's own. New bubbles animate
  // in, so the jump itself can be instant.
  const count = conversation.messages.length + typing.length + draftCount + working.length;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prepend.current) {
      el.scrollTop = prepend.current.top + el.scrollHeight - prepend.current.height;
      prepend.current = undefined;
      return;
    }
    if (conversation.messages.at(-1)?.author === "me") stick.current = true;
    if (stick.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);
  // Content that grows afterwards (a reaction, "Seen", the reply bar shrinking the view) keeps it there too.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !inner.current) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner.current);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!focus) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(focus.messageId)}"]`);
    if (!el) return;
    stick.current = false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("bm-flash");
    void el.offsetWidth;
    el.classList.add("bm-flash");
  }, [focus]);

  const picked = picker ? conversation.messages.find((m) => m.id === picker.messageId) : undefined;
  const closePicker = () => setPicker(undefined);
  const st = useBots.getState();

  return (
    <div
      ref={scroller}
      className="bots-messages"
      onWheel={() => (userScrolled.current = Date.now())}
      onTouchMove={() => (userScrolled.current = Date.now())}
      onKeyDown={() => (userScrolled.current = Date.now())}
      onScroll={(e) => {
        const el = e.currentTarget;
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (gap < 60) stick.current = true;
        else if (Date.now() - userScrolled.current < 600) stick.current = false;
        setAway(gap > 400);
      }}
    >
      <div ref={inner} className="bots-messages-inner">
        {conversation.more && <button type="button" className="btn bots-btn" disabled={loadingOlder} onClick={async () => {
          if (loadingOlder || !scroller.current) return;
          setLoadingOlder(true);
          stick.current = false;
          prepend.current = { height: scroller.current.scrollHeight, top: scroller.current.scrollTop };
          await useBots.getState().loadOlder(conversation.id);
          setLoadingOlder(false);
          requestAnimationFrame(() => { prepend.current = undefined; });
        }}>{loadingOlder ? "Loading older messages…" : "Load older messages"}</button>}
        {blocks.map((b) => {
          if (b.kind === "divider")
            return (
              <div key={b.key} className="bm-divider">
                {dividerTime(b.at)}
              </div>
            );
          if (b.kind === "event") {
            const m = b.message;
            // The bot the detail names, by id, so it still links after a rename.
            const eventBot = m.event!.bot ? bots.find((x) => x.id === m.event!.bot) : undefined;
            return (
              <div key={m.id} className={cx("bm-event", m.at > since && "bm-recv")} data-id={m.id}>
                <span className="bm-event-text">
                  <WithBotLinks text={m.event!.text} bots={bots} />
                </span>
                {m.event!.detail && (
                  <span className="bm-event-detail">
                    {m.event!.kind === "routine" && <ClockGlyph />}
                    {m.event!.threadId ? <ThreadLink id={m.event!.threadId}>{m.event!.detail}</ThreadLink> : eventBot ? <BotLink bot={eventBot} /> : <WithBotLinks text={m.event!.detail} bots={bots} />}
                  </span>
                )}
              </div>
            );
          }
          const mine = b.author === "me";
          const bot = mine ? undefined : bots.find((x) => x.id === b.author);
          return (
            <div key={b.messages[0]!.id} className={cx("bm-group", mine ? "bm-mine" : "bm-theirs")}>
              {group && !mine && (
                <div className="bm-name" style={{ "--who": bot ? colorOf(bot.look).hex : undefined } as React.CSSProperties}>
                  {bot?.name ?? "Deleted bot"}
                </div>
              )}
              <div className="bm-group-row">
                {group && !mine && <span className="bm-avatar">{bot && <BotAvatar look={bot.look} size={28} pulse={pulses[bot.id]} />}</span>}
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
                        onPicker={(p, el) => {
                          anchor.current = el;
                          setShowAll(false);
                          setPicker((cur) => (cur?.messageId === p.messageId && cur.what === p.what ? undefined : p));
                        }}
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
        <Working botIds={working} bots={bots} />
        <Typing conversation={conversation} botIds={typing} bots={bots} />
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
              className={cx("bm-react-btn", picked?.reactions?.some((r) => r.by === "me" && r.emoji === e && !r.to) && "bm-react-btn-on")}
              onClick={() => {
                if (!picked) return;
                const had = picked.reactions?.some((r) => r.by === "me" && r.emoji === e && !r.to);
                st.toggleReaction(conversation.id, picked.id, e, "me");
                if (!had && picked.author !== "me") noticeReaction(picked.author, e);
                closePicker();
              }}
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
                onClick={() => {
                  if (!picked) return;
                  st.toggleReaction(conversation.id, picked.id, e, "me");
                  if (picked.author !== "me") noticeReaction(picked.author, e);
                  closePicker();
                }}
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </Popover>
    </div>
  );
}

function ClockGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** Shrink a picked image so it fits in this browser's storage alongside everything else. */
function shrink(file: File, max = 720): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * k);
      canvas.height = Math.round(img.height * k);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that image"));
    };
    img.src = url;
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

function Composer({ conversation, replyTo, onReply }: { conversation: Conversation; replyTo?: string; onReply: (id?: string) => void }) {
  const bots = useBots((s) => s.bots);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [mention, setMention] = useState<{ query: string; index: number }>();
  const [notice, setNotice] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const dictation = useFieldDictation({ value: text, setValue: setText, field: input, onError: setNotice, fallback: true });
  const file = useRef<HTMLInputElement>(null);
  const touch = useMediaQuery("(pointer: coarse)");
  const name = conversationName(conversation, bots);
  const quoted = replyTo ? conversation.messages.find((m) => m.id === replyTo) : undefined;
  const members = bots.filter((b) => conversation.botIds.includes(b.id));
  const everyone = everyoneIn(conversation, bots);
  const query = mention?.query.toLowerCase();
  // The whole group comes last, so a bare "@" and Enter still picks one bot rather than waking them all.
  const matches =
    query === undefined || conversation.kind !== "group"
      ? []
      : [
          ...members.filter((b) => mentionName(b.name).toLowerCase().startsWith(query)).map((b) => ({ id: b.id, tag: mentionName(b.name), label: b.name, bots: [b] })),
          ...(members.length > 1 && ["all", "everyone"].some((w) => w.startsWith(query)) ? [{ id: "all", tag: "all", label: "All bots", bots: members }] : []),
        ];
  const stash = botStashOf(useStore((s) => s.settings.crossStash));
  const stashed = stash.use((s) => s.items);
  const [stashOpen, setStashOpen] = useState(false);
  const [stashIndex, setStashIndex] = useState(0);
  const [polling, setPolling] = useState(false);
  const stashList = stashOpen ? stashed : [];

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);
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

  const send = async () => {
    const body = text.trim();
    if (sendingRef.current || (!body && !images.length)) return;
    dictation.cancel();
    sendingRef.current = true;
    setSending(true);
    try {
      const m = await useBots.getState().post(conversation.id, { author: "me", text: body, images: images.length ? images : undefined, replyTo });
      if (!m) return; // Keep the entire draft until the server acknowledges it.
      setText((current) => current === text ? "" : current);
      setImages((current) => current.filter((src) => !images.includes(src)));
      setMention(undefined);
      onReply(undefined);
      respond(conversation.id, m);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
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
    if (sendingRef.current) return;
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
    const open = query !== undefined && (/^[\p{L}\d_-]*$/u.test(query) || members.some((b) => mentionName(b.name).toLowerCase().startsWith(query.toLowerCase())));
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
          if (sending) return;
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
            <span className="bots-reply-who">Replying to {authorName(quoted.author, bots).split(" ·")[0]}</span>
            <span className="bots-reply-text">{messageText(quoted)}</span>
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
                <img src={src} alt="" />
                <button type="button" aria-label="Remove image" disabled={sending} onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="bots-composer-row">
          <IconButton label="Add images" tooltip="Add images" tooltipSide="top" className="bots-composer-btn" disabled={sending} onClick={() => file.current?.click()}>
            <ImagePlus size={18} />
          </IconButton>
          {conversation.kind === "group" && (
            <IconButton label="New poll" tooltip="New poll" tooltipSide="top" className="bots-composer-btn" disabled={sending} onClick={() => setPolling(true)}>
              <ListChecks size={18} />
            </IconButton>
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
            disabled={sending}
            className="bots-composer-input bots-composer-textarea"
            rows={1}
            value={text}
            placeholder={`Message ${name}`}
            aria-label={`Message ${name}`}
            {...dictation.fieldProps}
            onChange={(e) => {
              setText(e.target.value);
              setStashOpen(false);
              findMention(e.target.value, e.target.selectionStart);
            }}
            onScroll={(e) => {
              if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onPaste={(e) => {
              if (sending) return;
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
          <button type="submit" className={cx("bots-send", (!!text.trim() || images.length > 0) && "bots-send-on")} aria-label={sending ? "Sending…" : "Send"} disabled={sending || (!text.trim() && !images.length)}>
            <ArrowUp size={18} strokeWidth={2.4} />
          </button>
        </div>
      </form>
    </div>
  );
}

/** A conversation with nothing in it yet: the bot says hello and offers a start. */
function Hello({ conversation }: { conversation: Conversation }) {
  const bots = useBots((s) => s.bots);
  const pulses = useBots((s) => s.pulses);
  const bot = bots.find((b) => b.id === conversation.botIds[0]);
  if (!bot) return null;
  const starts = ["What can you do?", "Introduce yourself", "Help me plan my week"];
  return (
    <div className="bots-hello">
      <BotAvatar look={bot.look} size={120} lively track playful pulse={pulses[bot.id]} />
      <h2>{bot.name}</h2>
      <p>{bot.instructions || "A new bot. Tell it what it's for, or just say hi."}</p>
      <div className="bots-hello-starts">
        {starts.map((s) => (
          <button
            key={s}
            type="button"
            className="bots-chip"
            onClick={() => {
              void useBots.getState().post(conversation.id, { author: "me", text: s }).then((m) => { if (m) respond(conversation.id, m); });
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

export function BotChat({ conversation }: { conversation: Conversation }) {
  const bots = useBots((s) => s.bots);
  const detailsOpen = useBots((s) => s.detailsOpen);
  const typing = useBots((s) => (s.typing[conversation.id]?.length ?? 0) > 0);
  const sidebarOpen = useStore((s) => s.botsSidebarOpen);
  const mobile = useMediaQuery("(max-width: 768px)");
  const [replyTo, setReplyTo] = useState<string>();
  // Kept here, not in Messages: a new bot's first message mounts the list, and should still animate in.
  const [openedAt] = useState(Date.now);
  const name = conversationName(conversation, bots);
  const sideBots = conversation.kind === "side" ? conversation.botIds.map((id) => bots.find((b) => b.id === id)?.name.split(" ·")[0] ?? "A bot") : [];
  // The hello is for bots the user made, which wait to be spoken to. The primary bot welcomes the user
  // and bots it makes introduce themselves, so their chat shows them at work from the start; so does
  // any bot already writing in it.
  const active = useBots((s) => {
    const id = conversation.botIds[0];
    const bot = s.bots.find((b) => b.id === id);
    if (!bot) return false;
    const st = s.status[bot.id];
    return (
      (!!bot.by && bot.by !== "me") ||
      (s.onboarding && !!bot.primary) ||
      (st?.state === "working" && st.conversationId === conversation.id) ||
      !!s.typing[conversation.id]?.length ||
      s.drafts.some((d) => d.conversationId === conversation.id)
    );
  });
  const empty = conversation.kind === "direct" && !conversation.messages.length && !active;
  return (
    <div className="bots-chat">
      <div className="bots-head">
        {mobile && !sidebarOpen && (
          <IconButton label="Open sidebar" className="bots-head-side" onClick={() => useStore.getState().setBotsSidebarOpen(true)}>
            <PanelLeft size={18} />
          </IconButton>
        )}
        <button type="button" className="bots-head-pill" aria-expanded={detailsOpen} onClick={() => useBots.getState().setDetailsOpen(!detailsOpen)}>
          <ConversationAvatar conversation={conversation} size={26} mood={typing ? "thinking" : undefined} badge={false} />
          <span className="bots-head-name">{name}</span>
        </button>
      </div>
      {empty ? <Hello conversation={conversation} /> : <Messages conversation={conversation} since={openedAt} onReply={setReplyTo} />}
      {conversation.kind === "side" ? (
        <div className="bots-dock">
          <div className="bots-side-note">
            {sideBots.join(" and ")} are talking between themselves. You can read along; they'll bring anything you need to decide back to you.
          </div>
        </div>
      ) : (
        <Composer conversation={conversation} replyTo={replyTo} onReply={setReplyTo} />
      )}
    </div>
  );
}
