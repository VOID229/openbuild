// Saving a chat a browser sent (PUT), or its sidebar edits (PATCH): projected over its replies' runs,
// keeping server-owned fields.
import type { Chat } from "../src/lib/types";
import { projectChat } from "./pi/projection";
import { keepPullRequestFields } from "./pullRequests";
import * as storage from "./storage";
import { runtimeChangeAllowed } from "./threadRuntime";

type Snapshots = Parameters<typeof projectChat>[1];

/**
 * A turn a bot's queued message started on the server that a browser's copy doesn't have yet: the tab
 * saves the reply before it as that one ends, just as the bot's message goes in (or a quick turn has
 * even finished). Kept, so the save doesn't drop it; the tab picks it up on its next refresh. Only
 * while the worker knows its run, and only when the browser's messages are exactly the start of the
 * stored ones: a browser never removes messages, so that copy just hasn't caught up.
 */
function keepBotTurn(chat: Chat, stored: Chat | undefined, runs: Snapshots): Chat {
  if (!stored || chat.messages.length >= stored.messages.length) return chat;
  if (chat.messages.some((m, i) => stored.messages[i]!.id !== m.id)) return chat;
  const tail = stored.messages.slice(chat.messages.length);
  const known = new Set(runs.map((r) => r.id));
  const admitted = tail.some((m) => m.role === "assistant" && m.stream && (m.status === "streaming" || known.has(m.stream.id)));
  return tail[0]!.role === "user" && tail[0]!.sentByBot && admitted ? { ...chat, messages: [...chat.messages, ...tail] } : chat;
}

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
  const projected = keepPullRequestFields(projectChat(onto ? chat as unknown as Chat : keepBotTurn(chat as unknown as Chat, stored, runs), runs, stored), stored);
  const v = storage.putChat({ ...projected });
  return v ? { v, chat: projected } : { error: "Chat was deleted", status: 410 };
}
