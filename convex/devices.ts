// Devices: each sign-in is a Convex Auth session, and an account can have MAX_DEVICES of them.
// To sign in somewhere new at the limit, sign one out (from Settings → Account on another device,
// or from the sign-in form after entering the password). Signing out is unlimited; new sign-ins are
// rate limited (limits.ts), so an account can't be passed around between lots of devices.
import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { MAX_DEVICES, rateLimiter } from "./limits";

/**
 * The signed-in user and session, or null. A session token stays valid for up to an hour after its
 * session is deleted, so this checks the session still exists: a signed-out device loses access now.
 */
export async function currentSession(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  const raw = await getAuthSessionId(ctx);
  const sessionId = raw && ctx.db.normalizeId("authSessions", raw);
  if (!userId || !sessionId) return null;
  const session = await ctx.db.get(sessionId);
  return session && session.userId === userId ? { userId, sessionId } : null;
}

export async function requireSession(ctx: QueryCtx) {
  const session = await currentSession(ctx);
  if (!session) throw new ConvexError("Not signed in");
  return session;
}

const sessionsOf = (ctx: QueryCtx, userId: Id<"users">) =>
  ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .take(50);

const deviceOf = (ctx: QueryCtx, sessionId: Id<"authSessions">) =>
  ctx.db
    .query("devices")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique();

/** Sign a session out: it, its refresh tokens and its device label go. */
export async function deleteSession(ctx: MutationCtx, sessionId: Id<"authSessions">) {
  for (const token of await ctx.db
    .query("authRefreshTokens")
    .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
    .collect()) {
    await ctx.db.delete(token._id);
  }
  const device = await deviceOf(ctx, sessionId);
  if (device) await ctx.db.delete(device._id);
  if (await ctx.db.get(sessionId)) await ctx.db.delete(sessionId);
}

/** The account's live sessions. Expired ones (devices unused for a month) are cleaned up, and freed. */
async function liveSessions(ctx: MutationCtx, userId: Id<"users">) {
  const now = Date.now();
  const live: Doc<"authSessions">[] = [];
  for (const session of await sessionsOf(ctx, userId)) {
    if (session.expirationTime > now) live.push(session);
    else await deleteSession(ctx, session._id);
  }
  // Labels of devices that signed themselves out (Convex Auth deletes just the session).
  for (const device of await ctx.db
    .query("devices")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(50)) {
    if (!live.some((s) => s._id === device.sessionId)) await ctx.db.delete(device._id);
  }
  return live;
}

async function describe(ctx: QueryCtx, sessions: Doc<"authSessions">[], current: Id<"authSessions"> | null) {
  const rows = await Promise.all(
    sessions.map(async (s) => {
      const device = await deviceOf(ctx, s._id);
      return { id: s._id, name: device?.name ?? null, lastSeen: device?.lastSeen ?? s._creationTime, current: s._id === current };
    }),
  );
  return rows.sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeen - a.lastSeen);
}

/** The account's devices, this one first. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const me = await currentSession(ctx);
    if (!me) return null;
    return { max: MAX_DEVICES, devices: await describe(ctx, await sessionsOf(ctx, me.userId), me.sessionId) };
  },
});

const STALE = 60 * 60 * 1000;

/** Name this device (e.g. "Safari on iPhone") and note it's in use. Called when the app opens. */
export const register = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const me = await requireSession(ctx);
    const name = args.name.trim().slice(0, 60) || "Unknown device";
    const now = Date.now();
    const device = await deviceOf(ctx, me.sessionId);
    if (!device) {
      await liveSessions(ctx, me.userId);
      await ctx.db.insert("devices", { userId: me.userId, sessionId: me.sessionId, name, lastSeen: now });
    } else if (device.name !== name || now - device.lastSeen > STALE) {
      await ctx.db.patch(device._id, { name, lastSeen: now });
    }
    return null;
  },
});

/** Sign another device out of the account; this device signs out with "Sign out". */
export const remove = mutation({
  args: { sessionId: v.id("authSessions") },
  handler: async (ctx, { sessionId }) => {
    const me = await requireSession(ctx);
    if (sessionId === me.sessionId) throw new ConvexError("ThisDevice");
    const session = await ctx.db.get(sessionId);
    if (!session || session.userId !== me.userId) throw new ConvexError("NoSuchDevice");
    await deleteSession(ctx, sessionId);
    return null;
  },
});

/**
 * Called after the password checks out, before the new session exists. At the device limit it
 * refuses with the account's devices (only shown to someone who just proved the password), unless
 * `replace` names one of them to sign out in its place.
 */
export const admit = internalMutation({
  args: { userId: v.id("users"), replace: v.optional(v.string()) },
  handler: async (ctx, { userId, replace }) => {
    const newDevice = await rateLimiter.check(ctx, "newDevice", { key: userId });
    if (!newDevice.ok) throw new ConvexError({ code: "NewDeviceLimit", retryAfter: newDevice.retryAfter });
    // A device signing in again (e.g. finishing an interrupted sign-up) gives up its old session.
    const current = await getAuthSessionId(ctx);
    let others = (await liveSessions(ctx, userId)).filter((s) => s._id !== current);
    const target = replace && others.find((s) => s._id === replace);
    if (target) {
      await deleteSession(ctx, target._id);
      others = others.filter((s) => s !== target);
    }
    if (others.length >= MAX_DEVICES) {
      throw new ConvexError({ code: "DeviceLimit", devices: await describe(ctx, others, null) });
    }
    return null;
  },
});

/**
 * Convex Auth's beforeSessionCreation, in the mutation that creates the session: the final say on
 * the device limit (two sign-ins at once both passing `admit`), and where a new device is counted.
 */
export async function beforeNewSession(ctx: MutationCtx, userId: Id<"users">) {
  // The signing-in device's previous session, if any, has already been deleted by now.
  if ((await liveSessions(ctx, userId)).length >= MAX_DEVICES) {
    throw new ConvexError({ code: "DeviceLimit", devices: [] });
  }
  await rateLimiter.limit(ctx, "newDevice", { key: userId, throws: true });
}
