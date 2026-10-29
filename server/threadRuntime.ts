// A runtime is a server-side thread identity, not a mutable request preference.
import type { ThreadRuntime } from "../shared/types";
import * as storage from "./storage";

export const validRuntime = (value: unknown): value is ThreadRuntime => value === "pi" || value === "durable" || value === "fx" || value === "codex" || value === "cursor" || value === "claude" || value === "opencode";
const key = (id: string) => `thread-runtime:${id}`;

export function threadRuntime(id: string): ThreadRuntime | undefined {
  const claimed = storage.getValue(key(id));
  if (validRuntime(claimed)) return claimed;
  if (storage.getValue(`pi-session:${id}`)) return "pi";
  if (storage.getValue(`fx-session:${id}`)) return "fx";
  if (storage.getValue(`codex-session:${id}`)) return "codex";
  if (storage.getValue(`cursor-session:${id}`)) return "cursor";
  if (storage.getValue(`claude-session:${id}`)) return "claude";
  if (storage.getValue(`opencode-session:${id}`)) return "opencode";
  const chat = storage.getChat(id);
  if (chat && Array.isArray(chat.messages) && chat.messages.length) return validRuntime(chat.runtime) ? chat.runtime : "pi";
  return undefined;
}

/** Synchronous read-and-write: no admission can race a different runtime in this process. */
export function claimRuntime(id: string, runtime: ThreadRuntime): void {
  const existing = threadRuntime(id);
  if (existing && existing !== runtime) throw new Error("A thread's runtime cannot change after it starts. Start a new thread to use another runtime.");
  storage.setValue(key(id), runtime);
}

export function runtimeChangeAllowed(chat: storage.StoredChat): boolean {
  if (chat.runtime !== undefined && !validRuntime(chat.runtime)) return false;
  const existing = threadRuntime(chat.id);
  return !existing || existing === (chat.runtime ?? "pi");
}
