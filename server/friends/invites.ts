// Becoming friends. The host (`openbuild friend invite`) waits with a one-time code that expires: it
// holds the host's addresses and public key, a secret, and which invite it is. The guest
// (`openbuild friend add <code>`) proves it has the code without sending its secret, signing the
// request with its own key; the host's owner sees who's asking and approves or declines; both keep the
// other's public key. The guest checks every answer against the key in the code, so nobody between the
// two can stand in for the host, and nobody without the code can stand in for the guest.
import { randomBytes } from "node:crypto";
import type { FriendMode } from "../../shared/friends";
import { fingerprintOf } from "../../shared/friends";
import { cleanName, decodeInvite, encodeInvite, isKeyId, joinProof, keyId, nonce, PATHS, peek, sameProof, seal, unseal } from "./protocol";
import * as store from "./store";

const TTL = 15 * 60 * 1000;

export interface JoinRequest {
  id: string;
  from: string;
  publicKey: string;
  name: string;
  at: number;
}

interface PendingInvite {
  id: string;
  secret: string;
  name: string;
  mode: FriendMode;
  /** The address the listener binds for this invite (and then for the friend it brings). */
  listen: string;
  urls: string[];
  expiresAt: number;
  request?: JoinRequest;
  decision?: "approved" | "declined";
  waiters: Set<() => void>;
}

const hot = globalThis as { openbuildFriendInvite?: PendingInvite; openbuildFriendJoinFailures?: number[] };

/** The invite waiting now, if it hasn't expired. One at a time: a new one replaces it. */
export function current(): PendingInvite | undefined {
  const invite = hot.openbuildFriendInvite;
  if (invite && invite.expiresAt <= Date.now()) {
    hot.openbuildFriendInvite = undefined;
    wake(invite);
    return undefined;
  }
  return invite;
}

const wake = (invite: PendingInvite) => {
  for (const fn of [...invite.waiters]) fn();
};

export function create(input: { name: string; mode: FriendMode; listen: string; urls: string[] }): { code: string; expiresAt: number; urls: string[] } {
  const previous = hot.openbuildFriendInvite;
  const invite: PendingInvite = {
    id: randomBytes(12).toString("base64url"),
    secret: randomBytes(18).toString("base64url"),
    name: cleanName(input.name) || "Friend",
    mode: input.mode,
    listen: input.listen,
    urls: input.urls,
    expiresAt: Date.now() + TTL,
    waiters: new Set(),
  };
  hot.openbuildFriendInvite = invite;
  if (previous) wake(previous);
  const code = encodeInvite({ id: invite.id, secret: invite.secret, key: store.identity().publicKey, name: invite.name, mode: invite.mode, urls: invite.urls, expiresAt: invite.expiresAt });
  return { code, expiresAt: invite.expiresAt, urls: invite.urls };
}

export function cancel() {
  const invite = hot.openbuildFriendInvite;
  hot.openbuildFriendInvite = undefined;
  if (invite) wake(invite);
}

/** Wait for someone to use the invite. Undefined when it expired, was replaced or cancelled first. */
export function waitForRequest(signal?: AbortSignal): Promise<JoinRequest | undefined> {
  const invite = current();
  if (!invite) return Promise.resolve(undefined);
  if (invite.request && !invite.decision) return Promise.resolve(invite.request);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      invite.waiters.delete(done);
      signal?.removeEventListener("abort", done);
      resolve(hot.openbuildFriendInvite === invite && invite.request && !invite.decision ? invite.request : undefined);
    };
    const timer = setTimeout(done, Math.max(0, invite.expiresAt - Date.now()));
    invite.waiters.add(done);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The owner's answer. Approving makes them a friend here; either way the invite is used up. */
export function decide(requestId: string, approve: boolean): store.StoredFriend | undefined {
  const invite = current();
  if (!invite?.request || invite.request.id !== requestId || invite.decision) throw new Error("Nobody is waiting on that invite anymore.");
  invite.decision = approve ? "approved" : "declined";
  if (!approve) return undefined;
  const { from, publicKey, name } = invite.request;
  const friend: store.StoredFriend = { id: from, name, publicKey, role: "guest", mode: invite.mode, listen: invite.listen, addedAt: Date.now() };
  store.putFriend(friend);
  return friend;
}

const json = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number) => json({ error: status === 429 ? "Too many attempts" : "Not accepted" }, status);
/** Codes that didn't check out, so one can't be guessed quickly. */
function failed(): boolean {
  const now = Date.now();
  const list = (hot.openbuildFriendJoinFailures = (hot.openbuildFriendJoinFailures ?? []).filter((at) => at > now - 60_000));
  list.push(now);
  return list.length > 10;
}
const limited = () => (hot.openbuildFriendJoinFailures ?? []).filter((at) => at > Date.now() - 60_000).length >= 10;

/** POST /friend/v1/join: someone with the code asks to be friends. */
export function handleJoin(text: string): Response {
  if (limited()) return refuse(429);
  const claimed = peek(text);
  const invite = current();
  const key = typeof claimed?.key === "string" ? claimed.key : "";
  const payload = claimed?.t === "join" ? unseal(text, key) : undefined;
  const me = store.identity();
  if (!invite || !payload || payload.to !== me.id || payload.invite !== invite.id || typeof payload.nonce !== "string") return failed() ? refuse(429) : refuse(403);
  if (!sameProof(payload.proof, joinProof(invite.secret, { invite: invite.id, from: payload.from, nonce: payload.nonce }))) return failed() ? refuse(429) : refuse(403);
  // One-time: the first to use it has it. Asking again with the same key gets the same request back.
  if (invite.request && invite.request.from !== payload.from) return refuse(409);
  if (payload.from === me.id || (store.friend(payload.from) && !invite.request)) return refuse(409);
  invite.request ??= { id: randomBytes(12).toString("base64url"), from: payload.from, publicKey: key, name: cleanName(payload.name) || "A friend", at: Date.now() };
  wake(invite);
  return json(JSON.parse(seal({ t: "join-pending", from: me.id, to: payload.from, request: invite.request.id, nonce: payload.nonce }, me)));
}

/** POST /friend/v1/join/status: the guest asks whether it was approved. */
export function handlePoll(text: string): Response {
  const invite = current();
  const request = invite?.request;
  const payload = request ? unseal(text, request.publicKey) : undefined;
  const me = store.identity();
  if (!invite || !request || !payload || payload.t !== "join-poll" || payload.to !== me.id || payload.request !== request.id || typeof payload.nonce !== "string") return refuse(403);
  // An answered invite stays until it expires, so a reply lost on the way can be asked for again.
  const status = invite.decision ?? "pending";
  return json(JSON.parse(seal({ t: "join-result", from: me.id, to: payload.from, request: request.id, nonce: payload.nonce, status, name: invite.name }, me)));
}

// ------------------------------------------------------------------ guest side

export class JoinError extends Error {}

async function post(base: string, path: string, frame: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: frame,
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
  });
}

/**
 * Use a friend's invite code: ask their server, then wait (up to the code's expiry) for them to
 * approve. Resolves to the new friend once both sides have each other's key. `onWaiting` hears once
 * the host has the request, so the CLI can say it's waiting on them.
 */
export async function join(code: string, name: string, opts: { signal?: AbortSignal; onWaiting?: (host: { name: string; fingerprint: string }) => void } = {}): Promise<store.StoredFriend> {
  const invite = decodeInvite(code);
  if (!invite) throw new JoinError("That isn't a friend invite code. It starts with obf1_.");
  if (invite.expiresAt <= Date.now()) throw new JoinError(`That invite expired. Ask ${invite.name} to run \`openbuild friend invite\` again.`);
  const me = store.identity();
  const host = keyId(invite.key);
  if (host === me.id) throw new JoinError("That's this server's own invite. Run `openbuild friend add` on the other computer.");
  if (store.friend(host)) throw new JoinError(`You're already friends with ${store.friend(host)!.name}.`);
  const ask = nonce();
  const frame = seal({ t: "join", from: me.id, to: host, invite: invite.id, key: me.publicKey, name: cleanName(name) || "A friend", nonce: ask, proof: joinProof(invite.secret, { invite: invite.id, from: me.id, nonce: ask }) }, me);
  let base: string | undefined;
  let request: string | undefined;
  let lastError = "";
  for (const url of invite.urls) {
    try {
      const res = await post(url, PATHS.join, frame, opts.signal);
      if (res.status === 409) throw new JoinError(`That invite was already used. Ask ${invite.name} for a new one.`);
      if (res.status === 429) throw new JoinError(`${invite.name}'s server has had too many attempts. Try again in a minute.`);
      if (res.status === 403) throw new JoinError(`${invite.name}'s server didn't accept the invite: it may have expired or been replaced. Ask for a new one.`);
      const reply = res.ok ? unseal(await res.text(), invite.key) : undefined;
      if (!reply || reply.t !== "join-pending" || reply.to !== me.id || reply.nonce !== ask || typeof reply.request !== "string") {
        lastError = `${url} answered, but not as ${invite.name}'s OpenBuild`;
        continue;
      }
      base = url;
      request = reply.request;
      break;
    } catch (err) {
      if (err instanceof JoinError || opts.signal?.aborted) throw err;
      lastError = `${url}: ${(err as Error).message}`;
    }
  }
  if (!base || !request) throw new JoinError(`Couldn't reach ${invite.name}'s OpenBuild (${lastError || invite.urls.join(", ")}). Over Tailscale, check they've shared their machine with you and that you accepted.`);
  opts.onWaiting?.({ name: invite.name, fingerprint: fingerprintOf(host) });
  while (Date.now() < invite.expiresAt) {
    await Bun.sleep(1200);
    if (opts.signal?.aborted) throw new JoinError("Cancelled.");
    const check = nonce();
    let reply;
    try {
      const res = await post(base, PATHS.poll, seal({ t: "join-poll", from: me.id, to: host, request, nonce: check }, me), opts.signal);
      if (res.status === 403) throw new JoinError(`${invite.name}'s invite isn't waiting anymore. Ask for a new one.`);
      reply = res.ok ? unseal(await res.text(), invite.key) : undefined;
    } catch (err) {
      if (err instanceof JoinError || opts.signal?.aborted) throw err;
      continue;
    }
    if (!reply || reply.t !== "join-result" || reply.to !== me.id || reply.nonce !== check || reply.request !== request) continue;
    if (reply.status === "declined") throw new JoinError(`${invite.name} declined.`);
    if (reply.status !== "approved") continue;
    const friend: store.StoredFriend = {
      id: host,
      name: cleanName(reply.name) || invite.name,
      publicKey: invite.key,
      role: "host",
      mode: invite.mode,
      urls: [base, ...invite.urls.filter((u) => u !== base)],
      addedAt: Date.now(),
    };
    store.putFriend(friend);
    return friend;
  }
  throw new JoinError(`${invite.name} didn't approve before the invite expired.`);
}

export const isRequestId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{16}$/.test(id);
export { isKeyId };
