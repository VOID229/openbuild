import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import { whisperRequest } from "../lib/whisper";
import { Toggle } from "./primitives";

export function DictationSettings() {
  const settings = useStore((s) => s.settings.dictation);
  const update = useStore((s) => s.updateSettings);
  const enabled = settings?.enabled ?? false;
  const connection = settings?.connection ?? "lan";
  const [status, setStatus] = useState("");
  const [checking, setChecking] = useState(false);
  useEffect(() => { setStatus(""); }, [connection, enabled]);
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
        <div className="setting-row setting-row-stack">
          <div className="setting-label">Whisper connection</div>
          <div className="segmented" role="radiogroup" aria-label="Whisper connection">
            {(["lan", "tailscale"] as const).map((value) => (
              <button type="button" key={value} className="segment" role="radio" aria-checked={connection === value}
                disabled={checking} onClick={() => update({ dictation: { enabled, connection: value } })}>
                {value === "lan" ? "LAN" : "Tailscale"}
              </button>
            ))}
          </div>
          <p className="setting-desc">This selects how the OpenBuild server reaches Whisper—not how your browser connects to OpenBuild. Microphone access requires HTTPS or localhost.</p>
          <button type="button" className="link-btn" disabled={checking} onClick={async () => {
            setChecking(true);
            setStatus("");
            try { await whisperRequest("check", connection); setStatus("Whisper is ready."); }
            catch (error) { setStatus(error instanceof Error ? error.message : "Connection failed."); }
            finally { setChecking(false); }
          }}>{checking ? "Checking…" : "Test connection"}</button>
          <p className="setting-desc" role="status">{status}</p>
        </div>
      )}
    </>
  );
}
