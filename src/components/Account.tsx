import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth } from "convex/react";
import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import { cloudClient, cloudConfigured, forgetDevice, unlock, useAccount, useCloud, type Account } from "../lib/cloud";
import { deriveCredentials, MIN_PASSWORD, normalizeUsername, USERNAME_RULE } from "../lib/cloud/crypto";
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

const authError = (err: unknown) => {
  const msg = (err as Error)?.message ?? "";
  if (/InvalidSecret|InvalidAccountId|Wrong password/i.test(msg)) return "Wrong username or password.";
  if (/already exists/i.test(msg)) return "That username is taken.";
  if (/TooManyFailedAttempts|rate/i.test(msg)) return "Too many attempts. Wait a little and try again.";
  if (/fetch|network|connect/i.test(msg)) return "Can't reach the sync server. Check your connection.";
  return "Something went wrong. Please try again.";
};

function SignInForm({ unlockFor }: { unlockFor?: Account }) {
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

function SignOutButton({ username }: { username: string }) {
  const { signOut } = useAuthActions();
  return (
    <button
      type="button"
      className="btn btn-sm"
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
          <div className="setting-label">Signed in as {account.username}</div>
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
