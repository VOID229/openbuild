import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { followJob, updateRuntime } from "../lib/pi";
import { loadRuntimeStatuses } from "../lib/runtimeStatus";
import { runtimeName } from "../lib/runtimes";
import { useStore } from "../lib/store";
import { useRuntimeUpdates, useUpdateAvailable, useReleaseUpdate } from "../lib/update";
import { IconButton, Spinner } from "./primitives";

/** "Pi 1.4.0", "Pi 1.4.0 and Codex 0.48.0", "Pi 1.4.0, Codex 0.48.0 and Claude Code 2.1.0". */
function listPhrase(items: string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const NOTICE_MS = 4000;
const NOTICE_LEAVE_MS = 180; // .notice-leaving's animation

/**
 * One notice. It leaves on its own after NOTICE_MS unless `sticky` (work in progress), hovered, or
 * showing its details; `onExpire` hides it for now, the close button's `onDismiss` for good.
 */
function Notice({ text, role = "status", action, details, sticky = false, dismissLabel = "Dismiss", onDismiss, onExpire }: {
  text: ReactNode;
  role?: "status" | "alert";
  action?: ReactNode;
  details?: string;
  sticky?: boolean;
  dismissLabel?: string;
  onDismiss: () => void;
  onExpire: () => void;
}) {
  const [leaving, setLeaving] = useState<"dismiss" | "expire">();
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!details) setOpen(false); }, [details]);
  useEffect(() => {
    if (sticky || hovered || open || leaving) return;
    const timer = setTimeout(() => setLeaving("expire"), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [sticky, hovered, open, leaving, text]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => {
      setLeaving(undefined);
      (leaving === "dismiss" ? onDismiss : onExpire)();
    }, NOTICE_LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);
  return (
    <div
      className={`notice${leaving ? " notice-leaving" : ""}`}
      role={role}
      onPointerEnter={(e) => { if (e.pointerType === "mouse") setHovered(true); }}
      onPointerLeave={(e) => { if (e.pointerType === "mouse") setHovered(false); }}
    >
      <div className="notice-row">
        <span className="notice-text">{text}</span>
        {action}
        {details && <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide details" : "Details"}</button>}
        <IconButton label={dismissLabel} tooltip={false} disabled={sticky} onClick={() => setLeaving("dismiss")}>
          <X size={15} />
        </IconButton>
      </div>
      {details && (
        <div className="notice-details" data-open={open || undefined}>
          <div><p>{details}</p></div>
        </div>
      )}
    </div>
  );
}

/** Notices at the top of the window; Settings → Notifications turns each kind off. */
export function Notices() {
  const prefs = useStore((s) => s.settings.notifications);
  const release = useReleaseUpdate(prefs.builds);
  const [dismissedRelease, setDismissedRelease] = useState(() => { try { return localStorage.getItem("openbuild:dismissed-release") ?? ""; } catch { return ""; } });
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [releaseResult, setReleaseResult] = useState("");
  const [releaseDetails, setReleaseDetails] = useState("");
  const [expiredRelease, setExpiredRelease] = useState("");
  const releaseKey = release ? `${release.track}:${release.latest}` : "";
  const showRelease = !!release && dismissedRelease !== releaseKey && expiredRelease !== releaseKey;
  const build = useUpdateAvailable(prefs.builds);
  const updates = useRuntimeUpdates(prefs.runtimeUpdates, prefs.updateRuntimes);
  const [buildClosed, setBuildClosed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [details, setDetails] = useState("");
  const [expiredUpdates, setExpiredUpdates] = useState("");
  const busy = useRef(false);
  const live = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => live.current?.abort(), []);
  // Closing a notice skips that release; the next one from the same runtime shows again. A notice
  // that timed out stays away until a newer release or a reload, and skips nothing.
  const shown = updates.filter((u) => prefs.dismissedUpdates?.[u.runtime] !== u.version);
  const shownKey = shown.map((u) => `${u.runtime}:${u.version}`).join();
  const showUpdates = (shown.length > 0 && expiredUpdates !== shownKey) || updating || !!feedback || !!error;
  const showBuild = prefs.builds && build && !buildClosed;
  if (!showRelease && !showBuild && !showUpdates) return null;
  const { updateSettings } = useStore.getState();
  const dismiss = () =>
    updateSettings({
      notifications: {
        ...prefs,
        dismissedUpdates: { ...prefs.dismissedUpdates, ...Object.fromEntries(shown.map((u) => [u.runtime, u.version])) },
      },
    });
  const startUpdate = async () => {
    if (busy.current || releaseBusy) return;
    busy.current = true;
    setUpdating(true);
    setError("");
    setDetails("");
    setFeedback("");
    const controller = new AbortController();
    live.current = controller;
    const completed: string[] = [];
    try {
      for (const update of shown) {
        const { job } = await updateRuntime(update.runtime);
        let lastLine = "";
        const result = await followJob((line) => { if (line.trim()) lastLine = line; }, controller.signal, undefined, undefined, job);
        if (controller.signal.aborted) return;
        if (result?.code !== 0) throw new Error(lastLine || `Could not confirm the ${runtimeName(update.runtime)} update. Please try again.`);
        const statuses = await loadRuntimeStatuses(true);
        const status = statuses[update.runtime];
        if (!status.installed || status.updateAvailable) throw new Error(`${runtimeName(update.runtime)} still needs an update. Please try again.`);
        const current = useStore.getState();
        current.updateSettings({ notifications: { ...current.settings.notifications, dismissedUpdates: { ...current.settings.notifications.dismissedUpdates, [update.runtime]: update.version } } });
        completed.push(`${runtimeName(update.runtime)}${status.version ? ` ${status.version}` : ""}`);
        setFeedback(`${listPhrase(completed)} updated.`);
      }
    } catch (err) {
      if (!controller.signal.aborted) { setError("Runtime update failed. You can retry or check Settings → Runtimes."); setDetails(err instanceof Error ? err.message : "Update failed."); }
    } finally {
      busy.current = false;
      if (!controller.signal.aborted) setUpdating(false);
    }
  };
  const updateRelease = async () => {
    if (busy.current || releaseBusy) return;
    busy.current = true;
    setReleaseBusy(true);
    setReleaseResult("");
    setReleaseDetails("");
    try {
      const response = await fetch("/api/releases/update", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not start the update.");
      let output = "";
      const result = await followJob(line => { output = (output + "\n" + line).slice(-12000); }, undefined, undefined, undefined, body.job);
      if (result?.code !== 0) throw new Error(output || "Connection lost. Check server status before retrying.");
      setReleaseResult("OpenBuild updated. Run ob restart on this server to load it.");
    } catch (err) {
      setReleaseResult("OpenBuild update failed. Check details before retrying.");
      setReleaseDetails(err instanceof Error ? err.message : String(err));
    } finally { busy.current = false; setReleaseBusy(false); }
  };
  return (
    <div className="notices">
      {showRelease && (
        <Notice
          text={releaseBusy ? "Updating OpenBuild…" : releaseResult || `OpenBuild ${release.latest} is available (${release.track}).`}
          action={<button type="button" className="btn btn-sm" disabled={releaseBusy || updating} aria-busy={releaseBusy} onClick={() => void updateRelease()}>{releaseBusy ? "Updating…" : releaseDetails ? "Retry" : "Update"}</button>}
          details={releaseDetails}
          sticky={releaseBusy}
          dismissLabel="Dismiss release update"
          onDismiss={() => { setDismissedRelease(releaseKey); try { localStorage.setItem("openbuild:dismissed-release", releaseKey); } catch {} }}
          onExpire={() => { setExpiredRelease(releaseKey); setReleaseResult(""); setReleaseDetails(""); }}
        />
      )}
      {showBuild && (
        <Notice
          text="OpenBuild was updated."
          action={<button type="button" className="btn btn-sm" onClick={() => location.reload()}>Reload</button>}
          onDismiss={() => setBuildClosed(true)}
          onExpire={() => setBuildClosed(true)}
        />
      )}
      {showUpdates && (
        <Notice
          text={error || feedback || (updating ? "Updating runtimes…" : `${listPhrase(shown.map((u) => `${runtimeName(u.runtime)} ${u.version}`))} ${shown.length === 1 ? "is" : "are"} available.`)}
          role={error ? "alert" : "status"}
          action={
            <button type="button" hidden={!shown.length && !updating} className="btn btn-sm" disabled={updating || releaseBusy} aria-busy={updating} onClick={() => void startUpdate()}>
              {updating && <Spinner size={12} />}
              {updating ? "Updating…" : error ? "Retry" : "Update"}
            </button>
          }
          details={details}
          sticky={updating}
          onDismiss={() => { dismiss(); setError(""); setFeedback(""); setDetails(""); }}
          onExpire={() => { setExpiredUpdates(shownKey); setError(""); setFeedback(""); setDetails(""); }}
        />
      )}
    </div>
  );
}
