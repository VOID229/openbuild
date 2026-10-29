import { X } from "lucide-react";
import { useState } from "react";
import { runtimeName } from "../lib/runtimes";
import { useStore } from "../lib/store";
import { useRuntimeUpdates, useUpdateAvailable } from "../lib/update";
import { IconButton } from "./primitives";

/** "Pi 1.4.0", "Pi 1.4.0 and Codex 0.48.0", "Pi 1.4.0, Codex 0.48.0 and Claude Code 2.1.0". */
function listPhrase(items: string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Notices at the top of the window; Settings → Notifications turns each kind off. */
export function Notices() {
  const prefs = useStore((s) => s.settings.notifications);
  const build = useUpdateAvailable(prefs.builds);
  const updates = useRuntimeUpdates(prefs.runtimeUpdates, prefs.updateRuntimes);
  const [buildClosed, setBuildClosed] = useState(false);
  // Closing a notice skips that release; the next one from the same runtime shows again.
  const shown = updates.filter((u) => prefs.dismissedUpdates?.[u.runtime] !== u.version);
  const showBuild = prefs.builds && build && !buildClosed;
  if (!showBuild && !shown.length) return null;
  const { openSettings, updateSettings } = useStore.getState();
  const dismiss = () =>
    updateSettings({
      notifications: {
        ...prefs,
        dismissedUpdates: { ...prefs.dismissedUpdates, ...Object.fromEntries(shown.map((u) => [u.runtime, u.version])) },
      },
    });
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
      {shown.length > 0 && (
        <div className="notice" role="status">
          <span className="notice-text">
            {listPhrase(shown.map((u) => `${runtimeName(u.runtime)} ${u.version}`))} {shown.length === 1 ? "is" : "are"} available.
          </span>
          <button type="button" className="btn btn-sm" onClick={() => openSettings("runtimes")}>
            Update
          </button>
          <IconButton label="Dismiss" tooltip={false} onClick={dismiss}>
            <X size={15} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
