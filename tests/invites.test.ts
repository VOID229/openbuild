// Invite-only sign-up and the device limit, end to end through the real Convex Auth sign-in action
// (convex-test runs it in memory, password hashing and all).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { appTest } from "./convex";

const { api, internal } = await import("../convex/_generated/api");

let t: Awaited<ReturnType<typeof appTest>>;
const PASSWORD = "oc1.".padEnd(48, "x");

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = (await exportPKCS8(keys.privateKey)).trimEnd().replace(/\n/g, " ");
  process.env.JWKS = JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(keys.publicKey)) }] });
  process.env.SITE_URL = "http://localhost:3000";
  process.env.CONVEX_SITE_URL = "https://test.convex.site";
});

/** Sign up or in from a fresh device. Resolves to that device's signed-in client. */
async function signIn(flow: "signUp" | "signIn", username: string, extra: Record<string, string> = {}) {
  const res = await t.action(api.auth.signIn, { provider: "password", params: { email: username, password: PASSWORD, flow, ...extra } });
  const token = (res as { tokens: { token: string } }).tokens.token;
  const { sub } = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
  return t.withIdentity({ subject: sub });
}

/** Headers for a webhook signed the way Resend (Svix) signs them. */
async function signedHeaders(secret: string, body: string) {
  const id = "msg_test";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${btoa(String.fromCharCode(...mac))}` };
}

/** The ConvexError payload a call fails with. */
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return (err as { data?: unknown }).data;
  }
  throw new Error("Expected it to fail");
}

const code = (maxUses: number) => t.action(internal.invites.createCode, { maxUses });

describe("invite codes", () => {
  beforeAll(async () => {
    t = await appTest();
  });

  test("no code, a made-up code and a revoked code all fail the same way", async () => {
    const revoked = await code(5);
    await t.mutation(internal.invites.revokeCode, { code: revoked });
    expect(await failure(signIn("signUp", "nocode"))).toBe("InvalidInvite");
    expect(await failure(signIn("signUp", "fake", { invite: "AAAA-BBBB-CCCC" }))).toBe("InvalidInvite");
    expect(await failure(signIn("signUp", "revoked", { invite: revoked }))).toBe("InvalidInvite");
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users).toEqual([]);
  });

  test("codes can be checked before signing up, without using them", async () => {
    const one = await code(1);
    expect(await t.mutation(api.invites.checkInvite, { code: one })).toBe(true);
    expect(await t.mutation(api.invites.checkInvite, { code: one })).toBe(true);
    expect(await t.mutation(api.invites.checkInvite, { code: "AAAA-BBBB-CCCC" })).toBe(false);
    await signIn("signUp", "checked", { invite: one });
    expect(await t.mutation(api.invites.checkInvite, { code: one })).toBe(false);
  });

  test("a multi-use code works until it's used up", async () => {
    const shared = await code(2);
    await signIn("signUp", "first", { invite: shared });
    // Typed loosely: lowercase, spaces instead of dashes, O for 0.
    await signIn("signUp", "second", { invite: shared.toLowerCase().replace(/-/g, " ").replace(/0/g, "o") });
    expect(await failure(signIn("signUp", "third", { invite: shared }))).toBe("InvalidInvite");
    const invite = await t.run((ctx) => ctx.db.query("inviteCodes").withIndex("by_code", (q) => q.eq("code", shared.replace(/-/g, ""))).unique());
    expect(invite?.uses).toBe(2);
  });

  test("a taken username doesn't use up the code", async () => {
    const one = await code(1);
    expect(await failure(signIn("signUp", "first", { invite: one, password: PASSWORD.replace(/x$/, "y") }))).toBe("UsernameTaken");
    await signIn("signUp", "fourth", { invite: one });
  });

  test("existing accounts sign in without a code", async () => {
    await signIn("signIn", "first");
  });
});

/** DNS-over-HTTPS as the waitlist sees it: which test domains take mail. */
function fakeDns(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== "dns.google" && url.hostname !== "cloudflare-dns.com") return realFetch(input, init);
  const name = url.searchParams.get("name")!;
  if (name === "unreachable.example") return Promise.reject(new Error("network down"));
  if (name === "nomail.example") return Promise.resolve(Response.json({ Status: 3 }));
  if (name === "nullmx.example") return Promise.resolve(Response.json({ Status: 0, Answer: [{ type: 15, data: "0 ." }] }));
  if (name === "website-only.example") return Promise.resolve(Response.json({ Status: 0 }));
  return Promise.resolve(Response.json({ Status: 0, Answer: [{ type: 15, data: `10 mx.${name}.` }] }));
}
const realFetch = globalThis.fetch;

describe("waitlist", () => {
  beforeAll(async () => {
    t = await appTest();
    globalThis.fetch = fakeDns as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test("joining twice is one entry, and rejects things that aren't addresses", async () => {
    await t.action(api.invites.joinWaitlist, { email: " Ann@Example.com " });
    await t.action(api.invites.joinWaitlist, { email: "ann@example.com" });
    await t.action(api.invites.joinWaitlist, { email: "ben@example.com" });
    expect(await failure(t.action(api.invites.joinWaitlist, { email: "nope" }))).toBe("InvalidEmail");
    expect(await t.query(internal.invites.waitlistSize, {})).toEqual({ waiting: 2 });
  });

  test("addresses that can't receive mail, and throwaway inboxes, are turned away", async () => {
    expect(await failure(t.action(api.invites.joinWaitlist, { email: "x@nomail.example" }))).toBe("InvalidEmail");
    expect(await failure(t.action(api.invites.joinWaitlist, { email: "x@nullmx.example" }))).toBe("InvalidEmail");
    expect(await failure(t.action(api.invites.joinWaitlist, { email: "x@website-only.example" }))).toBe("InvalidEmail");
    expect(await failure(t.action(api.invites.joinWaitlist, { email: "x@mailinator.com" }))).toBe("DisposableEmail");
    expect(await failure(t.action(api.invites.joinWaitlist, { email: "x@inbox.mailinator.com" }))).toBe("DisposableEmail");
    expect(await t.query(internal.invites.waitlistSize, {})).toEqual({ waiting: 2 });
  });

  test("if DNS can't be reached, real people aren't turned away", async () => {
    await t.action(api.invites.joinWaitlist, { email: "cat@unreachable.example" });
    expect(await t.query(internal.invites.waitlistSize, {})).toEqual({ waiting: 3 });
    await t.run(async (ctx) => {
      const entry = await ctx.db.query("waitlist").withIndex("by_email", (q) => q.eq("email", "cat@unreachable.example")).unique();
      await ctx.db.delete(entry!._id);
    });
  });

  test("one inbox is one place in line: Gmail dots, googlemail, and +tags", async () => {
    await t.action(api.invites.joinWaitlist, { email: "Jane.Doe@gmail.com" });
    await t.action(api.invites.joinWaitlist, { email: "janedoe+2@googlemail.com" });
    await t.action(api.invites.joinWaitlist, { email: "j.a.n.e.d.o.e+spam@gmail.com" });
    await t.action(api.invites.joinWaitlist, { email: "dan+news@example.com" });
    await t.action(api.invites.joinWaitlist, { email: "dan@example.com" });
    const emails = await t.run(async (ctx) => (await ctx.db.query("waitlist").collect()).map((w) => w.email));
    expect(emails).toEqual(["ann@example.com", "ben@example.com", "jane.doe@gmail.com", "dan+news@example.com"]);
    // Out of the way of the invite-order tests below.
    await t.run(async (ctx) => {
      for (const w of await ctx.db.query("waitlist").collect()) if (!["ann@example.com", "ben@example.com"].includes(w.email)) await ctx.db.delete(w._id);
    });
  });

  test("invites go out oldest first, and the address is deleted once its code is used", async () => {
    const res = await t.action(internal.invites.inviteWaitlist, { count: 1 });
    expect(res).toMatchObject({ emailed: false, invited: [{ email: "ann@example.com" }] });
    expect(await t.query(internal.invites.waitlistSize, {})).toEqual({ waiting: 1 });
    const invite = (res as { invited: { code: string }[] }).invited[0]!.code;
    await signIn("signUp", "ann", { invite });
    const emails = await t.run(async (ctx) => (await ctx.db.query("waitlist").collect()).map((w) => w.email));
    expect(emails).toEqual(["ben@example.com"]);
    expect(await failure(signIn("signUp", "ann2", { invite }))).toBe("InvalidInvite");
  });

  test("emails go out in one Resend batch; if it fails, they're back on the waitlist", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.INVITE_EMAIL_FROM = "OpenChat <invites@example.com>";
    const realFetch = globalThis.fetch;
    const sent: unknown[] = [];
    let status = 500;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status });
    }) as typeof fetch;
    try {
      await expect(t.action(internal.invites.inviteWaitlist, { count: 5 })).rejects.toThrow(/still on the waitlist/);
      expect(await t.query(internal.invites.waitlistSize, {})).toEqual({ waiting: 1 });
      expect(await t.run((ctx) => ctx.db.query("inviteCodes").filter((q) => q.eq(q.field("note"), "waitlist")).collect())).toHaveLength(1); // ann's, used

      status = 200;
      expect(await t.action(internal.invites.inviteWaitlist, { count: 5 })).toEqual({ emailed: true, invited: 1 });
      const batch = (sent[1] as { url: string; body: { to: string[]; text: string }[] });
      expect(batch.url).toBe("https://api.resend.com/emails/batch");
      expect(batch.body).toHaveLength(1);
      expect(batch.body[0]!.to).toEqual(["ben@example.com"]);
      expect(batch.body[0]!.text).toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/);
      expect(await t.query(internal.invites.waitlistSize, {})).toEqual({ waiting: 0 });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.RESEND_API_KEY;
      delete process.env.INVITE_EMAIL_FROM;
    }
  });

  test("a bounce reported by Resend revokes the code and keeps the address from rejoining", async () => {
    process.env.RESEND_WEBHOOK_SECRET = "whsec_" + btoa("0123456789abcdef0123456789abcdef");
    await t.action(api.invites.joinWaitlist, { email: "ghost@example.com" });
    const res = (await t.action(internal.invites.inviteWaitlist, { count: 1 })) as { invited: { code: string }[] };
    const ghostCode = res.invited[0]!.code;
    const body = JSON.stringify({ type: "email.bounced", data: { to: ["ghost@example.com"] } });

    // Unsigned or wrongly signed: ignored.
    expect((await t.fetch("/resend-webhook", { method: "POST", body })).status).toBe(401);
    const forged = await signedHeaders("whsec_" + btoa("not the real secret, not at all"), body);
    expect((await t.fetch("/resend-webhook", { method: "POST", headers: forged, body })).status).toBe(401);
    expect(await t.mutation(api.invites.checkInvite, { code: ghostCode })).toBe(true);

    const headers = await signedHeaders(process.env.RESEND_WEBHOOK_SECRET, body);
    expect((await t.fetch("/resend-webhook", { method: "POST", headers, body })).status).toBe(204);
    expect(await t.mutation(api.invites.checkInvite, { code: ghostCode })).toBe(false);

    // Joining again doesn't put it back in line.
    await t.action(api.invites.joinWaitlist, { email: "ghost@example.com" });
    expect(await t.query(internal.invites.waitlistSize, {})).toEqual({ waiting: 0 });
    delete process.env.RESEND_WEBHOOK_SECRET;
  });

  test("joining is rate limited", async () => {
    let limited: unknown;
    for (let i = 0; i < 80 && !limited; i++) {
      limited = await t.action(api.invites.joinWaitlist, { email: `bot${i}@spam.example` }).then(
        () => undefined,
        (err) => err.data,
      );
    }
    expect(limited).toMatchObject({ kind: "RateLimited", name: "waitlist" });
  });
});

describe("devices", () => {
  beforeAll(async () => {
    t = await appTest();
    await signIn("signUp", "dana", { invite: await code(1) });
  });

  test("an account can be on three devices; a fourth has to replace one", async () => {
    const phone = await signIn("signIn", "dana");
    await phone.mutation(api.devices.register, { name: "Safari on iPhone" });
    await signIn("signIn", "dana");

    const full = (await failure(signIn("signIn", "dana"))) as { code: string; devices: { id: string; name: string | null }[] };
    expect(full.code).toBe("DeviceLimit");
    expect(full.devices).toHaveLength(3);
    expect(full.devices.map((d) => d.name)).toContain("Safari on iPhone");

    const phoneId = full.devices.find((d) => d.name === "Safari on iPhone")!.id;
    const laptop = await signIn("signIn", "dana", { replace: phoneId });
    const list = await laptop.query(api.devices.list, {});
    expect(list?.devices).toHaveLength(3);
    expect(list?.devices.map((d) => d.id)).not.toContain(phoneId);

    // The replaced phone is out immediately, even though its token hasn't expired.
    expect(await phone.query(api.sync.me, {})).toBeNull();
    expect(await failure(phone.query(api.sync.changes, { since: 0 }))).toBe("Not signed in");
  });

  test("signing out other devices is rate limited, and can't target this device", async () => {
    const list = async () => (await t.run((ctx) => ctx.db.query("authSessions").collect())).map((s) => s._id);
    const [first] = await list();
    const me = t.withIdentity({ subject: `${(await t.run((ctx) => ctx.db.get(first!)))!.userId}|${first}` });
    expect(await failure(me.mutation(api.devices.remove, { sessionId: first! }))).toBe("ThisDevice");

    // One removal was used replacing the phone above; two more are allowed this week.
    for (const id of (await list()).filter((id) => id !== first)) await me.mutation(api.devices.remove, { sessionId: id });
    const third = await signIn("signIn", "dana");
    const thirdId = (await third.query(api.devices.list, {}))!.devices.find((d) => d.current)!.id;
    expect(await failure(me.mutation(api.devices.remove, { sessionId: thirdId as never }))).toMatchObject({ kind: "RateLimited", name: "removeDevice" });
  });

  test("new devices are rate limited per week", async () => {
    // Already used: sign-up, three sign-ins and the replacement. Keep signing in until it refuses.
    let refused: { code?: string } | undefined;
    for (let i = 0; i < 6 && !refused; i++) {
      const me = (await t.run((ctx) => ctx.db.query("authSessions").collect()))[0]!;
      await t.run((ctx) => ctx.db.delete(me._id)); // make room, so only the rate limit can refuse
      refused = (await signIn("signIn", "dana").then(
        () => undefined,
        (err) => err.data,
      )) as typeof refused;
    }
    expect(refused?.code).toBe("NewDeviceLimit");
  });
});

describe("other users' devices", () => {
  test("can't be signed out", async () => {
    t = await appTest();
    const one = await code(2);
    const erin = await signIn("signUp", "erin", { invite: one });
    const fay = await signIn("signUp", "fay", { invite: one });
    const fayId = (await fay.query(api.devices.list, {}))!.devices[0]!.id;
    expect(await failure(erin.mutation(api.devices.remove, { sessionId: fayId as never }))).toBe("NoSuchDevice");
  });
});
