// The app's view of OpenBots: a snapshot, then a stream of changes, plus the actions the UI takes.
// Bots themselves don't use these routes; their tools go through the socket in agent.ts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computerApi, computerTargets } from "../computers/api";
import * as devices from "../devices";
import { modelListing } from "../pi/routes";
import { getBot, getMessage } from "./db";
import { available, botModels } from "./extensions";
import type { Bot, BotMessage, BotsSettings, Conversation } from "../../shared/bots";
import { isBotId } from "../../shared/bots";
import { bad, readJson } from "../handlers";
import * as apps from "./apps";
import { startBots } from "./runner";
import { BotsError, snapshot, subscribe } from "./service";
import * as svc from "./service";

type Api = <R extends Request, A extends unknown[]>(handler: (req: R, ...rest: A) => Response | Promise<Response>) => (req: R, ...rest: A) => Response | Promise<Response>;

const json = (value: unknown, status = 200) => Response.json(value, { status });
const fail = (err: unknown) => {
  if (err instanceof BotsError) return bad(err.message, err.status);
  console.error("[bots]", err);
  return bad(err instanceof Error ? err.message : "Something went wrong", 500);
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page a service's sign-in ends on, in the popup the app opened. It tells the app and closes itself. */
function signInPage(title: string, body: string, ok: boolean, appId?: string): Response {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const note = JSON.stringify({ type: "openbots-app", app: appId ?? null, ok });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#111;color:#eee}main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1.15rem;margin:0 0 .5rem}p{color:#aaa;margin:0}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main>
<script nonce="${nonce}">try{window.opener&&window.opener.postMessage(${note},location.origin)}catch(e){}${ok ? "setTimeout(function(){window.close()},900)" : ""}</script></body></html>`;
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`, "referrer-policy": "no-referrer" },
  });
}

const LOGOS = join(import.meta.dir, "logos");

export function botRoutes(api: Api) {
  svc.ensureStarted();
  return {
    // ---------------------------------------------------------------- apps
    "/api/bots/apps": {
      GET: api(async () => {
        try {
          return json(await apps.snapshot());
        } catch (err) {
          return fail(err);
        }
      }),
    },
    // Where a service sends the user back after they sign in. The session cookie is SameSite=Strict, so
    // it doesn't come along on that redirect: the sign-in's single-use state is what vouches for it.
    "/api/bots/apps/callback": {
      GET: async (req: Request) => {
        try {
          const { app, error } = await apps.finish(new URL(req.url).searchParams);
          if (error) return signInPage(app ? `Couldn't connect ${app.name}` : "Couldn't connect", error, false, app?.id);
          return signInPage(`${app!.name} is connected`, "Your bots can use it now. You can close this window.", true, app!.id);
        } catch (err) {
          console.error("[bots] app sign-in failed:", err);
          return signInPage("Couldn't connect", err instanceof Error ? err.message : "Something went wrong.", false);
        }
      },
    },
    "/api/bots/apps/clients/:id": {
      DELETE: api(async (req: Bun.BunRequest<"/api/bots/apps/clients/:id">) => {
        try {
          await apps.forgetClient(req.params.id);
          return json({ ok: true });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/bots/apps/:id/connect": {
      POST: api(async (req: Bun.BunRequest<"/api/bots/apps/:id/connect">) => {
        try {
          const body = (await readJson(req)) ?? {};
          // The page's own address, which forbidden() has already matched to the host: the sign-in comes back there.
          const origin = req.headers.get("origin") || new URL(req.url).origin;
          return json(await apps.connect(req.params.id, { origin, fields: body.fields, client: body.client }));
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/bots/apps/:id/finish": {
      POST: api(async (req: Bun.BunRequest<"/api/bots/apps/:id/finish">) => {
        try {
          const body = (await readJson(req)) ?? {};
          return json(await apps.finishPasted(req.params.id, body.url));
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/bots/apps/:id/check": {
      POST: api(async (req: Bun.BunRequest<"/api/bots/apps/:id/check">) => {
        try {
          return json(await apps.check(req.params.id));
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/bots/apps/:id/logo": {
      GET: api((req: Bun.BunRequest<"/api/bots/apps/:id/logo">) => {
        const id = req.params.id;
        if (!/^[a-z0-9-]+$/.test(id)) return bad("Not found", 404);
        for (const [ext, type] of [["svg", "image/svg+xml"], ["png", "image/png"]] as const) {
          const path = join(LOGOS, `${id}.${ext}`);
          if (existsSync(path))
            return new Response(readFileSync(path), { headers: { "content-type": type, "cache-control": "public, max-age=86400", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff" } });
        }
        return bad("Not found", 404);
      }),
    },
    "/api/bots/apps/:id": {
      DELETE: api(async (req: Bun.BunRequest<"/api/bots/apps/:id">) => {
        try {
          await apps.disconnect(req.params.id);
          return json({ ok: true });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/bots/:id/file": {
      GET: api((req: Bun.BunRequest<"/api/bots/:id/file">) => botFile(req, req.params.id)),
    },
    // Where a bot's computer can run: this server, or a paired device that allowed it.
    "/api/bots/targets": {
      GET: api(async () => json({ targets: await computerTargets() })),
    },
    "/api/bots/stream": {
      GET: api((req: Request, server: Bun.Server<unknown>) => {
        const res = botsStream(req, server);
        void svc.greetOnFirstOpen();
        return res;
      }),
    },
    // The first-run notice's "Check again": ask Pi afresh, and say hello if it's ready now.
    "/api/bots/setup/check": {
      POST: api(async () => {
        await svc.greetOnFirstOpen(true);
        return json({ setup: svc.piSetup() ?? null });
      }),
    },
    "/api/bots": {
      GET: api(() => json(snapshot())),
      POST: api(async (req) => {
        try {
          svc.ensureStarted();
          const body = await readJson(req);
          const created = svc.createBot({
            id: typeof body?.id === "string" ? body.id : undefined,
            conversationId: typeof body?.conversationId === "string" ? body.conversationId : undefined,
            name: String(body?.name ?? ""),
            look: body?.look,
            instructions: typeof body?.instructions === "string" ? body.instructions : "",
            by: "me",
          });
          return json(created);
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/bots/reset": {
      POST: api(async () => {
        try {
          await svc.resetAll();
          return json({ ok: true });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/bots/settings": {
      PATCH: api(async (req) => {
        try {
          const body = (await readJson(req)) as Partial<BotsSettings> | undefined;
          if (!body || typeof body !== "object") return bad("Expected settings");
          return json(svc.updateSettings(body));
        } catch (err) {
          return fail(err);
        }
      }),
    },
    // The user's Pi extensions, and what bots can run on with the ones they've switched on.
    "/api/bots/extensions": {
      GET: api(() => {
        try {
          return json({ extensions: available() });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/bots/models": {
      GET: api(async (req) => {
        try {
          const fresh = new URL(req.url).searchParams.has("fresh");
          return json(await modelListing(await botModels(fresh), fresh));
        } catch (err) {
          return bad(err instanceof Error ? err.message : "Pi couldn't start", 502);
        }
      }),
    },
    "/api/bots/conversations": {
      POST: api(async (req) => {
        try {
          const body = await readJson(req);
          if (body?.kind !== "group" && body?.kind !== "side") return bad("Expected a group or a side chat");
          if (!Array.isArray(body.botIds)) return bad("Expected botIds");
          const messages = Array.isArray(body.messages) ? body.messages.filter(isClientMessage) : undefined;
          return json(svc.createConversation({ id: body.id, kind: body.kind, name: body.name, botIds: body.botIds, instructions: body.instructions, messages }));
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/bots/:id": {
      PATCH: api(async (req: Bun.BunRequest<"/api/bots/:id">) => {
        try {
          const body = await readJson(req);
          return json(svc.updateBot(req.params.id, (body ?? {}) as Partial<Bot>));
        } catch (err) {
          return fail(err);
        }
      }),
      DELETE: api(async (req: Bun.BunRequest<"/api/bots/:id">) => {
        try {
          await svc.deleteBot(req.params.id);
          return json({ ok: true });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/bots/:id/routines/:routineId": {
      PATCH: api(async (req: Bun.BunRequest<"/api/bots/:id/routines/:routineId">) => {
        try {
          const body = await readJson(req);
          return json(svc.updateRoutine(req.params.id, req.params.routineId, body ?? {}));
        } catch (err) {
          return fail(err);
        }
      }),
      DELETE: api((req: Bun.BunRequest<"/api/bots/:id/routines/:routineId">) => {
        try {
          svc.removeRoutine(req.params.id, req.params.routineId);
          return json({ ok: true });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/bots/conversations/:id": {
      PATCH: api(async (req: Bun.BunRequest<"/api/bots/conversations/:id">) => {
        try {
          const body = await readJson(req);
          return json(svc.updateConversation(req.params.id, (body ?? {}) as Partial<Conversation>));
        } catch (err) {
          return fail(err);
        }
      }),
      DELETE: api((req: Bun.BunRequest<"/api/bots/conversations/:id">) => {
        try {
          svc.deleteConversation(req.params.id);
          return json({ ok: true });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/bots/conversations/:id/read": {
      POST: api((req: Bun.BunRequest<"/api/bots/conversations/:id/read">) => markRead(req.params.id)),
    },
    "/api/bots/conversations/:id/messages": {
      GET: api((req: Bun.BunRequest<"/api/bots/conversations/:id/messages">) => olderMessages(req, req.params.id)),
      POST: api(async (req: Bun.BunRequest<"/api/bots/conversations/:id/messages">) => postMine(req.params.id, await readJson(req))),
    },
    "/api/bots/conversations/:id/messages/:messageId": {
      PATCH: api(async (req: Bun.BunRequest<"/api/bots/conversations/:id/messages/:messageId">) => patchMine(req.params.id, req.params.messageId, await readJson(req))),
      DELETE: api((req: Bun.BunRequest<"/api/bots/conversations/:id/messages/:messageId">) => deleteMine(req.params.id, req.params.messageId)),
    },
  };
}

// ---------------------------------------------------------------- in existing conversations
// What a tab does in the conversations a workspace already has. The plain routes above use these,
// and so does the bound workspace route (workspace.ts), which is all a paired device can reach.
// The writes take a body that's already parsed and run without awaiting anything, so the grant the
// bound route checked after the body arrived is the one in force when the change is made.

export const snapshotResponse = () => json(snapshot());

/**
 * The live view: a hello naming this workspace (its server id), the snapshot, then every change.
 * `track` hears how to close it, so a paired device's streams end when its access does.
 */
export function botsStream(req: Request, server: Bun.Server<unknown>, track?: (close: () => void) => () => void): Response {
  server.timeout(req, 0);
  svc.ensureStarted();
  const enc = new TextEncoder();
  let unsub = () => {};
  let untrack = () => {};
  let ping: ReturnType<typeof setInterval> | undefined;
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: unknown) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(value) + "\n"));
        } catch {
          stop();
        }
      };
      stop = () => {
        clearInterval(ping);
        unsub();
        untrack();
        req.signal.removeEventListener("abort", stop);
        try {
          controller.close();
        } catch {}
      };
      if (req.signal.aborted) return stop();
      send({ t: "hello", workspace: devices.serverId() });
      send({ t: "snapshot", ...snapshot() });
      unsub = subscribe(send);
      if (track) untrack = track(stop);
      ping = setInterval(() => send({ t: "ping" }), 20_000);
      ping.unref?.();
      req.signal.addEventListener("abort", stop, { once: true });
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform" } });
}

export function markRead(conversationId: string): Response {
  svc.markRead(conversationId);
  return json({ ok: true });
}

export function olderMessages(req: Request, conversationId: string): Response {
  try {
    const params = new URL(req.url).searchParams;
    const before = Number(params.get("before")) || undefined;
    return json(svc.messagePage(conversationId, params.get("beforeId") || undefined, before));
  } catch (err) {
    return fail(err);
  }
}

export function postMine(conversationId: string, body: unknown): Response {
  try {
    if (!isClientMessage(body) || body.author !== "me") return bad("Expected your message");
    return json(svc.postMessage(conversationId, { ...body, author: "me", at: Date.now() }));
  } catch (err) {
    return fail(err);
  }
}

/**
 * A question answered, a vote, or a reaction, on one of the user's or a bot's messages. A reaction
 * with `on` sets it rather than toggling it, so sending it again (a retry whose first try may still
 * land) leaves it as asked.
 */
export function patchMine(conversationId: string, messageId: string, body: any): Response {
  try {
    if (body?.question && typeof body.question.answer === "string") svc.answerQuestion(conversationId, messageId, body.question.answer);
    if (Array.isArray(body?.vote)) return json(svc.votePoll(conversationId, messageId, "me", body.vote.filter((key: unknown): key is string => typeof key === "string")));
    if (typeof body?.emoji === "string") {
      const to = typeof body.to === "string" ? body.to : undefined;
      if (typeof body.on === "boolean") {
        const row = getMessage(messageId);
        if (!row || row.conversationId !== conversationId) return bad("No such message.", 404);
        if (!!row.message.reactions?.some((r) => r.by === "me" && r.emoji === body.emoji && r.to === to) === body.on) return json(row.message);
      }
      return json(svc.toggleReaction(conversationId, messageId, body.emoji, "me", to));
    }
    // Questions may live in a history page, outside the latest snapshot.
    return json(svc.patchMessage(conversationId, messageId, {}));
  } catch (err) {
    return fail(err);
  }
}

export function deleteMine(conversationId: string, messageId: string): Response {
  try {
    svc.removeMessage(conversationId, messageId);
    return json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}

/** A file a bot linked to in a message, read from its computer. */
export async function botFile(req: Request, botId: string): Promise<Response> {
  try {
    const bot = getBot(botId);
    if (!bot?.computer) return bad("Bot computer not found", 404);
    const url = new URL(new URL(req.url).searchParams.get("url") ?? "");
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return bad("Invalid file URL", 400);
    const path = decodeURIComponent(url.pathname);
    if (path.includes("\0")) return bad("Invalid file path", 400);
    const result = await computerApi(bot.computer.device).call(bot.id, "fs", { op: "read", path }) as { data: string };
    const name = path.split("/").pop() || "download";
    return new Response(Buffer.from(result.data, "base64"), { headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    } });
  } catch (err) {
    return fail(err);
  }
}

function isClientMessage(m: unknown): m is BotMessage {
  if (!m || typeof m !== "object") return false;
  const message = m as BotMessage;
  return isBotId(message.id) && typeof message.text === "string" && message.author === "me";
}

startBots();
