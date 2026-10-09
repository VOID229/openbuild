// POST /api/chat on the hosted site (a Vercel Node.js function, see node.ts).
//
// A reply the app can pick back up (it sends a reply id and key) runs apart from this request: if the
// app's connection drops, the function keeps going and writes the reply, encrypted, to the sync
// service as it streams (convex/streams.ts), where the app reads it from instead. Stopping goes
// through there too.
import { waitUntil } from "@vercel/functions";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { CLOUD_URL } from "../../shared/cloud";
import { isStreamRef, sealEvents } from "../../shared/replies";
import type { ChatRequest } from "../../shared/types";
import { bad, handleChat, readJson } from "../handlers";
import { Run, startRun } from "../runs";
import { forbidden, secretsOf } from "./relay";

/** How often the reply is written out while text flows, and at least this often while it's quiet. */
const FLUSH = 1000;
const IDLE = 5000;
/** The function's own limit is 300 s (maxDuration); end the reply cleanly before it's cut off. */
const LIMIT = 285_000;

const headers = { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform", "x-openchat-run": "1" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function chat(req: Request): Promise<Response> {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  const blocked = forbidden(req);
  if (blocked) return blocked;
  const body = (await readJson(req)) as (ChatRequest & { secrets?: unknown }) | undefined;
  const secrets = secretsOf(body);
  if (!secrets) return bad("Malformed chat request");
  const keysFor = async (scope: string) => (secrets[scope] ?? []).map((k) => k.trim());

  const relaySecret = process.env.OPENCHAT_RELAY_SECRET;
  const cloudUrl = process.env.OPENCHAT_CLOUD_URL || CLOUD_URL;
  const ref = body?.stream;
  if (!isStreamRef(ref) || !ref.key || !relaySecret || !cloudUrl) return handleChat(req.signal, body, keysFor, { hosted: true });

  const convex = new ConvexHttpClient(cloudUrl);
  try {
    if (!(await convex.mutation(api.streams.begin, { secret: relaySecret, id: ref.id }))) {
      // The app retried a request that got through: the reply is already running.
      return Response.json({ error: "This reply is already running" }, { status: 409 });
    }
  } catch (err) {
    console.error("[chat] couldn't save the reply; streaming it without", err);
    return handleChat(req.signal, body, keysFor, { hosted: true });
  }
  const run = startRun((signal) => handleChat(signal, body, keysFor, { hosted: true }));
  const limit = setTimeout(() => {
    run.push({ t: "error", message: "This reply ran past the website's 5-minute limit and was cut off. Run OpenChat locally for longer replies." });
    run.stop();
  }, LIMIT);
  waitUntil(save(run, convex, relaySecret, ref.id, ref.key).finally(() => clearTimeout(limit)));
  return new Response(run.stream(), { headers });
}

/** Write the run's events to the sync service as they come, until it ends. Stops the run if the app asks. */
async function save(run: Run, convex: ConvexHttpClient, secret: string, id: string, key: string) {
  let saved = 0;
  let savedAt = 0;
  let failures = 0;
  while (true) {
    const ended = run.ended;
    const fresh = run.events.length > saved;
    if (fresh || ended || Date.now() - savedAt >= IDLE) {
      const batch = run.events.slice(saved);
      const events = ended ? [...batch, { t: "end" as const }] : batch;
      try {
        const chunk = events.length ? await sealEvents(key, id, events) : undefined;
        const { stop } = await convex.mutation(api.streams.append, { secret, id, chunk, done: ended });
        saved += batch.length;
        savedAt = Date.now();
        failures = 0;
        if (stop) run.stop();
        if (ended) return;
      } catch (err) {
        console.error("[chat] couldn't save part of a reply", err);
        if (++failures >= 5 && ended) return;
        await sleep(FLUSH);
      }
    }
    if (!run.ended) await Promise.race([sleep(FLUSH), run.next(Infinity)]);
  }
}
