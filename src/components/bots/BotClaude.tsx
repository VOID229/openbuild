// Settings → Bots → Claude: bots run on a Claude subscription through the pi-claude-code bridge
// OpenBuild ships, one provider per Claude Code login on the server. Connecting signs in with Claude
// Code's own `claude auth login` (open Claude, approve, paste the code back) when it isn't signed in
// yet. Disconnecting takes the login away from bots and leaves Claude Code signed in, unless asked.
import { CircleAlert, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { BotClaudeLogin, BotClaudeSignIn } from "../../../shared/bots";
import { botModels } from "../../lib/pi";
import { ClaudeMark, IconButton, Spinner } from "../primitives";
import { useModal } from "./BotDialogs";

interface Logins {
  logins: BotClaudeLogin[];
  installed: boolean;
  userPackage: boolean;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json as T;
}
const at = (id: string, action: string) => `/api/bots/claude/${encodeURIComponent(id)}/${action}`;

function DisconnectDialog({ login, onClose, onConfirm }: { login: BotClaudeLogin; onClose: () => void; onConfirm: (signOut: boolean) => void }) {
  const modal = useModal(onClose);
  const [signOut, setSignOut] = useState(false);
  return (
    <dialog {...modal} className="confirm-dialog bots-small-dialog" aria-label={`Disconnect ${login.name}`}>
      <h2>Disconnect {login.name} from bots?</h2>
      <p>Bots stop using this login and switch to a fallback model. Claude Code stays signed in.</p>
      <label className="bots-poll-check">
        <input type="checkbox" checked={signOut} onChange={(e) => setSignOut(e.target.checked)} />
        Also sign Claude Code out of this login on this server
      </label>
      <div className="confirm-actions">
        <button type="button" className="btn btn-sm" onClick={onClose} autoFocus>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={() => {
            onConfirm(signOut);
            onClose();
          }}
        >
          {signOut ? "Disconnect and sign out" : "Disconnect"}
        </button>
      </div>
    </dialog>
  );
}

function SignIn({ login, sign, onDone }: { login: BotClaudeLogin; sign: BotClaudeSignIn; onDone: (next?: BotClaudeSignIn) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const submit = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const { signIn } = await call<{ signIn: BotClaudeSignIn }>(at(login.id, "code"), { flowId: sign.id, code: code.trim() });
      setCode("");
      onDone(signIn);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => void call(at(login.id, "cancel"), {}).finally(() => onDone(undefined));
  return (
    <div className="app-guide bots-claude-signin">
      <div className="bots-field-label">Signing {login.name} in with Claude Code</div>
      <p className="field-help">Open Claude, approve, then paste the code it shows you here.</p>
      <div className="app-page-actions">
        <a className="btn bots-btn bots-btn-primary" href={sign.url} target="_blank" rel="noreferrer noopener">
          Open Claude <ExternalLink size={12} />
        </a>
      </div>
      <form
        className="bots-claude-code"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim() && !busy) void submit();
        }}
      >
        <input
          className="input"
          aria-label="Code from Claude"
          placeholder="Paste the code from Claude"
          value={code}
          autoComplete="off"
          spellCheck={false}
          maxLength={1024}
          disabled={busy}
          onChange={(e) => setCode(e.target.value)}
        />
        <button type="submit" className="btn bots-btn bots-btn-primary" disabled={!code.trim() || busy}>
          {busy ? <Spinner size={12} /> : null} Connect
        </button>
        <button type="button" className="btn bots-btn" disabled={busy} onClick={cancel}>
          Cancel
        </button>
      </form>
      {problem && (
        <p className="field-help key-status key-status-bad" role="alert">
          <CircleAlert size={13} className="bad" /> {problem}
        </p>
      )}
    </div>
  );
}

function LoginRow({ login, disabled, onChanged }: { login: BotClaudeLogin; disabled: boolean; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const [sign, setSign] = useState<BotClaudeSignIn | undefined>(login.signIn?.status === "waiting" ? login.signIn : undefined);
  useEffect(() => setSign(login.signIn?.status === "waiting" ? login.signIn : undefined), [login.signIn?.id, login.signIn?.status]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(undefined);
    try {
      await work();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const connect = () =>
    run(async () => {
      const { signIn } = await call<{ signIn: BotClaudeSignIn | null }>(at(login.id, "connect"), {});
      if (signIn?.status === "failed") throw new Error(signIn.error ?? "Claude Code couldn't start signing in.");
      setSign(signIn?.status === "waiting" ? signIn : undefined);
      if (!signIn) await onChanged();
    });
  const disconnect = (signOut: boolean) =>
    run(async () => {
      await call(at(login.id, "disconnect"), { signOut });
      await onChanged();
    });
  const finished = (next?: BotClaudeSignIn) => {
    setSign(undefined);
    if (next?.status === "failed") setProblem(next.error ?? "The sign-in didn't finish.");
    void onChanged();
  };

  const connected = login.signedIn && login.enabled;
  const state = connected ? "Connected" : login.signedIn ? "Off for bots" : "Not signed in";
  const detail = [login.email, login.plan && `${login.plan[0]!.toUpperCase()}${login.plan.slice(1)} plan`, login.configDir].filter(Boolean).join(" · ");
  return (
    <>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">
            <ClaudeMark size={13} /> {login.name} <span className={connected ? "badge badge-accent" : "badge"}>{state}</span>
          </div>
          <p className="setting-desc">{detail}</p>
        </div>
        {connected ? (
          <button type="button" className="btn btn-sm" disabled={busy || disabled} onClick={() => setConfirm(true)}>
            {busy && <Spinner size={12} />} Disconnect
          </button>
        ) : (
          !sign && (
            <button type="button" className="btn btn-sm" disabled={busy || disabled} onClick={() => void connect()}>
              {busy && <Spinner size={12} />} Connect
            </button>
          )
        )}
      </div>
      {sign && <SignIn login={login} sign={sign} onDone={finished} />}
      {(problem || login.error) && (
        <p className="field-help key-status key-status-bad" role="alert">
          <CircleAlert size={13} className="bad" /> {problem ?? login.error}
        </p>
      )}
      {confirm && <DisconnectDialog login={login} onClose={() => setConfirm(false)} onConfirm={(signOut) => void disconnect(signOut)} />}
    </>
  );
}

export function BotClaude() {
  const [state, setState] = useState<Logins>();
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string>();
  const load = async () => {
    setLoading(true);
    try {
      setState(await call<Logins>("/api/bots/claude"));
      setProblem(undefined);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => void load(), []);
  /** A login came or went: the bots' model list changes with it. */
  const changed = async () => {
    await load();
    await botModels(true).catch(() => {});
  };
  const connected = state?.logins.filter((l) => l.signedIn && l.enabled).length ?? 0;

  return (
    <>
      <div className="pi-subhead">
        <p className="subpage-desc bots-claude-desc">Run bots on your Claude Pro or Max plan, through Claude Code on this server. Their use counts against its limits.</p>
        <span className="bots-claude-head">
          {state ? (connected ? `${connected} connected` : "Not connected") : ""}
          <IconButton label="Check again" onClick={() => void load()} disabled={loading}>
            {loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
          </IconButton>
        </span>
      </div>
      {problem && (
        <p className="field-help key-status key-status-bad" role="alert">
          <CircleAlert size={13} className="bad" /> {problem}
        </p>
      )}
      {state && !state.installed && (
        <p className="field-help key-status key-status-bad" role="alert">
          <CircleAlert size={13} className="bad" /> Claude Code isn't installed on this server. Install it (curl -fsSL https://claude.ai/install.sh | bash), then check again.
        </p>
      )}
      {state?.userPackage && (
        <p className="field-help">Your own pi-claude-code is loaded under Custom extensions. Turn it off there to use these logins.</p>
      )}
      {state?.logins.map((login) => (
        <LoginRow key={login.id} login={login} disabled={!state.installed || state.userPackage} onChanged={changed} />
      ))}
      {state && state.logins.length > 0 && <p className="field-help">Add another login in Settings → Harnesses.</p>}
    </>
  );
}
