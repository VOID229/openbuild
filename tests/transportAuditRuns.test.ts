// Offline regressions for the shared transport. No servers, credentials, or user data are opened.
import { describe, expect, test } from "bun:test";
import { Run, startRun } from "../server/runs";
import { readEvents } from "../shared/replies";
import type { StreamEvent } from "../shared/types";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n");
const waiters = (run: Run) => (run as unknown as { waiters: Set<() => void> }).waiters.size;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function collect(body: ReadableStream<Uint8Array>) {
  const out: StreamEvent[] = [];
  for await (const event of readEvents(body)) out.push(event);
  return out;
}

describe("transport audit: watcher lifetime", () => {
  test("disconnect removes the pending waiter without stopping execution", async () => {
    const run = new Run();
    const reader = run.stream().getReader();
    const pending = reader.read();
    await tick();
    expect(waiters(run)).toBe(1);
    await reader.cancel();
    await pending;
    expect(waiters(run)).toBe(0);
    expect(run.signal.aborted).toBe(false);
    run.push({ t: "text", v: "still running" });
    run.end();
    expect(await collect(run.stream())).toEqual([{ t: "text", v: "still running" }, { t: "end" }]);
  });

  test("each heartbeat removes its losing event waiter", async () => {
    // Shorten only the transport heartbeat, leaving all other timers alone.
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) =>
      realTimeout(fn, delay === 15_000 ? 0 : delay, ...args)) as typeof setTimeout;
    const run = new Run();
    const reader = run.stream().getReader();
    try {
      for (let n = 0; n < 3; n++) {
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("\n");
        // The next pull may already be waiting; old heartbeat waiters must not accumulate.
        expect(waiters(run)).toBeLessThanOrEqual(1);
      }
    } finally {
      await reader.cancel();
      globalThis.setTimeout = realTimeout;
      run.end();
    }
    expect(waiters(run)).toBe(0);
  });
});

describe("transport audit: NDJSON source lifetime", () => {
  test("an early consumer return cancels the unread source and releases its lock", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encode({ t: "text", v: "one" })); },
      cancel() { cancelled = true; },
    });
    for await (const event of readEvents(body)) {
      expect(event).toEqual({ t: "text", v: "one" });
      break;
    }
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("an uncooperative source cancellation cannot hang iterator cleanup", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encode({ t: "done" })); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    });
    const events = readEvents(body);
    expect((await events.next()).value).toEqual({ t: "done" });
    await events.return(undefined);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("a parse failure cancels the source without replacing the syntax error", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("not json\n")); },
      cancel() { cancelled = true; throw new Error("cancel also failed"); },
    });
    await expect(collect(body)).rejects.toBeInstanceOf(SyntaxError);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("normal EOF preserves split UTF-8, heartbeat skipping, and a final unterminated line", async () => {
    const bytes = new TextEncoder().encode('\n{"t":"text","v":"שלום"}\n\n{"t":"done"}');
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
      cancel() { cancelled = true; },
    });
    expect(await collect(body)).toEqual([{ t: "text", v: "שלום" }, { t: "done" }]);
    expect(cancelled).toBe(false);
    expect(body.locked).toBe(false);
  });

  test("Stop cancels a stalled upstream reader and ends the run", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const run = startRun(async () => new Response(body));
    await tick();
    run.stop();
    await tick();
    expect(cancelled).toBe(true);
    expect(run.ended).toBe(true);
    expect(body.locked).toBe(false);
    expect(await collect(run.stream())).toEqual([{ t: "end" }]);
  });

  test("abort also prevents remaining events in the current decoded batch", async () => {
    const ctrl = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"t":"text","v":"one"}\n{"t":"text","v":"two"}\n'));
      },
    });
    const events = readEvents(body, ctrl.signal);
    expect((await events.next()).value).toEqual({ t: "text", v: "one" });
    ctrl.abort(new Error("stopped between events"));
    await expect(events.next()).rejects.toThrow("stopped between events");
    expect(body.locked).toBe(false);
  });

  test("an already aborted reader cancels without consuming a buffered event", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("already stopped"));
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encode({ t: "text", v: "must not escape" })); },
      cancel() { cancelled = true; },
    });
    await expect(readEvents(body, ctrl.signal).next()).rejects.toThrow("already stopped");
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("a response arriving after Stop has its unread body cancelled", async () => {
    let respond!: (response: Response) => void;
    const run = startRun(() => new Promise<Response>((resolve) => { respond = resolve; }));
    run.stop();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    respond(new Response(body));
    await tick();
    expect(cancelled).toBe(true);
    expect(run.ended).toBe(true);
  });
});
