// `openbuild friend …` talks to the running server over a unix socket next to the friend data
// (owner-only, like the folder it's in). The server is what holds friends' connections and the bots'
// chats, so the CLI asks it rather than writing anything itself.
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { FriendMode } from "../../shared/friends";
import { fingerprintOf } from "../../shared/friends";
import { mentionName } from "../../shared/bots";
import * as db from "../bots/db";
import * as svc from "../bots/service";
import * as chats from "./chats";
import * as invites from "./invites";
import * as listener from "./listener";
import { added, remove, setAllowTools, summaries } from "./manage";
import { cleanName } from "./protocol";
import * as store from "./store";
import { TransportError, transports } from "./transport";

export const controlSocketPath = () => join(store.friendsDir(), "control.sock");

const hot = globalThis as { openbuildFriendControl?: ReturnType<typeof Bun.serve> };

class ControlError extends Error {}

function findFriend(spec: unknown): store.StoredFriend {
  const text = String(spec ?? "").trim().toLowerCase();
  const all = store.friends();
  if (!text) throw new ControlError(all.length ? `Say which friend: ${all.map((f) => f.name).join(", ")}.` : "You have no friends here yet. Add one with `openbuild friend add <code>`.");
  const found = all.filter((f) => f.id === text || f.id.startsWith(text.replace(/-/g, "")) || f.name.toLowerCase() === text);
  if (found.length === 1) return found[0]!;
  const prefix = all.filter((f) => f.name.toLowerCase().startsWith(text));
  if (!found.length && prefix.length === 1) return prefix[0]!;
  throw new ControlError(found.length || prefix.length ? `More than one friend matches "${spec}". Use their id.` : `No friend called "${spec}". Friends: ${all.map((f) => f.name).join(", ") || "none"}.`);
}

function findBots(specs: unknown): string[] {
  const list = Array.isArray(specs) ? specs : String(specs ?? "").split(",");
  const bots = db.listBots();
  return list.map((raw) => {
    const text = String(raw).trim().toLowerCase();
    const hit = bots.filter((b) => b.id === text || (text.length >= 4 && b.id.startsWith(text)) || b.name.toLowerCase() === text || mentionName(b.name).toLowerCase() === text);
    if (hit.length !== 1) throw new ControlError(hit.length ? `More than one bot matches "${raw}".` : `You have no bot called "${raw}". Bots: ${bots.map((b) => b.name).join(", ")}.`);
    return hit[0]!.id;
  });
}

function findChat(spec: unknown): db.StoredConversation {
  const text = String(spec ?? "").trim().toLowerCase();
  const all = chats.sharedChats();
  const hit = all.filter((c) => c.id === text || (text.length >= 4 && c.id.startsWith(text)) || c.name?.toLowerCase() === text);
  if (hit.length === 1) return hit[0]!;
  throw new ControlError(hit.length ? `More than one shared chat matches "${spec}". Use its id.` : `No shared chat called "${spec}". Shared chats: ${all.map((c) => c.name).join(", ") || "none"}.`);
}

const chatView = (c: db.StoredConversation) => ({
  id: c.id,
  name: c.name,
  friend: c.friend!.friendName,
  bots: c.botIds.map((id) => db.getBot(id)?.name).filter(Boolean),
  theirs: c.friend!.members.map((m) => m.name),
  ended: c.friend!.ended,
});

/** Who's in the chat changed, said in it the way the app's Members panel says it. */
function changeBots(c: db.StoredConversation, ids: string[], join: boolean) {
  const next = join ? [...new Set([...c.botIds, ...ids])] : c.botIds.filter((id) => !ids.includes(id));
  svc.updateConversation(c.id, { botIds: next });
  for (const id of ids) {
    if (join === c.botIds.includes(id)) continue;
    const name = db.getBot(id)!.name;
    svc.postMessage(c.id, { id: crypto.randomUUID(), author: "me", at: Date.now(), text: "", event: { kind: join ? "joined" : "left", text: join ? "Added" : "Removed", detail: name, bot: id } });
  }
}

async function handle(method: string, p: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  switch (method) {
    case "status": {
      const invite = invites.current();
      const me = store.identity();
      return { me: { id: me.id, fingerprint: fingerprintOf(me.id) }, friends: summaries(), invite: invite ? { expiresAt: invite.expiresAt, urls: invite.urls, mode: invite.mode } : null, listening: listener.listening(), port: store.listenPort() };
    }
    case "invite": {
      const mode: FriendMode = p.mode === "lan" ? "lan" : p.mode === "tunnel" ? "tunnel" : "tailscale";
      const port = store.listenPort();
      let place;
      try {
        place = await transports[mode].place({ port, address: typeof p.address === "string" && p.address.trim() ? p.address.trim() : undefined });
      } catch (err) {
        throw err instanceof TransportError ? new ControlError(err.message) : err;
      }
      const created = invites.create({ name: cleanName(p.name) || chats.ownerName(), mode, listen: place.listen, urls: place.urls });
      const listening = listener.sync();
      if (listening.error) {
        invites.cancel();
        listener.sync();
        throw new ControlError(listening.error);
      }
      return { ...created, mode, port, tailscaleIp: place.tailscaleIp };
    }
    case "wait": {
      const request = await invites.waitForRequest(signal);
      return { request: request ? { id: request.id, name: request.name, fingerprint: fingerprintOf(request.from) } : null };
    }
    case "decide": {
      if (!invites.isRequestId(p.request)) throw new ControlError("Which request?");
      let friend;
      try {
        friend = invites.decide(p.request, p.approve === true);
      } catch (err) {
        throw new ControlError((err as Error).message);
      }
      if (friend) added();
      return { friend: friend ? summaries().find((f) => f.id === friend.id) : null };
    }
    case "cancel":
      invites.cancel();
      listener.sync();
      return { ok: true };
    case "remove": {
      const friend = findFriend(p.friend);
      remove(friend.id);
      return { removed: friend.name };
    }
    case "tools": {
      const friend = findFriend(p.friend);
      setAllowTools(friend.id, p.allow === true);
      return { name: friend.name, allowTools: p.allow === true };
    }
    case "bots":
      return { bots: db.listBots().map((b) => ({ id: b.id, name: b.name, primary: !!b.primary })) };
    case "chats":
      return { chats: chats.sharedChats().map(chatView) };
    case "chat": {
      const friend = findFriend(p.friend);
      const conversation = chats.start(friend, String(p.name ?? ""), findBots(p.bots));
      return { chat: chatView(db.getConversation(conversation.id)!) };
    }
    case "join":
    case "leave": {
      const c = findChat(p.chat);
      if (c.friend!.ended) throw new ControlError(`“${c.name}” doesn't sync with ${c.friend!.friendName} anymore.`);
      changeBots(c, findBots(p.bots), method === "join");
      return { chat: chatView(db.getConversation(c.id)!) };
    }
    default:
      throw new ControlError(`Unknown command ${method}`);
  }
}

/** `add` takes as long as the friend takes to approve, so it answers as NDJSON: waiting, then the outcome. */
function addStream(p: Record<string, unknown>, signal: AbortSignal): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const line = (value: unknown) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(value) + "\n"));
        } catch {}
      };
      try {
        const friend = await invites.join(String(p.code ?? ""), cleanName(p.name) || chats.ownerName(), { signal, onWaiting: (host) => line({ waiting: host }) });
        added();
        line({ friend: summaries().find((f) => f.id === friend.id) });
      } catch (err) {
        line({ error: err instanceof invites.JoinError ? err.message : `Couldn't add that friend: ${(err as Error).message}` });
      }
      try {
        controller.close();
      } catch {}
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
}

export function listen() {
  hot.openbuildFriendControl?.stop(true);
  const path = controlSocketPath();
  mkdirSync(store.friendsDir(), { recursive: true, mode: 0o700 });
  try {
    unlinkSync(path);
  } catch {}
  hot.openbuildFriendControl = Bun.serve({
    unix: path,
    async fetch(req, server) {
      // Waiting on an invite, or on a friend's approval, takes minutes.
      server.timeout(req, 0);
      let body: { method?: unknown; params?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "Expected JSON" }, { status: 400 });
      }
      const method = String(body.method ?? "");
      const params = body.params && typeof body.params === "object" ? (body.params as Record<string, unknown>) : {};
      if (method === "add") return addStream(params, req.signal);
      try {
        return Response.json({ result: await handle(method, params, req.signal) });
      } catch (err) {
        const known = err instanceof ControlError || err instanceof svc.BotsError;
        if (!known) console.error("[friends] control:", err);
        return Response.json({ error: (err as Error).message }, { status: known ? 400 : 500 });
      }
    },
  });
  try {
    chmodSync(path, 0o600);
  } catch {}
}

export function stop() {
  hot.openbuildFriendControl?.stop(true);
  hot.openbuildFriendControl = undefined;
}

