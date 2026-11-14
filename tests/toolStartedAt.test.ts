// A running tool call's timer counts from when the call started, not from when its row was shown:
// leaving a thread and coming back used to restart it from 0s (server/runs.ts stamps the start,
// the worker log keeps it, the projection and the ToolCalls row read it).
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StreamEvent } from "../shared/types";
import { Run } from "../server/runs";
import { WorkerRun, type PiRunRecord } from "../server/pi/workerRuntime";
import { projectReply } from "../server/pi/projection";
import { ToolRow } from "../src/components/ToolCalls";
import type { Message, ToolPart } from "../src/lib/types";

type Tool = Extract<StreamEvent, { t: "tool" }>;
const tools = (events: StreamEvent[]) => events.filter((e): e is Tool => e.t === "tool");
const startOf = (events: StreamEvent[], i: number) => tools(events)[i]?.startedAt;

describe("a tool call's start time", () => {
  test("is stamped on the call's first event only, and a supplied one is kept", () => {
    const run = new Run();
    const before = Date.now();
    run.push({ t: "tool", id: "a", name: "bash", args: { command: "sleep 60" }, status: "running" });
    run.push({ t: "tool", id: "a", name: "bash", status: "running", output: "…" });
    run.push({ t: "tool", id: "b", name: "bash", status: "running", startedAt: 1234 });
    run.push({ t: "tool", id: "a", name: "bash", status: "done", ms: 60_000 });
    expect(startOf(run.events, 0)).toBeGreaterThanOrEqual(before);
    expect(startOf(run.events, 0)).toBeLessThanOrEqual(Date.now());
    expect(startOf(run.events, 1)).toBeUndefined();
    expect(startOf(run.events, 2)).toBe(1234);
    expect(startOf(run.events, 3)).toBeUndefined();
  });

  test("is in the worker's log, which a reconnecting viewer replays", () => {
    const logged: StreamEvent[] = [];
    const record = { id: "r", threadId: "t", kind: "run", request: {}, status: "pending", startedAt: 1 } as unknown as PiRunRecord;
    const run = new WorkerRun(record, (e) => logged.push(e as StreamEvent));
    run.push({ t: "tool", id: "a", name: "bash", status: "running" });
    expect(startOf(logged, 0)).toBeNumber();
    expect(startOf(run.events, 0)).toBe(startOf(logged, 0)!);
  });

  test("survives later events in the projected reply", () => {
    const message = { id: "m", role: "assistant", content: "", status: "streaming", createdAt: 1, startedAt: 1 } as Message;
    const reply = projectReply(message, { id: "s", threadId: "t", kind: "run", status: "pending", startedAt: 1, events: [
      { t: "tool", id: "a", name: "bash", status: "running", startedAt: 500 },
      { t: "tool", id: "a", name: "bash", status: "running", output: "building" },
    ] });
    expect((reply.parts?.[0] as ToolPart).startedAt).toBe(500);
  });
});

describe("a running tool row", () => {
  const row = (part: Partial<ToolPart>) =>
    renderToStaticMarkup(createElement(ToolRow, { part: { type: "tool", id: "a", name: "bash", args: { command: "bun test" }, status: "running", ...part } }));

  test("shows how long the call has run since it started, even when just shown", () => {
    expect(row({ startedAt: Date.now() - 42_000 })).toMatch(/tool-time[^>]*>42s</);
  });

  test("waits a few seconds before showing a time, as before", () => {
    expect(row({ startedAt: Date.now() - 1000 })).not.toContain("tool-time");
    expect(row({})).not.toContain("tool-time");
  });
});
