import { expect, test } from "bun:test";
import { redactLine, serverLog } from "./serverLog";

const stream = (...parts: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } });

test("a server's output is scrubbed of keys and tokens line by line", () => {
  expect(redactLine("Authorization: Bearer abc.def-123")).not.toContain("abc.def");
  expect(redactLine('{"token":"s3cr3t-value"}')).not.toContain("s3cr3t");
  expect(redactLine("key sk-abcdefghijklmnop1234")).not.toContain("abcdefghijkl");
  expect(redactLine("device " + "a".repeat(40))).toBe("device [redacted]");
  expect(redactLine("listening on 127.0.0.1:3000")).toBe("listening on 127.0.0.1:3000");
});

test("only the last bounded lines are kept, each scrubbed and capped, across chunk boundaries", async () => {
  const log = serverLog();
  await log.drain(stream("first\nsecond to", "ken=hunter2value\n", ...Array.from({ length: 100 }, (_, i) => `line ${i}\n`), "x".repeat(5000), "\nunfinished"), "out");
  const tail = log.tail();
  expect(tail).not.toContain("first");
  expect(tail).not.toContain("hunter2value");
  expect(tail).toContain("out: line 99");
  expect(tail).toContain("out: unfinished");
  expect(tail.split("\n").length).toBeLessThanOrEqual(60);
  expect(Math.max(...tail.split("\n").map((l) => l.length))).toBeLessThanOrEqual(310);
});

test("a server that printed nothing says so, and a failed pipe doesn't throw", async () => {
  const log = serverLog();
  await log.drain(undefined, "out");
  await log.drain(new ReadableStream({ start(c) { c.error(new Error("closed")); } }), "err");
  expect(log.tail()).toBe("(the server printed nothing)");
});
