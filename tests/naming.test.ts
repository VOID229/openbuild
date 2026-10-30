import { describe, expect, test } from "bun:test";
import { threadTranscript } from "../src/lib/naming";
import type { Message } from "../src/lib/types";

const message = (id: number, role: Message["role"], content: string): Message => ({ id: String(id), role, content, createdAt: id });

describe("threadTranscript", () => {
  test("is empty for a thread with nothing to read", () => {
    expect(threadTranscript({ messages: [] })).toBe("");
    expect(threadTranscript({ messages: [message(1, "assistant", "  ")] })).toBe("");
  });

  test("labels turns in order, with shell commands and attachment-only prompts", () => {
    const attached = { ...message(3, "user", ""), attachments: [{ name: "shot.png" }] } as Message;
    const messages = [message(1, "user", "fix the build"), message(2, "assistant", "done"), attached, message(4, "shell", "bun test")];
    expect(threadTranscript({ messages })).toBe("User: fix the build\n\nAssistant: done\n\nUser: shot.png\n\nUser: $ bun test");
  });

  test("keeps the opening prompt and the latest messages when the budget runs out", () => {
    const messages = [message(1, "user", "start"), ...[2, 3, 4, 5].map((i) => message(i, "assistant", `reply ${i}`.padEnd(90, ".")))];
    const out = threadTranscript({ messages }, 220);
    expect(out.startsWith("User: start\n\n[…]\n\nAssistant: reply 4")).toBe(true);
    expect(out).toContain("reply 5");
    expect(out).not.toContain("reply 3");
  });

  test("clips a long message so it can't take the whole budget", () => {
    const messages = [message(1, "user", "start"), message(2, "assistant", "x".repeat(5000)), message(3, "user", "latest")];
    const out = threadTranscript({ messages });
    expect(out).toContain("…");
    expect(out).toContain("latest");
    expect(out.length).toBeLessThan(1600);
  });
});
