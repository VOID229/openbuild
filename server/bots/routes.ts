// The app's view of OpenBots: a snapshot, then a stream of changes, plus the actions the UI takes.
// Bots themselves don't use these routes; their tools go through the socket in agent.ts.
import { computerApi } from "../computers/api";
import { getBot } from "./db";
import type { Bot, BotMessage, BotsSettings, Conversation } from "../../shared/bots";
import { isBotId } from "../../shared/bots";
import { bad, readJson } from "../handlers";
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

export function botRoutes(api: Api) {
  svc.ensureStarted();
  return {
    "/api/bots/:id/file": {
      GET: api(async (req: Bun.BunRequest<"/api/bots/:id/file">) => {
        try {
          const bot = getBot(req.params.id);
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
      }),
    },
    "/api/bots/stream": {
      GET: api((req: Request, server: Bun.Server<unknown>) => {
        server.timeout(req, 0);
        svc.ensureStarted();
        const enc = new TextEncoder();
        let unsub = () => {};
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
              req.signal.removeEventListener("abort", stop);
              try {
                controller.close();
              } catch {}
            };
            if (req.signal.aborted) return stop();
            send({ t: "snapshot", ...snapshot() });
            unsub = subscribe(send);
            ping = setInterval(() => send({ t: "ping" }), 20_000);
            ping.unref?.();
            req.signal.addEventListener("abort", stop, { once: true });
            svc.greetOnFirstOpen();
          },
          cancel() {
            stop();
          },
        });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform" } });
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
      POST: api((req: Bun.BunRequest<"/api/bots/conversations/:id/read">) => {
        svc.markRead(req.params.id);
        return json({ ok: true });
      }),
    },
    "/api/bots/conversations/:id/messages": {
      GET: api((req: Bun.BunRequest<"/api/bots/conversations/:id/messages">) => {
        try {
          const params = new URL(req.url).searchParams;
          const before = Number(params.get("before")) || undefined;
          return json(svc.messagePage(req.params.id, params.get("beforeId") || undefined, before));
        } catch (err) {
          return fail(err);
        }
      }),
      POST: api(async (req: Bun.BunRequest<"/api/bots/conversations/:id/messages">) => {
        try {
          const body = await readJson(req);
          if (!isClientMessage(body) || body.author !== "me") return bad("Expected your message");
          return json(svc.postMessage(req.params.id, { ...body, author: "me", at: Date.now() }));
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/bots/conversations/:id/messages/:messageId": {
      PATCH: api(async (req: Bun.BunRequest<"/api/bots/conversations/:id/messages/:messageId">) => {
        try {
          const body = await readJson(req);
          if (body?.question && typeof body.question.answer === "string") svc.answerQuestion(req.params.id, req.params.messageId, body.question.answer);
          if (typeof body?.emoji === "string") return json(svc.toggleReaction(req.params.id, req.params.messageId, body.emoji, "me", typeof body.to === "string" ? body.to : undefined));
          // Questions may live in a history page, outside the latest snapshot.
          return json(svc.patchMessage(req.params.id, req.params.messageId, {}));
        } catch (err) {
          return fail(err);
        }
      }),
      DELETE: api((req: Bun.BunRequest<"/api/bots/conversations/:id/messages/:messageId">) => {
        try {
          svc.removeMessage(req.params.id, req.params.messageId);
          return json({ ok: true });
        } catch (err) {
          return fail(err);
        }
      }),
    },
  };
}

function isClientMessage(m: unknown): m is BotMessage {
  if (!m || typeof m !== "object") return false;
  const message = m as BotMessage;
  return isBotId(message.id) && typeof message.text === "string" && message.author === "me";
}

startBots();
