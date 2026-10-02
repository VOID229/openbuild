// POST /api/models on the hosted site (Vercel Edge Function): check a key, list its models.
import { bad, handleModels, isKey, readJson } from "../handlers";
import { forbidden } from "./relay";

export default async function models(req: Request): Promise<Response> {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  const blocked = forbidden(req);
  if (blocked) return blocked;
  const body = await readJson(req);
  return handleModels(body?.plan, isKey(body?.key) ? body.key.trim() : undefined);
}
