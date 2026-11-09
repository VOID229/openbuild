// The GitHub app's sign-in: OpenBuild's GitHub App through the device flow, where it's installed
// (the user's own account, organizations) with the repositories picked there, and the difference
// between disconnecting here and revoking on GitHub. A personal access token stays an explicit choice.
import { CircleAlert, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { GITHUB_AUTHORIZATIONS_URL, type GithubInstallation } from "../../../shared/github";
import { useGithub } from "../../lib/github";
import { Spinner } from "../primitives";
import { CopyLine } from "./BotApps";

const DAY = 24 * 3600_000;

function Installation({ inst }: { inst: GithubInstallation }) {
  const repos = inst.repositorySelection === "all" ? "All repositories" : inst.repositories?.length ? inst.repositories.map((r) => `${r.name}${r.private ? " (private)" : ""}`).join(", ") + (inst.moreRepositories ? `, and ${inst.moreRepositories} more` : "") : "No repositories selected";
  return (
    <li>
      <b>
        {inst.account} · {inst.accountType === "Organization" ? "Organization" : "Personal account"}
        {inst.suspended ? " · Suspended" : ""}
      </b>
      <span>{repos}</span>
      <a href={inst.manageUrl} target="_blank" rel="noreferrer">
        Change repositories or uninstall <ExternalLink size={11} />
      </a>
    </li>
  );
}

/**
 * `onConnected` connects the app once GitHub says yes; `onPat` shows the token field for a user
 * who'd rather paste one.
 */
export function GithubSignIn({ onConnected, onPat, patShown }: { onConnected: () => Promise<void>; onPat: () => void; patShown: boolean }) {
  const { view, installations, installationsError, device } = useGithub();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  useEffect(() => {
    void useGithub.getState().load().catch((err) => setProblem((err as Error).message));
  }, []);
  const app = view?.mode === "app" ? view.app : undefined;
  useEffect(() => {
    if (app && !app.signedOut) void useGithub.getState().loadInstallations();
  }, [app?.login, app?.signedOut]);

  // Watch a sign-in under way. The server asks GitHub; this only asks the server.
  const pending = device?.status.status === "pending" ? device.flowId : undefined;
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    const tick = async () => {
      try {
        const status = await useGithub.getState().pollDevice();
        // Connected ends this effect (nothing is pending anymore), so it's handled before that matters.
        if (status?.status === "connected") return void (await onConnected());
        if (!stopped && status?.status === "pending") timer = setTimeout(tick, 2000);
      } catch (err) {
        if (!stopped) setProblem((err as Error).message);
      }
    };
    let timer = setTimeout(tick, 2000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pending]);

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

  if (!view) return null;
  const ended = device && device.status.status !== "pending" && device.status.status !== "connected" ? device.status : undefined;
  const expiring = app?.refreshExpiresAt && app.refreshExpiresAt - Date.now() < 14 * DAY;

  return (
    <div className="app-guide">
      <div className="bots-field-label">GitHub account</div>

      {device?.status.status === "pending" ? (
        <>
          <p className="field-help">Enter this code on GitHub and approve OpenBuild. This page updates by itself.</p>
          <CopyLine value={device.status.userCode} label="Copy code" />
          <div className="app-page-actions">
            <a className="btn bots-btn bots-btn-primary" href={device.status.verificationUri} target="_blank" rel="noreferrer">
              Open GitHub <ExternalLink size={12} />
            </a>
            <button type="button" className="btn bots-btn" onClick={() => void run(() => useGithub.getState().cancelDevice())}>
              Cancel
            </button>
            <Spinner size={13} />
          </div>
        </>
      ) : app ? (
        <>
          <p className="field-help">
            {app.signedOut ? (
              <>
                <CircleAlert size={13} className="bad" /> GitHub signed OpenBuild out as <b>{app.login}</b>. Connect again.
              </>
            ) : (
              <>
                Signed in as <b>{app.login}</b> with the OpenBuild GitHub App.
              </>
            )}
          </p>
          {expiring && !app.signedOut && <p className="field-help">This sign-in expires within two weeks. Connect again to renew it.</p>}
          {(app.signedOut || expiring) && (
            <div className="app-page-actions">
              <button type="button" className="btn bots-btn bots-btn-primary" disabled={busy || !view.configured} onClick={() => void run(() => useGithub.getState().startDevice())}>
                Connect again
              </button>
            </div>
          )}

          {!app.signedOut && (
            <>
              <div className="bots-field-label">Installations</div>
              {installationsError ? (
                <p className="field-help key-status key-status-bad">{installationsError}</p>
              ) : !installations ? (
                <Spinner size={13} />
              ) : installations.length ? (
                <details className="app-details" open>
                  <summary>{installations.length === 1 ? "1 account" : `${installations.length} accounts`}</summary>
                  <ul>
                    {installations.map((inst) => (
                      <Installation key={inst.id} inst={inst} />
                    ))}
                  </ul>
                </details>
              ) : (
                <p className="field-help">Not installed yet, so bots can't reach any repository.</p>
              )}
              <p className="field-help">Bots can use every installation listed. To limit them, install the app only where they should work, with only those repositories. On an organization, an owner installs or approves it.</p>
              <div className="app-page-actions">
                {view.installPersonalUrl && (
                  <a className="btn bots-btn" href={view.installPersonalUrl} target="_blank" rel="noreferrer">
                    Install on my account <ExternalLink size={12} />
                  </a>
                )}
                {view.installOrgUrl && (
                  <a className="btn bots-btn" href={view.installOrgUrl} target="_blank" rel="noreferrer">
                    Install on an organization <ExternalLink size={12} />
                  </a>
                )}
                <button type="button" className="btn bots-btn" disabled={busy} onClick={() => void run(() => useGithub.getState().loadInstallations())}>
                  Refresh
                </button>
              </div>
            </>
          )}

          <div className="bots-field-label">Disconnect</div>
          <p className="field-help">
            Disconnecting deletes the tokens from this server. GitHub keeps the authorization until you revoke it.{" "}
            <a href={GITHUB_AUTHORIZATIONS_URL} target="_blank" rel="noreferrer">
              Revoke on GitHub <ExternalLink size={11} />
            </a>
          </p>
          <div className="app-page-actions">
            <button type="button" className="btn bots-btn bots-danger" disabled={busy} onClick={() => void run(() => useGithub.getState().disconnect())}>
              Disconnect here
            </button>
            {!confirmRevoke ? (
              <button type="button" className="apps-link" disabled={busy} onClick={() => setConfirmRevoke(true)}>
                The token may have leaked
              </button>
            ) : (
              <button type="button" className="btn bots-btn bots-danger" disabled={busy} onClick={() => void run(() => useGithub.getState().revoke()).then(() => setConfirmRevoke(false))}>
                Disconnect and have GitHub revoke both tokens
              </button>
            )}
          </div>
          {confirmRevoke && <p className="field-help">GitHub revokes both tokens and emails you. You can connect again afterwards.</p>}
        </>
      ) : (
        <>
          {view.mode === "pat" && view.hasPat && view.configured && <p className="field-help">Bots use your personal access token. The GitHub App is safer: its tokens expire, and you choose which repositories it reaches.</p>}
          {view.mode === "off" && <p className="field-help">Not connected.</p>}
          {view.configured ? (
            <>
              <p className="field-help">Sign in with the OpenBuild GitHub App, then install it where bots should work.</p>
              <div className="app-page-actions">
                <button type="button" className="btn bots-btn bots-btn-primary" disabled={busy} onClick={() => void run(() => useGithub.getState().startDevice())}>
                  {busy ? <Spinner size={13} /> : "Connect with GitHub"}
                </button>
                {view.mode === "off" && view.hasPat && (
                  <button type="button" className="btn bots-btn" disabled={busy} onClick={() => void run(() => useGithub.getState().usePat())}>
                    Use my saved personal access token
                  </button>
                )}
                {view.mode !== "app" && !patShown && (
                  <button type="button" className="apps-link" onClick={onPat}>
                    Paste a personal access token instead
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="field-help">
              The GitHub App isn't set up on this server, so GitHub connects with a personal access token.
              {view.mode === "off" && view.hasPat && (
                <>
                  {" "}
                  <button type="button" className="apps-link" disabled={busy} onClick={() => void run(() => useGithub.getState().usePat())}>
                    Use my saved one
                  </button>
                </>
              )}
            </p>
          )}
        </>
      )}

      {ended && (
        <p className="field-help key-status key-status-bad" role="alert">
          <CircleAlert size={13} className="bad" /> {ended.status === "denied" ? "GitHub says the sign-in was turned down." : ended.status === "expired" ? "The code ran out before it was entered. Connect again." : ended.status === "cancelled" ? "Sign-in cancelled." : (ended.error ?? "Signing in didn't work.")}
        </p>
      )}
      {problem && (
        <p className="field-help key-status key-status-bad" role="alert">
          <CircleAlert size={13} className="bad" /> {problem}
        </p>
      )}
    </div>
  );
}
