// Pieces the OpenBots sidebar, chat and details panel share.
import { Star } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { Mood } from "../../lib/bots/looks";
import { conversationName, useBots } from "../../lib/bots/store";
import type { Bot, BotMessage, Conversation } from "../../lib/bots/types";
import { BotAvatar, BotHuddle } from "./BotAvatar";

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

const DAY = 24 * 60 * 60 * 1000;
const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

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

export const fullTime = (t: number) => new Date(t).toLocaleString([], { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

/** A message as one line of text: for previews, reply quotes and copying. */
export function messageText(m: BotMessage): string {
  if (m.question) return `❓ ${m.question.title}`;
  if (m.poll) return `📊 ${m.poll.question}`;
  if (m.plan) return `📋 Plan: ${m.plan.title}`;
  if (m.event) return [m.event.text, m.event.detail].filter(Boolean).join(" ");
  const text = m.text.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  if (text) return text;
  return m.images?.length ? (m.images.length === 1 ? "📷 Photo" : `📷 ${m.images.length} photos`) : "";
}

export function authorName(author: string, bots: Bot[]) {
  return author === "me" ? "You" : (bots.find((b) => b.id === author)?.name ?? "Deleted bot");
}

/** The sidebar's second line: the latest message, with who said it where that isn't obvious. */
export function previewOf(c: Conversation, bots: Bot[]): string {
  const last = c.messages.findLast((m) => !m.event) ?? c.messages.at(-1);
  if (!last) return "Say hi";
  const text = messageText(last);
  if (last.author === "me") return `You: ${text}`;
  if (c.kind !== "direct") return `${authorName(last.author, bots).split(" ·")[0]}: ${text}`;
  return text;
}

const MISSING = { shape: "orb", color: "gray" };

/** A conversation's picture: the bot, or a huddle of the group's or side chat's bots. */
export const ConversationAvatar = memo(function ConversationAvatar({
  conversation,
  size,
  alive = true,
  lively,
  track,
  playful,
  busy,
  mood,
  badge = true,
}: {
  conversation: Conversation;
  size: number;
  alive?: boolean;
  lively?: boolean;
  track?: boolean;
  playful?: boolean;
  busy?: boolean;
  mood?: Mood;
  badge?: boolean;
}) {
  const bots = useBots((s) => s.bots);
  const pulses = useBots((s) => s.pulses);
  const members = conversation.botIds.map((id) => bots.find((b) => b.id === id));
  if (conversation.kind === "direct") {
    const bot = members[0];
    return (
      <span className="bots-avatar-wrap">
        <BotAvatar look={bot?.look ?? MISSING} size={size} alive={alive} lively={lively} track={track} playful={playful} busy={busy} mood={mood} pulse={bot ? pulses[bot.id] : undefined} label={bot?.name} />
        {badge && bot?.primary && (
          <span className="bots-primary-badge" role="img" aria-label="Primary bot" style={{ "--badge": `${Math.max(14, Math.round(size * 0.3))}px` } as React.CSSProperties}>
            <Star fill="currentColor" strokeWidth={0} />
          </span>
        )}
      </span>
    );
  }
  const looks = members.map((b) => b?.look ?? MISSING);
  return <BotHuddle looks={looks} size={size} alive={alive} busy={busy} track={track} extra={looks.length > 4 ? looks.length - 4 : undefined} />;
});

export { conversationName };
