// Rate limits. The sync server runs on Convex's free tier, so these mostly protect its monthly
// budget of function calls from bots, and keep an account to a few devices.
import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const WEEK = 7 * 24 * HOUR;

/** Devices (sessions) an account can be signed in on at once. */
export const MAX_DEVICES = 3;

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Global: invite code checks, sign-up attempts (each re-checks the code), sign-in attempts, and
  // waitlist joins.
  // Convex Auth separately allows only 10 wrong passwords an hour per account.
  signUp: { kind: "token bucket", rate: 30, period: HOUR, capacity: 30 },
  inviteCheck: { kind: "token bucket", rate: 120, period: HOUR, capacity: 60 },
  signIn: { kind: "token bucket", rate: 600, period: HOUR, capacity: 300, shards: 2 },
  waitlist: { kind: "token bucket", rate: 60, period: HOUR, capacity: 60 },
  // Per account: new sign-ins (each makes a device), and signing other devices out. Enough to set up
  // three devices and fix a mistake or two, not enough to rotate an account between many devices.
  newDevice: { kind: "token bucket", rate: 3, period: WEEK, capacity: 5 },
  removeDevice: { kind: "token bucket", rate: 3, period: WEEK, capacity: 3 },
});

/** Count a sign-in attempt against the global limit (before the slow password check). */
export const signInAttempt = internalMutation({
  args: {},
  handler: async (ctx) => (await rateLimiter.limit(ctx, "signIn")).ok,
});
