// The friend protocol's pieces that need no state: keys, signed frames and invite codes. Both sides
// of a friendship, and the tests, use these.
//
// Every frame either side sends is sealed: `{"p": <payload JSON as a string>, "s": <Ed25519 signature>}`.
// The signature covers a domain tag and the exact payload text, so nothing is re-serialised before
// it's checked. Payloads name who sent them and who they're for (`from`, `to`), so a frame can't be
// reflected back at its sender or replayed to another friend; data frames carry a sequence number the
// receiver only ever accepts going up, and handshake and control frames are bound to the connection.
import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import type { FriendMode } from "../../shared/friends";

export const VERSION = 1;
const DOMAIN = "openbuild-friend/v1\n";
/** Where friends connect, on the friend listener. Nothing else is served there. */
export const PATHS = { connect: "/friend/v1/connect", join: "/friend/v1/join", poll: "/friend/v1/join/status" } as const;

export interface KeyPair {
  /** The key's id: a fingerprint of the public key. */
  id: string;
  /** The raw Ed25519 public key, base64url. */
  publicKey: string;
  privateKey: KeyObject;
}

const isKeyText = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{43}$/.test(x);

export function keyId(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 24);
}
export const isKeyId = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{24}$/.test(x);

export function newKeyPair(): { publicKey: string; secret: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; d: string };
  return { publicKey: jwk.x, secret: jwk.d };
}

export function loadKeyPair(stored: { publicKey: string; secret: string }): KeyPair {
  if (!isKeyText(stored.publicKey) || !isKeyText(stored.secret)) throw new Error("The friend key file is damaged.");
  const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: stored.publicKey, d: stored.secret }, format: "jwk" });
  return { id: keyId(stored.publicKey), publicKey: stored.publicKey, privateKey };
}

const publicKeys = new Map<string, KeyObject>();
function publicKeyObject(publicKey: string): KeyObject | undefined {
  if (!isKeyText(publicKey)) return undefined;
  let key = publicKeys.get(publicKey);
  if (!key) {
    try {
      key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
    } catch {
      return undefined;
    }
    publicKeys.set(publicKey, key);
  }
  return key;
}

export const nonce = () => randomBytes(18).toString("base64url");

export type Payload = { t: string; from: string; to?: string; [key: string]: unknown };

/** A payload signed with this side's key, as it goes on the wire. */
export function seal(payload: Payload, key: KeyPair): string {
  const p = JSON.stringify(payload);
  const s = sign(null, Buffer.from(DOMAIN + p), key.privateKey).toString("base64url");
  return JSON.stringify({ p, s });
}

/** Frames are small: chat text and a few ids. Anything bigger isn't one of ours. */
export const MAX_FRAME = 64 * 1024;

/**
 * The payload of a frame `publicKey` signed, or undefined: not a frame, a bad signature, or signed by
 * someone else. `from` must be that key's own id, so a valid frame always says truly who sent it.
 */
export function unseal(frame: unknown, publicKey: string): Payload | undefined {
  if (typeof frame !== "string" || frame.length > MAX_FRAME) return undefined;
  let outer: { p?: unknown; s?: unknown };
  try {
    outer = JSON.parse(frame);
  } catch {
    return undefined;
  }
  if (typeof outer?.p !== "string" || typeof outer.s !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(outer.s)) return undefined;
  const key = publicKeyObject(publicKey);
  if (!key || !verify(null, Buffer.from(DOMAIN + outer.p), key, Buffer.from(outer.s, "base64url"))) return undefined;
  let payload: Payload;
  try {
    payload = JSON.parse(outer.p);
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== "object" || typeof payload.t !== "string" || payload.from !== keyId(publicKey)) return undefined;
  return payload;
}

/** The payload of a frame without checking it: only to find out which key should have signed it. */
export function peek(frame: unknown): Payload | undefined {
  if (typeof frame !== "string" || frame.length > MAX_FRAME) return undefined;
  try {
    const outer = JSON.parse(frame);
    const payload = typeof outer?.p === "string" ? JSON.parse(outer.p) : undefined;
    return payload && typeof payload === "object" && typeof payload.t === "string" ? payload : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ invite codes

/** What `openbuild friend invite` prints, decoded. */
export interface Invite {
  /** Which invite this is, so the host knows the code being used is the one it's waiting with. */
  id: string;
  /** Proves the guest has the code, without ever sending it. */
  secret: string;
  /** The host's public key: the guest checks everything the host says against it. */
  key: string;
  name: string;
  mode: FriendMode;
  urls: string[];
  expiresAt: number;
}

const CODE_PREFIX = "obf1_";

export function encodeInvite(invite: Invite): string {
  const body = { i: invite.id, s: invite.secret, k: invite.key, n: invite.name, m: invite.mode === "lan" ? "l" : "t", u: invite.urls, e: Math.floor(invite.expiresAt / 1000) };
  return CODE_PREFIX + Buffer.from(JSON.stringify(body)).toString("base64url");
}

/** An invite code, as pasted (spaces and line breaks around it are fine), or undefined when it isn't one. */
export function decodeInvite(code: string): Invite | undefined {
  const text = code.replace(/\s+/g, "");
  if (!text.startsWith(CODE_PREFIX) || text.length > 4000) return undefined;
  let body: any;
  try {
    body = JSON.parse(Buffer.from(text.slice(CODE_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const urls = Array.isArray(body?.u) ? body.u.filter((u: unknown): u is string => typeof u === "string" && /^https?:\/\/[^/\s]+$/.test(u)).slice(0, 8) : [];
  if (typeof body?.i !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(body.i)) return undefined;
  if (typeof body.s !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(body.s) || !isKeyText(body.k) || !urls.length || !Number.isFinite(body.e)) return undefined;
  return { id: body.i, secret: body.s, key: body.k, name: cleanName(body.n) || "Friend", mode: body.m === "l" ? "lan" : "tailscale", urls, expiresAt: body.e * 1000 };
}

/** What a guest sends to show it has the invite's secret: tied to the invite, its own key and a fresh nonce. */
export function joinProof(secret: string, input: { invite: string; from: string; nonce: string }): string {
  return createHmac("sha256", Buffer.from(secret, "base64url")).update(`${input.invite}\n${input.from}\n${input.nonce}`).digest("base64url");
}

export function sameProof(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A name someone else chose, made safe to show and to put in a bot's prompt: one short line. */
export function cleanName(name: unknown, max = 60): string {
  if (typeof name !== "string") return "";
  return name.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
