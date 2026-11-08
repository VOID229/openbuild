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

const LEAKS = ["LIVE_COOKIE_SECRET", "second-part", "word", "two", "hunter", "quote", "LIVE_AUTH", "BASIC_SECRET", "tail-of-secret"];
const lines = [
  "Cookie: first=abc; session=LIVE_COOKIE_SECRET; theme=dark",
  "set-cookie: id=1; second-part=2; Path=/",
  '{"password":"two word secret","user":"bob"}',
  "{'password': 'two word secret', 'user': 'bob'}",
  '{"password":"has \\"quote\\" inside"}',
  '{"msg":"{\\"password\\":\\"two word secret\\"}"}',
  "Authorization: Bearer LIVE_AUTH extra",
  "Authorization: Basic BASIC_SECRET",
  'config {"token":"tail-of-secret',
];

test("multipart header values and complete quoted secrets are redacted whole", () => {
  for (const line of lines) {
    const clean = redactLine(line);
    for (const leak of ["LIVE_COOKIE_SECRET", "second-part", "word secret", "two word", "quote", "LIVE_AUTH", "BASIC_SECRET", "tail-of-secret"]) expect(clean).not.toContain(leak);
    expect(clean).toContain("[redacted]");
  }
  // What isn't secret stays readable, and a quoted secret doesn't swallow the fields after it.
  expect(redactLine('{"password":"two word secret","user":"bob"}')).toBe('{"password":"[redacted]","user":"bob"}');
  expect(redactLine("starting on port 3000 (session ready)")).toBe("starting on port 3000 (session ready)");
});

test("the same lines are redacted when the stream splits them anywhere, and stay bounded", async () => {
  const text = lines.join("\n") + "\nplain line\n";
  for (const size of [1, 2, 3, 7, 19]) {
    const chunks = text.match(new RegExp(`[^]{1,${size}}`, "g"))!;
    const log = serverLog();
    await log.drain(stream(...chunks), "out");
    const tail = log.tail();
    for (const leak of LEAKS.filter((l) => !["two", "word", "hunter", "quote"].includes(l))) expect(tail).not.toContain(leak);
    expect(tail).not.toContain("two word");
    expect(tail).toContain("out: plain line");
    expect(tail.split("\n").length).toBeLessThanOrEqual(60);
  }
});

test("a secret cut off by the line bound is still not shown", async () => {
  const log = serverLog();
  await log.drain(stream('{"password":"', "x".repeat(2000), " two word secret"), "out");
  const tail = log.tail();
  expect(tail).not.toContain("xxxx");
  expect(tail).not.toContain("word secret");
});
