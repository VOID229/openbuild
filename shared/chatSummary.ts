import type { Chat } from "../src/lib/types";

const CREATE_PR = /(?:^|[;&|(\n])\s*gh\s+pr\s+create\b/;
const PR_URL = /https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+/;

/** The pull requests this thread's agent opened with `gh pr create`, by URL. */
export function openedPullRequests(chat: Chat): string[] {
  const urls = new Set<string>();
  for (const message of chat.messages ?? []) {
    for (const part of message.parts ?? []) {
      if (part.type !== "tool" || typeof part.args?.command !== "string" || !CREATE_PR.test(part.args.command)) continue;
      const url = typeof part.output === "string" ? part.output.match(PR_URL)?.[0] : undefined;
      if (url) urls.add(url);
    }
  }
  return [...urls];
}

/** A sidebar projection, never a replacement for the stored transcript. */
export function chatSummary(chat: Chat): Chat {
  const opened = openedPullRequests(chat);
  return {
    ...chat,
    ...(opened.length ? { openedPullRequests: opened } : {}),
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
