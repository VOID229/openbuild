import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Everything a user syncs is encrypted on their device before it gets here (src/lib/cloud/crypto.ts):
// the server stores ciphertext it has no key for, plus the bookkeeping sync needs.
export default defineSchema({
  ...authTables,

  // One per user. `wrappedKey` is the account's data key, encrypted with a key derived from the
  // password on the device. `seq` is where the account's write counter started (see `seqs`).
  vaults: defineTable({
    userId: v.id("users"),
    wrappedKey: v.bytes(),
    iv: v.bytes(),
    seq: v.number(),
  }).index("by_user", ["userId"]),

  // Numbers each user's writes so devices can ask for "changes since". Kept apart from the vault,
  // which every device watches (sync.me): bumping it there re-ran that query on each write.
  seqs: defineTable({
    userId: v.id("users"),
    seq: v.number(),
  }).index("by_user", ["userId"]),

  // A synced item: "chat:<id>", "settings" or "profile". Deleting keeps a tombstone (no content)
  // so other devices learn about it. Large items are kept in file storage instead of `data`.
  // Drafts written here by older app versions ("draft:…", "draftfile:…") have `expiresAt` and are
  // deleted after it (crons.ts); drafts now live in `drafts`.
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

  // Unsent composer drafts ("draft:<chat id>") and their attachments ("draftfile:<id>"), encrypted
  // like records. Kept out of `records` so writing one doesn't wake every device's live "changes"
  // feed: devices fetch drafts when the app opens or comes back into view (sync.draftsSince).
  // `at` is when the draft was edited or cleared on its device (the newer one wins); `changedAt`
  // is when it reached the server; `session` is the device that wrote it. Deleted after `expiresAt`.
  drafts: defineTable({
    userId: v.id("users"),
    key: v.string(),
    session: v.id("authSessions"),
    at: v.number(),
    changedAt: v.number(),
    deleted: v.boolean(),
    iv: v.optional(v.bytes()),
    data: v.optional(v.bytes()),
    file: v.optional(v.id("_storage")),
    expiresAt: v.number(),
  })
    .index("by_user_key", ["userId", "key"])
    .index("by_user_changedAt", ["userId", "changedAt"])
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
