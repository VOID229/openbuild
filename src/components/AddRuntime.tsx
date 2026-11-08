// Settings → Runtimes → Add runtime: another login of a runtime on one device, in three steps.
// It saves a runtime account entry on that device; Claude's become model picker providers.
// Given a saved entry, the same steps edit it in place.
import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { RuntimeAccount } from "../../shared/types";
import { deviceList } from "../lib/devices";
import { runtimeName } from "../lib/runtimes";
import { useStore } from "../lib/store";
import { cx, usePresence } from "../lib/ui";
import { accountCommand } from "./RuntimeAccounts";
import { RuntimeIcon } from "./Workspace";

type AccountRuntime = RuntimeAccount["runtime"];
const CHOICES: AccountRuntime[] = ["claude", "codex", "cursor"];
const STEPS = ["Runtime", "Identity", "Config"];
const VARIABLES = { codex: "CODEX_HOME", claude: "CLAUDE_CONFIG_DIR", cursor: "CURSOR_CONFIG_DIR" };

function Field({ label, hint, value, onChange, placeholder, autoFocus }: { label: string; hint: string; value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  return (
    <label className="ar-field">
      <span><b>{label}</b><small>{hint}</small></span>
      <input className="input" aria-label={label} autoFocus={autoFocus} spellCheck={false} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** The first free `claude2`, `claude3`, … on this device. */
export function nextAccountName(runtime: AccountRuntime, taken: string[]): string {
  const names = new Set(taken.map((n) => n.toLowerCase()));
  let n = 2;
  while (names.has(`${runtime}${n}`)) n++;
  return `${runtime}${n}`;
}

/** Whether a saved entry belongs to the device: local ones may carry no id or this server's. */
export function accountOnDevice(a: RuntimeAccount, deviceId: string | undefined): boolean {
  if ((a.deviceId ?? "") === (deviceId ?? "")) return true;
  if (deviceId || !a.deviceId) return false;
  const local = deviceList().find((d) => d.local);
  return !!local && (a.deviceId === local.id || a.deviceId === local.serverId);
}

/** Why `account` can't be saved among `accounts` (an edit doesn't clash with itself), or "". */
export function accountProblem(account: RuntimeAccount, accounts: RuntimeAccount[], deviceId: string | undefined, detected: string[] = []): string {
  const others = accounts.filter((a) => a.id !== account.id && a.runtime === account.runtime && accountOnDevice(a, deviceId));
  const label = account.name.toLowerCase();
  if (label === account.runtime || [...others.map((a) => a.name), ...detected].some((n) => n.toLowerCase() === label)) return "This label is already in use.";
  if (!/^(\/|~\/|[A-Za-z]:[\\/])/.test(account.configDir)) return "Enter an absolute directory, or one starting with ~/.";
  if (account.shadowHome && !/^(\/|~\/|[A-Za-z]:[\\/])/.test(account.shadowHome)) return "Enter an absolute shadow home, or one starting with ~/.";
  if (others.some((a) => (a.shadowHome ?? a.configDir) === (account.shadowHome ?? account.configDir))) return "This directory is already listed.";
  const window = account.autoCompactWindow;
  if (window !== undefined && !(Number.isInteger(window) && window >= 100_000 && window <= 1_000_000)) return "Auto-compact must be between 100,000 and 1,000,000 tokens.";
  return "";
}

export function AddRuntime({ open, deviceId, where, account, onClose }: { open: boolean; deviceId?: string; where: string; account?: RuntimeAccount; onClose: () => void }) {
  const { mounted, visible } = usePresence(open);
  const accounts = useStore((s) => s.settings.runtimeAccounts) ?? [];
  const detected = useStore((s) => s.claudeModels[deviceId ?? ""]?.accounts);
  const update = useStore((s) => s.updateSettings);
  const reloadCodex = useStore((s) => s.loadCodexModels);
  const reload = useStore((s) => s.loadClaudeModels);
  const [step, setStep] = useState(0);
  const [runtime, setRuntime] = useState<AccountRuntime>("claude");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [binPath, setBinPath] = useState("");
  const [shadowHome, setShadowHome] = useState("");
  const [compact, setCompact] = useState("");
  const [launchArgs, setLaunchArgs] = useState("");
  // The runtime the fields were filled for: picking another one starts them over.
  const [filledFor, setFilledFor] = useState<AccountRuntime>();
  const options = {
    ...(binPath.trim() ? { binPath: binPath.trim() } : {}),
    ...(launchArgs.trim() ? { launchArgs: launchArgs.trim() } : {}),
    ...(runtime === "codex" && shadowHome.trim() ? { shadowHome: shadowHome.trim() } : {}),
    ...(runtime === "claude" && compact.trim() ? { autoCompactWindow: Number(compact.replaceAll(",", "")) } : {}),
  };

  const detectedNames = (r: AccountRuntime) => (r === "claude" ? (detected ?? []).map((a) => a.account.name).filter((n) => n.toLowerCase() !== account?.name.toLowerCase()) : []);
  const taken = (r: AccountRuntime) => [
    ...accounts.filter((a) => a.id !== account?.id && a.runtime === r && accountOnDevice(a, deviceId)).map((a) => a.name),
    ...detectedNames(r),
  ];
  useEffect(() => {
    if (!open) return;
    setStep(0); setError("");
    if (account) {
      setRuntime(account.runtime); setFilledFor(account.runtime);
      setName(account.name); setPath(account.configDir);
      setBinPath(account.binPath ?? ""); setShadowHome(account.shadowHome ?? "");
      setCompact(account.autoCompactWindow ? String(account.autoCompactWindow) : ""); setLaunchArgs(account.launchArgs ?? "");
    } else setFilledFor(undefined);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose, account]);
  // Empty fields use the example shown in them.
  const suggested = nextAccountName(runtime, taken(runtime));
  const label = name.trim() || suggested;
  const directory = path.trim() || `~/.${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(?<=[a-z])(\d+)$/, "-$1")}`;
  const next = () => {
    if (step === 0 && runtime !== filledFor) {
      setFilledFor(runtime);
      setName(account?.name ?? ""); setPath("");
      setBinPath(""); setShadowHome(""); setCompact(""); setLaunchArgs("");
    }
    if (step === 1 && (label.toLowerCase() === runtime || taken(runtime).some((n) => n.toLowerCase() === label.toLowerCase()))) { setError("This label is already in use."); return; }
    setError(""); setStep(step + 1);
  };
  const add = () => {
    // An edit keeps the entry's id and device, so threads and bots that use it follow it.
    const saved: RuntimeAccount = { id: account?.id ?? crypto.randomUUID(), runtime, name: label, configDir: directory, deviceId: account ? account.deviceId : deviceId, ...options };
    const problem = accountProblem(saved, accounts, deviceId, detectedNames(runtime));
    if (problem) { setError(problem); return; }
    update({ runtimeAccounts: account ? accounts.map((a) => (a.id === account.id ? saved : a)) : [...accounts, saved] });
    for (const r of new Set([runtime, account?.runtime])) {
      if (r === "claude") void reload(deviceId, true);
      if (r === "codex") void reloadCodex(deviceId, true);
    }
    onClose();
  };
  if (!mounted) return null;
  const draft: RuntimeAccount = { id: "", name: label, runtime, configDir: directory, ...options };
  return createPortal(
    <div className="modal-root ar-root" data-state={visible ? "open" : "closed"}>
      <div className="modal-backdrop" onClick={onClose} aria-hidden />
      <div className="modal ar" role="dialog" aria-modal="true" aria-labelledby="ar-title">
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}><X size={16} /></button>
        <header className="ar-head">
          <h2 id="ar-title">{account ? `Edit ${account.name}` : "Add runtime"}</h2>
          <p>{account ? `Change this account for a runtime on ${where}.` : `Add another account for a runtime on ${where}.`}</p>
          <ol className="ar-steps">
            {STEPS.map((label, i) => (
              <li key={label} className={cx(i === step && "ar-step-on")} aria-current={i === step ? "step" : undefined}>
                <span className={cx("ar-num", i < step && "ar-num-done")}>{i < step ? <Check size={12} /> : i + 1}</span>{label}
              </li>
            ))}
          </ol>
        </header>
        <div className="ar-body">
          {step === 0 && (
            <div className="ar-grid" role="radiogroup" aria-label="Runtime">
              {CHOICES.map((r) => (
                <button key={r} type="button" role="radio" aria-checked={runtime === r} className="ar-choice" onClick={() => setRuntime(r)}>
                  <RuntimeIcon runtime={r} size={18} />
                  <span>{runtimeName(r)}</span>
                  {runtime === r && <Check size={15} className="ar-check" />}
                </button>
              ))}
            </div>
          )}
          {step === 1 && (
            <label className="ar-field">
              <span><b>Label</b><small>{runtime === "claude" || runtime === "codex" ? "Shown in the model picker’s provider list." : "Shown in the account picker for new threads."}</small></span>
              <input className="input" aria-label="Label" autoFocus spellCheck={false} placeholder={suggested} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          {step === 2 && (
            <>
              <Field label="Binary path" hint={`The ${runtimeName(runtime)} program this account runs. Empty uses the device’s.`} placeholder={runtime === "cursor" ? "cursor-agent" : runtime} value={binPath} onChange={setBinPath} />
              <Field label={`${VARIABLES[runtime]} path`} hint={runtime === "codex" ? "Codex home and config directory." : "Keeps this account’s sign-in and history separate."} placeholder={directory} value={path} onChange={setPath} autoFocus />
              {runtime === "codex" && <Field label="Shadow home path" hint={`Optional. Keeps auth.json here while sharing everything else from ${VARIABLES.codex}.`} placeholder="~/.codex-shadow/personal" value={shadowHome} onChange={setShadowHome} />}
              {runtime === "claude" && <Field label="Auto-compact after" hint="Compact after 100,000 to 1,000,000 tokens. Leave empty to use Claude’s default." placeholder="e.g. 300000" value={compact} onChange={setCompact} />}
              <Field label="Launch arguments" hint={runtime === "codex" ? "Passed to codex app-server when it starts." : "Passed to the CLI when a session starts."} placeholder={runtime === "claude" ? "e.g. --chrome" : ""} value={launchArgs} onChange={setLaunchArgs} />
              <div className="ar-login">
                <small>Sign in by running this in a terminal on {where}:</small>
                <code>{accountCommand(draft)}</code>
              </div>
            </>
          )}
          {error && <p className="pi-error" role="alert">{error}</p>}
        </div>
        <footer className="ar-foot">
          {step > 0 && <button type="button" className="btn" onClick={() => { setError(""); setStep(step - 1); }}>Back</button>}
          <button type="button" className="btn btn-primary" onClick={step < 2 ? next : add}>{step < 2 ? "Next" : account ? "Save" : "Add runtime"}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
