// End-to-end encryption for cloud sync. Everything synced is encrypted here, on the device, before
// it leaves; the sync server only ever holds ciphertext.
//
//   password ──PBKDF2(600k, salt = username)──▶ master ──HKDF──┬─▶ "auth": what the server sees as the password
//                                                              └─▶ "wrap": encrypts the data key
//   data key (random AES-256-GCM) encrypts every record; the server stores it wrapped.
//
// The server can't get from the auth secret back to the password or the wrap key, so it can't
// decrypt anything. The flip side: a forgotten password can't be reset. Data on your devices is
// unaffected, but the synced copy can't be opened without it.
//
// Records are gzipped before encryption (smaller uploads, faster sync), and each one is bound to
// its key as associated data, so the server can't swap one record's content for another's.

const enc = new TextEncoder();
const dec = new TextDecoder();
const ITERATIONS = 600_000;

export const normalizeUsername = (u: string) => u.trim().toLowerCase();
export const USERNAME_RULE = /^[a-z0-9._-]{3,64}$/;
export const MIN_PASSWORD = 10;

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export interface Credentials {
  /** Sent to the server in place of the password. */
  authSecret: string;
  /** Unwraps the data key; never leaves the device. */
  wrapKey: CryptoKey;
}

export async function deriveCredentials(username: string, password: string): Promise<Credentials> {
  const salt = await crypto.subtle.digest("SHA-256", enc.encode(`openchat:v1:${normalizeUsername(username)}`));
  const pw = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const masterBits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, pw, 256);
  const master = await crypto.subtle.importKey("raw", masterBits, "HKDF", false, ["deriveBits", "deriveKey"]);
  const hkdf = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(info) });
  const authBits = await crypto.subtle.deriveBits(hkdf("openchat auth v1"), master, 256);
  const wrapKey = await crypto.subtle.deriveKey(hkdf("openchat wrap v1"), master, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { authSecret: `oc1.${b64url(authBits)}`, wrapKey };
}

const randomIv = () => crypto.getRandomValues(new Uint8Array(12));

/** A new data key for a new account: the key itself (non-extractable) and its wrapped form for the server. */
export async function createDataKey(wrapKey: CryptoKey): Promise<{ key: CryptoKey; wrappedKey: ArrayBuffer; iv: ArrayBuffer }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = randomIv();
  const wrappedKey = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode("openchat data key") }, wrapKey, raw);
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  raw.fill(0);
  return { key, wrappedKey, iv: iv.buffer };
}

/** Unwrap the account's data key. Throws when the password is wrong. */
export async function unwrapDataKey(wrapKey: CryptoKey, wrappedKey: ArrayBuffer, iv: ArrayBuffer): Promise<CryptoKey> {
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode("openchat data key") }, wrapKey, wrappedKey));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  raw.fill(0);
  return key;
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<ArrayBuffer> {
  return new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
}

export async function seal(key: CryptoKey, recordKey: string, value: unknown): Promise<{ iv: ArrayBuffer; data: ArrayBuffer }> {
  const packed = await pipe(enc.encode(JSON.stringify(value)), new CompressionStream("gzip"));
  const iv = randomIv();
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(recordKey) }, key, packed);
  return { iv: iv.buffer, data };
}

export async function open<T>(key: CryptoKey, recordKey: string, iv: ArrayBuffer, data: ArrayBuffer): Promise<T> {
  const packed = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode(recordKey) }, key, data);
  return JSON.parse(dec.decode(await pipe(new Uint8Array(packed), new DecompressionStream("gzip")))) as T;
}
