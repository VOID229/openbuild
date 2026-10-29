import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import { cx } from "../lib/ui";
import { whisperRequest } from "../lib/whisper";
import { Toggle } from "./primitives";

export function DictationSettings() {
  const settings = useStore((s) => s.settings.dictation);
  const update = useStore((s) => s.updateSettings);
  const enabled = settings?.enabled ?? false;
  const connection = settings?.connection ?? "lan";
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();
  const [checking, setChecking] = useState(false);
  useEffect(() => { setStatus(undefined); }, [connection, enabled]);
  return (
    <>
      <div className="setting-row setting-row-divided">
        <div className="setting-text">
          <div className="setting-label">Local dictation</div>
          <p className="setting-desc">Use your server's Whisper instead of browser speech recognition. Tap the mic to record, then tap again to transcribe. Audio stays on your private server. Up to two minutes per recording.</p>
        </div>
        <Toggle label="Local dictation" checked={enabled} onChange={(enabled) => update({ dictation: { enabled, connection } })} />
      </div>
      {enabled && (
        <div className="setting-row setting-row-stack setting-row-top">
          <div className="setting-text">
            <div className="setting-label">Whisper connection</div>
            <p className="setting-desc">Which Whisper address the server talks to: LAN when you're on the same network, Tailscale when you're away. This is the server's route to Whisper, not your browser's route to OpenBuild.</p>
            {status && (
              <p className={cx("setting-desc", "setting-status", status.ok ? "setting-status-ok" : "setting-status-bad")} role="status">
                {status.text}
              </p>
            )}
          </div>
          <div className="setting-control">
            <div className="segmented" role="radiogroup" aria-label="Whisper connection">
              {(["lan", "tailscale"] as const).map((value) => (
                <button type="button" key={value} className="segment" role="radio" aria-checked={connection === value}
                  disabled={checking} onClick={() => update({ dictation: { enabled, connection: value } })}>
                  {value === "lan" ? "LAN" : "Tailscale"}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-sm"
              disabled={checking}
              onClick={async () => {
                setChecking(true);
                setStatus(undefined);
                try {
                  await whisperRequest("check", connection);
                  setStatus({ ok: true, text: "Whisper is ready." });
                } catch (error) {
                  setStatus({ ok: false, text: error instanceof Error ? error.message : "Connection failed." });
                } finally {
                  setChecking(false);
                }
              }}
            >
              {checking ? "Checking…" : "Test connection"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
