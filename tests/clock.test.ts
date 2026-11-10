// Times of day: on a 12-hour clock the hour after midnight reads 00, not 12 (which reads like noon).
import { expect, test } from "bun:test";
import { formatTime } from "../src/lib/clock";

const at = (h: number, m: number) => new Date(2026, 10, 10, h, m);

test("midnight's hour shows as 00 on a 12-hour clock, and noon stays 12 PM", () => {
  const us = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
  expect([at(0, 2), at(9, 3), at(12, 2), at(23, 59)].map((d) => formatTime(us, d).replace(/\s/g, " "))).toEqual(["00:02 AM", "9:03 AM", "12:02 PM", "11:59 PM"]);
  const withDay = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
  expect(formatTime(withDay, at(0, 30)).replace(/\s/g, " ")).toBe("Tue 00:30 AM");
});

test("24-hour clocks are left as they are", () => {
  const de = new Intl.DateTimeFormat("de-DE", { hour: "numeric", minute: "2-digit" });
  expect(formatTime(de, at(0, 2))).toBe("0:02");
  expect(formatTime(de, at(12, 2))).toBe("12:02");
});
