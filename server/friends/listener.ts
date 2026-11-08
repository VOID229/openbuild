// The friend listener: a port of its own that serves the friend protocol and nothing else. It isn't
// the app's server with fewer routes: it's a separate Bun.serve with one small fetch handler, so the
// app, its sign-in, pairing, files, terminals, threads, projects, settings and bots' computers aren't
// reachable from it at all. It only listens while there's something to serve: an invite waiting, or a
// friend who connects here.
import type { Server } from "bun";
import { nonce, PATHS, MAX_FRAME } from "./protocol";
import * as invites from "./invites";
import { accepting, type Pending } from "./link";
import * as store from "./store";

const hot = globalThis as { openbuildFriendListeners?: { key: string; servers: Server<Pending>[] } };

const notFound = () => new Response("Not found", { status: 404 });
/** Guests that connected but haven't answered the challenge yet. A few is plenty. */
let unanswered = 0;
const UNANSWERED_LIMIT = 16;

async function body(req: Request): Promise<string | undefined> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_FRAME) return undefined;
  const text = await req.text();
  return text.length > MAX_FRAME ? undefined : text;
}

/** Everything the friend port answers. Exported so the tests can hold it to that. */
export async function friendFetch(req: Request, server: Server<Pending>): Promise<Response | undefined> {
  const url = new URL(req.url);
  // A web page can send requests to any address, but browsers always say where they come from and
  // other servers don't: nothing a browser sends is a friend's.
  if (req.headers.has("origin") || req.headers.has("sec-fetch-site")) return notFound();
  if (url.pathname === PATHS.connect && req.method === "GET") {
    const from = url.searchParams.get("from") ?? "";
    const friend = store.friend(from);
    // Only a friend who dials this server, as approved; a removed one is a stranger again.
    if (!friend || friend.role !== "guest") return new Response("Not a friend", { status: 403 });
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    if (unanswered >= UNANSWERED_LIMIT) return new Response("Busy", { status: 503 });
    unanswered++;
    setTimeout(() => unanswered--, 10_000).unref?.();
    return server.upgrade(req, { data: { friendId: friend.id, nonce: nonce() } }) ? undefined : new Response("Upgrade failed", { status: 400 });
  }
  if ((url.pathname === PATHS.join || url.pathname === PATHS.poll) && req.method === "POST") {
    const text = await body(req);
    if (text === undefined) return new Response("Too large", { status: 413 });
    return url.pathname === PATHS.join ? invites.handleJoin(text) : invites.handlePoll(text);
  }
  return notFound();
}

/** The addresses to listen on: OPENBUILD_FRIEND_HOST, or what the waiting invite and the friends who dial here were given. */
export function wanted(): string[] {
  const invite = invites.current();
  const hosts = new Set([...(invite ? [invite.listen] : []), ...store.friends().filter((f) => f.role === "guest").map((f) => f.listen ?? "0.0.0.0")]);
  if (!hosts.size) return [];
  if (process.env.OPENBUILD_FRIEND_HOST) return process.env.OPENBUILD_FRIEND_HOST.split(",").map((h) => h.trim()).filter(Boolean);
  return hosts.has("0.0.0.0") ? ["0.0.0.0"] : [...hosts].sort();
}

/** Listen where it's wanted, and nowhere else. Says why when it can't. */
export function sync(): { error?: string; port?: number } {
  const hosts = wanted();
  const port = store.listenPort();
  const key = `${hosts.join(",")}:${port}`;
  const running = hot.openbuildFriendListeners;
  if (running?.key === key) return { port };
  for (const server of running?.servers ?? []) server.stop(true);
  hot.openbuildFriendListeners = undefined;
  if (!hosts.length) return {};
  const servers: Server<Pending>[] = [];
  try {
    for (const hostname of hosts) {
      servers.push(
        Bun.serve<Pending, never>({
          hostname,
          port,
          maxRequestBodySize: MAX_FRAME,
          idleTimeout: 30,
          fetch: friendFetch,
          websocket: { ...accepting, maxPayloadLength: MAX_FRAME, idleTimeout: 120 },
          error: () => new Response("Error", { status: 500 }),
        }),
      );
    }
  } catch (err) {
    for (const server of servers) server.stop(true);
    const code = (err as { code?: string }).code;
    const error = code === "EADDRINUSE"
      ? `Port ${port} is already in use, so friends can't connect. Free it, or set OPENBUILD_FRIEND_PORT to another port and restart OpenBuild.`
      : `Couldn't listen for friends on ${hosts.join(", ")}:${port}: ${(err as Error).message}`;
    console.error(`[friends] ${error}`);
    return { error };
  }
  store.keepPort(port);
  hot.openbuildFriendListeners = { key, servers };
  return { port };
}

export function stop() {
  for (const server of hot.openbuildFriendListeners?.servers ?? []) server.stop(true);
  hot.openbuildFriendListeners = undefined;
}

export const listening = () => !!hot.openbuildFriendListeners;
