// Face ID / Touch ID unlock for cloud sync, for browsers that can't keep the data key.
//
// Normally the data key is kept on the device as a non-extractable CryptoKey in IndexedDB, so sync
// stays unlocked across reloads. Without IndexedDB (iOS Lockdown Mode) there's nowhere safe to put
// it, and the password would be needed after every reload. Instead, a passkey can stand in for it:
//
//   passkey ──PRF(salt)──▶ secret ──HKDF──▶ "passkey wrap" key ──AES-GCM──▶ data key (stored here)
//
// The PRF secret comes from the authenticator (Secure Enclave / iCloud Keychain) only after Face ID
// or Touch ID, and is never stored. What's stored on the device is the data key encrypted with it,
// which is useless without the passkey. Needs WebAuthn's PRF extension (Safari 18 / iOS 18 and up).
import { createStore, del, get, set } from "../kv";

const enc = new TextEncoder();
const store = createStore("openchat-passkey", "unlock");

interface PasskeyRecord {
  credentialId: string;
  /** The data key, encrypted with the passkey's wrap key. Missing until setup is confirmed. */
  wrapped?: string;
  iv?: string;
}

/** The wrap key and vault from the last password unlock, held in memory so Face ID can be set up without asking again. */
let session: { scope: string; wrapKey: CryptoKey; wrappedKey: ArrayBuffer; iv: ArrayBuffer } | undefined;

export function rememberSession(scope: string, wrapKey: CryptoKey, wrappedKey: ArrayBuffer, iv: ArrayBuffer) {
  session = { scope, wrapKey, wrappedKey, iv };
}

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const passkeysAvailable = () => typeof PublicKeyCredential !== "undefined" && !!navigator.credentials?.create;

export const loadPasskey = (scope: string) => get<PasskeyRecord>(scope, store).catch(() => undefined);
export const removePasskey = (scope: string) => del(scope, store).catch(() => {});
/** Face ID setup can be offered: passkeys exist and this page was unlocked with the password. */
export const canSetUpPasskey = (scope: string) => passkeysAvailable() && session?.scope === scope;

const prfSalt = () => crypto.subtle.digest("SHA-256", enc.encode("openchat passkey unlock v1"));

type PrfOutput = { enabled?: boolean; results?: { first?: ArrayBuffer } };
const prfOf = (cred: PublicKeyCredential) => (cred.getClientExtensionResults() as { prf?: PrfOutput }).prf;

async function wrapKeyFrom(prf: ArrayBuffer): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode("openchat passkey wrap v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const describe = (err: unknown) => {
  const name = (err as Error)?.name;
  if (name === "NotAllowedError") return new Error("Face ID was cancelled or isn't allowed here.");
  if (name === "InvalidStateError") return new Error("This device already has a passkey for that.");
  return err instanceof Error ? err : new Error(String(err));
};

/** Ask the passkey for its PRF secret (prompts Face ID / Touch ID). */
async function evaluate(credentialId: string): Promise<ArrayBuffer> {
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: "public-key", id: unb64(credentialId) }],
        userVerification: "required",
        extensions: { prf: { eval: { first: await prfSalt() } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;
  } catch (err) {
    throw describe(err);
  }
  const first = prfOf(cred)?.results?.first;
  if (!first) throw new Error("This passkey can't be used to unlock (it needs iOS 18, macOS 15 or later).");
  return first;
}

async function finish(scope: string, credentialId: string, prf: ArrayBuffer) {
  if (!session || session.scope !== scope) throw new Error("Unlock with your password first.");
  const raw = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: session.iv, additionalData: enc.encode("openchat data key") }, session.wrapKey, session.wrappedKey),
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode("openchat passkey data key") }, await wrapKeyFrom(prf), raw);
  raw.fill(0);
  await set(scope, { credentialId, wrapped: b64(wrapped), iv: b64(iv) } satisfies PasskeyRecord, store);
}

/**
 * Create a passkey and use it to protect the data key. Resolves to "done", or "confirm" when the
 * browser needs a second Face ID prompt (call confirmPasskey from another tap).
 */
export async function setUpPasskey(scope: string, username: string): Promise<"done" | "confirm"> {
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "OpenBuild" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: username, displayName: `OpenBuild sync unlock (${username})` },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
        extensions: { prf: { eval: { first: await prfSalt() } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;
  } catch (err) {
    throw describe(err);
  }
  const prf = prfOf(cred);
  if (!prf?.enabled && !prf?.results?.first) throw new Error("This device's passkeys can't be used to unlock (it needs iOS 18, macOS 15 or later).");
  const credentialId = b64(cred.rawId);
  // Some browsers (Safari) only hand out the PRF secret when the passkey is used, not when it's made.
  if (prf.results?.first) {
    await finish(scope, credentialId, prf.results.first);
    return "done";
  }
  await set(scope, { credentialId } satisfies PasskeyRecord, store);
  try {
    await finish(scope, credentialId, await evaluate(credentialId));
    return "done";
  } catch {
    // Usually: the browser wants a fresh tap before the second prompt.
    return "confirm";
  }
}

/** Second step of setup, from a fresh tap. */
export async function confirmPasskey(scope: string) {
  const record = await loadPasskey(scope);
  if (!record) throw new Error("Set up Face ID unlock again.");
  await finish(scope, record.credentialId, await evaluate(record.credentialId));
}

/** Unlock with the passkey: prompts Face ID / Touch ID and returns the data key. */
export async function unlockWithPasskey(scope: string): Promise<CryptoKey> {
  const record = await loadPasskey(scope);
  if (!record?.wrapped || !record.iv) throw new Error("Face ID unlock isn't set up on this device.");
  const prf = await evaluate(record.credentialId);
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(record.iv), additionalData: enc.encode("openchat passkey data key") }, await wrapKeyFrom(prf), unb64(record.wrapped)),
    );
  } catch {
    throw new Error("That passkey doesn't match. Unlock with your password and set up Face ID again.");
  }
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  raw.fill(0);
  return key;
}
