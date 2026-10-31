// Settings → Runtimes → Add runtime: another login of a runtime on one device, in three steps.
// It saves the same account entry Providers & accounts lists; Claude's become model picker providers.
import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { RuntimeAccount } from "../../shared/types";
import { runtimeName } from "../lib/runtimes";
import { useStore } from "../lib/store";
import { cx, usePresence } from "../lib/ui";
import { accountCommand } from "./RuntimeAccounts";
import { RuntimeIcon } from "./Workspace";

type AccountRuntime = RuntimeAccount["runtime"];
const CHOICES: AccountRuntime[] = ["claude", "codex", "cursor"];
const STEPS = ["Runtime", "Identity", "Config"];
const VARIABLES = { codex: "CODEX_HOME", claude: "CLAUDE_CONFIG_DIR", cursor: "CURSOR_CONFIG_DIR" };

/** The first free `claude2`, `claude3`, … on this device. */
export function nextAccountName(runtime: AccountRuntime, taken: string[]): string {
  const names = new Set(taken.map((n) => n.toLowerCase()));
  let n = 2;
  while (names.has(`${runtime}${n}`)) n++;
  return `${runtime}${n}`;
}

export function AddRuntime({ open, deviceId, where, onClose }: { open: boolean; deviceId?: string; where: string; onClose: () => void }) {
  const { mounted, visible } = usePresence(open);
  const accounts = useStore((s) => s.settings.runtimeAccounts) ?? [];
  const detected = useStore((s) => s.claudeModels[deviceId ?? ""]?.accounts);
  const update = useStore((s) => s.updateSettings);
  const reload = useStore((s) => s.loadClaudeModels);
  const [step, setStep] = useState(0);
  const [runtime, setRuntime] = useState<AccountRuntime>("claude");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState("");

  const taken = (r: AccountRuntime) => [
    ...accounts.filter((a) => a.runtime === r && (a.deviceId ?? "") === (deviceId ?? "")).map((a) => a.name),
    ...(r === "claude" ? (detected ?? []).map((a) => a.account.name) : []),
  ];
  useEffect(() => {
    if (!open) return;
    setStep(0); setError("");
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
  const next = () => {
    if (step === 0) {
      const suggested = nextAccountName(runtime, taken(runtime));
      setName(suggested);
      setPath(`~/.${suggested.replace(/(\d+)$/, "-$1")}`);
    }
    if (step === 1 && !name.trim()) { setError("Enter a label."); return; }
    if (step === 1 && (name.trim().toLowerCase() === runtime || taken(runtime).some((n) => n.toLowerCase() === name.trim().toLowerCase()))) { setError("This label is already in use."); return; }
    setError(""); setStep(step + 1);
  };
  const add = () => {
    const configDir = path.trim();
    if (!/^(\/|~\/|[A-Za-z]:[\\/])/.test(configDir)) { setError("Enter an absolute directory, or one starting with ~/."); return; }
    if (accounts.some((a) => a.runtime === runtime && (a.deviceId ?? "") === (deviceId ?? "") && a.configDir === configDir)) { setError("This directory is already listed."); return; }
    update({ runtimeAccounts: [...accounts, { id: crypto.randomUUID(), runtime, name: name.trim(), configDir, deviceId }] });
    if (runtime === "claude") void reload(deviceId, true);
    onClose();
  };
  if (!mounted) return null;
  const draft: RuntimeAccount = { id: "", name, runtime, configDir: path.trim() };
  return createPortal(
    <div className="modal-root ar-root" data-state={visible ? "open" : "closed"}>
      <div className="modal-backdrop" onClick={onClose} aria-hidden />
      <div className="modal ar" role="dialog" aria-modal="true" aria-labelledby="ar-title">
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}><X size={16} /></button>
        <header className="ar-head">
          <h2 id="ar-title">Add runtime</h2>
          <p>Add another account for a runtime on {where}.</p>
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
              <span><b>Label</b><small>{runtime === "claude" ? "Shown in the model picker’s provider list." : "Shown in the account picker for new threads."}</small></span>
              <input className="input" aria-label="Label" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          {step === 2 && (
            <>
              <label className="ar-field">
                <span><b>{VARIABLES[runtime]} path</b><small>Keeps this account’s sign-in and history separate.</small></span>
                <input className="input" aria-label={`${VARIABLES[runtime]} path`} autoFocus spellCheck={false} value={path} onChange={(e) => setPath(e.target.value)} />
              </label>
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
          <button type="button" className="btn btn-primary" onClick={step < 2 ? next : add}>{step < 2 ? "Next" : "Add runtime"}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
