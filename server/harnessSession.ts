import { open } from "node:fs/promises";
import * as storage from "./storage";
import { threadRuntime } from "./threadRuntime";

/** Read identity only: never start a harness or create a session for the copy menu. */
export async function harnessSession(threadId: string) {
  const runtime = threadRuntime(threadId);
  if (!runtime || runtime === "durable") return { runtime, id: null };
  const raw = storage.getValue(`${runtime}-session:${threadId}`);
  if (!raw) return { runtime, id: null };
  try {
    const saved = JSON.parse(raw);
    if (runtime !== "pi") return { runtime, id: typeof saved.id === "string" && saved.id ? saved.id : null };
    // Imported and forked Pi sessions need not share OpenBuild's thread ID.
    const file = await open(saved.file, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const header = JSON.parse(buffer.toString("utf8", 0, bytesRead).split("\n")[0]!);
      return { runtime, id: header.type === "session" && typeof header.id === "string" && header.id ? header.id : null };
    } finally {
      await file.close();
    }
  } catch {
    return { runtime, id: null };
  }
}
