import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import { cx } from "../lib/ui";
import { whisperRequest } from "../lib/whisper";
import { Toggle } from "./primitives";
import { SettingRow } from "./SettingsUI";

/** Settings → General → Dictation: the browser's speech recognition, or the server's Whisper. */
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
      <SettingRow label="Local dictation" desc="Transcribe with your server’s Whisper." hint="Instead of the browser’s speech recognition. Up to two minutes per recording.">
        <Toggle label="Local dictation" checked={enabled} onChange={(enabled) => update({ dictation: { enabled, connection } })} />
      </SettingRow>
      {enabled && (
        <div className="setting-row">
          <div className="setting-text">
            <div className="setting-label">Whisper connection</div>
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
              {checking ? "Checking…" : "Test"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
