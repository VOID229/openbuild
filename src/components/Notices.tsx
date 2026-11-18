import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { followJob, updateRuntime } from "../lib/pi";
import { loadRuntimeStatuses } from "../lib/runtimeStatus";
import { runtimeName } from "../lib/runtimes";
import { useServerOutage } from "../lib/serverOutage";
import { useStore } from "../lib/store";
import { useReleaseUpdate } from "../lib/releaseUpdate";
import { providerList, providerUpdateText, useRuntimeUpdates, useUpdateAvailable } from "../lib/update";
import { IconButton, Spinner } from "./primitives";

/** How long a notice stays, in ms: 4 s. Only a test fixture changes it (tests/fixtures/releaseUpdate). */
export const noticeTiming = { ms: 4000 };
/** The longest .notice-leaving animation (styles.css): the corner's slide out. */
const NOTICE_LEAVE_MS = 220;

/**
 * One notice. It leaves on its own after noticeTiming.ms unless `sticky` (work in progress) or
 * `persistent` (waiting on the user). The clock stops while it's hovered, focused from the keyboard
 * or showing its details, and goes on from where it was; new text starts it again. `onExpire` hides
 * it for now, the close button's `onDismiss` for good.
 */
function Notice({ text, role = "status", action, details, sticky = false, persistent = false, dismissLabel = "Dismiss", onDismiss, onExpire }: {
  text: ReactNode;
  role?: "status" | "alert";
  action?: ReactNode;
  details?: string;
  sticky?: boolean;
  persistent?: boolean;
  dismissLabel?: string;
  onDismiss: () => void;
  onExpire: () => void;
}) {
  const [leaving, setLeaving] = useState<"dismiss" | "expire">();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const left = useRef(noticeTiming.ms);
  useEffect(() => { if (!details) setOpen(false); }, [details]);
  // Before the clock's effect, so a change of text or the end of some work gets the whole time.
  useEffect(() => { left.current = noticeTiming.ms; }, [text, sticky]);
  const paused = hovered || focused || open;
  useEffect(() => {
    if (sticky || persistent || paused || leaving) return;
    const started = performance.now();
    const timer = setTimeout(() => setLeaving("expire"), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(0, left.current - (performance.now() - started));
    };
  }, [sticky, persistent, paused, leaving, text]);
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
      data-paused={paused || undefined}
      onPointerEnter={(e) => { if (e.pointerType === "mouse") setHovered(true); }}
      onPointerLeave={(e) => { if (e.pointerType === "mouse") setHovered(false); }}
      // From the keyboard only: a clicked button keeps focus, and that mustn't hold the notice for good.
      onFocus={(e) => { if (e.target.matches(":focus-visible")) setFocused(true); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}
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

/**
 * Notices over the window; Settings → Notifications turns each kind off. Reconnecting shows at the
 * top in the middle; updates (a newer build to reload, newer harnesses) slide in at the top right
 * and leave after noticeTiming.ms (4 s). A newer OpenBuild release has none: the button beside the
 * version in the sidebar's footer offers it, installs it and restarts the server (ReleaseUpdate.tsx).
 */
export function Notices() {
  const prefs = useStore((s) => s.settings.notifications);
  // The sidebar's release update (lib/releaseUpdate.ts): while it installs, harnesses wait; while
  // the server restarts for it, there's no "Reconnecting" to say.
  const phase = useReleaseUpdate((s) => s.phase);
  const releaseBusy = phase === "installing";
  const restarting = phase === "restarting";
  const build = useUpdateAvailable(prefs.builds);
  const updates = useRuntimeUpdates(prefs.runtimeUpdates, prefs.updateRuntimes);
  const [buildClosed, setBuildClosed] = useState(false);
  const outage = useServerOutage((s) => s.outage);
  const [outageClosed, setOutageClosed] = useState(false);
  useEffect(() => { if (!outage) setOutageClosed(false); }, [outage]);
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
  // The restart already says what's happening, in the sidebar.
  const showOutage = outage && !outageClosed && !restarting;
  if (!showOutage && !showBuild && !showUpdates) return null;
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
        completed.push(runtimeName(update.runtime));
        setFeedback(`${providerList(completed)} updated`);
      }
    } catch (err) {
      if (!controller.signal.aborted) { setError("Harness update failed. You can retry or check Settings → Harnesses."); setDetails(err instanceof Error ? err.message : "Update failed."); }
    } finally {
      busy.current = false;
      if (!controller.signal.aborted) setUpdating(false);
    }
  };
  return (
    <>
      {showOutage && (
        <div className="notices">
          <Notice
            text="Reconnecting to OpenBuild…"
            action={<Spinner size={12} />}
            persistent
            dismissLabel="Dismiss reconnecting notice"
            onDismiss={() => setOutageClosed(true)}
            onExpire={() => {}}
          />
        </div>
      )}
      {(showBuild || showUpdates) && (
        <div className="notices notices-corner">
          {showBuild && (
            <Notice
              text="OpenBuild was updated."
              action={<button type="button" className="btn btn-sm btn-primary" onClick={() => location.reload()}>Reload</button>}
              dismissLabel="Dismiss build update"
              onDismiss={() => setBuildClosed(true)}
              onExpire={() => setBuildClosed(true)}
            />
          )}
          {showUpdates && (
            <Notice
              text={error || feedback || (updating ? "Updating harnesses…" : providerUpdateText(shown.map((u) => runtimeName(u.runtime))))}
              role={error ? "alert" : "status"}
              action={
                <button type="button" hidden={!shown.length && !updating} className="btn btn-sm btn-primary" disabled={updating || releaseBusy} aria-busy={updating} onClick={() => void startUpdate()}>
                  {updating && <Spinner size={12} />}
                  {updating ? "Updating…" : error ? "Retry" : "Update"}
                </button>
              }
              details={details}
              sticky={updating}
              dismissLabel="Dismiss harness update"
              onDismiss={() => { dismiss(); setError(""); setFeedback(""); setDetails(""); }}
              onExpire={() => { setExpiredUpdates(shownKey); setError(""); setFeedback(""); setDetails(""); }}
            />
          )}
        </div>
      )}
    </>
  );
}
