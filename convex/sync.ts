// Sync API. Every function acts only on the signed-in user's own data. Content arrives encrypted
// and is stored as-is; nothing here logs, inspects or keeps anything else.
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { currentSession, deleteSession, requireSession } from "./devices";

/** Encrypted content stored inline; bigger items go to file storage. Convex documents max out at 1 MiB. */
const MAX_INLINE = 800 * 1024;
/** Records returned per "changes" page. */
const PAGE = 25;
/** Records deleted per call when deleting an account. */
const DELETE_BATCH = 200;

async function userId(ctx: QueryCtx): Promise<Id<"users">> {
  return (await requireSession(ctx)).userId;
}

const vaultOf = (ctx: QueryCtx, user: Id<"users">) =>
  ctx.db
    .query("vaults")
    .withIndex("by_user", (q) => q.eq("userId", user))
    .unique();

/** The signed-in account: its username, and its wrapped data key (null until set up). */
export const me = query({
  args: {},
  handler: async (ctx) => {
    // Null too when this device was signed out from another one: the app then signs out here.
    const id = (await currentSession(ctx))?.userId;
    if (!id) return null;
    const user = await ctx.db.get(id);
    const vault = await vaultOf(ctx, id);
    return {
      username: user?.email ?? "",
      vault: vault && { wrappedKey: vault.wrappedKey, iv: vault.iv },
    };
  },
});

/** Store the account's wrapped data key, once, right after sign-up. */
export const createVault = mutation({
  args: { wrappedKey: v.bytes(), iv: v.bytes() },
  handler: async (ctx, { wrappedKey, iv }) => {
    const user = await userId(ctx);
    if (await vaultOf(ctx, user)) throw new ConvexError("Account is already set up");
    await ctx.db.insert("vaults", { userId: user, wrappedKey, iv, seq: 0 });
  },
});

/** Records changed after `since` (a seq), oldest first. Subscribe to it to get changes live. */
export const changes = query({
  args: { since: v.number() },
  handler: async (ctx, { since }) => {
    const user = await userId(ctx);
    const page = await ctx.db
      .query("records")
      .withIndex("by_user_seq", (q) => q.eq("userId", user).gt("seq", since))
      .take(PAGE);
    return Promise.all(
      page.map(async (r) => ({
        key: r.key,
        seq: r.seq,
        deleted: r.deleted,
        iv: r.iv,
        data: r.data,
        url: r.file ? await ctx.storage.getUrl(r.file) : null,
      })),
    );
  },
});

/** An upload URL for an item too big to store inline. */
export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await userId(ctx);
    return ctx.storage.generateUploadUrl();
  },
});

/**
 * Write one record. `base` is the seq this device last saw for it: if someone else wrote it since,
 * nothing is written and the caller gets `conflict` (it will receive that write, merge, and retry).
 * A deleted record stays deleted.
 */
export const put = mutation({
  args: {
    key: v.string(),
    base: v.number(),
    deleted: v.boolean(),
    iv: v.optional(v.bytes()),
    data: v.optional(v.bytes()),
    file: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const user = await userId(ctx);
    const vault = await vaultOf(ctx, user);
    if (!vault) throw new ConvexError("Account is not set up");
    if (args.key.length > 200) throw new ConvexError("Key too long");
    if (args.data && args.data.byteLength > MAX_INLINE) throw new ConvexError("Too large; upload it as a file");
    if (!args.deleted && !args.iv) throw new ConvexError("Missing content");

    const current = await ctx.db
      .query("records")
      .withIndex("by_user_key", (q) => q.eq("userId", user).eq("key", args.key))
      .unique();
    const discard = async () => {
      if (args.file) await ctx.storage.delete(args.file);
    };
    if (current?.deleted) {
      await discard();
      return { seq: current.seq, deleted: true as const };
    }
    if (current && current.seq > args.base) {
      await discard();
      return { seq: current.seq, conflict: true as const };
    }

    const seq = vault.seq + 1;
    await ctx.db.patch(vault._id, { seq });
    const content = args.deleted ? { iv: undefined, data: undefined, file: undefined } : { iv: args.iv, data: args.file ? undefined : args.data, file: args.file };
    if (current) {
      if (current.file && current.file !== content.file) await ctx.storage.delete(current.file);
      await ctx.db.replace(current._id, { userId: user, key: args.key, seq, deleted: args.deleted, ...content });
    } else {
      await ctx.db.insert("records", { userId: user, key: args.key, seq, deleted: args.deleted, ...content });
    }
    return { seq };
  },
});

async function deleteRecords(ctx: MutationCtx, user: Id<"users">) {
  const batch = await ctx.db
    .query("records")
    .withIndex("by_user_key", (q) => q.eq("userId", user))
    .take(DELETE_BATCH);
  for (const r of batch) {
    if (r.file) await ctx.storage.delete(r.file);
    await ctx.db.delete(r._id);
  }
  return batch.length === DELETE_BATCH;
}

/**
 * Permanently delete the account and everything synced to it. Call until it returns `done: true`
 * (big accounts are deleted in batches). Data on your devices is not touched.
 */
export const deleteAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await userId(ctx);
    if (await deleteRecords(ctx, user)) return { done: false };

    const vault = await vaultOf(ctx, user);
    if (vault) await ctx.db.delete(vault._id);
    for (const account of await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", user))
      .collect()) {
      for (const code of await ctx.db
        .query("authVerificationCodes")
        .withIndex("accountId", (q) => q.eq("accountId", account._id))
        .collect()) {
        await ctx.db.delete(code._id);
      }
      await ctx.db.delete(account._id);
    }
    for (const session of await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", user))
      .collect()) {
      await deleteSession(ctx, session._id);
    }
    await ctx.db.delete(user);
    return { done: true };
  },
});
