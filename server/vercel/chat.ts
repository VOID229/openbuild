// POST /api/chat on the hosted site (Vercel Edge Function).
import type { ChatRequest } from "../../shared/types";
import { bad, handleChat, readJson } from "../handlers";
import { forbidden, secretsOf } from "./relay";

export default async function chat(req: Request): Promise<Response> {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  const blocked = forbidden(req);
  if (blocked) return blocked;
  const body = (await readJson(req)) as (ChatRequest & { secrets?: unknown }) | undefined;
  const secrets = secretsOf(body);
  if (!secrets) return bad("Malformed chat request");
  return handleChat(req, body, async (scope) => (secrets[scope] ?? []).map((k) => k.trim()), { hosted: true });
}
