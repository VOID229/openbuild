import { useEffect, useRef, useState, type ReactNode, type FormEvent } from "react";

/** Nothing behind this gate is mounted until the server accepts this browser's session. */
export function LocalAccess({ load }: { load: () => Promise<ReactNode> }) {
  const [status, setStatus] = useState<{ configured: boolean; authenticated: boolean }>();
  const [content, setContent] = useState<ReactNode>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const outage = useRef<HTMLDialogElement>(null);

  // Server unreachable (restart, tunnel blip). Never shown as "locked": we don't know that it is.
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let checking = false;
    const check = async () => {
      // Many API calls can fail at once when the server drops; one probe at a time is enough.
      if (checking) return;
      checking = true;
      clearTimeout(retry);
      try {
        const res = await fetch("/api/auth/status", { cache: "no-store" });
        if (!res.ok) throw new Error();
        const next = await res.json();
        if (typeof next.configured !== "boolean" || typeof next.authenticated !== "boolean") throw new Error();
        failures = 0;
        if (active) { setStatus(next); setOffline(false); }
      } catch {
        // Keep the last known status so a restart doesn't tear down the open app; retry quickly.
        failures++;
        if (active) { setOffline(true); retry = setTimeout(check, Math.min(1000 * failures, 5000)); }
      } finally { checking = false; }
    };
    // Catch expired/revoked sessions on every API path, not only the status poll.
    const original = window.fetch;
    const guarded = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const api = url.origin === location.origin && url.pathname.startsWith("/api/") && url.pathname !== "/api/auth/status";
      let res: Response;
      try { res = await original(input, init); } catch (err) {
        // A failed API call is the fastest sign the server went away: confirm now instead of at the next poll.
        if (active && api && (err as Error)?.name !== "AbortError") void check();
        throw err;
      }
      if (active && api && (res.status === 502 || res.status === 503 || res.status === 504)) void check();
      if (active && url.origin === location.origin && url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth/") && res.status === 401) {
        setStatus({ configured: true, authenticated: false });
      }
      return res;
    }, { preconnect: original.preconnect });
    window.fetch = guarded;
    void check();
    const timer = setInterval(check, 15_000);
    window.addEventListener("focus", check);
    return () => { active = false; clearInterval(timer); clearTimeout(retry); window.removeEventListener("focus", check); if (window.fetch === guarded) window.fetch = original; };
  }, []);

  useEffect(() => {
    if (!status?.authenticated) { setContent(null); return; }
    let active = true;
    load().then((node) => { if (active) setContent(node); }).catch(() => {
      if (active) setError("Couldn't load OpenBuild. Reload this page to try again.");
    });
    return () => { active = false; };
  }, [status?.authenticated, load]);

  // Only a real answer from the server can lock the screen; an unreachable server never does.
  const locked = !!status && !status.authenticated;
  // Brief blips (a restart takes a second or two) show nothing at all.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!offline) { setSlow(false); return; }
    const t = setTimeout(() => setSlow(true), 1500);
    return () => clearTimeout(t);
  }, [offline]);
  // While the server is unreachable the app is blocked: a modal <dialog> sits in the top layer and makes
  // everything else (including other dialogs and portals) inert, so nothing can be clicked or typed into.
  const blocked = offline && !!status;
  useEffect(() => {
    const d = outage.current;
    if (!d) return;
    if (blocked && !d.open) d.showModal();
    if (!blocked && d.open) d.close();
  }, [blocked]);
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

  // Blocks input immediately; the card fades in only if the outage outlasts a quick restart.
  const reconnecting = (
    <dialog ref={outage} className={`local-access-outage${slow ? " local-access-outage-shown" : ""}`} aria-labelledby="local-access-outage-title" onCancel={(e) => e.preventDefault()}>
      <div className="local-access-outage-card" role="status" aria-live="polite">
        <span className="local-access-spinner" aria-hidden="true" />
        <div>
          <h2 id="local-access-outage-title">Reconnecting to OpenBuild</h2>
          <p>The server is restarting or can't be reached. This closes on its own once it's back.</p>
        </div>
      </div>
    </dialog>
  );

  if (status?.authenticated) return <>{content || <div className="local-access-loading" role="status">{error}</div>}{reconnecting}</>;
  if (!locked) return (
    <div className="local-access-screen local-access-waiting">
      {slow && <div role="status" aria-live="polite"><span className="local-access-dot" aria-hidden="true" />Connecting to OpenBuild…</div>}
    </div>
  );
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
        ) : <p>Set a password in a terminal on the host computer:<br /><code>openbuild set pass &lt;password&gt;</code></p>}
        {error && <p id="local-access-error" className="local-access-error" role="alert">{error}</p>}
      </dialog>
      {reconnecting}
    </div>
  );
}
