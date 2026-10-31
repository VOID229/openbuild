import { useState } from "react";
import type { RuntimeAccount, ThreadRuntime } from "../../shared/types";
import { useStore, threadDevice } from "../lib/store";
import { OptionSelect } from "./ModelSelect";

const variables = { codex: "CODEX_HOME", claude: "CLAUDE_CONFIG_DIR", cursor: "CURSOR_CONFIG_DIR" };
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export function accountCommand(a: RuntimeAccount): string {
  const shell = (p: string) => p.startsWith("~/") ? '"$HOME"/' + quote(p.slice(2)) : quote(p);
  const bin = a.binPath?.trim();
  const program = bin ? (bin.includes("/") ? shell(bin) : quote(bin)) : a.runtime === "cursor" ? "cursor-agent" : a.runtime;
  const command = a.runtime === "claude" ? `${program} auth login` : a.runtime === "cursor" ? `${program} login` : `${program} -c 'cli_auth_credentials_store="file"' login`;
  return `${variables[a.runtime]}=${shell(a.shadowHome ?? a.configDir)} ${command}`;
}
export function ThreadAccountSelect() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const device = useStore((s) => threadDevice(s));
  const accounts = (settings.runtimeAccounts ?? []).filter((a) => a.runtime === settings.threadRuntime && (a.deviceId ?? "") === (device ?? ""));
  // Claude's accounts are providers in the model picker.
  if (!accounts.length || settings.threadRuntime === "claude") return null;
  return <OptionSelect label="Account for new thread" value={accounts.some((a) => a.id === settings.threadAccountId) ? settings.threadAccountId! : ""} options={[{ value: "", label: "Default account" }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]} onChange={(threadAccountId) => update({ threadAccountId })} />;
}
export function RuntimeAccounts({ runtime, deviceId }: { runtime: ThreadRuntime; deviceId?: string }) {
  const savedAccounts = useStore((s) => s.settings.runtimeAccounts);
  const accounts = savedAccounts ?? [];
  const update = useStore((s) => s.updateSettings);
  const claudeLists = useStore((s) => s.claudeModels);
  const reload = useStore((s) => s.loadClaudeModels);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  if (runtime !== "codex" && runtime !== "claude" && runtime !== "cursor") return null;
  const rows = accounts.filter((a) => a.runtime === runtime && (a.deviceId ?? "") === (deviceId ?? ""));
  const detected = runtime === "claude" ? (claudeLists[deviceId ?? ""]?.accounts ?? []).map((a) => a.account).filter((a) => !rows.some((b) => b.name === a.name)) : [];
  return <section className="pi-block">
    <h3 className="settings-subheading">Accounts</h3>
    <p className="pi-meta">The default account uses this device’s existing configuration. Add separate configuration directories for other accounts, then select one before starting a thread.</p>
    <ul className="pi-list">{rows.map((a) => <li className="pi-row" key={a.id}>
      <div className="pi-row-text"><span className="pi-row-name">{a.name}</span><span className="pi-row-desc">{variables[runtime]}={a.configDir}</span><code style={{ overflowWrap: "anywhere" }}>{accountCommand(a)}</code></div>
      <button className="btn btn-sm" onClick={() => { update({ runtimeAccounts: accounts.filter((b) => b.id !== a.id) }); if (runtime === "claude") void reload(deviceId, true); }}>Remove</button>
    </li>)}{detected.map((a) => <li className="pi-row" key={a.id}>
      <div className="pi-row-text"><span className="pi-row-name">{a.name}</span><span className="pi-row-desc">Detected · {variables[runtime]}={a.configDir}</span></div>
    </li>)}</ul>
    <p className="pi-meta">Run the login command in a terminal on the selected device. Removing an entry keeps its files and existing threads.</p>
    <form className="pi-block" onSubmit={(e) => {
      e.preventDefault();
      if (!name.trim() || !/^(\/|~\/|[A-Za-z]:[\\/])/.test(path.trim())) { setError("Enter an account name and an absolute configuration directory (or ~/path)."); return; }
      if (rows.some((a) => a.configDir === path.trim())) { setError("This configuration directory is already listed."); return; }
      update({ runtimeAccounts: [...accounts, { id: crypto.randomUUID(), runtime, name: name.trim(), configDir: path.trim(), deviceId }] });
      if (runtime === "claude") void reload(deviceId, true);
      setName(""); setPath(""); setError("");
    }}>
      <label className="pi-meta">Account name<input className="input" aria-label="Account name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Work" /></label>
      <label className="pi-meta">Configuration directory<input className="input" aria-label="Account configuration directory" value={path} onChange={(e) => setPath(e.target.value)} placeholder={`~/.${runtime}-work`} /></label>
      {error && <p role="alert">{error}</p>}
      <button className="btn btn-sm" type="submit">Add account</button>
    </form>
  </section>;
}
