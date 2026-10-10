import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth } from "convex/react";
import { CircleHelp, LockKeyhole } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
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
import { deriveCredentials, MIN_PASSWORD, type Credentials, normalizeUsername, USERNAME_RULE } from "../lib/cloud/crypto";
import { usingFallbackStorage } from "../lib/kv";
import { useCachedAsync, useCachedQuery } from "../lib/settingsCache";
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
  // Cached so coming back to this section shows the account straight away, not a spinner.
  const account = useCachedQuery(api.sync.me, isAuthenticated ? {} : "skip");
  const status = useCloud((s) => s.status);
  if (isLoading || (isAuthenticated && account === undefined)) return <Spinner size={16} />;
  if (!isAuthenticated || !account) return <SignInForm />;
  if (status === "locked") return <SignInForm unlockFor={account} />;
  return <SignedIn account={account} />;
}

/** Face ID unlock state for an account on this device; undefined while it's being read. */
export function usePasskeyState(username: string | undefined) {
  return useCachedAsync(username, passkeyState);
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

type Device = { id: string; name: string | null; lastSeen: number; current: boolean };

/** A ConvexError's payload: a string code, or an object like { code: "DeviceLimit", devices }. */
const errorData = (err: unknown) => {
  const data = (err as { data?: unknown })?.data;
  if (typeof data === "string") return { code: data } as Record<string, unknown>;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
};

/** "in 5 minutes", "in 3 hours", "in 2 days". */
const waitText = (ms: unknown) => {
  const minutes = Math.max(1, Math.ceil(Number(ms) / 60_000) || 1);
  if (minutes < 90) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `in ${hours} hours`;
  return `in ${Math.ceil(hours / 24)} days`;
};

const authError = (err: unknown) => {
  const data = errorData(err);
  const code = String(data.code ?? data.kind ?? "");
  const msg = `${code} ${(err as Error)?.message ?? ""}`;
  if (/InvalidInvite/.test(msg)) return "That invite code isn't valid.";
  if (/NewDeviceLimit/.test(msg)) return `This account has signed in on too many new devices this week. Try again ${waitText(data.retryAfter)}.`;
  if (/DeviceLimit/.test(msg)) return "This account is signed in on as many devices as it can be. Sign one out first.";
  if (/InvalidEmail/.test(msg)) return "That address can't receive email. Check it for typos.";
  if (/DisposableEmail/.test(msg)) return "Use a permanent email address. Throwaway inboxes can't join the waitlist.";
  if (/InvalidCredentials|Wrong password/i.test(msg)) return "Wrong username or password.";
  if (/UsernameTaken|already exists/i.test(msg)) return "That username is taken.";
  if (/TooManyFailedAttempts|rate/i.test(msg)) return "Too many attempts. Wait a little and try again.";
  if (/fetch|network|connect/i.test(msg)) return "Can't reach the sync server. Check your connection.";
  return "Something went wrong. Please try again.";
};

/** "Active now", "Active 3 hours ago", "Active 2 days ago". */
const lastSeenText = (at: number) => {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 60) return "Active in the last hour";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Active ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `Active ${days} day${days === 1 ? "" : "s"} ago`;
};

function DeviceRows({ devices, busy, action, onAction }: { devices: Device[]; busy?: string; action: string; onAction: (id: string) => void }) {
  return (
    <ul className="device-list">
      {devices.map((d) => (
        <li key={d.id} className="device-row">
          <div className="device-text">
            <div className="device-name">{d.name ?? "Unknown device"}</div>
            <div className="device-seen">{d.current ? "This device" : lastSeenText(d.lastSeen)}</div>
          </div>
          {!d.current && (
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => onAction(d.id)}>
              {busy === d.id && <Spinner size={12} />}
              {action}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

const WAITLIST_NOTE =
  "New accounts are invite-only for now: the sync server runs on a free plan with room for a limited number of people.";

function SignInForm({ unlockFor, hideFaceId }: { unlockFor?: Account; hideFaceId?: boolean }) {
  const { signIn } = useAuthActions();
  // New visitors land on sign-up, which starts with the invite code alone; the username and
  // password fields appear once the server says the code is good.
  const [mode, setMode] = useState<"signIn" | "signUp" | "waitlist">("signUp");
  const [invite, setInvite] = useState("");
  const [inviteOk, setInviteOk] = useState(false);
  const [username, setUsername] = useState(unlockFor?.username ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<string | boolean>(false);
  const [error, setError] = useState<string>();
  // At the device limit: the account's devices, to pick one to sign out in favour of this one.
  const [full, setFull] = useState<Device[]>();
  const creds = useRef<{ name: string; password: string; creds: Credentials }>(undefined);
  const signUp = mode === "signUp" && !unlockFor;
  const needsCode = signUp && !inviteOk;

  if (mode === "waitlist" && !unlockFor) return <WaitlistForm onDone={(m) => setMode(m)} />;

  const switchTo = (m: typeof mode) => {
    setMode(m);
    setError(undefined);
    setFull(undefined);
  };

  const run = async (replace?: string) => {
    const name = normalizeUsername(username);
    setBusy(replace ?? true);
    setError(undefined);
    try {
      // Deriving is slow on purpose; don't redo it when retrying with a device to replace.
      if (creds.current?.name !== name || creds.current.password !== password) {
        creds.current = { name, password, creds: await deriveCredentials(name, password) };
      }
      const derived = creds.current.creds;
      const params = { email: name, password: derived.authSecret, ...(replace ? { replace } : {}) };
      if (unlockFor) {
        // Setting up an account whose sign-up was interrupted: check the password with the server
        // first, so the data key can't end up locked with a different one.
        if (!unlockFor.vault) await signIn("password", { ...params, flow: "signIn" });
        await unlock(unlockFor, derived);
      } else {
        await signIn("password", { ...params, flow: signUp ? "signUp" : "signIn", ...(signUp ? { invite } : {}) });
        // Wait for the session, then get the data key onto this device.
        const account = await waitForAccount();
        await unlock(account, derived);
      }
      setFull(undefined);
    } catch (err) {
      const data = errorData(err);
      if (data.code === "DeviceLimit" && Array.isArray(data.devices) && data.devices.length) {
        setFull(data.devices as Device[]);
      } else {
        if (data.code === "InvalidInvite") setInviteOk(false);
        setError(authError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const checkInvite = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (await cloudClient()!.mutation(api.invites.checkInvite, { code: invite })) setInviteOk(true);
      else setError("That invite code isn't valid.");
    } catch (err) {
      setError(authError(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (needsCode) return checkInvite();
    const name = normalizeUsername(username);
    if (!USERNAME_RULE.test(name)) return setError("Usernames are 3–64 characters: letters, numbers, dots, dashes and underscores.");
    if (signUp && password.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters.`);
    if (signUp && password !== confirm) return setError("The passwords don't match.");
    await run();
  };

  if (full) {
    return (
      <div className="account-form">
        <Note>
          {normalizeUsername(username)} is already signed in on {full.length} devices, the most an account can be on. Sign one of them out to use this
          one instead.
        </Note>
        <DeviceRows devices={full} busy={typeof busy === "string" ? busy : busy ? "-" : undefined} action="Sign out" onAction={(id) => void run(id)} />
        {error && (
          <p className="account-error" role="alert">
            {error}
          </p>
        )}
        <div className="account-actions">
          <button type="button" className="link-btn" onClick={() => switchTo(mode)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

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
          : signUp
            ? `${WAITLIST_NOTE} Enter the invite code you were sent, then choose a username and password.`
            : "Sync your chats, settings and profile between devices. Everything is encrypted on your device with your password before it's uploaded, so only you can read it. No tracking. New accounts are invite-only for now."}
      </Note>
      {signUp && (
        <div className="field">
          <label className="md-label" htmlFor="account-invite">
            <span className="md-hash">#</span>
            Invite code
          </label>
          <input
            id="account-invite"
            className="input input-code"
            value={invite}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="XXXX-XXXX-XXXX"
            readOnly={inviteOk}
            autoFocus
            onChange={(e) => setInvite(e.target.value)}
          />
          {inviteOk ? (
            <p className="field-help">
              Code accepted. Now choose a username and password.{" "}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setInviteOk(false);
                  setError(undefined);
                }}
              >
                Use a different code
              </button>
            </p>
          ) : (
            <p className="field-help">
              No code yet?{" "}
              <button type="button" className="link-btn" onClick={() => switchTo("waitlist")}>
                Join the waitlist
              </button>
            </p>
          )}
        </div>
      )}
      {!unlockFor && !needsCode && (
        <div className="field">
          <label className="md-label" htmlFor="account-username">
            <span className="md-hash">#</span>
            Username
          </label>
          <input id="account-username" className="input" value={username} autoFocus={signUp} autoComplete="username" autoCapitalize="none" spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
        </div>
      )}
      {!needsCode && (
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
      )}
      {signUp && inviteOk && (
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
        <button type="submit" className="btn" disabled={!!busy || (needsCode ? !invite.trim() : !password || (!unlockFor && !username))}>
          {busy && <Spinner size={13} />}
          {unlockFor ? "Unlock" : needsCode ? "Continue" : signUp ? "Create account" : "Sign in"}
        </button>
        {unlockFor ? (
          <SignOutButton username={unlockFor.username} />
        ) : (
          <>
            <button type="button" className="link-btn" onClick={() => switchTo(signUp ? "signIn" : "signUp")}>
              {signUp ? "Already have an account?" : "Create an account"}
            </button>
            {!signUp && (
              <button type="button" className="link-btn" onClick={() => switchTo("waitlist")}>
                Join the waitlist
              </button>
            )}
          </>
        )}
      </div>
    </form>
  );
}

/** Join the waitlist: an email address, to send a one-time invite code to. */
function WaitlistForm({ onDone }: { onDone: (mode: "signIn" | "signUp") => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [joined, setJoined] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await cloudClient()!.action(api.invites.joinWaitlist, { email });
      setJoined(email.trim());
    } catch (err) {
      setError(authError(err));
    } finally {
      setBusy(false);
    }
  };

  if (joined) {
    return (
      <div className="account-form">
        <Note>
          You're on the waitlist. When there's room, a one-time invite code will be emailed to <strong>{joined}</strong>. Then come back here,
          choose Create an account, and enter the code with a username and password.
        </Note>
        <div className="account-actions">
          <button type="button" className="btn" onClick={() => onDone("signUp")}>
            I have a code
          </button>
          <button type="button" className="link-btn" onClick={() => onDone("signIn")}>
            Already have an account?
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="account-form" onSubmit={submit}>
      <Note>
        Join the waitlist and you'll get a one-time invite code by email when there's room. Then come back here, enter the code, and choose a username
        and password.
      </Note>
      <div className="field">
        <label className="md-label" htmlFor="account-email">
          <span className="md-hash">#</span>
          Email
        </label>
        <input id="account-email" className="input" type="email" value={email} autoComplete="email" autoCapitalize="none" spellCheck={false} onChange={(e) => setEmail(e.target.value)} />
        <p className="field-help">
          Only used to send your code. It's never linked to your account, and it's deleted from the waitlist once the code is used.
        </p>
      </div>
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
      <div className="account-actions">
        <button type="submit" className="btn" disabled={busy || !email.trim()}>
          {busy && <Spinner size={13} />}
          Join the waitlist
        </button>
        <button type="button" className="link-btn" onClick={() => onDone("signUp")}>
          I have a code
        </button>
        <button type="button" className="link-btn" onClick={() => onDone("signIn")}>
          Already have an account?
        </button>
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

/** Settings → Account → Devices: everywhere this account is signed in, and signing others out. */
function DevicesSetting() {
  const list = useCachedQuery(api.devices.list, {});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const remove = async (id: string) => {
    setBusy(id);
    setError(undefined);
    try {
      await cloudClient()!.mutation(api.devices.remove, { sessionId: id as Id<"authSessions"> });
    } catch (err) {
      setError(authError(err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="setting-row setting-row-top setting-row-divided">
      <div className="setting-text">
        <div className="setting-label">
          Devices
          <span className="caption">
            {list ? `${list.devices.length} of ${list.max}` : null}
          </span>
        </div>
        <p className="setting-desc">
          An account can be signed in on up to {list?.max ?? "…"} devices. To use a new one, sign one of these out. Devices that go unused for a
          month are signed out on their own.
        </p>
        <DeviceRows devices={list?.devices ?? []} busy={busy} action="Sign out" onAction={(id) => void remove(id)} />
        {error && (
          <p className="account-error" role="alert">
            {error}
          </p>
        )}
      </div>
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
      <DevicesSetting />
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
