// The live connection with each friend. Only the guest side ever dials: a machine shared over
// Tailscale can be reached but can't start connections back to whoever it's shared with. So the guest
// opens one WebSocket to the host's friend listener and holds it, and frames go both ways over it.
//
// Opening it, both sides prove who they are: the host sends a challenge signed with its key, the guest
// answers it signed with its own (naming a session id), and the host confirms. From then on every frame
// is signed and checked against the key that friend was approved with. Data frames are numbered per
// direction and kept in the sender's outbox (store.ts) until the other side acknowledges them, so a
// restart on either side, or a dropped connection, loses nothing: on reconnecting the sender resends
// what's unacknowledged and the receiver applies only what's newer than what it already has.
import type { ServerWebSocket } from "bun";
import { PATHS, nonce, seal, unseal, type Payload } from "./protocol";
import * as store from "./store";

export interface Socket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

interface Session {
  friendId: string;
  /** Names this connection: control frames carry it, so one can't be replayed into another. */
  sid: string;
  socket: Socket;
  lastHeard: number;
}

/** A friend sending this many messages a minute is cut off, and has to reconnect: nothing is lost, it just slows them down. */
export const RATE_LIMIT = 120;
const PING_EVERY = 20_000;
const SILENT_FOR = 65_000;
const HANDSHAKE_MS = 10_000;
const BACKOFF_MAX = 60_000;

export const CLOSE = { replaced: 4000, handshake: 4001, signature: 4002, refused: 4003, removed: 4004, rate: 4008 } as const;

type Apply = (friend: store.StoredFriend, kind: string, body: unknown) => void;
type Hooks = { apply: Apply; status: () => void; removedByPeer: (friendId: string) => void };

const hot = globalThis as {
  openbuildFriendSessions?: Map<string, Session>;
  openbuildFriendDialers?: Map<string, Dialer>;
  openbuildFriendRefused?: Set<string>;
  openbuildFriendWindows?: Map<string, { since: number; count: number }>;
  openbuildFriendHooks?: Hooks;
  openbuildFriendTimer?: ReturnType<typeof setInterval>;
};
const sessions = (hot.openbuildFriendSessions ??= new Map());
const dialers = (hot.openbuildFriendDialers ??= new Map());
/** Friends whose server turned this one away the last time it dialed. */
const refused = (hot.openbuildFriendRefused ??= new Set());
/** Data frames heard from each friend this minute, for the rate limit. Per friend, so reconnecting doesn't reset it. */
const windows = (hot.openbuildFriendWindows ??= new Map());
let hooks: Hooks = (hot.openbuildFriendHooks ??= { apply() {}, status() {}, removedByPeer() {} });
export function setHooks(next: Hooks) {
  hooks = hot.openbuildFriendHooks = next;
}

export const online = (friendId: string) => sessions.has(friendId);
export const wasRefused = (friendId: string) => refused.has(friendId);

const me = () => store.identity();
const frame = (friendId: string, payload: Omit<Payload, "from" | "to">) => seal({ ...payload, from: me().id, to: friendId } as Payload, me());

function transmit(session: Session, payload: Omit<Payload, "from" | "to">) {
  try {
    session.socket.send(frame(session.friendId, payload));
  } catch {
    // A socket that just closed: its close handler ends the session, and the outbox still has it.
  }
}

/** Send a frame to a friend: kept until they acknowledge it, and sent now if they're connected. */
export function deliver(friendId: string, kind: string, body: unknown) {
  const out = store.enqueue(friendId, kind, body);
  const session = sessions.get(friendId);
  if (session) transmit(session, { t: "msg", seq: out.seq, kind, body });
}

function begin(friendId: string, socket: Socket, sid: string) {
  const previous = sessions.get(friendId);
  // A friend reconnecting before the old socket noticed it was gone: the newer one wins.
  if (previous && previous.socket !== socket) previous.socket.close(CLOSE.replaced, "replaced");
  const session: Session = { friendId, sid, socket, lastHeard: Date.now() };
  sessions.set(friendId, session);
  refused.delete(friendId);
  store.updateFriend(friendId, { lastSeenAt: Date.now() });
  for (const out of store.pending(friendId)) transmit(session, { t: "msg", seq: out.seq, kind: out.kind, body: out.body });
  hooks.status();
}

function end(friendId: string, socket: Socket) {
  if (sessions.get(friendId)?.socket !== socket) return;
  sessions.delete(friendId);
  if (store.friend(friendId)) store.updateFriend(friendId, { lastSeenAt: Date.now() });
  hooks.status();
}

/** Close a friend's connection now (they were removed), telling them why first when `bye`. */
export function disconnect(friendId: string, bye: boolean) {
  const dialer = dialers.get(friendId);
  if (dialer) {
    dialer.stopped = true;
    clearTimeout(dialer.timer);
    dialers.delete(friendId);
  }
  const session = sessions.get(friendId);
  if (session) {
    if (bye) transmit(session, { t: "bye", sid: session.sid, reason: "removed" });
    sessions.delete(friendId);
    session.socket.close(CLOSE.removed, "removed");
    if (dialer?.socket && dialer.socket !== session.socket) dialer.socket.close(CLOSE.removed, "removed");
  } else dialer?.socket?.close(CLOSE.removed, "removed");
  refused.delete(friendId);
  hooks.status();
}

/** A frame on an established connection. Anything not signed by this friend's key, or not for this server, ends it. */
function receive(session: Session, text: unknown) {
  const friend = store.friend(session.friendId);
  if (!friend) return session.socket.close(CLOSE.refused, "not a friend");
  const payload = unseal(text, friend.publicKey);
  if (!payload || payload.to !== me().id) return session.socket.close(CLOSE.signature, "bad signature");
  session.lastHeard = Date.now();
  if (payload.t === "msg") {
    const seq = payload.seq;
    if (!Number.isSafeInteger(seq) || (seq as number) < 1) return session.socket.close(CLOSE.signature, "bad frame");
    const last = store.lastIn(friend.id);
    // Already applied: a resend after a reconnect, or a replay. Say again how far this side got.
    if ((seq as number) <= last) return transmit(session, { t: "ack", sid: session.sid, seq: last });
    const now = Date.now();
    let heard = windows.get(friend.id);
    if (!heard || now - heard.since > 60_000) windows.set(friend.id, (heard = { since: now, count: 0 }));
    // Unacknowledged, so the friend sends it again once it has reconnected.
    if (++heard.count > RATE_LIMIT) return session.socket.close(CLOSE.rate, "too many messages");
    try {
      hooks.apply(friend, String(payload.kind ?? ""), payload.body);
    } catch (err) {
      // One frame that can't be applied mustn't hold up the rest behind it forever.
      console.warn(`[friends] couldn't apply a frame from ${friend.name}:`, (err as Error).message);
    }
    store.setLastIn(friend.id, seq as number);
    return transmit(session, { t: "ack", sid: session.sid, seq });
  }
  // Control frames belong to this connection.
  if (payload.sid !== session.sid) return;
  if (payload.t === "ack" && Number.isSafeInteger(payload.seq)) return store.acknowledged(friend.id, payload.seq as number);
  if (payload.t === "ping") return transmit(session, { t: "pong", sid: session.sid });
  if (payload.t === "bye" && payload.reason === "removed") return hooks.removedByPeer(friend.id);
}

// ------------------------------------------------------------------ host side: accepting

export interface Pending {
  friendId: string;
  nonce: string;
  sid?: string;
  timer?: ReturnType<typeof setTimeout>;
}

const adapt = (ws: ServerWebSocket<Pending>): Socket => ({ send: (t) => void ws.send(t), close: (code, reason) => ws.close(code, reason) });
const accepted = new WeakMap<ServerWebSocket<Pending>, Socket>();
const socketOf = (ws: ServerWebSocket<Pending>) => {
  let socket = accepted.get(ws);
  if (!socket) accepted.set(ws, (socket = adapt(ws)));
  return socket;
};

/** The friend listener's WebSocket handlers. A guest has a few seconds to answer the challenge. */
export const accepting = {
  open(ws: ServerWebSocket<Pending>) {
    const friend = store.friend(ws.data.friendId);
    if (!friend) return ws.close(CLOSE.refused, "not a friend");
    ws.data.timer = setTimeout(() => ws.close(CLOSE.handshake, "no answer"), HANDSHAKE_MS);
    ws.send(frame(friend.id, { t: "challenge", nonce: ws.data.nonce }));
  },
  message(ws: ServerWebSocket<Pending>, text: string | Buffer) {
    const data = ws.data;
    const socket = socketOf(ws);
    const live = sessions.get(data.friendId);
    if (data.sid && live?.socket === socket) return receive(live, String(text));
    if (data.sid) return ws.close(CLOSE.replaced, "replaced");
    const friend = store.friend(data.friendId);
    if (!friend) return ws.close(CLOSE.refused, "not a friend");
    const answer = unseal(String(text), friend.publicKey);
    if (!answer || answer.t !== "auth" || answer.to !== me().id || answer.nonce !== data.nonce || typeof answer.sid !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(answer.sid)) {
      return ws.close(CLOSE.handshake, "bad answer");
    }
    clearTimeout(data.timer);
    data.sid = answer.sid;
    ws.send(frame(friend.id, { t: "ready", sid: answer.sid }));
    begin(friend.id, socket, answer.sid);
  },
  close(ws: ServerWebSocket<Pending>) {
    clearTimeout(ws.data.timer);
    end(ws.data.friendId, socketOf(ws));
  },
};

// ------------------------------------------------------------------ guest side: dialing

interface Dialer {
  friendId: string;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
  socket?: Socket;
  stopped?: boolean;
}

const wsUrl = (base: string) => `${base.replace(/^http/, "ws").replace(/\/$/, "")}${PATHS.connect}?from=${me().id}`;

/** Keep a connection open to every friend that hosts, for as long as they're friends. */
export function dialAll() {
  for (const friend of store.friends()) if (friend.role === "host" && !dialers.has(friend.id)) dial(friend.id);
  for (const id of dialers.keys()) if (store.friend(id)?.role !== "host") disconnect(id, false);
}

export function dial(friendId: string) {
  let dialer = dialers.get(friendId);
  if (!dialer) dialers.set(friendId, (dialer = { friendId, attempt: 0 }));
  if (dialer.socket || dialer.stopped) return;
  const friend = store.friend(friendId);
  if (!friend || friend.role !== "host" || !friend.urls?.length) return void dialers.delete(friendId);
  const base = friend.urls[dialer.attempt % friend.urls.length]!;
  const d = dialer;
  let state: "challenge" | "auth" | "ready" = "challenge";
  let sid = "";
  let heard = false;
  const ws = new WebSocket(wsUrl(base));
  const socket: Socket = { send: (t) => ws.send(t), close: (code, reason) => ws.close(code, reason) };
  d.socket = socket;
  const handshake = setTimeout(() => state !== "ready" && ws.close(CLOSE.handshake, "no handshake"), HANDSHAKE_MS);
  ws.onmessage = (event) => {
    heard = true;
    const text = typeof event.data === "string" ? event.data : "";
    if (state === "ready") {
      const session = sessions.get(friendId);
      return session?.socket === socket ? receive(session, text) : ws.close(CLOSE.replaced, "replaced");
    }
    const host = store.friend(friendId);
    const payload = host && unseal(text, host.publicKey);
    // The host proves itself first: a challenge not signed by the key in the invite isn't theirs.
    if (!payload || payload.to !== me().id) return ws.close(CLOSE.signature, "bad signature");
    if (state === "challenge" && payload.t === "challenge" && typeof payload.nonce === "string") {
      sid = nonce();
      state = "auth";
      return ws.send(frame(friendId, { t: "auth", nonce: payload.nonce, sid }));
    }
    if (state === "auth" && payload.t === "ready" && payload.sid === sid) {
      clearTimeout(handshake);
      state = "ready";
      d.attempt = 0;
      return begin(friendId, socket, sid);
    }
    ws.close(CLOSE.handshake, "unexpected frame");
  };
  ws.onclose = (event) => {
    clearTimeout(handshake);
    if (d.socket === socket) d.socket = undefined;
    end(friendId, socket);
    if (d.stopped || !store.friend(friendId)) return void dialers.delete(friendId);
    // Turned away before a word was said: ask the plain address whether it knows this server at all.
    if (!heard || event.code === CLOSE.refused) void checkRefused(friendId, base);
    d.attempt++;
    // Cut off for sending too much (either way): there's no point trying again before the minute is out.
    const wait = event.code === CLOSE.rate ? 30_000 : Math.min(BACKOFF_MAX, 1000 * 2 ** Math.min(d.attempt - 1, 6)) * (0.8 + Math.random() * 0.4);
    d.timer = setTimeout(() => dial(friendId), wait);
    d.timer.unref?.();
  };
  ws.onerror = () => {};
}

/** Whether the friend's listener says it doesn't know this server: they removed it, most likely. */
async function checkRefused(friendId: string, base: string) {
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}${PATHS.connect}?from=${me().id}`, { signal: AbortSignal.timeout(4000), redirect: "error" });
    const was = refused.has(friendId);
    if (res.status === 403) refused.add(friendId);
    else refused.delete(friendId);
    if (was !== refused.has(friendId)) hooks.status();
  } catch {}
}

/** Heartbeats both ways, and a connection that's gone quiet is closed so the guest dials again. */
export function startTimer() {
  if (hot.openbuildFriendTimer) clearInterval(hot.openbuildFriendTimer);
  hot.openbuildFriendTimer = setInterval(() => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      if (now - session.lastHeard > SILENT_FOR) session.socket.close(CLOSE.handshake, "silent");
      else transmit(session, { t: "ping", sid: session.sid });
    }
  }, PING_EVERY);
  hot.openbuildFriendTimer.unref?.();
}

/** Stop everything, for shutdown and hot reloads. */
export function stopAll() {
  for (const id of [...dialers.keys()]) {
    const d = dialers.get(id)!;
    d.stopped = true;
    clearTimeout(d.timer);
    d.socket?.close(1001, "going away");
  }
  dialers.clear();
  for (const session of sessions.values()) session.socket.close(1001, "going away");
  sessions.clear();
}
