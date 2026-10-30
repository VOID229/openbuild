import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

/** Notices at the top of the window; Settings → Notifications turns each kind off. */
export function Notices() {
  const prefs = useStore((s) => s.settings.notifications);
  const release = useReleaseUpdate(prefs.builds);
  const [dismissedRelease, setDismissedRelease] = useState("");
  const releaseKey = release ? `${release.track}:${release.latest}` : "";
  const showRelease = !!release && dismissedRelease !== releaseKey;
  const build = useUpdateAvailable(prefs.builds);
  const updates = useRuntimeUpdates(prefs.runtimeUpdates, prefs.updateRuntimes);
  const [buildClosed, setBuildClosed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const busy = useRef(false);
  const live = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => live.current?.abort(), []);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(""), 5000);
    return () => clearTimeout(timer);
  }, [feedback]);
  // Closing a notice skips that release; the next one from the same runtime shows again.
  const shown = updates.filter((u) => prefs.dismissedUpdates?.[u.runtime] !== u.version);
  const showBuild = prefs.builds && build && !buildClosed;
  if (!showRelease && !showBuild && !shown.length && !updating && !feedback && !error) return null;
  const { updateSettings } = useStore.getState();
  const dismiss = () =>
    updateSettings({
      notifications: {
        ...prefs,
        dismissedUpdates: { ...prefs.dismissedUpdates, ...Object.fromEntries(shown.map((u) => [u.runtime, u.version])) },
      },
    });
  const startUpdate = async () => {
    if (busy.current) return;
    busy.current = true;
    setUpdating(true);
    setError("");
    setFeedback("");
    const controller = new AbortController();
    live.current = controller;
    const completed: string[] = [];
    try {
      for (const update of shown) {
        await updateRuntime(update.runtime);
        let lastLine = "";
        const result = await followJob((line) => { if (line.trim()) lastLine = line; }, controller.signal);
        if (controller.signal.aborted) return;
        if (result?.code !== 0) throw new Error(lastLine || `Could not confirm the ${runtimeName(update.runtime)} update. Please try again.`);
        const statuses = await loadRuntimeStatuses(true);
        const status = statuses[update.runtime];
        if (!status.installed || status.updateAvailable) throw new Error(`${runtimeName(update.runtime)} still needs an update. Please try again.`);
        completed.push(`${runtimeName(update.runtime)}${status.version ? ` ${status.version}` : ""}`);
        setFeedback(`${listPhrase(completed)} updated.`);
      }
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Update failed. Please try again.");
    } finally {
      busy.current = false;
      if (!controller.signal.aborted) setUpdating(false);
    }
  };
  return (
    <div className="notices">
      {showRelease && (
        <div className="notice" role="status">
          <span className="notice-text">OpenBuild {release.latest} is available ({release.track}). Run <code>ob update</code> on this server, then <code>ob restart</code>.</span>
          <IconButton label="Dismiss release update" tooltip={false} onClick={() => setDismissedRelease(releaseKey)}><X size={15} /></IconButton>
        </div>
      )}
      {showBuild && (
        <div className="notice" role="status">
          <span className="notice-text">OpenBuild was updated.</span>
          <button type="button" className="btn btn-sm" onClick={() => location.reload()}>
            Reload
          </button>
          <IconButton label="Dismiss" tooltip={false} onClick={() => setBuildClosed(true)}>
            <X size={15} />
          </IconButton>
        </div>
      )}
      {(shown.length > 0 || updating) && (
        <div className="notice" role="status">
          <span className="notice-text">
            {updating ? "Updating runtimes…" : `${listPhrase(shown.map((u) => `${runtimeName(u.runtime)} ${u.version}`))} ${shown.length === 1 ? "is" : "are"} available.`}
          </span>
          <button type="button" className="btn btn-sm" disabled={updating} aria-busy={updating} onClick={() => void startUpdate()}>
            {updating && <Spinner size={12} />}
            {updating ? "Updating…" : "Update"}
          </button>
          <IconButton label="Dismiss" tooltip={false} onClick={dismiss}>
            <X size={15} />
          </IconButton>
        </div>
      )}
      {(feedback || error) && (
        <div className="notice" role={error ? "alert" : "status"}>
          <span className="notice-text">{[feedback, error].filter(Boolean).join(" ")}</span>
          <IconButton label="Dismiss update result" tooltip={false} onClick={() => { setFeedback(""); setError(""); }}>
            <X size={15} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
