// Invite-only sign-up. New accounts need an invite code: either one sent to an address on the
// waitlist (single use), or a multi-use code handed out by hand (e.g. 50 uses for one forum post).
// Codes are claimed in the same mutation that creates the account (see createOrUpdateUser in
// auth.ts), so two sign-ups can never both get the last use of a code.
//
// Admin, from the repo (add --prod for the hosted service):
//   bunx convex run invites:inviteWaitlist '{"count": 10}'       invite the next 10 on the waitlist (max 100)
//   bunx convex run invites:createCode '{"maxUses": 50, "note": "reddit"}'
//   bunx convex run invites:revokeCode '{"code": "ABCD-EFGH-JKMN"}'   kill switch for a leaked code
//   bunx convex run invites:waitlistSize
// Waitlist invites are emailed when RESEND_API_KEY and INVITE_EMAIL_FROM are set on the deployment;
// otherwise inviteWaitlist prints the codes to send yourself. With RESEND_WEBHOOK_SECRET set too,
// Resend reports bounces to /resend-webhook (http.ts), which revokes codes sent to dead addresses.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { acceptsMail, canonicalEmail, isDisposable, looksLikeEmail } from "./emailCheck";
import { rateLimiter } from "./limits";

// Crockford base32: no I, L, O or U, so codes survive being read aloud or retyped.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12; // 60 bits

/** Uppercase, separators dropped, look-alike letters read as the digits they resemble. */
export const normalizeCode = (code: string) =>
  code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");

const formatCode = (code: string) => code.match(/.{1,4}/g)!.join("-");

function generateCode() {
  // 256 is a multiple of 32, so masking keeps every character equally likely.
  return [...crypto.getRandomValues(new Uint8Array(CODE_LENGTH))].map((b) => ALPHABET[b & 31]).join("");
}

const findCode = (ctx: QueryCtx, code: string) =>
  ctx.db
    .query("inviteCodes")
    .withIndex("by_code", (q) => q.eq("code", normalizeCode(code)))
    .unique();

const usable = (invite: Doc<"inviteCodes"> | null, now: number): invite is Doc<"inviteCodes"> =>
  !!invite && !invite.revoked && invite.uses < invite.maxUses && (invite.expiresAt === undefined || invite.expiresAt > now);

/**
 * Before a sign-up does any real work: count it against the global sign-up limit, then check the
 * code. Returns instead of throwing so the attempt stays counted even when it's refused.
 */
export const precheck = internalMutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    if (!(await rateLimiter.limit(ctx, "signUp")).ok) return "rateLimited" as const;
    return usable(await findCode(ctx, code), Date.now()) ? ("ok" as const) : ("invalid" as const);
  },
});

/**
 * Check a code before showing the rest of the sign-up form. Doesn't use it up (that happens when
 * the account is created). Rate limited, and every unusable code gets the same answer.
 */
export const checkInvite = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    if (!(await rateLimiter.limit(ctx, "inviteCheck")).ok) throw new ConvexError("RateLimited");
    return usable(await findCode(ctx, code), Date.now());
  },
});

/**
 * Use up one claim of `code`, inside the mutation creating the account. Every reason a code can't
 * be used (never existed, used up, revoked, expired) gives the same error, so trying codes reveals
 * nothing. A waitlist address is deleted once its code is used.
 */
export async function claimInvite(ctx: MutationCtx, code: unknown) {
  const invite = typeof code === "string" ? await findCode(ctx, code) : null;
  if (!usable(invite, Date.now())) throw new ConvexError("InvalidInvite");
  await ctx.db.patch(invite._id, { uses: invite.uses + 1 });
  if (invite.waitlistId) {
    const entry = await ctx.db.get(invite.waitlistId);
    if (entry) await ctx.db.delete(entry._id);
    await ctx.db.patch(invite._id, { waitlistId: undefined });
  }
}

/**
 * Join the waitlist. The address is checked without sending anything: it must look like one, not
 * be a throwaway inbox, and its domain must accept mail. Says the same thing whether or not the
 * address (or another spelling of the same inbox) was already on the list.
 */
export const joinWaitlist = action({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    if (!looksLikeEmail(email)) throw new ConvexError("InvalidEmail");
    const domain = email.slice(email.lastIndexOf("@") + 1);
    if (isDisposable(domain)) throw new ConvexError("DisposableEmail");
    // Counted before the DNS lookup, so floods are turned away before they cost lookups.
    if (!(await ctx.runMutation(internal.invites.countJoin, {}))) throw new ConvexError({ kind: "RateLimited", name: "waitlist" });
    if ((await acceptsMail(domain)) === "no") throw new ConvexError("InvalidEmail");
    await ctx.runMutation(internal.invites.addToWaitlist, { email, canonical: canonicalEmail(email) });
    return null;
  },
});

export const countJoin = internalMutation({
  args: {},
  handler: async (ctx) => (await rateLimiter.limit(ctx, "waitlist")).ok,
});

export const addToWaitlist = internalMutation({
  args: { email: v.string(), canonical: v.string() },
  handler: async (ctx, { email, canonical }) => {
    const sameInbox = await ctx.db
      .query("waitlist")
      .withIndex("by_canonical", (q) => q.eq("canonical", canonical))
      .first();
    const sameAddress = await ctx.db
      .query("waitlist")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    // Already waiting, already invited, or bounced before: nothing to add.
    if (!sameInbox && !sameAddress) await ctx.db.insert("waitlist", { email, canonical });
  },
});

/**
 * An invite email bounced (the address doesn't exist) or was marked as spam: revoke its unused code
 * and keep the address as a marker, so it can't rejoin and be emailed again. Called by the Resend
 * webhook (http.ts).
 */
export const markUndeliverable = internalMutation({
  args: { emails: v.array(v.string()) },
  handler: async (ctx, { emails }) => {
    for (const raw of emails) {
      const email = raw.trim().toLowerCase();
      for (const entry of await ctx.db
        .query("waitlist")
        .withIndex("by_email", (q) => q.eq("email", email))
        .take(10)) {
        await ctx.db.patch(entry._id, { bounced: true });
        for (const invite of await ctx.db
          .query("inviteCodes")
          .withIndex("by_waitlist", (q) => q.eq("waitlistId", entry._id))
          .take(10)) {
          if (invite.uses === 0) await ctx.db.patch(invite._id, { revoked: true });
        }
      }
    }
  },
});

// --- Admin (internal: run with `bunx convex run`, never callable from the app).

export const insertCode = internalMutation({
  args: { code: v.string(), maxUses: v.number(), expiresAt: v.optional(v.number()), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await ctx.db.insert("inviteCodes", { ...args, uses: 0, revoked: false });
  },
});

/** A code for handing out by hand. `maxUses` defaults to 1; `days` makes it expire. */
export const createCode = internalAction({
  args: { maxUses: v.optional(v.number()), days: v.optional(v.number()), note: v.optional(v.string()) },
  handler: async (ctx, { maxUses = 1, days, note }) => {
    if (!Number.isInteger(maxUses) || maxUses < 1) throw new Error("maxUses must be a positive whole number");
    const code = generateCode();
    await ctx.runMutation(internal.invites.insertCode, {
      code,
      maxUses,
      expiresAt: days === undefined ? undefined : Date.now() + days * 24 * 60 * 60 * 1000,
      note,
    });
    return formatCode(code);
  },
});

/** Kill switch: the code stops working immediately. Already-created accounts keep working. */
export const revokeCode = internalMutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const invite = await findCode(ctx, code);
    if (!invite) throw new Error("No such code");
    await ctx.db.patch(invite._id, { revoked: true });
    return { uses: invite.uses, maxUses: invite.maxUses };
  },
});

export const waitlistSize = internalQuery({
  args: {},
  handler: async (ctx) => {
    const waiting = await ctx.db
      .query("waitlist")
      .withIndex("by_invited", (q) => q.eq("invitedAt", undefined))
      .take(10_000);
    return { waiting: waiting.length };
  },
});

/** Give the oldest uninvited waitlist addresses one single-use code each (one code per address). */
export const assignWaitlistCodes = internalMutation({
  args: { codes: v.array(v.string()) },
  handler: async (ctx, { codes }) => {
    const entries = await ctx.db
      .query("waitlist")
      .withIndex("by_invited", (q) => q.eq("invitedAt", undefined))
      .take(codes.length);
    const now = Date.now();
    return Promise.all(
      entries.map(async (entry, i) => {
        const code = codes[i]!;
        await ctx.db.insert("inviteCodes", { code, maxUses: 1, uses: 0, revoked: false, waitlistId: entry._id, note: "waitlist" });
        await ctx.db.patch(entry._id, { invitedAt: now });
        return { email: entry.email, code: formatCode(code) };
      }),
    );
  },
});

/** Undo assignWaitlistCodes for invites whose email didn't go out: back in the queue, code gone. */
export const unassignWaitlistCodes = internalMutation({
  args: { codes: v.array(v.string()) },
  handler: async (ctx, { codes }) => {
    for (const code of codes) {
      const invite = await findCode(ctx, code);
      if (!invite || invite.uses > 0) continue;
      if (invite.waitlistId) await ctx.db.patch(invite.waitlistId, { invitedAt: undefined });
      await ctx.db.delete(invite._id);
    }
  },
});

/**
 * Invite the next `count` people on the waitlist, emailing each their code through Resend when
 * RESEND_API_KEY and INVITE_EMAIL_FROM are set. One batch request (Resend's free tier allows 100
 * emails a day and 2 requests a second); if it fails, everyone goes back in the queue.
 */
export const inviteWaitlist = internalAction({
  args: { count: v.number() },
  handler: async (ctx, { count }) => {
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("count must be 1–100 (Resend sends at most 100 per batch)");
    const invited: { email: string; code: string }[] = await ctx.runMutation(internal.invites.assignWaitlistCodes, {
      codes: Array.from({ length: count }, generateCode),
    });
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.INVITE_EMAIL_FROM;
    if (!apiKey || !from) return { emailed: false, invited };
    if (!invited.length) return { emailed: true, invited: 0 };
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(invited.map(({ email, code }) => ({ from, to: [email], subject: "Your OpenChat invite code", text: inviteEmail(code) }))),
    });
    if (!res.ok) {
      await ctx.runMutation(internal.invites.unassignWaitlistCodes, { codes: invited.map((i) => i.code) });
      throw new Error(`Resend refused the batch (${res.status}): ${await res.text()}. Nobody was invited; they're still on the waitlist.`);
    }
    return { emailed: true, invited: invited.length };
  },
});

const inviteEmail = (code: string) => `You're in! Here's your OpenChat invite code:

    ${code}

To create your account, open OpenChat, go to Settings → Account → Create an account, enter the code, then choose a username and password.

The code works once. Your email address was only kept to send you this, and it's deleted from the waitlist as soon as the code is used. It isn't linked to your account.
`;
