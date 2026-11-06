import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotHuddle } from "../src/components/bots/BotAvatar";

const looks = [
  { shape: "orb", color: "blue" },
  { shape: "orb", color: "green" },
  { shape: "orb", color: "pink" },
];

test("a huddle animates only the members at work", () => {
  const html = renderToStaticMarkup(createElement(BotHuddle, { looks, size: 34, alive: true, busy: true, active: [false, true, false] }));
  expect(html.match(/bot-alive/g)?.length).toBe(1);
  expect(html.match(/data-busy/g)?.length).toBe(1);
});

test("without `active` a huddle animates every member together", () => {
  const html = renderToStaticMarkup(createElement(BotHuddle, { looks, size: 34, alive: true, busy: true }));
  expect(html.match(/bot-alive/g)?.length).toBe(3);
});
