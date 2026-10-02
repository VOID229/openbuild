// Shared by the hosted (Vercel Edge) functions. The hosted relay has no storage at all: the browser
// sends the API keys a request needs along with it, they're used for that request only, and nothing
// (keys, prompts, replies) is logged or kept.
import { bad, isKeyList } from "../handlers";

/** Only answer requests from pages on this same site, so other websites can't use the relay. */
export function forbidden(req: Request): Response | undefined {
  const origin = req.headers.get("origin");
  if (origin === null) return undefined; // Not a cross-site browser request.
  try {
    if (new URL(origin).host === new URL(req.url).host) return undefined;
  } catch {}
  return bad("Forbidden", 403);
}

/** `{ scope: string[] }`: the keys for the plan and search providers this request uses. */
export function secretsOf(body: any): Record<string, string[]> | undefined {
  const s = body?.secrets;
  if (!s || typeof s !== "object" || Array.isArray(s)) return undefined;
  const entries = Object.entries(s);
  if (entries.length > 12 || !entries.every(([k, v]) => k.length <= 32 && isKeyList(v))) return undefined;
  return s as Record<string, string[]>;
}
