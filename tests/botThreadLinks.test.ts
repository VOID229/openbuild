// Where a link in a bot chat to one of its threads opens it (lib/bots/activity): in the details
// panel's Threads tab while the thread is running and listed there, else over OpenBots.
import { describe, expect, test } from "bun:test";
import { runningThreads, threadOpensIn, threadStarter } from "../src/lib/bots/activity";
import type { Conversation } from "../src/lib/bots/types";
import type { Chat } from "../src/lib/types";

const chat = (id: string, running: boolean, startedBy?: Chat["startedBy"]): Chat =>
  ({
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    ...(startedBy ? { startedBy } : {}),
    messages: [
      { id: `${id}-u`, role: "user", content: "Go", createdAt: 1 },
      { id: `${id}-a`, role: "assistant", content: "…", createdAt: 1, status: running ? "streaming" : "done" },
    ],
  }) as Chat;
const started = (threadId: string, author = "egg") => ({ id: `e-${threadId}`, author, at: 1, text: "", event: { kind: "thread" as const, text: "Started a thread", detail: threadId, threadId } });
const conv = (id: string, kind: Conversation["kind"], messages: Conversation["messages"] = []) => ({ id, kind, messages }) as Pick<Conversation, "id" | "kind" | "messages">;

const dm = conv("dm", "direct", [started("old-style")]);
const chats = [
  chat("running", true, { bot: "egg", conversation: "dm" }),
  chat("finished", false, { bot: "egg", conversation: "dm" }),
  chat("elsewhere", true, { bot: "egg", conversation: "group" }),
  // Started before threads said who started them: the chat's line does.
  chat("old-style", true),
];

describe("threadOpensIn", () => {
  test("a running thread a bot started from this chat opens in the details panel", () => {
    expect(threadOpensIn(dm, chats, "running")).toBe("details");
    expect(threadOpensIn(dm, chats, "old-style")).toBe("details");
  });

  test("a finished one, or another chat's, opens over OpenBots: the Threads tab doesn't list it", () => {
    expect(threadOpensIn(dm, chats, "finished")).toBe("over");
    expect(threadOpensIn(dm, chats, "elsewhere")).toBe("over");
    expect(threadOpensIn(conv("group", "group"), chats, "elsewhere")).toBe("details");
  });

  test("one just started here that hasn't reached this tab yet goes to the panel; an unknown one doesn't", () => {
    const fresh = conv("dm", "direct", [started("brand-new")]);
    expect(threadOpensIn(fresh, chats, "brand-new")).toBe("details");
    expect(threadOpensIn(dm, chats, "brand-new")).toBe("over");
  });

  test("a side chat has no Threads tab", () => {
    expect(threadOpensIn(conv("dm", "side"), chats, "running")).toBe("over");
  });

  test("agrees with what the Threads tab lists", () => {
    const listed = runningThreads(dm, chats).map((t) => t.chat.id);
    expect(listed).toEqual(["running", "old-style"]);
    for (const c of chats) expect(threadOpensIn(dm, chats, c.id) === "details").toBe(listed.includes(c.id));
    expect(threadStarter(dm, chats[0]!)).toBe("egg");
    expect(threadStarter(dm, chats[2]!)).toBeUndefined();
  });
});
