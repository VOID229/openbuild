import { expect, test } from "bun:test";
import { projectChat } from "../server/pi/projection";
import { limitReason } from "../shared/usage";
import type { Chat } from "../src/lib/types";

test("usage limits and empty balances are told apart from ordinary failures", () => {
  for (const error of [
    "Credit balance is too low",
    "Your credit balance is too low to access the Anthropic API.",
    "This request requires more credits, or fewer max_tokens.",
    "insufficient_quota",
    "You exceeded your current quota, please check your plan and billing details.",
    "API Error: 402 Payment Required",
  ]) expect(limitReason(error)).toBe("credits");
  for (const error of [
    "You've hit your limit · resets 3pm",
    "You've hit your 5-hour limit · resets 12:20pm (Asia/Jerusalem)",
    "You've hit your 7-day limit · resets Nov 2",
    "You've hit your usage limit. Upgrade to get more.",
    "Claude usage limit reached",
    "You're out of extra usage",
    "API Error: 429 {\"type\":\"error\"}",
    "429 Too Many Requests",
    "Upstream error (HTTP 429)",
    "rate_limit_error: slow down",
    "RESOURCE_EXHAUSTED",
  ]) expect(limitReason(error)).toBe("usage");
  for (const error of [
    undefined,
    "The model returned an empty response.",
    "prompt is too long: 250000 tokens > 200000 maximum context length exceeded",
    "Lost the connection to this reply.",
    "Your API key was rejected.",
    "Overloaded",
    "Failed at line 429 of worker.ts",
  ]) expect(limitReason(error)).toBeUndefined();
});

test("a reply cut off by a limit while no browser was open still surfaces its thread", () => {
  const chat = (status: "streaming" | "error"): Chat => ({
    id: "t", title: "T", createdAt: 1, updatedAt: 2,
    messages: [{ id: "a", role: "assistant", content: "", createdAt: 1, status, stream: { id: "r", via: "server" } }],
  } as Chat);
  const snapshot = (message: string) => ({ id: "r", threadId: "t", kind: "run" as const, status: "error", startedAt: 1, endedAt: 3, events: [{ t: "error" as const, message }] });
  expect(projectChat(chat("streaming"), [snapshot("Claude usage limit reached")]).done).toBe(true);
  expect(projectChat(chat("streaming"), [snapshot("Boom")]).done).toBeUndefined();
});
