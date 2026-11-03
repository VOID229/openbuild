// An OpenBots conversation, chat style: bubbles grouped by who sent them, a time between messages
// far apart, reactions both ways, replies that quote what they answer, and bots typing. Group
// chats name each bot over its messages; side chats between bots are read-only.
import { ArrowDown, ArrowUp, Bookmark, Check, CircleDashed, CircleDot, Copy, CornerUpLeft, ImagePlus, PanelLeft, PanelRight, SmilePlus, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { noticeAnswer, noticeReaction, respond } from "../../lib/bots/engine";
import { colorOf } from "../../lib/bots/looks";
import { conversationName, directOf, useBots } from "../../lib/bots/store";
import type { Bot, BotMessage, Conversation, Reaction } from "../../lib/bots/types";
import { reactionId } from "../../../shared/bots";
import { useStore } from "../../lib/store";
import { useShallow } from "zustand/react/shallow";
import { copyText, cx, useMediaQuery } from "../../lib/ui";
import { Linkify } from "../Linkify";
import { openLightbox } from "../Lightbox";
import { DictationButton } from "../DictationButton";
import { useFieldDictation } from "../../lib/useFieldDictation";
import { IconButton, Popover } from "../primitives";
import { StashTray } from "../StashTray";
import { botStashOf, imageFiles, pasteBotStash, stashAction, type Stashed } from "../../lib/stash";
import { SHORTCUT_EVENT, type ShortcutEventDetail } from "../../lib/shortcuts";
import { BotAvatar } from "./BotAvatar";
import { authorName, ConversationAvatar, dividerTime, fullTime, messageText } from "./common";

const QUICK = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
const MORE = ["🎉", "🙏", "👀", "💯", "✅", "🤔", "😍", "👏", "🙌", "😅", "🤯", "💡", "🚀", "⭐", "😎", "🥲", "🫡", "👋", "❌", "➕", "🤝", "😴", "🍕", "☕"];

/** Messages this far apart get a time between them. */
const DIVIDER_GAP = 45 * 60 * 1000;
/** A bot or the user's messages this close together share one group. */
const GROUP_GAP = 5 * 60 * 1000;

const EMPTY: string[] = [];
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

/** An @mention in the bot's colour, opening its thread. */
function Mention({ bot }: { bot: Bot }) {
  const thread = useBots((s) => directOf(s.conversations, bot.id)?.id);
  const style = { "--mention": colorOf(bot.look).hex } as React.CSSProperties;
  if (!thread) return <span className="bm-mention" style={style}>@{firstName(bot)}</span>;
  return (
    <button type="button" className="bm-mention bm-mention-link" style={style} onClick={() => useBots.getState().select(thread)}>
      @{firstName(bot)}
    </button>
  );
}

/** Bold, inline code, links and @mentions (in the mentioned bot's colour). */
const RichText = memo(function RichText({ text, bots, botId }: { text: string; bots: Bot[]; botId?: string }) {
  const fileHref = botId ? (url: string) => `/api/bots/${encodeURIComponent(botId)}/file?url=${encodeURIComponent(url)}` : undefined;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*|@([\p{L}\d][\p{L}\d_-]*)/gu)) {
    const start = m.index ?? 0;
    if (start > last) parts.push(<Linkify key={last} text={text.slice(last, start)} fileHref={fileHref} />);
    if (m[1]) parts.push(<code key={start}>{m[1]}</code>);
    else if (m[2]) parts.push(<strong key={start}>{m[2]}</strong>);
    else {
      const bot = bots.find((b) => firstName(b).toLowerCase() === m[3]!.toLowerCase());
      parts.push(
        bot ? (
          <Mention key={start} bot={bot} />
        ) : (
          m[0]
        ),
      );
    }
    last = start + m[0].length;
  }
  if (last < text.length) parts.push(<Linkify key={last} text={text.slice(last)} fileHref={fileHref} />);
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
  what: "react" | "more";
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
  const emojiOnly = !m.images?.length && !m.question && !m.plan && EMOJI_ONLY.test(m.text.replace(/\s/g, ""));
  const card = !!(m.question || m.plan);
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
          data-tooltip={fullTime(m.at)}
          data-tooltip-side={mine ? "left" : "right"}
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
          {m.text && !m.question && (
            <div className="bm-text">
              <RichText text={m.text} bots={bots} botId={m.author === "me" ? undefined : m.author} />
            </div>
          )}
          {m.question && <QuestionCard conversation={conversation} message={m} />}
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
            <IconButton label="More" tooltip={false} className="bm-action" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => onPicker({ messageId: m.id, mine, what: "more" }, e.currentTarget)}>
              <Ellipsis size={16} />
            </IconButton>
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
                        <RichText text={draft} bots={bots} botId={id} />
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
  const directBot = conversation.kind === "direct" ? bots.find((b) => b.id === conversation.botIds[0]) : undefined;

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
                    {eventBot ? <BotLink bot={eventBot} /> : <WithBotLinks text={m.event!.detail} bots={bots} />}
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
      <Popover open={!!picker && picker.what === "more"} onClose={closePicker} anchor={anchor} className="menu bm-more-menu" role="menu" label="Message actions" fixed="auto" align={picker?.mine ? "end" : "start"}>
        {picked && (
          <>
            <button type="button" role="menuitem" className="menu-item" onClick={() => { onReply(picked.id); closePicker(); }}>
              <CornerUpLeft size={15} /> Reply
            </button>
            <button type="button" role="menuitem" className="menu-item" disabled={!messageText(picked)} onClick={() => { void copyText(picked.text || messageText(picked)); closePicker(); }}>
              <Copy size={15} /> Copy text
            </button>
            {picked.author === "me" && directBot && picked.text && (
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  void st.post(conversation.id, { author: "me", text: `Please remember this: ${picked.text}`, replyTo: picked.id });
                  closePicker();
                }}
              >
                <Brain size={15} /> Ask {firstName(directBot)} to remember
              </button>
            )}
            {picked.author === "me" && (
              <>
                <div className="menu-sep" />
                <button type="button" role="menuitem" className="menu-item menu-item-danger" onClick={() => { st.deleteMessage(conversation.id, picked.id); closePicker(); }}>
                  <Trash size={15} /> Delete
                </button>
              </>
            )}
          </>
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

function Composer({ conversation, replyTo, onReply }: { conversation: Conversation; replyTo?: string; onReply: (id?: string) => void }) {
  const bots = useBots((s) => s.bots);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [mention, setMention] = useState<{ query: string; index: number }>();
  const input = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const touch = useMediaQuery("(pointer: coarse)");
  const name = conversationName(conversation, bots);
  const quoted = replyTo ? conversation.messages.find((m) => m.id === replyTo) : undefined;
  const members = bots.filter((b) => conversation.botIds.includes(b.id));
  const matches = mention && conversation.kind === "group" ? members.filter((b) => firstName(b).toLowerCase().startsWith(mention.query.toLowerCase())) : [];

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

  const send = async () => {
    const body = text.trim();
    if (sendingRef.current || (!body && !images.length)) return;
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
  const findMention = (value: string, caret: number) => {
    const m = /(?:^|\s)@([\p{L}\d_-]*)$/u.exec(value.slice(0, caret));
    setMention(m ? { query: m[1]!, index: 0 } : undefined);
  };
  const insertMention = (bot: Bot) => {
    const el = input.current!;
    const caret = el.selectionStart;
    const before = text.slice(0, caret).replace(/@([\p{L}\d_-]*)$/u, `@${firstName(bot)} `);
    const next = before + text.slice(caret);
    setText(next);
    setMention(undefined);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  return (
    <div className="bots-dock">
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
            {matches.map((b, i) => (
              <button
                key={b.id}
                type="button"
                role="option"
                aria-selected={i === mention!.index % matches.length}
                className="menu-item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertMention(b)}
              >
                <BotAvatar look={b.look} size={22} alive={false} />
                <span className="menu-item-label">{b.name}</span>
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
          <textarea
            ref={input}
            disabled={sending}
            className="bots-composer-input"
            rows={1}
            value={text}
            placeholder={`Message ${name}`}
            aria-label={`Message ${name}`}
            onChange={(e) => {
              setText(e.target.value);
              findMention(e.target.value, e.target.selectionStart);
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
              if (matches.length && mention) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setMention({ ...mention, index: (mention.index + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length });
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  insertMention(matches[mention.index % matches.length]!);
                  return;
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setMention(undefined);
                  return;
                }
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
  const empty = conversation.kind === "direct" && !conversation.messages.length;
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
        {!detailsOpen && (
          <IconButton label="Details" tooltipSide="left" className="bots-head-tools" onClick={() => useBots.getState().setDetailsOpen(true)}>
            <PanelRight size={18} />
          </IconButton>
        )}
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
