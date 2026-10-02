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
  records: defineTable({
    userId: v.id("users"),
    key: v.string(),
    seq: v.number(),
    deleted: v.boolean(),
    iv: v.optional(v.bytes()),
    data: v.optional(v.bytes()),
    file: v.optional(v.id("_storage")),
  })
    .index("by_user_key", ["userId", "key"])
    .index("by_user_seq", ["userId", "seq"]),
});
