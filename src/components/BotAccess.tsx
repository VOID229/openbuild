// Settings → Devices → Using this device: what a paired server's bots may do on this machine.
// Pairing grants none of it. Each is switched on here, on the machine it concerns, and the server
// checks it on every request (server/computers/api.ts).
import { CircleAlert } from "lucide-react";
import { useState } from "react";
import type { BotToolGrants, PairedClient } from "../../shared/types";
import { setPairedClientBotTools } from "../lib/pi";
import { Spinner, Toggle } from "./primitives";

export const NO_GRANTS: BotToolGrants = { files: false, terminal: false, browser: false, unisolated: false };

export const GRANT_ROWS: { key: keyof BotToolGrants; label: string; desc: string }[] = [
  { key: "files", label: "Files", desc: "Read and write files in their computer here." },
  { key: "terminal", label: "Terminal", desc: "Run commands, which can also change files and start programs." },
  { key: "browser", label: "Browser", desc: "Open and drive a browser here." },
  { key: "unisolated", label: "Unisolated", desc: "Run as you, outside a container. They can reach everything you can." },
];

export function BotAccess({ client }: { client: PairedClient }) {
  const [grants, setGrants] = useState<BotToolGrants>(client.botTools ?? NO_GRANTS);
  const [busy, setBusy] = useState<keyof BotToolGrants>();
  const [error, setError] = useState<string>();

  const change = async (key: keyof BotToolGrants, value: boolean) => {
    if (key === "unisolated" && value && !confirm(`Let bots from ${client.name} run outside a container on this device? They could read and change anything your user can.`)) return;
    setBusy(key);
    setError(undefined);
    try {
      setGrants((await setPairedClientBotTools(client.id, { [key]: value })).botTools);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="bot-access" role="group" aria-label={`What bots from ${client.name} may use on this device`}>
      <span className="bot-access-title">Bots from {client.name} may use this device's</span>
      <span className="pi-row-desc">These pick tools; they aren't a sandbox. Only a container isolates bots from this device.</span>
      {GRANT_ROWS.map((row) => (
        <div key={row.key} className="bot-access-row">
          <div className="pi-row-text">
            <span className="pi-row-name">{row.label}</span>
            <span className="pi-row-desc">{row.desc}</span>
          </div>
          {busy === row.key ? <Spinner size={14} /> : null}
          <Toggle label={`${row.label} for bots from ${client.name}`} checked={grants[row.key]} disabled={!!busy} onChange={(v) => void change(row.key, v)} />
        </div>
      ))}
      {error && (
        <span className="pi-error device-error" role="alert">
          <CircleAlert size={13} /> {error}
        </span>
      )}
    </div>
  );
}
