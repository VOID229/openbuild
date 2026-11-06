import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageItem } from "../src/components/MessageItem";
import { useBots } from "../src/lib/bots/store";
import type { Bot } from "../src/lib/bots/types";

const eggbot = { id: "bot-egg", name: "Dr Eggbot · notes", look: { shape: "puff", color: "white" } } as Bot;
/** The label alone: the message's action buttons draw icons too. */
const label = (extra: { sentBy: string; sentByBot?: string }) => renderToStaticMarkup(createElement(MessageItem, { message: { id: "m", role: "user", content: "Hi", createdAt: 0, ...extra }, chatId: "c", isLast: false })).split('class="bubble"')[0]!;
// Rendering to a string reads the store's initial state.
const withBots = (bots: Bot[]) => { useBots.getInitialState().bots = bots; };

afterEach(() => withBots([]));

test("a bot's message shows its current name and mascot", () => {
  withBots([eggbot]);
  const html = label({ sentBy: "Old name", sentByBot: eggbot.id });
  expect(html).toContain("<span>Dr Eggbot</span>");
  expect(html).toContain("<svg");
});

test("an older message finds its bot by the first name it kept", () => {
  withBots([eggbot]);
  const html = label({ sentBy: "Dr" });
  expect(html).toContain("<span>Dr Eggbot</span>");
  expect(html).toContain("<svg");
});

test("a deleted bot keeps the name it signed with, without a mascot", () => {
  const html = label({ sentBy: "manager", sentByBot: "gone" });
  expect(html).toContain("<span>manager</span>");
  expect(html).not.toContain("<svg");
});

test("a bot's follow-up steered into a running reply is signed too", () => {
  withBots([eggbot]);
  const message = { id: "a", role: "assistant", content: "", createdAt: 0, parts: [{ type: "steer", id: "s1", text: "Also this", sentBy: "Dr", sentByBot: eggbot.id }] } as const;
  const html = renderToStaticMarkup(createElement(MessageItem, { message: message as never, chatId: "c", isLast: false }));
  expect(html).toContain("Sent by");
  expect(html).toContain("<span>Dr Eggbot</span>");
});
