import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";

// Username + password, no email: nothing to verify, nothing that identifies you. The "password"
// the server sees is derived from your real password on your device (src/lib/cloud/crypto.ts),
// and the key that encrypts your data is derived separately, so the server can't decrypt anything.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      profile: (params) => {
        const username = String(params.email ?? "").trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,64}$/.test(username)) throw new ConvexError("Invalid username");
        return { email: username };
      },
      validatePasswordRequirements: (password) => {
        if (password.length < 40) throw new ConvexError("Invalid password");
      },
    }),
  ],
});
