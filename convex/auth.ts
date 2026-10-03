import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { beforeNewSession } from "./devices";
import { claimInvite } from "./invites";

// Username + password, no email: nothing to verify, nothing that identifies you. The "password"
// the server sees is derived from your real password on your device (src/lib/cloud/crypto.ts),
// and the key that encrypts your data is derived separately, so the server can't decrypt anything.
// Sign-up also takes an invite code (convex/invites.ts).
const password = Password({
  profile: (params) => {
    const username = String(params.email ?? "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,64}$/.test(username)) throw new ConvexError("Invalid username");
    // `invite` only rides along to createOrUpdateUser below, which claims it; it's never stored.
    return { email: username, invite: params.invite } as { email: string };
  },
  validatePasswordRequirements: (password) => {
    if (password.length < 40) throw new ConvexError("Invalid password");
  },
});

// Convex redacts plain Errors in production ("Server Error"), so a wrong password or a taken
// username would reach the browser with no readable reason. Rethrow those as ConvexErrors, which
// are passed through to the client intact (see authError in src/components/Account.tsx).
// Around the password check: the global rate limits and invite precheck before it (so refused
// attempts never reach the slow hashing), and the device limit after it.
type Authorize = (params: Record<string, unknown>, ctx: any) => Promise<{ userId: Id<"users"> } | null>;
const options = (password as unknown as { options: { authorize: Authorize } }).options;
const authorize = options.authorize;
options.authorize = async (params, ctx) => {
  if (params.flow === "signUp") {
    const verdict = await ctx.runMutation(internal.invites.precheck, { code: String(params.invite ?? "") });
    if (verdict === "rateLimited") throw new ConvexError("RateLimited");
    if (verdict !== "ok") throw new ConvexError("InvalidInvite");
  } else if (params.flow === "signIn") {
    if (!(await ctx.runMutation(internal.limits.signInAttempt, {}))) throw new ConvexError("RateLimited");
  }
  let result: Awaited<ReturnType<Authorize>>;
  try {
    result = await authorize(params, ctx);
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (/Invalid credentials/.test(msg)) throw new ConvexError("InvalidCredentials");
    if (/already exists/.test(msg)) throw new ConvexError("UsernameTaken");
    throw err;
  }
  if (result) {
    await ctx.runMutation(internal.devices.admit, {
      userId: result.userId,
      replace: typeof params.replace === "string" ? params.replace : undefined,
    });
  }
  return result;
};

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [password],
  callbacks: {
    // Runs in the mutation that creates the account, so the invite is claimed atomically with it:
    // if the code was used up in the meantime, no account is created.
    async createOrUpdateUser(ctx, args) {
      if (args.existingUserId) return args.existingUserId;
      const db = ctx as unknown as MutationCtx;
      await claimInvite(db, args.profile.invite);
      return db.db.insert("users", { email: args.profile.email });
    },
    async beforeSessionCreation(ctx, { userId }) {
      await beforeNewSession(ctx as unknown as MutationCtx, userId as Id<"users">);
    },
  },
});
