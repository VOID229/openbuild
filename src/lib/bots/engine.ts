// Small reactions the app plays itself. Replies, memory and routines come from the server
// (server/bots/); posting a message is what wakes a bot.
import { useBots } from "./store";
import type { BotMessage } from "./types";

const timers = new Set<ReturnType<typeof setTimeout>>();
const later = (ms: number, fn: () => void) => {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
};

/** The user sent a message. The server wakes the bots. */
export function respond(_conversationId: string, _message: BotMessage) {}

/** The user reacted to a bot's message: show it on the avatar. The bot itself reacts from the server. */
export function noticeReaction(botId: string, emoji: string) {
  const mood = emoji === "❤️" || emoji === "😍" ? "love" : emoji === "😮" || emoji === "😱" ? "surprised" : emoji === "😢" ? "sleepy" : "happy";
  later(250 + Math.random() * 400, () => useBots.getState().pulse(botId, mood));
}

/** The user picked an option. Their answer is already posted, which is what wakes the bot. */
export function noticeAnswer(_conversationId: string, botId: string, _label: string) {
  later(300, () => useBots.getState().pulse(botId, "happy"));
}
