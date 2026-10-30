import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("focus styles wait for keyboard navigation", () => {
  const lines = readFileSync("src/styles.css", "utf8").split("\n").filter((line) => line.includes(":focus-visible"));
  const ungated = lines.filter((line) => line !== ":focus-visible {" && !line.startsWith(":where([data-keyboard-nav]) ") && !line.startsWith(":where(textarea, "));
  expect(ungated).toEqual([]);
});
