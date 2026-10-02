// Chat persistence in IndexedDB (attachments make localStorage too small).
import { createStore, del, entries, set, clear } from "idb-keyval";
import type { Chat } from "./types";

const store = createStore("openchat", "chats");

export async function loadChats(): Promise<Chat[]> {
  try {
    const all = await entries<string, Chat>(store);
    return all
      .map(([, chat]) => ({
        ...chat,
        // A reload mid-generation leaves "streaming" messages behind.
        messages: chat.messages.map((m) => (m.status === "streaming" ? { ...m, status: "stopped" as const } : m)),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (err) {
    console.error("Failed to load chats", err);
    return [];
  }
}

export function saveChat(chat: Chat) {
  return set(chat.id, chat, store).catch((err) => console.error("Failed to save chat", err));
}

export function deleteChat(id: string) {
  return del(id, store).catch((err) => console.error("Failed to delete chat", err));
}

export function deleteAllChats() {
  return clear(store).catch((err) => console.error("Failed to clear chats", err));
}
