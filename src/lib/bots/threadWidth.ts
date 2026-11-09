// How wide a coding thread opened in OpenBots' details panel is (BotDetails' ThreadPane). Dragged by
// its left edge, kept for every chat and across reloads, and never so wide the bot chat beside it
// stops being usable.

export const THREAD_DEFAULT = 480;
export const THREAD_MIN = 360;
/** The least the bot chat beside the thread keeps. */
export const CHAT_MIN = 420;
const KEY = "openbuild:bots-thread-width";

/** The widest the thread can be when the chat and panel share `room` pixels. */
export const threadMax = (room: number) => Math.max(THREAD_MIN, Math.round(room) - CHAT_MIN);

export const clampThreadWidth = (width: number, room: number) => Math.min(threadMax(room), Math.max(THREAD_MIN, Math.round(width)));

export function loadThreadWidth(): number {
  try {
    const w = Number(localStorage.getItem(KEY));
    return Number.isFinite(w) && w >= THREAD_MIN ? Math.round(w) : THREAD_DEFAULT;
  } catch {
    return THREAD_DEFAULT;
  }
}

export function saveThreadWidth(width: number) {
  try {
    if (width === THREAD_DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(width));
  } catch {}
}
