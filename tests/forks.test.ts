// "2nd" → "5th": how deep forks go and what they're called.
import { describe, expect, test } from "bun:test";
import { chatDepth, ordinal } from "../src/lib/forks";

describe("fork depth", () => {
  test("ordinary chats are depth 1; forks without a stored depth are 2nd", () => {
    expect(chatDepth({})).toBe(1);
    expect(chatDepth({ forkOf: "a" })).toBe(2);
    expect(chatDepth({ forkOf: "a", forkDepth: 4 })).toBe(4);
  });

  test("labels run 2nd through 5th", () => {
    expect([2, 3, 4, 5].map(ordinal)).toEqual(["2nd", "3rd", "4th", "5th"]);
  });
});
