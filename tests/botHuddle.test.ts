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

test("a member at work is never one of the count: it takes the last dozing member's place", () => {
  const six = ["blue", "green", "pink", "amber", "teal", "purple"].map((color) => ({ shape: "orb", color }));
  const shown = (active?: boolean[]) =>
    [...renderToStaticMarkup(createElement(BotHuddle, { looks: six, size: 80, active, extra: 2 })).matchAll(/data-color="(\w+)"/g)].map((m) => m[1]);
  expect(shown([false, false, false, false, false, false])).toEqual(["blue", "green", "pink", "amber"]);
  expect(shown([false, false, false, false, true, false])).toEqual(["blue", "green", "pink", "teal"]);
  expect(shown([false, true, false, false, false, true])).toEqual(["blue", "green", "pink", "purple"]);
  expect(shown()).toEqual(["blue", "green", "pink", "amber"]);
});
