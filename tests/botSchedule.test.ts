import { expect, test } from "bun:test";
import { isSchedule, nextRun, parseSchedule } from "../shared/botSchedule";

test("full weekday names and plurals preserve every selected day", () => {
  for (const [input, days] of [
    ["Monday at 8:00", [1]],
    ["Mondays and Thursdays at 18:30", [1, 4]],
    ["Tuesday, Wednesday, Friday at 7", [2, 3, 5]],
    ["Saturdays and Sundays at noon", [0, 6]],
    ["mon, wed, fri at 7", [1, 3, 5]],
  ] as const) {
    const parsed = parseSchedule(input);
    expect(parsed).toMatchObject({ kind: "days", days: [...days] });
  }
});

test("weekday schedules choose the next matching local day", () => {
  const monday = new Date(2026, 7, 10, 9).getTime();
  const parsed = parseSchedule("Mondays and Thursdays at 8:00");
  expect(isSchedule(parsed)).toBe(true);
  if (isSchedule(parsed)) expect(nextRun(parsed, monday)).toBe(new Date(2026, 7, 13, 8).getTime());
});

test("relative once schedules stay anchored to creation when recomputed", () => {
  const createdAt = new Date(2026, 7, 10, 9).getTime();
  const parsed = parseSchedule("in 2 hours", { once: true, now: createdAt, anchor: createdAt });
  expect(parsed).toEqual({ kind: "once", at: createdAt + 2 * 3600_000 });
  if (isSchedule(parsed)) expect(nextRun(parsed, createdAt + 3 * 3600_000)).toBeUndefined();
});
