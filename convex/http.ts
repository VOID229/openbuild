import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";

const http = httpRouter();
auth.addHttpRoutes(http);

const enc = new TextEncoder();
const TOLERANCE_S = 5 * 60;

/**
 * Whether a webhook really comes from Resend: it signs each one (via Svix) with the endpoint's
 * secret, "whsec_" + base64. The signed text is "<id>.<timestamp>.<body>"; old timestamps are
 * refused so a captured request can't be replayed later.
 */
export async function verifyResendWebhook(secret: string, headers: Headers, body: string) {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_S) return false;
  const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${timestamp}.${body}`)));
  const expected = btoa(String.fromCharCode(...mac));
  return signatures.split(" ").some((entry) => {
    const [version, sig] = entry.split(",");
    if (version !== "v1" || !sig || sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

// Resend → "a sent email bounced / was marked as spam": stop that address getting more invites.
http.route({
  path: "/resend-webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) return new Response("Not configured", { status: 503 });
    const body = await req.text();
    if (!(await verifyResendWebhook(secret, req.headers, body))) return new Response("Bad signature", { status: 401 });

    let event: unknown;
    try {
      event = JSON.parse(body);
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }
    const { type, data } = (event ?? {}) as { type?: unknown; data?: { to?: unknown } };
    if (type === "email.bounced" || type === "email.complained") {
      const to = Array.isArray(data?.to) ? data.to.filter((e): e is string => typeof e === "string") : [];
      if (to.length) await ctx.runMutation(internal.invites.markUndeliverable, { emails: to.slice(0, 50) });
    }
    return new Response(null, { status: 204 });
  }),
});

export default http;
