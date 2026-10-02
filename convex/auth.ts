import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";

// Username + password, no email: nothing to verify, nothing that identifies you. The "password"
// the server sees is derived from your real password on your device (src/lib/cloud/crypto.ts),
// and the key that encrypts your data is derived separately, so the server can't decrypt anything.
const password = Password({
  profile: (params) => {
    const username = String(params.email ?? "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,64}$/.test(username)) throw new ConvexError("Invalid username");
    return { email: username };
  },
  validatePasswordRequirements: (password) => {
    if (password.length < 40) throw new ConvexError("Invalid password");
  },
});

// Convex redacts plain Errors in production ("Server Error"), so a wrong password or a taken
// username would reach the browser with no readable reason. Rethrow those as ConvexErrors, which
// are passed through to the client intact (see authError in src/components/Account.tsx).
const options = (password as unknown as { options: { authorize: (params: any, ctx: any) => Promise<unknown> } }).options;
const authorize = options.authorize;
options.authorize = async (params, ctx) => {
  try {
    return await authorize(params, ctx);
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (/Invalid credentials/.test(msg)) throw new ConvexError("InvalidCredentials");
    if (/already exists/.test(msg)) throw new ConvexError("UsernameTaken");
    throw err;
  }
};

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({ providers: [password] });
