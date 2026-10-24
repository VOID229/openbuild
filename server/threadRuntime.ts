// A runtime is a server-side thread identity, not a mutable request preference.
import type { ThreadRuntime } from "../shared/types";
import * as storage from "./storage";

export const validRuntime = (value: unknown): value is ThreadRuntime => value === "pi" || value === "durable";
const key = (id: string) => `thread-runtime:${id}`;

export function threadRuntime(id: string): ThreadRuntime | undefined {
  const claimed = storage.getValue(key(id));
  if (validRuntime(claimed)) return claimed;
  if (storage.getValue(`pi-session:${id}`)) return "pi";
  const chat = storage.getChat(id);
  if (chat && Array.isArray(chat.messages) && chat.messages.length) return chat.runtime === "durable" ? "durable" : "pi";
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
