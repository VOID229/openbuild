import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth } from "convex/react";
import { CircleHelp, LockKeyhole } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "../../convex/_generated/api";
import {
  cloudClient,
  cloudConfigured,
  confirmPasskeySetup,
  disablePasskey,
  enablePasskey,
  forgetDevice,
  passkeyState,
  unlock,
  unlockWithFaceId,
  useAccount,
  useCloud,
  type Account,
} from "../lib/cloud";
import { deriveCredentials, MIN_PASSWORD, normalizeUsername, USERNAME_RULE } from "../lib/cloud/crypto";
import { usingFallbackStorage } from "../lib/kv";
import { useStore } from "../lib/store";
import { Spinner, Toggle } from "./primitives";

function Note({ children }: { children: ReactNode }) {
  return <p className="setting-desc">{children}</p>;
}

/** Settings → Account: sign in to sync chats, settings and profile across devices. */
export function AccountSection() {
  if (!cloudConfigured()) {
    return (
      <>
        <Note>
          Accounts sync your chats, settings and profile between devices, end-to-end encrypted. They aren't switched on for this copy of OpenChat
          yet.
        </Note>
        <Note>
          To switch them on (once, free): run <code>bun run setup:cloud</code> in the OpenChat folder, log in to Convex when it asks, then restart{" "}
          <code>bun run dev</code>. Commit the <code>shared/cloud.ts</code> it writes and every copy of OpenChat can create accounts and sign in right
          here.
        </Note>
      </>
    );
  }
  return <AccountPanel />;
}

function AccountPanel() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const account = useAccount();
  const status = useCloud((s) => s.status);
  if (isLoading || (isAuthenticated && account === undefined)) return <Spinner size={16} />;
  if (!isAuthenticated || !account) return <SignInForm />;
  if (status === "locked") return <SignInForm unlockFor={account} />;
  return <SignedIn account={account} />;
}

/** Face ID unlock state for an account on this device; undefined while it's being read. */
export function usePasskeyState(username: string | undefined) {
  const [state, setState] = useState<Awaited<ReturnType<typeof passkeyState>>>();
  const refresh = useCallback(() => {
    if (username) void passkeyState(username).then(setState);
  }, [username]);
  useEffect(refresh, [refresh]);
  return [state, refresh] as const;
}

/** "Unlock with Face ID", for a locked account that has it set up on this device. */
export function FaceIdUnlockButton({ username, className = "btn" }: { username: string; className?: string }) {
  const [state] = usePasskeyState(username);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (state !== "on") return null;
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            await unlockWithFaceId(username);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy && <Spinner size={13} />}
        Unlock with Face ID
      </button>
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * Fullscreen, can't be dismissed: in a browser that can't keep the sync key (iOS Lockdown Mode),
 * a reload locks sync. Rather than let changes pile up locally and diverge, the app stays covered
 * until sync is unlocked again (Face ID, or the password), or the account is signed out.
 */
export function SyncLockScreen() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const account = useAccount();
  const status = useCloud((s) => s.status);
  const [passkey] = usePasskeyState(account?.username);
  const [info, setInfo] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Signed in (or still finding out) and sync isn't running yet: "off" is the brief moment before
  // sync reports "locked", which after a reload it always does here.
  const signedIn = isLoading || (isAuthenticated && (account === undefined || !!account?.vault));
  const show = usingFallbackStorage && signedIn && (status === "off" || status === "locked");
  const ready = !!account && status === "locked" && passkey !== undefined;

  useEffect(() => {
    if (!show) return;
    // Everything else on the page is out of reach while this is up.
    const others = [...document.body.children].filter((el) => el !== ref.current && !el.hasAttribute("inert"));
    others.forEach((el) => el.setAttribute("inert", ""));
    return () => others.forEach((el) => el.removeAttribute("inert"));
  }, [show]);

  if (!show) return null;
  const faceId = passkey === "on" && !usePassword;
  return createPortal(
    <div ref={ref} className="sync-lock" role="dialog" aria-modal="true" aria-labelledby="sync-lock-title">
      <div className="sync-lock-card">
        {!ready ? (
          <Spinner size={18} />
        ) : (
          <>
            <LockKeyhole size={28} className="sync-lock-icon" />
            <div className="sync-lock-title">
              <h1 id="sync-lock-title">{faceId ? "Unlock with Face ID to resync" : "Enter your password to resync"}</h1>
              <button type="button" className="sync-lock-help" aria-label="Why?" aria-expanded={info} onClick={() => setInfo(!info)}>
                <CircleHelp size={17} />
              </button>
            </div>
            {info && (
              <p className="setting-desc sync-lock-info">
                Because Lockdown Mode is enabled on this iPhone, {passkey === "on" ? "it needs to sign in with the passkey" : "it needs your password"} after
                each refresh to re-enable syncing.
                {passkey !== "on" && " Set up Unlock with Face ID in Settings → Account to use Face ID instead."} To avoid this, disable Lockdown Mode for
                this website only in Safari: tap the page menu in the address bar → Website Settings → turn off Lockdown Mode.
              </p>
            )}
            {faceId ? (
              <>
                <FaceIdUnlockButton username={account.username} />
                <div className="sync-lock-links">
                  <button type="button" className="link-btn" onClick={() => setUsePassword(true)}>
                    Use password instead
                  </button>
                  <SignOutButton username={account.username} className="link-btn" />
                </div>
              </>
            ) : (
              <SignInForm unlockFor={account} hideFaceId />
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function FaceIdSetting({ username }: { username: string }) {
  const [state, refresh] = usePasskeyState(username);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!state || state === "off") return null;

  const run = (action: () => Promise<unknown>) => async () => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <div className="setting-row setting-row-top setting-row-divided">
      <div className="setting-text">
        <div className="setting-label">Unlock with Face ID</div>
        <p className="setting-desc">
          {state === "on"
            ? "On. This browser can't keep sync unlocked across reloads (Lockdown Mode turns off the storage it needs), so after a reload you unlock with Face ID instead of your password. After turning it off, you can delete the \"OpenChat sync unlock\" passkey in the Passwords app."
            : state === "pending"
              ? "Almost done: confirm with Face ID once more to finish."
              : "This browser can't keep sync unlocked across reloads (Lockdown Mode turns off the storage it needs), so you'd need your password after every reload. Set up a passkey to unlock with Face ID instead. Your password still works."}
        </p>
        {error && (
          <p className="account-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {state === "on" ? (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={run(() => disablePasskey(username))}>
          Turn off
        </button>
      ) : state === "pending" ? (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={run(() => confirmPasskeySetup(username))}>
          {busy && <Spinner size={12} />}
          Confirm with Face ID
        </button>
      ) : (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={run(() => enablePasskey(username))}>
          {busy && <Spinner size={12} />}
          Set up
        </button>
      )}
    </div>
  );
}

const authError = (err: unknown) => {
  const data = (err as { data?: unknown })?.data;
  const msg = `${typeof data === "string" ? data : ""} ${(err as Error)?.message ?? ""}`;
  if (/InvalidCredentials|Wrong password/i.test(msg)) return "Wrong username or password.";
  if (/UsernameTaken|already exists/i.test(msg)) return "That username is taken.";
  if (/TooManyFailedAttempts|rate/i.test(msg)) return "Too many attempts. Wait a little and try again.";
  if (/fetch|network|connect/i.test(msg)) return "Can't reach the sync server. Check your connection.";
  return "Something went wrong. Please try again.";
};

function SignInForm({ unlockFor, hideFaceId }: { unlockFor?: Account; hideFaceId?: boolean }) {
  const { signIn } = useAuthActions();
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [username, setUsername] = useState(unlockFor?.username ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const signUp = mode === "signUp" && !unlockFor;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = normalizeUsername(username);
    if (!USERNAME_RULE.test(name)) return setError("Usernames are 3–64 characters: letters, numbers, dots, dashes and underscores.");
    if (signUp && password.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters.`);
    if (signUp && password !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    setError(undefined);
    try {
      const creds = await deriveCredentials(name, password);
      if (unlockFor) {
        // Setting up an account whose sign-up was interrupted: check the password with the server
        // first, so the data key can't end up locked with a different one.
        if (!unlockFor.vault) await signIn("password", { email: name, password: creds.authSecret, flow: "signIn" });
        await unlock(unlockFor, creds);
      } else {
        await signIn("password", { email: name, password: creds.authSecret, flow: mode });
        // Wait for the session, then get the data key onto this device.
        const account = await waitForAccount();
        await unlock(account, creds);
      }
    } catch (err) {
      setError(authError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="account-form" onSubmit={submit}>
      {unlockFor && !hideFaceId && (
        <div className="account-faceid">
          <FaceIdUnlockButton username={unlockFor.username} />
        </div>
      )}
      <Note>
        {unlockFor
          ? `Enter the password for ${unlockFor.username} to start syncing on this device.`
          : "Sync your chats, settings and profile between devices. Everything is encrypted on your device with your password before it's uploaded, so only you can read it. No email, no tracking."}
      </Note>
      {!unlockFor && (
        <div className="field">
          <label className="md-label" htmlFor="account-username">
            <span className="md-hash">#</span>
            Username
          </label>
          <input id="account-username" className="input" value={username} autoComplete="username" autoCapitalize="none" spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
        </div>
      )}
      <div className="field">
        <label className="md-label" htmlFor="account-password">
          <span className="md-hash">#</span>
            Password
        </label>
        <input
          id="account-password"
          className="input"
          type="password"
          value={password}
          autoComplete={signUp ? "new-password" : "current-password"}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {signUp && (
        <div className="field">
          <label className="md-label" htmlFor="account-confirm">
            <span className="md-hash">#</span>
            Confirm password
          </label>
          <input id="account-confirm" className="input" type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
          <p className="field-help">
            Your password is the only key to your synced data. If you forget it, it can't be reset or recovered (what's on your devices stays).
          </p>
        </div>
      )}
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
      <div className="account-actions">
        <button type="submit" className="btn" disabled={busy || !password || (!unlockFor && !username)}>
          {busy && <Spinner size={13} />}
          {unlockFor ? "Unlock" : signUp ? "Create account" : "Sign in"}
        </button>
        {unlockFor ? (
          <SignOutButton username={unlockFor.username} />
        ) : (
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setMode(signUp ? "signIn" : "signUp");
              setError(undefined);
            }}
          >
            {signUp ? "I have an account" : "Create an account"}
          </button>
        )}
      </div>
    </form>
  );
}

/** Resolves once the new session is active and the account can be read. */
function waitForAccount(): Promise<Account> {
  const client = cloudClient()!;
  return new Promise((resolve, reject) => {
    const watch = client.watchQuery(api.sync.me, {});
    const timer = setTimeout(() => {
      stop();
      reject(new Error("Timed out connecting to the sync server"));
    }, 20_000);
    const check = () => {
      try {
        const me = watch.localQueryResult();
        if (me) {
          stop();
          resolve(me);
        }
      } catch {}
    };
    const unsubscribe = watch.onUpdate(check);
    const stop = () => {
      clearTimeout(timer);
      unsubscribe();
    };
    check();
  });
}

function SignOutButton({ username, className = "btn btn-sm" }: { username: string; className?: string }) {
  const { signOut } = useAuthActions();
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        await forgetDevice(username);
        await signOut();
      }}
    >
      Sign out
    </button>
  );
}

const STATUS_TEXT: Record<string, string> = {
  connecting: "Connecting…",
  syncing: "Syncing…",
  synced: "Up to date",
  offline: "Offline. Changes will sync when you're back online.",
  error: "Sync problem",
  off: "Not syncing",
};

function SyncKeysSetting() {
  const on = useStore((s) => !!s.settings.syncApiKeys);
  const update = useStore((s) => s.updateSettings);
  return (
    <div className="setting-row setting-row-top">
      <div className="setting-text">
        <div className="setting-label">Sync API keys</div>
        <p className="setting-desc">
          {on
            ? "Your Opencode and search keys sync to every device on this account, encrypted with your password like everything else. Turning this off removes them from the account; each device keeps its own copy."
            : "Off: API keys stay on each device, and you add them on every device separately. Turn on to enter them once and have them everywhere, end-to-end encrypted."}
        </p>
      </div>
      <Toggle checked={on} onChange={(v) => update({ syncApiKeys: v })} label="Sync API keys" />
    </div>
  );
}

function SignedIn({ account }: { account: Account }) {
  const { status, error, pending } = useCloud();
  const { signOut } = useAuthActions();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();

  const deleteAccount = async () => {
    setDeleting(true);
    setDeleteError(undefined);
    try {
      const client = cloudClient()!;
      while (!(await client.mutation(api.sync.deleteAccount, {})).done);
      await forgetDevice(account.username);
      await signOut();
    } catch (err) {
      setDeleteError((err as Error).message);
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Signed in as{" "}
            <span className="private-text" tabIndex={0}>
              {account.username}
            </span>
          </div>
          <p className="setting-desc" role="status">
            {status === "syncing" || status === "connecting" ? <Spinner size={11} /> : null} {STATUS_TEXT[status] ?? status}
            {status === "syncing" && pending > 0 ? ` (${pending} left)` : ""}
            {status === "error" && error ? `: ${error}` : ""}
          </p>
        </div>
        <SignOutButton username={account.username} />
      </div>
      <Note>
        Chats, settings and your profile sync live between every device signed in to this account. They're encrypted on the device before upload; the
        sync server stores only ciphertext.
      </Note>
      <SyncKeysSetting />
      <FaceIdSetting username={account.username} />
      <div className="setting-row setting-row-top setting-row-divided">
        <div className="setting-text">
          <div className="setting-label">Delete account</div>
          <p className="setting-desc">Permanently deletes the account and everything synced to it. Chats on your devices are kept.</p>
          {confirming && (
            <div className="field account-delete">
              <label className="md-label" htmlFor="account-delete-confirm">
                <span className="md-hash">#</span>
            Type {account.username} to confirm
              </label>
              <input id="account-delete-confirm" className="input" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
              {deleteError && <p className="account-error">{deleteError}</p>}
            </div>
          )}
        </div>
        {confirming ? (
          <button type="button" className="btn btn-sm btn-danger" disabled={deleting || normalizeUsername(typed) !== account.username} onClick={deleteAccount}>
            {deleting && <Spinner size={12} />}
            Delete forever
          </button>
        ) : (
          <button type="button" className="btn btn-sm" onClick={() => setConfirming(true)}>
            Delete…
          </button>
        )}
      </div>
    </>
  );
}
