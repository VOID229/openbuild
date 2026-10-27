import { EXTERNAL_VIA } from "../../shared/replies";
import type { Chat } from "./types";

/** A visible active thread has already shown this projection; other threads keep their unread dot. */
export function readChatProjection(chat: Chat, activeChatId: string | undefined): Chat {
  return chat.id === activeChatId && chat.unread ? { ...chat, unread: false } : chat;
}

/** A poll must not replace a locally streaming reply with a stale saved snapshot. A terminal
 * projection of that exact run is authoritative, though: the worker may have finished offline. */
export function canSyncChat(current: Chat | undefined, incoming: Chat): boolean {
  return !current || current.messages.every((message) => {
    if (message.status !== "streaming" || message.stream?.via === EXTERNAL_VIA) return true;
    if (!message.stream?.id) return false;
    const projected = incoming.messages.find((m) => m.id === message.id);
    return projected?.stream?.id === message.stream.id &&
      (projected.status === "done" || projected.status === "error" || projected.status === "stopped");
  });
}
