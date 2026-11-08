// Saving a chat a browser sent (PUT), or its sidebar edits (PATCH): projected over its replies' runs,
// keeping server-owned fields.
import type { Chat } from "../src/lib/types";
import { projectChat } from "./pi/projection";
import { keepPullRequestFields } from "./pullRequests";
import * as storage from "./storage";
import { runtimeChangeAllowed } from "./threadRuntime";

type Snapshots = Parameters<typeof projectChat>[1];

/**
 * `onto` rebuilds the chat from the stored one as it is once the replies' runs are in hand (a PATCH
 * merges its metadata there), so messages written while waiting for them aren't overwritten. From
 * that read to the save nothing yields.
 */
export async function writeChat(
  chat: storage.StoredChat,
  snapshots: (id: string) => Promise<Snapshots>,
  onto?: (stored: Chat) => storage.StoredChat,
): Promise<{ v: string; chat: Chat } | { error: string; status: number }> {
  if (!runtimeChangeAllowed(chat)) return { error: "A thread's runtime cannot change after it starts.", status: 400 };
  const needsPi = chat.runtime !== "durable" && (chat as unknown as Chat).messages.some(message => message.model?.plan === "pi" || message.model?.plan === "fx" || message.model?.plan === "codex" || message.model?.plan === "cursor" || message.model?.plan === "claude" || message.model?.plan === "opencode" || message.model?.plan === "grok" || message.model?.plan === "hermes" || message.shell);
  const runs = needsPi ? await snapshots(chat.id) : [];
  const stored = storage.getChat(chat.id) as Chat | undefined;
  if (onto) {
    if (!stored) return { error: "Chat was deleted", status: 410 };
    chat = onto(stored);
    if (!runtimeChangeAllowed(chat)) return { error: "A thread's runtime cannot change after it starts.", status: 400 };
  }
  const projected = keepPullRequestFields(projectChat(chat as unknown as Chat, runs, stored), stored);
  const v = storage.putChat({ ...projected });
  return v ? { v, chat: projected } : { error: "Chat was deleted", status: 410 };
}
