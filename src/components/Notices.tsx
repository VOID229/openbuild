import { X } from "lucide-react";
import { useState } from "react";
import { useStore } from "../lib/store";
import { usePiUpdate, useUpdateAvailable } from "../lib/update";
import { IconButton } from "./primitives";

/** Notices at the top of the window; Settings → Notifications turns each kind off. */
export function Notices() {
  const prefs = useStore((s) => s.settings.notifications);
  const build = useUpdateAvailable(prefs.builds);
  const pi = usePiUpdate(prefs.piUpdates);
  const [buildClosed, setBuildClosed] = useState(false);
  const showBuild = prefs.builds && build && !buildClosed;
  const showPi = prefs.piUpdates && pi && pi !== prefs.dismissedPi;
  if (!showBuild && !showPi) return null;
  const { openSettings, updateSettings } = useStore.getState();
  return (
    <div className="notices">
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
      {showPi && (
        <div className="notice" role="status">
          <span className="notice-text">Pi {pi} is available.</span>
          <button type="button" className="btn btn-sm" onClick={() => openSettings("pi")}>
            Update
          </button>
          {/* Closing it skips this release; the next one shows again. */}
          <IconButton label="Dismiss" tooltip={false} onClick={() => updateSettings({ notifications: { ...prefs, dismissedPi: pi } })}>
            <X size={15} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
