// Replies outlive the connection that started them: the server keeps running them, and the app
// reconnects and replays them (server/runs.ts, convex/streams.ts, src/lib/api.ts streamChat).
import { beforeAll, describe, expect, test } from "bun:test";
import { newStreamKey, openEvents, readEvents, sealEvents } from "../shared/replies";
import type { StreamEvent } from "../shared/types";
import { localRun, startRun } from "../server/runs";
import { appTest } from "./convex";

const g = globalThis as any;
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", hidden: false };

const ndjson = (events: StreamEvent[]) => events.map((e) => JSON.stringify(e) + "\n").join("");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A chat handler response that writes `events` one at a time, stopping early if aborted. */
function slowReply(events: StreamEvent[], signal: AbortSignal, gap = 5) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(c) {
        for (const e of events) {
          if (signal.aborted) break;
          await sleep(gap);
          c.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        }
        c.close();
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
}

async function collect(body: ReadableStream<Uint8Array>) {
  const out: StreamEvent[] = [];
  for await (const e of readEvents(body)) out.push(e);
  return out;
}

const words = ["Hello", " there", ",", " friend", "."].map((v) => ({ t: "text" as const, v }));

describe("server runs", () => {
  test("keep going when the watcher leaves, and replay from the start", async () => {
    let signal!: AbortSignal;
    const run = startRun(async (s) => slowReply([...words, { t: "done" }], (signal = s)));
    // A watcher that reads two events and leaves (closed tab).
    const reader = run.stream().getReader();
    await reader.read();
    await reader.cancel();
    expect(signal.aborted).toBe(false);
    // Someone reconnecting gets everything, then the end marker.
    const replay = await collect(run.stream());
    expect(replay).toEqual([...words, { t: "done" }, { t: "end" }]);
    expect(run.ended).toBe(true);
  });

  test("a stop ends the run", async () => {
    let signal!: AbortSignal;
    const run = startRun(async (s) => slowReply(words, (signal = s), 20));
    await run.next(0);
    run.stop();
    expect(signal.aborted).toBe(true);
    const replay = await collect(run.stream());
    expect(replay.at(-1)).toEqual({ t: "end" });
    expect(replay.length).toBeLessThan(words.length + 1);
  });

  test("a request that's rejected becomes an error event", async () => {
    const run = startRun(async () => Response.json({ error: "No key" }, { status: 400 }));
    expect(await collect(run.stream())).toEqual([{ t: "error", status: 400, message: "No key" }, { t: "end" }]);
  });

  test("sending the same reply id again watches the running reply", () => {
    let starts = 0;
    const start = () => (starts++, startRun(async (s) => slowReply(words, s)));
    const a = localRun("reply-id-0123456789", start);
    const b = localRun("reply-id-0123456789", start);
    expect(a).toBe(b);
    expect(starts).toBe(1);
  });
});

describe("saved replies (hosted)", () => {
  const secret = "s".repeat(40);
  const id = "abcdefghijklmnop1234";
  beforeAll(() => {
    process.env.OPENCHAT_RELAY_SECRET = secret;
  });

  test("events are encrypted with the reply's key, bound to its id", async () => {
    const key = newStreamKey();
    const { iv, data } = await sealEvents(key, id, words);
    expect(new TextDecoder().decode(data)).not.toContain("Hello");
    expect(await openEvents(key, id, iv, data)).toEqual(words);
    expect(openEvents(key, "another-id-123456789", iv, data)).rejects.toThrow();
    expect(openEvents(newStreamKey(), id, iv, data)).rejects.toThrow();
  });

  test("only the relay writes; anyone with the id reads and stops", async () => {
    const t = await appTest();
    const { api } = await import("../convex/_generated/api");
    expect(t.mutation(api.streams.begin, { secret: "wrong".repeat(10), id })).rejects.toThrow();
    expect(await t.mutation(api.streams.begin, { secret, id })).toBe(true);
    // A retried request finds it taken.
    expect(await t.mutation(api.streams.begin, { secret, id })).toBe(false);
    expect(await t.query(api.streams.read, { id: "nope-nope-nope-nope", after: 0 })).toBeNull();

    const key = newStreamKey();
    const chunk = await sealEvents(key, id, words.slice(0, 2));
    expect(await t.mutation(api.streams.append, { secret, id, chunk, done: false })).toEqual({ stop: false });
    expect(t.mutation(api.streams.append, { secret: "x", id, chunk, done: false })).rejects.toThrow();

    const page = (await t.query(api.streams.read, { id, after: 0 }))!;
    expect(page.done).toBe(false);
    expect(page.chunks.map((c) => c.seq)).toEqual([1]);
    expect(await openEvents(key, id, page.chunks[0]!.iv, page.chunks[0]!.data)).toEqual(words.slice(0, 2));
    expect((await t.query(api.streams.read, { id, after: 1 }))!.chunks).toEqual([]);

    // The app stops it; the relay hears on its next write.
    await t.mutation(api.streams.stop, { id });
    expect(await t.mutation(api.streams.append, { secret, id, done: true })).toEqual({ stop: true });
    expect((await t.query(api.streams.read, { id, after: 0 }))!.done).toBe(true);
  });

  test("expired replies are deleted", async () => {
    const t = await appTest();
    const { api, internal } = await import("../convex/_generated/api");
    await t.mutation(api.streams.begin, { secret, id });
    await t.mutation(api.streams.append, { secret, id, chunk: await sealEvents(newStreamKey(), id, words), done: true });
    await t.run(async (ctx) => {
      const s = (await ctx.db.query("streams").first())!;
      await ctx.db.patch(s._id, { expiresAt: Date.now() - 1 });
    });
    await t.mutation(internal.streams.expire, {});
    expect(await t.query(api.streams.read, { id, after: 0 })).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("streamChunks").collect())).toEqual([]);
  });
});

describe("the app reconnects", () => {
  test("a dropped connection picks the reply back up, replaying it", async () => {
    const realFetch = g.fetch;
    const calls: string[] = [];
    g.fetch = async (input: any, init?: any) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/config") return Response.json({ mode: "local", convexUrl: null, serverId: "server-1" });
      if (url === "/api/chat") {
        // Two words arrive, then the connection drops (Tailscale restarting, Safari suspended…).
        let n = 0;
        return new Response(
          new ReadableStream({
            pull(c) {
              if (n < 2) return c.enqueue(new TextEncoder().encode(JSON.stringify(words[n++]) + "\n"));
              c.error(new TypeError("Load failed"));
            },
          }),
          { headers: { "x-openchat-run": "1" } },
        );
      }
      if (url.startsWith("/api/chat/runs/")) return new Response(ndjson([...words, { t: "done" }, { t: "end" }]), { headers: { "x-openchat-run": "1" } });
      return Response.json({ state: null });
    };
    try {
      const { streamChat } = await import("../src/lib/api");
      const req = { plan: "go" as const, model: "m", effort: "medium" as const, sessionId: "c", messages: [{ role: "user" as const, content: "hi" }] };
      const got: string[] = [];
      for await (const ev of streamChat(req, { id: "reply-0123456789abcdef", via: "server-1" }, Date.now(), new AbortController().signal)) {
        got.push(ev.t === "text" ? ev.v : ev.t);
      }
      expect(got).toEqual(["Hello", " there", "reset", ...words.map((w) => w.v), "done"]);
      expect(calls.filter((c) => c.includes("/api/chat"))).toEqual(["POST /api/chat", "GET /api/chat/runs/reply-0123456789abcdef"]);
    } finally {
      g.fetch = realFetch;
    }
  });
});
