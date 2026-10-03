import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Everything a user syncs is encrypted on their device before it gets here (src/lib/cloud/crypto.ts):
// the server stores ciphertext it has no key for, plus the bookkeeping sync needs.
export default defineSchema({
  ...authTables,

  // One per user. `wrappedKey` is the account's data key, encrypted with a key derived from the
  // password on the device; `seq` numbers the user's writes so devices can ask for "changes since".
  vaults: defineTable({
    userId: v.id("users"),
    wrappedKey: v.bytes(),
    iv: v.bytes(),
    seq: v.number(),
  }).index("by_user", ["userId"]),

  // A synced item: "chat:<id>", "settings" or "profile". Deleting keeps a tombstone (no content)
  // so other devices learn about it. Large items are kept in file storage instead of `data`.
  // Drafts ("draft:…", "draftfile:…") have `expiresAt` and are deleted after it (crons.ts).
  records: defineTable({
    userId: v.id("users"),
    key: v.string(),
    seq: v.number(),
    deleted: v.boolean(),
    iv: v.optional(v.bytes()),
    data: v.optional(v.bytes()),
    file: v.optional(v.id("_storage")),
    expiresAt: v.optional(v.number()),
  })
    .index("by_user_key", ["userId", "key"])
    .index("by_user_seq", ["userId", "seq"])
    .index("by_expiresAt", ["expiresAt"]),

  // Invite codes for sign-up (convex/invites.ts). `uses` counts accounts created with it; a code
  // stops working when used up, past `expiresAt`, or `revoked` (the kill switch for a leaked code).
  // `waitlistId` ties a single-use code to the waitlist address it was emailed to.
  inviteCodes: defineTable({
    code: v.string(),
    maxUses: v.number(),
    uses: v.number(),
    revoked: v.boolean(),
    expiresAt: v.optional(v.number()),
    note: v.optional(v.string()),
    waitlistId: v.optional(v.id("waitlist")),
  })
    .index("by_code", ["code"])
    .index("by_waitlist", ["waitlistId"]),

  // Addresses waiting for an invite. Only used to email the code, never linked to an account, and
  // deleted once the code sent to it is used.
  // `canonical` is the inbox it delivers to (emailCheck.ts), so one inbox is one place in line;
  // `bounced` marks an address whose invite bounced, kept so it can't rejoin.
  waitlist: defineTable({
    email: v.string(),
    canonical: v.optional(v.string()),
    invitedAt: v.optional(v.number()),
    bounced: v.optional(v.boolean()),
  })
    .index("by_email", ["email"])
    .index("by_canonical", ["canonical"])
    .index("by_invited", ["invitedAt"]),

  // A name for each signed-in session ("Safari on iPhone"), for Settings → Account → Devices.
  devices: defineTable({
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
    name: v.string(),
    lastSeen: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_user", ["userId"]),
});
