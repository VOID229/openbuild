import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotHuddle, HUDDLE_SEAT_MIN } from "../src/components/bots/BotAvatar";

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

const six = ["blue", "green", "pink", "amber", "teal", "purple"].map((color) => ({ shape: "orb", color }));
const colors = (html: string) => [...html.matchAll(/data-color="(\w+)"/g)].map((m) => m[1]);
const more = (html: string) => html.match(/class="bot-huddle-more"[^>]*>([^<]*)</)?.[1];

test("a member at work is never one of the count: it takes the last dozing member's place", () => {
  const shown = (size: number, active?: boolean[]) => colors(renderToStaticMarkup(createElement(BotHuddle, { looks: six, size, active })));
  // Too small for a seat, the count goes beside the huddle and all four seats are members.
  expect(shown(24, [false, false, false, false, false, false])).toEqual(["blue", "green", "pink", "amber"]);
  expect(shown(24, [false, false, false, false, true, false])).toEqual(["blue", "green", "pink", "teal"]);
  expect(shown(24, [false, true, false, false, false, true])).toEqual(["blue", "green", "pink", "purple"]);
  expect(shown(24)).toEqual(["blue", "green", "pink", "amber"]);
  // Big enough, the count has the fourth seat, and three are members.
  expect(shown(80, [false, false, false, false, false, false])).toEqual(["blue", "green", "pink"]);
  expect(shown(80, [false, false, false, false, true, false])).toEqual(["blue", "green", "teal"]);
  expect(shown(80, [false, true, false, false, false, true])).toEqual(["blue", "green", "purple"]);
});

test("a big huddle's count takes the last seat of the grid, and counts everyone not shown", () => {
  const html = renderToStaticMarkup(createElement(BotHuddle, { looks: six, size: HUDDLE_SEAT_MIN }));
  expect(html).toContain('data-more="seat"');
  expect(html.match(/bot-huddle-seat/g)?.length).toBe(1);
  expect(more(html)).toBe("+3");
  // In the grid's bottom-right seat, the size of a member's.
  expect(html).toMatch(/bot-huddle-seat" style="left:47%;top:47%;width:50%;height:50%/);
});

test("a small huddle's count follows it, outside the box", () => {
  const html = renderToStaticMarkup(createElement(BotHuddle, { looks: six, size: HUDDLE_SEAT_MIN - 1 }));
  expect(html).toContain('data-more="beside"');
  expect(html).not.toContain("bot-huddle-seat");
  expect(more(html)).toBe("+2");
  // The box closes before the count opens: it isn't drawn over the members.
  expect(html).toMatch(/<\/span><\/span><span class="bot-huddle-more"[^>]*>\+2<\/span><\/span>$/);
});

test("a group that fits has no count at all", () => {
  for (const size of [18, 80]) {
    const html = renderToStaticMarkup(createElement(BotHuddle, { looks: six.slice(0, 4), size }));
    expect(colors(html)).toHaveLength(4);
    expect(html).not.toContain("bot-huddle-more");
    expect(html).not.toContain("data-more");
  }
});

test("with the user in it, the count's seat leaves room for two members", () => {
  const html = renderToStaticMarkup(createElement(BotHuddle, { looks: six, size: 96, me: createElement("img", { className: "me" }) }));
  expect(colors(html)).toEqual(["blue", "green"]);
  expect(more(html)).toBe("+4");
});
