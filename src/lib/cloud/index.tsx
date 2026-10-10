// Cloud account wiring: the Convex client (when a deployment is configured), sign-in state, and
// running the sync engine while signed in and unlocked.
import { ConvexAuthProvider, useAuthActions } from "@convex-dev/auth/react";
import { ConvexReactClient, useConvexAuth, useQuery } from "convex/react";
import { useEffect, useRef, type ReactNode } from "react";
import { create } from "zustand";
import { api } from "../../../convex/_generated/api";
import { config } from "../runtime";
import { useStore } from "../store";
import { useCachedAsync, useCachedQuery } from "../settingsCache";
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
    // Convex's own "leave this site?" prompt fires whenever a sync write is in flight. Sync keeps
    // unsent changes (its dirty set) and sends them after a reload, so the prompt isn't needed.
    client = new ConvexReactClient(convexUrl, { unsavedChangesWarning: false });
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

/** What this device is called in Settings → Account → Devices, e.g. "Safari on iPhone". */
export function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox|FxiOS/.test(ua)
        ? "Firefox"
        : /Chrome|CriOS/.test(ua)
          ? "Chrome"
          : /Safari/.test(ua)
            ? "Safari"
            : "Browser";
  return os ? `${browser} on ${os}` : browser;
}

/** Runs sync while signed in and unlocked. Rendered once chats have loaded. */
export function CloudSync() {
  const { isAuthenticated } = useConvexAuth();
  const { signOut } = useAuthActions();
  const account = useAccount();
  const keyVersion = useCloudKey((s) => s.version);
  const chatsLoaded = useStore((s) => s.chatsLoaded);
  const username = account?.username;
  const hasVault = !!account?.vault;
  const lastUsername = useRef<string>(undefined);

  // Warm what Settings → Account shows, from launch on, so opening that section has it ready. These
  // use the same queries and args as the section, so it reads the cached values straight away.
  useCachedQuery(api.sync.me, isAuthenticated ? {} : "skip");
  useCachedQuery(api.devices.list, username ? {} : "skip");
  useCachedAsync(username, passkeyState);

  // Ask for other devices' drafts as soon as this device is signed in, alongside the account check,
  // instead of after it: the sync engine's subscription to the same query then starts with the result.
  useEffect(() => {
    if (!isAuthenticated || !client) return;
    return client.watchQuery(api.sync.liveDrafts, {}).onUpdate(() => {});
  }, [isAuthenticated]);

  // Name this device in the account's device list. And if it was signed out from another device,
  // the session is gone (the account reads as null): finish signing out here, forgetting the key.
  const removed = isAuthenticated && account === null;
  useEffect(() => {
    if (username) {
      lastUsername.current = username;
      void client?.mutation(api.devices.register, { name: deviceName() }).catch(() => {});
    } else if (removed) {
      const last = lastUsername.current;
      lastUsername.current = undefined;
      void (async () => {
        if (last) await forgetDevice(last);
        await signOut();
      })();
    }
  }, [username, removed, signOut]);

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
