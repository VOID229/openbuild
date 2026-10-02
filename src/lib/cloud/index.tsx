// Cloud account wiring: the Convex client (when a deployment is configured), sign-in state, and
// running the sync engine while signed in and unlocked.
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient, useConvexAuth, useQuery } from "convex/react";
import { useEffect, type ReactNode } from "react";
import { create } from "zustand";
import { api } from "../../../convex/_generated/api";
import { config } from "../runtime";
import { useStore } from "../store";
import { usingFallbackStorage } from "../kv";
import { createDataKey, unwrapDataKey, type Credentials } from "./crypto";
import { canSetUpPasskey, confirmPasskey, loadPasskey, rememberSession, removePasskey, setUpPasskey, unlockWithPasskey } from "./passkey";
import { forgetAccount, loadDataKey, saveDataKey, SyncEngine, useCloud } from "./sync";

export { useCloud } from "./sync";

let client: ConvexReactClient | undefined;
let deploymentUrl: string | undefined;

/** Read the server's config and connect to the Convex deployment, if one is configured. */
export async function initCloud() {
  const { convexUrl } = await config;
  if (convexUrl) {
    deploymentUrl = convexUrl;
    client = new ConvexReactClient(convexUrl);
  }
}

export const cloudConfigured = () => !!client;
export const cloudClient = () => client;

export function CloudProvider({ children }: { children: ReactNode }) {
  return client ? <ConvexAuthProvider client={client}>{children}</ConvexAuthProvider> : <>{children}</>;
}

/** Bumped when this device gets the data key, so CloudSync picks it up. */
export const useCloudKey = create<{ version: number }>(() => ({ version: 0 }));

const scopeOf = (username: string) => `${deploymentUrl}|${username}`;

export type Account = NonNullable<ReturnType<typeof useAccount>>;
/** The signed-in account (undefined while loading, null when signed out). */
export function useAccount() {
  const { isAuthenticated } = useConvexAuth();
  return useQuery(api.sync.me, isAuthenticated ? {} : "skip");
}

/** After sign-in (or to unlock): get the account's data key onto this device, creating it for a new account. */
export async function unlock(account: Account, creds: Credentials) {
  if (!client) throw new Error("Cloud sync isn't configured");
  let key: CryptoKey;
  let vault: { wrappedKey: ArrayBuffer; iv: ArrayBuffer };
  if (account.vault) {
    try {
      key = await unwrapDataKey(creds.wrapKey, account.vault.wrappedKey, account.vault.iv);
    } catch {
      throw new Error("Wrong password");
    }
    vault = account.vault;
  } else {
    const created = await createDataKey(creds.wrapKey);
    await client.mutation(api.sync.createVault, { wrappedKey: created.wrappedKey, iv: created.iv });
    key = created.key;
    vault = created;
  }
  const scope = scopeOf(account.username);
  // Without IndexedDB the key only lasts until a reload; keep what Face ID setup needs for this page.
  if (usingFallbackStorage) rememberSession(scope, creds.wrapKey, vault.wrappedKey, vault.iv);
  await saveDataKey(scope, key);
  useCloudKey.setState((s) => ({ version: s.version + 1 }));
}

// Face ID / Touch ID unlock (see passkey.ts). Only offered where the data key can't be kept, which
// is when the browser has no IndexedDB (iOS Lockdown Mode); elsewhere sync stays unlocked anyway.

/** "on": set up; "pending": needs the second Face ID tap; "available": can be set up now; "off". */
export async function passkeyState(username: string): Promise<"on" | "pending" | "available" | "off"> {
  if (!usingFallbackStorage) return "off";
  const scope = scopeOf(username);
  const record = await loadPasskey(scope);
  if (record?.wrapped) return "on";
  if (!canSetUpPasskey(scope)) return "off";
  return record ? "pending" : "available";
}

export const enablePasskey = (username: string) => setUpPasskey(scopeOf(username), username);
export const confirmPasskeySetup = (username: string) => confirmPasskey(scopeOf(username));
export const disablePasskey = (username: string) => removePasskey(scopeOf(username));

/** Unlock sync on this device with Face ID / Touch ID. */
export async function unlockWithFaceId(username: string) {
  const scope = scopeOf(username);
  await saveDataKey(scope, await unlockWithPasskey(scope));
  useCloudKey.setState((s) => ({ version: s.version + 1 }));
}

/** Stop syncing and forget this device's key and sync state. Local chats and settings stay. */
export async function forgetDevice(username: string) {
  await forgetAccount(scopeOf(username));
  await removePasskey(scopeOf(username));
  useCloudKey.setState((s) => ({ version: s.version + 1 }));
}

/** Runs sync while signed in and unlocked. Rendered once chats have loaded. */
export function CloudSync() {
  const account = useAccount();
  const keyVersion = useCloudKey((s) => s.version);
  const chatsLoaded = useStore((s) => s.chatsLoaded);
  const username = account?.username;
  const hasVault = !!account?.vault;

  useEffect(() => {
    if (!client || !chatsLoaded || !username) {
      useCloud.setState({ status: "off" });
      return;
    }
    if (!hasVault) {
      useCloud.setState({ status: "locked" });
      return;
    }
    let engine: SyncEngine | undefined;
    let cancelled = false;
    void loadDataKey(scopeOf(username)).then((key) => {
      if (cancelled) return;
      if (!key) return useCloud.setState({ status: "locked" });
      engine = new SyncEngine(client!, scopeOf(username), key);
      void engine.start();
    });
    return () => {
      cancelled = true;
      engine?.stop();
    };
  }, [chatsLoaded, username, hasVault, keyVersion]);

  return null;
}
