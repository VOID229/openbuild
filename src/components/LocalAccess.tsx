import { useEffect, useRef, useState, type ReactNode, type FormEvent } from "react";

/** Nothing behind this gate is mounted until the server accepts this browser's session. */
export function LocalAccess({ load }: { load: () => Promise<ReactNode> }) {
  const [status, setStatus] = useState<{ configured: boolean; authenticated: boolean }>();
  const [content, setContent] = useState<ReactNode>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const res = await fetch("/api/auth/status", { cache: "no-store" });
        if (!res.ok) throw new Error();
        const next = await res.json();
        if (typeof next.configured !== "boolean" || typeof next.authenticated !== "boolean") throw new Error();
        if (active) { setStatus(next); setError(""); }
      } catch {
        if (active) { setStatus(undefined); setError("Can't reach the server. Retrying…"); }
      }
    };
    // Catch expired/revoked sessions on every API path, not only the status poll.
    const original = window.fetch;
    const guarded = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const res = await original(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (active && url.origin === location.origin && url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth/") && res.status === 401) {
        setStatus({ configured: true, authenticated: false });
      }
      return res;
    }, { preconnect: original.preconnect });
    window.fetch = guarded;
    void check();
    const timer = setInterval(check, 15_000);
    window.addEventListener("focus", check);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", check); if (window.fetch === guarded) window.fetch = original; };
  }, []);

  useEffect(() => {
    if (!status?.authenticated) { setContent(null); return; }
    let active = true;
    load().then((node) => { if (active) setContent(node); }).catch(() => {
      if (active) setError("Couldn't load OpenBuild. Reload this page to try again.");
    });
    return () => { active = false; };
  }, [status?.authenticated, load]);

  // Until the first status check answers, show nothing: an unlocked session shouldn't flash the lock.
  const locked = status ? !status.authenticated : !!error;
  useEffect(() => {
    if (locked && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [locked]);

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      if (!res.ok) {
        setError(res.status === 429 ? "Too many attempts. Wait a minute and try again." : res.status === 401 ? "Incorrect password." : "Couldn't unlock the server. Try again.");
        return;
      }
      setPassword("");
      setStatus({ configured: true, authenticated: true });
    } catch { setError("Can't reach the server. Try again."); }
    finally { setBusy(false); }
  };

  if (status?.authenticated) return <>{content || <div className="local-access-loading" role="status">{error}</div>}</>;
  if (!locked) return <div className="local-access-screen" />;
  return (
    <div className="local-access-screen">
      <dialog ref={dialog} className="local-access-dialog" aria-labelledby="local-access-title" aria-describedby="local-access-description" onCancel={(e) => e.preventDefault()}>
        <h1 id="local-access-title">OpenBuild is locked</h1>
        <p id="local-access-description">Enter this server's local password to access Pi and this device. No cloud account required.</p>
        {status?.configured ? (
          <form onSubmit={unlock}>
            <label htmlFor="local-password">Password</label>
            <input id="local-password" type="password" autoComplete="current-password" autoFocus required maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={error ? "local-access-error" : undefined} />
            <button type="submit" disabled={busy || !password}>{busy ? "Unlocking…" : "Unlock"}</button>
          </form>
        ) : status ? <p>Set a password in a terminal on the host computer:<br /><code>openbuild set pass &lt;password&gt;</code></p> : <p role="status">Connecting to the server…</p>}
        {error && <p id="local-access-error" className="local-access-error" role="alert">{error}</p>}
      </dialog>
    </div>
  );
}
