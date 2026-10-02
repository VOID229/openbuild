// POST /api/verify-search on the hosted site (Vercel Edge Function): check a search key or SearXNG address.
import { SEARCH_PROVIDERS } from "../../shared/types";
import { bad, handleSearchCheck, isKey, isSearchProvider, readJson } from "../handlers";
import { forbidden } from "./relay";

export default async function verifySearch(req: Request): Promise<Response> {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  const blocked = forbidden(req);
  if (blocked) return blocked;
  const body = await readJson(req);
  const provider = body?.provider;
  if (!isSearchProvider(provider)) return bad("Expected { provider }");
  const credential = SEARCH_PROVIDERS[provider].credential === "url" ? body?.url : body?.key;
  return handleSearchCheck(provider, isKey(credential) ? credential.trim() : undefined, { hosted: true });
}
