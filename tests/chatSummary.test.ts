import { expect, test } from "bun:test";
import { chatSummary } from "../shared/chatSummary";
import type { Chat } from "../src/lib/types";

test("sidebar projections exclude large transcripts and retain status, models and usage", () => {
  const chat: Chat = { id: "large", title: "A thread", createdAt: 1, updatedAt: 2, pinned: true, messages: [{
    id: "reply", role: "assistant", createdAt: 1, status: "done", content: "x".repeat(5_000_000),
    parts: [{ type: "text", text: "y".repeat(5_000_000) }], model: { plan: "codex", id: "test", name: "Test" },
  }] };
  const summary = chatSummary(chat);
  expect(JSON.stringify(summary).length).toBeLessThan(1000);
  expect(summary.historyDeferred).toBe(true);
  expect(summary.pinned).toBe(true);
  expect(summary.messages[0]?.model).toEqual(chat.messages[0]?.model);
  expect(summary.messages[0]?.status).toBe("done");
  expect(chat.messages[0]?.content.length).toBe(5_000_000);
});
