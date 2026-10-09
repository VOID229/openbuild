// Replies in progress on the hosted site. The relay (server/vercel/chat.ts) keeps nothing between
// requests, so it writes each reply here as it streams; if the app's connection to the relay drops
// (a reload, a closed tab, a network blip), the app reads the reply from here instead, live. The
// events are encrypted with the reply's own key, which only the app has (shared/replies.ts).
//
// Only the relay can write (it proves itself with OPENCHAT_RELAY_SECRET); reading or stopping a
// reply takes its random id. Replies are deleted an hour after they end, or two hours after their
// last write if the relay died mid-reply.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query, type QueryCtx } from "./_generated/server";

const HOUR = 60 * 60 * 1000;
/** Chunks returned per read. */
const PAGE = 64;
const MAX_CHUNK = 512 * 1024;
const DELETE_BATCH = 200;

const streamId = v.string();
const isId = (id: string) => /^[A-Za-z0-9_-]{16,64}$/.test(id);

function isRelay(secret: string) {
  const expected = process.env.OPENCHAT_RELAY_SECRET;
  return !!expected && expected.length >= 32 && secret === expected;
}

const streamOf = (ctx: QueryCtx, id: string) =>
  ctx.db
    .query("streams")
    .withIndex("by_streamId", (q) => q.eq("streamId", id))
    .unique();

/** Relay: claim a reply id. False if it's already taken (the app retried a request that got through). */
export const begin = mutation({
  args: { secret: v.string(), id: streamId },
  handler: async (ctx, { secret, id }) => {
    if (!isRelay(secret) || !isId(id)) throw new Error("Forbidden");
    if (await streamOf(ctx, id)) return false;
    const now = Date.now();
    await ctx.db.insert("streams", { streamId: id, seq: 0, done: false, stopped: false, updatedAt: now, expiresAt: now + 2 * HOUR });
    return true;
  },
});

/** Relay: add a batch of events (or none, as a sign of life). Says whether the app asked to stop. */
export const append = mutation({
  args: { secret: v.string(), id: streamId, chunk: v.optional(v.object({ iv: v.bytes(), data: v.bytes() })), done: v.boolean() },
  handler: async (ctx, { secret, id, chunk, done }) => {
    if (!isRelay(secret)) throw new Error("Forbidden");
    const stream = await streamOf(ctx, id);
    if (!stream) return { stop: true };
    if (stream.done) return { stop: stream.stopped };
    let seq = stream.seq;
    if (chunk) {
      if (chunk.data.byteLength > MAX_CHUNK) throw new Error("Chunk too large");
      await ctx.db.insert("streamChunks", { streamId: id, seq: ++seq, iv: chunk.iv, data: chunk.data });
    }
    const now = Date.now();
    await ctx.db.patch(stream._id, { seq, done, updatedAt: now, expiresAt: now + (done ? HOUR : 2 * HOUR) });
    return { stop: stream.stopped };
  },
});

/** A reply's chunks after `after`, oldest first; null if there's no such reply (yet, or anymore). */
export const read = query({
  args: { id: streamId, after: v.number() },
  handler: async (ctx, { id, after }) => {
    const stream = await streamOf(ctx, id);
    if (!stream) return null;
    const chunks = await ctx.db
      .query("streamChunks")
      .withIndex("by_streamId_and_seq", (q) => q.eq("streamId", id).gt("seq", after))
      .take(PAGE);
    return {
      done: stream.done,
      updatedAt: stream.updatedAt,
      chunks: chunks.map((c) => ({ seq: c.seq, iv: c.iv, data: c.data })),
    };
  },
});

/** App: stop a reply. The relay sees it on its next write (within a few seconds). */
export const stop = mutation({
  args: { id: streamId },
  handler: async (ctx, { id }) => {
    const stream = await streamOf(ctx, id);
    if (stream && !stream.done && !stream.stopped) await ctx.db.patch(stream._id, { stopped: true });
  },
});

export const expire = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("streams")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(20);
    let more = expired.length === 20;
    for (const stream of expired) {
      const chunks = await ctx.db
        .query("streamChunks")
        .withIndex("by_streamId_and_seq", (q) => q.eq("streamId", stream.streamId))
        .take(DELETE_BATCH);
      for (const c of chunks) await ctx.db.delete(c._id);
      if (chunks.length === DELETE_BATCH) more = true;
      else await ctx.db.delete(stream._id);
    }
    if (more) await ctx.scheduler.runAfter(0, internal.streams.expire, {});
  },
});
