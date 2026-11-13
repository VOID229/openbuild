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

test("a countdown to a run reads to the second, and is gone once it's due", async () => {
  const { countdown } = await import("../shared/botSchedule");
  const s = 1000;
  expect(countdown(42 * s)).toBe("in 42s");
  expect(countdown(41.2 * s)).toBe("in 42s");
  expect(countdown((4 * 60 + 5) * s)).toBe("in 4m 05s");
  expect(countdown((3 * 3600 + 12 * 60 + 5) * s)).toBe("in 3h 12m 05s");
  expect(countdown(3600 * s)).toBe("in 1h 00m 00s");
  expect(countdown((2 * 86_400 + 4 * 3600 + 12 * 60) * s)).toBe("in 2d 4h 12m");
  expect(countdown(0)).toBeUndefined();
  expect(countdown(-5 * s)).toBeUndefined();
});

test("a routine being set reads back from its activity line; one running doesn't", async () => {
  const { routineSet } = await import("../shared/bots");
  expect(routineSet({ kind: "routine", text: "Set a routine", detail: "Standup · Weekdays at 9:00" })).toEqual({ title: "Standup", schedule: "Weekdays at 9:00", followUp: false });
  expect(routineSet({ kind: "routine", text: "Set a follow-up", detail: "Check CI · in 2 hours" })).toEqual({ title: "Check CI", schedule: "in 2 hours", followUp: true });
  // A title with the separator in it keeps it: the schedule is after the last.
  expect(routineSet({ kind: "routine", text: "Set a routine", detail: "Notes · weekly · Mondays at 9:00" })).toEqual({ title: "Notes · weekly", schedule: "Mondays at 9:00", followUp: false });
  // Older wording.
  expect(routineSet({ kind: "routine", text: "Routine", detail: "Standup · Weekdays at 9:00" })?.title).toBe("Standup");
  expect(routineSet({ kind: "routine", text: "Follow-up set", detail: "Check CI · in 2 hours" })?.followUp).toBe(true);
  for (const event of [
    { kind: "routine", text: "Ran a routine", detail: "Standup" },
    { kind: "routine", text: "Routine", detail: "Standup" },
    { kind: "routine", text: "Followed up", detail: "Check CI" },
    { kind: "memory", text: "Set a routine", detail: "Standup · Weekdays at 9:00" },
  ]) expect(routineSet(event)).toBeUndefined();
});
