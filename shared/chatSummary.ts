import type { Chat } from "../src/lib/types";

/** A sidebar projection, never a replacement for the stored transcript. */
export function chatSummary(chat: Chat): Chat {
  return {
    ...chat,
    historyDeferred: true,
    messages: (chat.messages ?? []).map(m => ({
      id: m.id, role: m.role, createdAt: m.createdAt, content: "",
      shell: m.shell ? { ...m.shell, command: m.shell.command.slice(0, 200), output: "", error: m.shell.error?.slice(0, 500) } : undefined,
      status: m.status, model: m.model, stream: m.stream,
      parts: m.parts?.filter(p => p.type === "ask" && p.answer === undefined),
      usage: m.usage, error: m.error?.slice(0, 500),
    })),
  };
}
