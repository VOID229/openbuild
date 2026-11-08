import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotHuddle } from "../src/components/bots/BotAvatar";

const looks = [
  { shape: "orb", color: "blue" },
  { shape: "orb", color: "green" },
  { shape: "orb", color: "pink" },
];

test("a huddle wakes only the members at work, and the rest doze", () => {
  const html = renderToStaticMarkup(createElement(BotHuddle, { looks, size: 34, alive: true, busy: true, active: [false, true, false] }));
  expect(html.match(/data-busy/g)?.length).toBe(1);
  expect(html.match(/data-asleep/g)?.length).toBe(2);
  // Dozing, they still breathe.
  expect(html.match(/bot-alive/g)?.length).toBe(3);
});

test("a huddle that isn't alive dozes still, but its members at work fidget", () => {
  const html = renderToStaticMarkup(createElement(BotHuddle, { looks, size: 34, alive: false, active: [false, true, false] }));
  expect(html.match(/data-asleep/g)?.length).toBe(2);
  expect(html.match(/bot-alive/g)?.length).toBe(1);
});

test("without `active` a huddle animates every member together, and none doze", () => {
  const html = renderToStaticMarkup(createElement(BotHuddle, { looks, size: 34, alive: true, busy: true }));
  expect(html.match(/bot-alive/g)?.length).toBe(3);
  expect(html).not.toContain("data-asleep");
  expect(html).not.toContain("bot-lid");
});
