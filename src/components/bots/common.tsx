// Pieces the OpenBots sidebar, chat and details panel share.
import { Star } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { awayFrom, awayIn, awayLines, busyBots, plainPhase, plainPhaseEnds, reading, typingAnywhere, type PlainPhase } from "../../lib/bots/activity";
import type { Mood } from "../../lib/bots/looks";
import { conversationName, useBots } from "../../lib/bots/store";
import type { Bot, BotMessage, Conversation } from "../../lib/bots/types";
import { eventDetail, eventText } from "../../../shared/bots";
import type { FriendFrom } from "../../../shared/friends";
import { accountName } from "../../lib/models";
import { oneLine } from "../../lib/chatText";
import { BotAvatar, BotHuddle, BotLineup } from "./BotAvatar";
import { clock } from "../../lib/clock";

/**
 * True once `busy` has lasted a moment. Saves and reconnects usually finish in a blink, and a status
 * bar for those just pushes the view down and back up as a flicker.
 */
export function useSlow(busy: boolean, delay = 1200) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) return setSlow(false);
    const t = setTimeout(() => setSlow(true), delay);
    return () => clearTimeout(t);
  }, [busy, delay]);
  return busy && slow;
}

const NONE: string[] = [];

/** The conversation's bots at work, as it shows them (see `busyBots`). In a group, these are awake and the rest doze. */
export function useBusyBots(conversation: Pick<Conversation, "id" | "botIds" | "kind"> | undefined): string[] {
  return useBots(useShallow((s) => (conversation ? busyBots(conversation, s.status, s.typing) : NONE)));
}

const DAY = 24 * 60 * 60 * 1000;
const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);

/** When a conversation last moved, as briefly as it reads: "3:04 PM", "Yesterday", "Mon", "Nov 1". */
export function shortTime(t: number) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(t)) / DAY);
  if (days <= 0) return clock(t);
  if (days === 1) return "Yesterday";
  if (days < 7) return new Date(t).toLocaleDateString([], { weekday: "short" });
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** A divider between messages far apart in time: "Today 3:04 PM", "Sun, Nov 1 12:39 PM". */
export function dividerTime(t: number) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(t)) / DAY);
  if (days <= 0) return `Today ${clock(t)}`;
  if (days === 1) return `Yesterday ${clock(t)}`;
  return `${new Date(t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${clock(t)}`;
}


/** What follows the first question of a card that asks several. */
const more = (q: { steps?: unknown[] }) => (q.steps && q.steps.length > 1 ? ` (+${q.steps.length - 1} more)` : "");

/** A message as one line of text: for previews, reply quotes and copying. */
export function messageText(m: BotMessage): string {
  if (m.question) return `? ${m.question.title}${more(m.question)}`;
  if (m.poll) return `📊 ${m.poll.question}`;
  if (m.plan) return `📋 Plan: ${m.plan.title}`;
  if (m.html) return `📄 ${m.html.title}`;
  if (m.event) {
    const detail = eventDetail(m.event);
    return [eventText(m.event, {}), detail && m.event.kind === "model" ? `(${accountName(detail)})` : detail].filter(Boolean).join(" ");
  }
  // Without Markdown's own marks ("**", a list's "-", a heading's "#"): a line that names the message.
  const text = oneLine(m.text);
  if (text) return text;
  if (m.files?.length) return m.files.length === 1 ? `📎 ${m.files[0]!.name}` : `📎 ${m.files.length + (m.images?.length ?? 0)} files`;
  return m.images?.length ? (m.images.length === 1 ? "📷 Photo" : `📷 ${m.images.length} photos`) : "";
}

/** {@link messageText} for display: a question's "?" in muted gray, since a red mark reads as an error. */
export function messageLine(m: BotMessage): ReactNode {
  if (!m.question) return messageText(m);
  return (
    <>
      <span className="bots-question-mark" aria-hidden>?</span> {m.question.title}{more(m.question)}
    </>
  );
}

/** Who wrote a message. A friend's bot reads "Juniper · Alice" (its tag is its friend), a friend themselves "Alice". */
export function authorName(author: string, bots: Bot[], from?: FriendFrom) {
  if (author === "me") return "You";
  if (from) return from.owner ? from.friendName : `${from.name.split(" · ")[0]} · ${from.friendName}`;
  return bots.find((b) => b.id === author)?.name ?? "Deleted bot";
}

/** The sidebar's second line: the latest message, with who said it where that isn't obvious. */
export function previewOf(c: Conversation, bots: Bot[]): ReactNode {
  const last = c.messages.findLast((m) => !m.event) ?? c.messages.at(-1);
  if (!last) return "Say hi";
  const text = messageLine(last);
  if (last.author === "me") return <>You: {text}</>;
  // A minion's chat is the minion's: its own words go unnamed, as a bot's do in its own chat; its owner's are named.
  if (c.minion && last.author === c.minion) return text;
  if (c.kind !== "direct") return <>{authorName(last.author, bots, last.from).split(" ·")[0]}: {text}</>;
  return text;
}

const MISSING = { shape: "blob", color: "gray" };
const NO_DOTS: boolean[] = [];

/**
 * Where each of these bots is with plain words (activity.ts, plainPhase): the one source the chat's
 * working row, its header and the sidebar read, so a bot is three dots in all of them or none. Looks
 * again by itself when a phase is over, since nothing in the store changes then.
 */
export function usePlainPhases(botIds: readonly string[]): (PlainPhase | undefined)[] {
  const read = (s: ReturnType<typeof useBots.getState>, now: number) => botIds.map((id) => plainPhase(s.status[id], s.shown[id], typingAnywhere(s.typing, id), now) ?? "").join(",");
  const key = useBots((s) => read(s, Date.now()));
  const ends = useBots((s) => Math.min(Infinity, ...botIds.map((id) => plainPhaseEnds(s.status[id], s.shown[id], typingAnywhere(s.typing, id), Date.now()) ?? Infinity)));
  const [, again] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(ends)) return;
    const t = setTimeout(() => again((n) => n + 1), Math.max(0, ends - Date.now()) + 20);
    return () => clearTimeout(t);
  }, [ends, key]);
  // The same array while nothing changes, so the memoized mascots it's handed to don't redraw.
  return useMemo(() => key.split(",").map((phase) => (phase || undefined) as PlainPhase | undefined).slice(0, botIds.length), [key, botIds.length]);
}

/** Whether each of these bots shows as three dots right now (usePlainPhases). */
export function useDots(botIds: readonly string[]): boolean[] {
  const phases = usePlainPhases(botIds);
  return useMemo(() => phases.map((phase) => phase === "dots"), [phases]);
}

/** Whether each of a conversation's bots is at work in another chat in a way it shows (`awayIn`), and not typing here: its mascot is calmer here. */
export const useAway = (conversation: Pick<Conversation, "id" | "botIds" | "kind">): boolean[] =>
  useBots(useShallow((s) => conversation.botIds.map((id) => awayIn(conversation, s.status[id]) && !s.typing[conversation.id]?.includes(id))));

/**
 * What a bot at work in another chat is doing there, in words for this one (activity.ts, awayLines),
 * or undefined while it isn't. The same array while the words don't change.
 */
export function useAwayLines(conversationId: string, botId: string | undefined): string[] | undefined {
  const key = useBots((s) => {
    const conversation = s.conversations.find((c) => c.id === conversationId);
    // A bot's own chat says nothing of its work elsewhere while it's pointed at a group (awayIn): that group does.
    if (!botId || !(conversation ? awayIn(conversation, s.status[botId]) : awayFrom(s.status[botId], conversationId)) || s.typing[conversationId]?.includes(botId)) return "";
    return awayLines(conversationId, botId, s.status[botId], { conversations: s.conversations, bots: s.bots, typing: s.typing, shown: s.shown[botId] }).join("\n");
  });
  return useMemo(() => (key ? key.split("\n") : undefined), [key]);
}

/**
 * A line of text, said the most exact way that fits its box: the first of `lines` that does, so a
 * name is left out whole ("in another group") rather than cut off. The last one is shown however it
 * fits. Its box clips: one line (overflow hidden, nowrap), or a few (a line clamp), and words that
 * spill past it either way don't fit. `onFit` hears once it has settled on one, for a box placed by
 * its size (a hover card). It looks again from the first when its words change,
 * or when its box grows wider than it was when the words last didn't fit: a box that's as wide as its
 * words narrows with shorter ones, and that's no reason to try the longer ones again. Such a box never
 * grows with the room around it either: `within` names the closest ancestor whose width it's watched
 * by instead.
 */
export function FitText({ lines, within, onFit, className, ...rest }: { lines: string[]; within?: string; onFit?: () => void; className?: string } & React.HTMLAttributes<HTMLSpanElement>) {
  const ref = useRef<HTMLSpanElement>(null);
  const key = lines.join("\n");
  const [fit, setFit] = useState({ key, i: 0, room: Infinity });
  const now = fit.key === key ? fit : { key, i: 0, room: Infinity };
  const i = Math.min(now.i, lines.length - 1);
  const current = useRef(now);
  current.current = now;
  const told = useRef<string>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (i < lines.length - 1 && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) return setFit({ key, i: i + 1, room: room(el) });
    if (told.current === lines[i]) return;
    told.current = lines[i];
    onFit?.();
  });
  const room = (el: HTMLElement) => ((within && el.closest(within)) || el).clientWidth;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const box = (within && el.closest(within)) || el;
    const watch = new ResizeObserver(() => {
      const now = current.current;
      if (now.i > 0 && box.clientWidth > now.room + 1) setFit({ key, i: 0, room: Infinity });
    });
    watch.observe(box);
    return () => watch.disconnect();
  }, [key, within]);
  return (
    <span ref={ref} className={className} {...rest}>
      {lines[i]}
    </span>
  );
}

/** Whether each of these bots is reading something right now (`reading`): its mascot reads along. */
export const useReading = (botIds: string[]): boolean[] => useBots(useShallow((s) => botIds.map((id) => reading(s.status[id]))));

/**
 * The mark on a side chat's bots: a speech bubble with three dots, ringed in the background it sits
 * on, so a chat between bots reads as a DM between them and never as a group of yours.
 */
export function DmMark({ size }: { size: number }) {
  return (
    <span className="bots-dm-mark" role="img" aria-label="Between bots" style={{ "--mark": `${Math.max(14, Math.round(size * 0.4))}px` } as React.CSSProperties}>
      <svg viewBox="-2 -2 24 22" aria-hidden>
        <path className="bots-dm-bubble" d="M6 0h8a6 6 0 0 1 0 12h-4.5L5 16.5V12h1A6 6 0 0 1 6 0Z" />
        <g className="bots-dm-dots">
          <circle cx="5.6" cy="6" r="1.5" />
          <circle cx="10" cy="6" r="1.5" />
          <circle cx="14.4" cy="6" r="1.5" />
        </g>
      </svg>
    </span>
  );
}

/**
 * A conversation's picture: the bot, or a huddle of the group's bots. A side chat's bots sit side by
 * side when there are two (a huddle when there are more), with a speech bubble between them (`badge`).
 */
export const ConversationAvatar = memo(function ConversationAvatar({
  conversation,
  size,
  alive = true,
  lively,
  track,
  busy,
  working,
  mood,
  badge = true,
  zzz = false,
  lineup,
  still = false,
}: {
  conversation: Conversation;
  size: number;
  alive?: boolean;
  lively?: boolean;
  track?: boolean;
  busy?: boolean;
  /** The bots at work, so a group animates just those members and the rest doze. */
  working?: string[];
  mood?: Mood;
  badge?: boolean;
  /** A "zzz" over a group's dozing huddle: on in the sidebars, off beside a name or a chat's messages. */
  zzz?: boolean;
  /** A group's members in a row, each its own mascot, rather than huddled together. */
  lineup?: boolean;
  /**
   * A picture of it, as in a hover card: held still, whatever its bots are doing. No life of its own,
   * no work, reactions or dots, and no following the pointer; it overrides the rest.
   */
  still?: boolean;
}) {
  const bots = useBots((s) => s.bots);
  const pulses = useBots((s) => s.pulses);
  // Three dots exactly when the chat's working row and header show them (useDots); never held still.
  // A group's member busy in a chat that has nothing to do with this one dozes here (busyBots): no
  // dots or reading of that work either.
  const shared = useDots(conversation.botIds);
  // A bot's own chat is the bot, busy anywhere, unless it's pointed at a group (activity.ts, homeHere): the same filter then holds it to its work there.
  const here = useBusyBots(conversation);
  const ownDots = useMemo(() => shared.map((d, i) => d && here.includes(conversation.botIds[i]!)), [shared, here, conversation.botIds]);
  const dots = still ? NO_DOTS : ownDots;
  if (still) [alive, busy, track, working] = [false, false, false, undefined];
  const allReads = useReading(conversation.botIds);
  const reads = useMemo(() => allReads.map((r, i) => r && here.includes(conversation.botIds[i]!)), [allReads, here, conversation.botIds]);
  // At work in another chat: calmer, here.
  const aways = useAway(conversation);
  const away = still ? undefined : aways;
  const members = conversation.botIds.map((id) => bots.find((b) => b.id === id));
  if (conversation.kind === "direct") {
    const bot = members[0];
    return (
      <span className="bots-avatar-wrap">
        <BotAvatar look={bot?.look ?? MISSING} size={size} alive={alive} lively={lively} track={track} busy={busy} away={away?.[0]} reading={reads[0]} mood={mood} dots={dots[0]} pulse={bot && !still ? pulses[bot.id] : undefined} label={bot?.name} />
        {badge && bot?.primary && (
          <span className="bots-primary-badge" role="img" aria-label="Primary bot" style={{ "--badge": `${Math.max(14, Math.round(size * 0.3))}px` } as React.CSSProperties}>
            <Star fill="currentColor" strokeWidth={0} />
          </span>
        )}
      </span>
    );
  }
  const looks = members.map((b) => b?.look ?? MISSING);
  const active = working && conversation.botIds.map((id) => working.includes(id));
  if (lineup) return <BotLineup looks={looks} size={size} alive={alive} busy={busy} active={active} away={away} dots={dots} reading={reads} track={track} />;
  // A minion's chat with its owner is the minion's: its mascot, with its owner's small at its corner.
  const mine = conversation.minion ? conversation.botIds.indexOf(conversation.minion) : -1;
  if (mine >= 0) {
    const minion = members[mine];
    const owner = members[1 - mine];
    return (
      <span className="bots-avatar-wrap bots-avatar-minion">
        <BotAvatar look={minion?.look ?? MISSING} size={size} alive={alive} lively={lively} track={track} busy={busy} away={away?.[mine]} reading={reads[mine]} mood={mood} dots={dots[mine]} pulse={minion && !still ? pulses[minion.id] : undefined} label={minion?.name} />
        {badge && (
          <span className="bots-minion-owner" role="img" aria-label={`${owner?.name.split(" · ")[0] ?? "A deleted bot"}'s minion`} style={{ "--badge": `${Math.max(14, Math.round(size * 0.46))}px` } as React.CSSProperties}>
            <BotAvatar look={owner?.look ?? MISSING} size={Math.max(10, Math.round(size * 0.46) - 4)} alive={false} />
          </span>
        )}
      </span>
    );
  }
  if (conversation.kind === "side")
    return (
      <span className="bots-avatar-wrap bots-avatar-side">
        <BotHuddle looks={looks} size={size} alive={alive} busy={busy} active={active} away={away} dots={dots} reading={reads} track={track} zzz={zzz} pair />
        {badge && <DmMark size={size} />}
      </span>
    );
  return <BotHuddle looks={looks} size={size} alive={alive} busy={busy} active={active} away={away} dots={dots} reading={reads} track={track} zzz={zzz} />;
});

export { conversationName };
