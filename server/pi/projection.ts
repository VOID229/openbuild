// The worker's event log is authoritative for admitted replies, even when no browser was open.
// Merge only matching stream IDs: an edited/retried/deleted message must never be resurrected.
import type { ShellEvent, StreamEvent } from "../../shared/types";
import type { Chat, Message, Part, ToolPart } from "../../src/lib/types";
import * as storage from "../storage";

export interface PiSnapshot {
  id: string;
  threadId: string;
  kind: "run" | "shell";
  events: (StreamEvent | ShellEvent)[];
  eventCount?: number;
  status: string;
  startedAt: number;
  endedAt?: number;
}

/** Pure replay; timings are based on saved timestamps, never on when the server reconnects. */
export function projectReply(message: Message, snapshot: PiSnapshot): Message {
  const parts: Part[] = [];
  let content = "", notice: string | undefined, error: string | undefined;
  let usage: Message["usage"], finish: string | undefined;
  for (const event of snapshot.events as StreamEvent[]) {
    switch (event.t) {
      case "text": {
        content += event.v;
        const last = parts.at(-1);
        if (last?.type === "text") last.text += event.v;
        else if (event.v.trim()) parts.push({ type: "text", text: event.v.replace(/^\s+/, "") });
        break;
      }
      case "reasoning": {
        const last = parts.at(-1);
        if (last?.type === "thought") last.text += event.v;
        else if (event.v.trim()) parts.push({ type: "thought", text: event.v.replace(/^\s+/, "") });
        break;
      }
      case "tool": {
        const { t, ...tool } = event;
        const at = parts.findIndex(p => p.type === "tool" && p.id === tool.id);
        const fields = Object.fromEntries(Object.entries(tool).filter(([, v]) => v !== undefined));
        if (at < 0) parts.push({ type: "tool", ...tool });
        else parts[at] = { ...parts[at] as ToolPart, ...fields };
        break;
      }
      case "ask": {
        const { t, ...ask } = event;
        if (!parts.some(p => p.type === "ask" && p.id === ask.id)) parts.push({ type: "ask", ...ask });
        break;
      }
      case "asked": {
        const ask = parts.find(p => p.type === "ask" && p.id === event.id);
        if (ask?.type === "ask") ask.answer = event.answer ?? "";
        break;
      }
      case "steer": {
        const old = message.parts?.find(p => p.type === "steer" && p.id === event.id);
        parts.push({ type: "steer", id: event.id, text: event.text, ...(old?.type === "steer" ? { attachments: old.attachments } : {}) });
        break;
      }
      case "notice": notice = notice ? `${notice}\n${event.message}` : event.message; break;
      case "error": error = event.message; break;
      case "usage": usage = event.usage; break;
      case "done": finish = event.finish; usage = event.usage ?? usage; break;
    }
  }
  const ended = snapshot.endedAt !== undefined || snapshot.status !== "pending";
  const status: Message["status"] = !ended ? "streaming" : error || finish === "error" ? "error" : finish === "aborted" || snapshot.status === "aborted" ? "stopped" : "done";
  if (ended) for (const p of parts) {
    if (p.type === "tool" && p.status === "running") p.status = "error";
    if (p.type === "ask" && p.answer === undefined) p.answer = "";
  }
  return { ...message, content, parts: parts.length ? parts : undefined, status, error, finish, usage, notice,
    reasoning: undefined, reasoningMs: undefined,
    ...(ended ? { workedMs: Math.max(0, (snapshot.endedAt ?? snapshot.startedAt) - (message.startedAt ?? snapshot.startedAt)) } : {}),
  };
}

export function projectChat(chat: Chat, snapshots: PiSnapshot[], previous?: Chat): Chat {
  if (chat.runtime === "durable") return chat;
  let updatedAt = chat.updatedAt;
  let completed = false;
  const byId = new Map(snapshots.filter(s => s.threadId === chat.id).map(s => [s.id, s]));
  const messages = chat.messages.map(message => {
    const id = message.role === "shell" ? message.shell?.stream?.id : message.stream?.id;
    const snapshot = id && byId.get(id);
    if (!snapshot) return message;
    let projected = message;
    if (message.role === "assistant" && snapshot.kind === "run") projected = projectReply(message, snapshot);
    else if (message.role === "shell" && snapshot.kind === "shell" && message.shell) {
      let output = "";
      let exit: Extract<ShellEvent, { t: "exit" }> | undefined;
      for (const event of snapshot.events as ShellEvent[]) {
        if (event.t === "snap") output = event.output;
        else if (event.t === "out") output += event.v;
        else if (event.t === "exit") exit = event;
      }
      const { t, ...result } = exit ?? { t: "exit", status: "running" as const };
      projected = { ...message, shell: { ...message.shell, output, ...result } };
    }
    if (snapshot.endedAt) {
      updatedAt = Math.max(updatedAt, snapshot.endedAt);
      const old = previous?.messages.find(m => m.id === message.id) ?? message;
      if (message.role === "assistant" && old.status === "streaming" && projected.status === "done") completed = true;
    }
    return projected;
  });
  return { ...chat, messages, updatedAt, ...(completed ? { unread: true, done: true, archived: false } : {}) };
}

// Polls must not re-read and reduce a thread's entire history when neither its saved body nor
// worker log changed. Keep only small signatures here; the worker's disk log remains authoritative.
const projectedVersions = new Map<string, { version: string; signature: string }>();
const managedBoundaries = new Map<string, number>();
/** Infinity while busy; otherwise the time after which terminal-created messages may be imported. */
export const managedSessionBoundary = (id: string) => managedBoundaries.get(id);

/** Repair disk state before returning its index, and protect it from a stale browser's PUT. */
export function projectStoredChats(snapshots: PiSnapshot[]) {
  const versions = new Map(storage.chatIndex().map(row => [row.id, row.v]));
  const byThread = new Map<string, PiSnapshot[]>();
  for (const snapshot of snapshots) {
    const group = byThread.get(snapshot.threadId) ?? [];
    group.push(snapshot);
    byThread.set(snapshot.threadId, group);
  }
  for (const [id, group] of byThread) {
    managedBoundaries.set(id, group.reduce((latest, s) => Math.max(latest, s.status === "pending" ? Infinity : s.endedAt ?? s.startedAt), 0));
    const version = versions.get(id);
    if (!version) continue;
    const signature = group.map(s => `${s.id}:${s.eventCount ?? s.events.length}:${s.status}:${s.endedAt ?? ""}`).join("|");
    const cached = projectedVersions.get(id);
    if (cached?.version === version && cached.signature === signature) continue;
    const chat = storage.getChat(id) as Chat | undefined;
    if (!chat) continue;
    const projected = projectChat(chat, group);
    const changed = JSON.stringify(projected) !== JSON.stringify(chat);
    const next = changed ? storage.putChat({ ...projected }) : version;
    if (next) projectedVersions.set(id, { version: next, signature });
  }
  for (const id of projectedVersions.keys()) if (!versions.has(id)) projectedVersions.delete(id);
}
