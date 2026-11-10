// The GitHub app's sign-in, as rows in its page's cards: OpenBuild's GitHub App through the device
// flow, where it's installed (the user's own account, organizations) with the repositories picked
// there, and, in the danger zone, the difference between disconnecting here and revoking on GitHub.
// A personal access token stays an explicit choice.
import { ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { GITHUB_AUTHORIZATIONS_URL, type GithubInstallation } from "../../../shared/github";
import { useGithub } from "../../lib/github";
import { IconButton, Spinner } from "../primitives";
import { AppAlert, AppRowLine, CopyLine } from "./BotApps";

const DAY = 24 * 3600_000;

/** An installation as a row: its owner, how many repositories it reaches (named in a tooltip), and where to change that. */
function Installation({ inst }: { inst: GithubInstallation }) {
  const listed = inst.repositories ?? [];
  const count = listed.length + (inst.moreRepositories ?? 0);
  const repos = inst.repositorySelection === "all" ? "All repositories" : count === 1 ? "1 repository" : count ? `${count} repositories` : "No repositories selected";
  const names = listed.map((r) => `${r.name}${r.private ? " (private)" : ""}`).join(", ") + (inst.moreRepositories ? `, and ${inst.moreRepositories} more` : "");
  return (
    <AppRowLine
      className="app-install"
      lead={
        <span className="app-install-avatar" aria-hidden>
          {inst.account[0]?.toUpperCase()}
        </span>
      }
      label={inst.account}
      desc={
        <>
          {inst.accountType === "Organization" ? "Organization" : "Personal account"}
          {" · "}
          <span data-tooltip={names || undefined} data-tooltip-side="top" className={names ? "app-install-repos" : undefined}>
            {repos}
          </span>
          {inst.suspended && <span className="app-install-suspended"> · Suspended</span>}
        </>
      }
    >
      <a className="btn btn-sm" href={inst.manageUrl} target="_blank" rel="noreferrer" aria-label={`Configure ${inst.account} on GitHub`}>
        Configure <ExternalLink size={12} />
      </a>
    </AppRowLine>
  );
}

/**
 * `part` is which card this is for: "connection" (signing in, and where it's installed) or "danger"
 * (disconnecting, and revoking). `onConnected` connects the app once GitHub says yes; `onPat` shows
 * the token field for a user who'd rather paste one.
 */
export function GithubSignIn({ part, onConnected, onPat, patShown }: { part: "connection" | "danger"; onConnected: () => Promise<void>; onPat: () => void; patShown: boolean }) {
  const { view, installations, installationsError, device } = useGithub();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const connection = part === "connection";

  useEffect(() => {
    if (connection) void useGithub.getState().load().catch((err) => setProblem((err as Error).message));
  }, [connection]);
  const app = view?.mode === "app" ? view.app : undefined;
  useEffect(() => {
    if (connection && app && !app.signedOut) void useGithub.getState().loadInstallations();
  }, [connection, app?.login, app?.signedOut]);

  // Watch a sign-in under way. The server asks GitHub; this only asks the server.
  const pending = connection && device?.status.status === "pending" ? device.flowId : undefined;
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

  // The danger zone: what disconnecting here does, and what to do when a token may have leaked.
  if (!connection) {
    if (!app) return null;
    return (
      <>
        <AppRowLine
          label="Disconnect GitHub"
          desc={
            <>
              Deletes the tokens from this server. GitHub keeps the authorization until you{" "}
              <a href={GITHUB_AUTHORIZATIONS_URL} target="_blank" rel="noreferrer">
                revoke it there <ExternalLink size={11} />
              </a>
            </>
          }
        >
          <button type="button" className="btn btn-sm app-danger-btn" disabled={busy} onClick={() => void run(() => useGithub.getState().disconnect())}>
            Disconnect
          </button>
        </AppRowLine>
        <AppRowLine label="Revoke tokens" desc={confirmRevoke ? "GitHub revokes both tokens and emails you. You can connect again afterwards." : "If a token may have leaked, disconnect and have GitHub revoke it."}>
          {confirmRevoke ? (
            <>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirmRevoke(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-sm app-danger-btn app-danger-solid" disabled={busy} onClick={() => void run(() => useGithub.getState().revoke()).then(() => setConfirmRevoke(false))}>
                Revoke both
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-sm app-danger-btn" disabled={busy} onClick={() => setConfirmRevoke(true)}>
              Revoke
            </button>
          )}
        </AppRowLine>
        {problem && (
          <div className="app-card-block">
            <AppAlert>{problem}</AppAlert>
          </div>
        )}
      </>
    );
  }

  const ended = device && device.status.status !== "pending" && device.status.status !== "connected" ? device.status : undefined;
  const expiring = app?.refreshExpiresAt && app.refreshExpiresAt - Date.now() < 14 * DAY;
  const avatar = (login: string) => (
    <span className="app-install-avatar" aria-hidden>
      {login[0]?.toUpperCase()}
    </span>
  );

  return (
    <div className="app-guide">
      {device?.status.status === "pending" ? (
        <div className="app-card-block">
          <div className="app-card-label">Enter this code on GitHub</div>
          <p className="app-card-desc">Approve OpenBuild there. This page updates by itself.</p>
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
        </div>
      ) : app ? (
        <>
          <AppRowLine
            lead={avatar(app.login)}
            label={app.login}
            desc={app.signedOut ? "GitHub signed OpenBuild out. Connect again." : expiring ? "This sign-in expires within two weeks." : "Signed in with the OpenBuild GitHub App"}
            className={app.signedOut ? "app-row-bad" : undefined}
          >
            {(app.signedOut || expiring) && (
              <button type="button" className="btn btn-sm bots-btn-primary bots-btn" disabled={busy || !view.configured} onClick={() => void run(() => useGithub.getState().startDevice())}>
                Connect again
              </button>
            )}
          </AppRowLine>

          {!app.signedOut && (
            <>
              <div className="app-card-sub">
                <span className="app-card-sublabel">Installations</span>
                <span className="app-card-subhint" data-tooltip="Bots can use every installation listed. To limit them, install the app only where they should work, with only those repositories. On an organization, an owner installs or approves it." data-tooltip-side="top">
                  Bots can use all of these
                </span>
              </div>
              {installationsError ? (
                <div className="app-card-block">
                  <AppAlert>{installationsError}</AppAlert>
                </div>
              ) : !installations ? (
                <div className="app-card-block">
                  <Spinner size={13} />
                </div>
              ) : installations.length ? (
                installations.map((inst) => <Installation key={inst.id} inst={inst} />)
              ) : (
                <AppRowLine label="Not installed yet" desc="Bots can't reach any repository until it is." />
              )}
              <div className="app-card-block app-card-actions">
                <div className="app-page-actions">
                  {view.installPersonalUrl && (
                    <a className="btn btn-sm" href={view.installPersonalUrl} target="_blank" rel="noreferrer">
                      Install on my account <ExternalLink size={12} />
                    </a>
                  )}
                  {view.installOrgUrl && (
                    <a className="btn btn-sm" href={view.installOrgUrl} target="_blank" rel="noreferrer">
                      Install on an organization <ExternalLink size={12} />
                    </a>
                  )}
                  <IconButton label="Refresh installations" tooltipSide="top" className="app-refresh" disabled={busy} onClick={() => void run(() => useGithub.getState().loadInstallations())}>
                    <RefreshCw size={14} />
                  </IconButton>
                </div>
              </div>
            </>
          )}
        </>
      ) : (
        <div className="app-card-block">
          <div className="app-card-label">{view.mode === "pat" && view.hasPat ? "Signed in with a personal access token" : "Not connected"}</div>
          <p className="app-card-desc">
            {!view.configured
              ? "The GitHub App isn't set up on this server, so GitHub connects with a personal access token."
              : view.mode === "pat" && view.hasPat
                ? "The GitHub App is safer: its tokens expire, and you choose which repositories it reaches."
                : "Sign in with the OpenBuild GitHub App, then install it where bots should work."}
          </p>
          {view.configured ? (
            <div className="app-page-actions">
              <button type="button" className="btn bots-btn bots-btn-primary" disabled={busy} onClick={() => void run(() => useGithub.getState().startDevice())}>
                {busy ? <Spinner size={13} /> : "Connect with GitHub"}
              </button>
              {view.mode === "off" && view.hasPat && (
                <button type="button" className="btn bots-btn" disabled={busy} onClick={() => void run(() => useGithub.getState().usePat())}>
                  Use my saved token
                </button>
              )}
              {view.mode !== "app" && !patShown && (
                <button type="button" className="apps-link" onClick={onPat}>
                  Paste a personal access token instead
                </button>
              )}
            </div>
          ) : (
            view.mode === "off" &&
            view.hasPat && (
              <div className="app-page-actions">
                <button type="button" className="btn bots-btn" disabled={busy} onClick={() => void run(() => useGithub.getState().usePat())}>
                  Use my saved token
                </button>
              </div>
            )
          )}
        </div>
      )}

      {(ended || problem) && (
        <div className="app-card-block">
          {ended && <AppAlert>{ended.status === "denied" ? "GitHub says the sign-in was turned down." : ended.status === "expired" ? "The code ran out before it was entered. Connect again." : ended.status === "cancelled" ? "Sign-in cancelled." : (ended.error ?? "Signing in didn't work.")}</AppAlert>}
          {problem && <AppAlert>{problem}</AppAlert>}
        </div>
      )}
    </div>
  );
}
