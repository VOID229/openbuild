import { ChevronRight, FolderOpen, Puzzle, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PluginInfo } from "../../shared/plugins";
import { openSettingsPage, settingsUp } from "../lib/pages";
import { usePlugins } from "../lib/plugins";
import { useStore } from "../lib/store";
import { cx } from "../lib/ui";
import { SettingsHeading as Heading, Toggle } from "./primitives";
import { SettingRow, SettingsGroup, SubPage } from "./SettingsUI";

// "Don't ask again" is a browser preference: deleting is local to this device, like the UI itself.
const SKIP_DELETE_CONFIRM = "openbuild.plugins.skipDeleteConfirm";

function skipDeleteConfirm(): boolean {
  try {
    return localStorage.getItem(SKIP_DELETE_CONFIRM) === "1";
  } catch {
    return false;
  }
}

function rememberSkipDeleteConfirm(skip: boolean) {
  try {
    if (skip) localStorage.setItem(SKIP_DELETE_CONFIRM, "1");
    else localStorage.removeItem(SKIP_DELETE_CONFIRM);
  } catch {}
}

function DeletePluginDialog({ plugin, busy, onCancel, onConfirm }: { plugin: PluginInfo; busy: boolean; onCancel: () => void; onConfirm: (skipNextTime: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [skipNextTime, setSkipNextTime] = useState(skipDeleteConfirm);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-labelledby="plugin-delete-title"
      aria-describedby="plugin-delete-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="plugin-delete-title">Delete “{plugin.name}”?</h2>
      <p id="plugin-delete-description">
        This permanently deletes the plugin’s folder and files. It can’t be undone.
      </p>
      <label className="confirm-skip">
        <input type="checkbox" checked={skipNextTime} onChange={(event) => setSkipNextTime(event.target.checked)} />
        Don't ask again
      </label>
      <div className="confirm-actions">
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy} autoFocus>
          Cancel
        </button>
        <button type="button" className="btn btn-sm btn-danger" onClick={() => onConfirm(skipNextTime)} disabled={busy}>
          <Trash2 size={14} />
          {busy ? "Deleting…" : "Delete plugin"}
        </button>
      </div>
    </dialog>
  );
}

/**
 * Settings → Plugins. Lists every folder the server found (including broken ones), lets each be
 * turned off without deleting it, and reloads after edits; each plugin's page has its details and
 * Delete. Client modules, styles, manifests and server modules all hot-reload; only changes to
 * OpenBuild's own app code need a restart.
 */
export function PluginsSection() {
  const info = usePlugins((s) => s.info);
  const error = usePlugins((s) => s.error);
  const loading = usePlugins((s) => s.loading);
  const runtimeErrors = usePlugins((s) => s.errors);
  const reload = usePlugins((s) => s.reload);
  const setSystemEnabled = usePlugins((s) => s.setSystemEnabled);
  const setEnabled = usePlugins((s) => s.setEnabled);
  const remove = usePlugins((s) => s.remove);
  const page = useStore((s) => s.settingsPage);
  const [pendingDelete, setPendingDelete] = useState<PluginInfo>();
  const [deleting, setDeleting] = useState(false);
  const disabled = new Set(info?.disabled ?? []);
  const systemEnabled = !!info?.enabled && !info?.safe;

  const deletePlugin = async (plugin: PluginInfo, skipNextTime: boolean) => {
    if (deleting) return;
    setDeleting(true);
    const ok = await remove(plugin.id);
    setDeleting(false);
    rememberSkipDeleteConfirm(skipNextTime);
    if (ok) {
      setPendingDelete(undefined);
      if (useStore.getState().settingsPage) settingsUp();
    }
    // A failure (or the error banner) still leaves a way to retry.
    else setPendingDelete(plugin);
  };

  const requestDelete = (plugin: PluginInfo) => {
    // Delete immediately when the confirmation was turned off earlier.
    if (skipDeleteConfirm()) void deletePlugin(plugin, true);
    else setPendingDelete(plugin);
  };

  const dialog = pendingDelete && (
    <DeletePluginDialog
      plugin={pendingDelete}
      busy={deleting}
      onCancel={() => setPendingDelete(undefined)}
      onConfirm={(skip) => void deletePlugin(pendingDelete, skip)}
    />
  );
  const toggle = (plugin: PluginInfo, problem?: string) => (
    <Toggle
      checked={!disabled.has(plugin.id)}
      disabled={!systemEnabled || !!problem}
      onChange={(next) => void setEnabled(plugin.id, next)}
      label={`Enable ${plugin.name}`}
    />
  );

  // A plugin's page: settings/plugins/plugin/<id>.
  const openId = page?.startsWith("plugin/") ? decodeURIComponent(page.slice("plugin/".length)) : undefined;
  if (openId) {
    const plugin = info?.plugins.find((p) => p.id === openId);
    const problem = plugin && (plugin.error ?? runtimeErrors[plugin.id]);
    return (
      <SubPage title={plugin?.name ?? openId} trail={["Plugins"]}>
        {!plugin ? (
          info && <p className="pi-empty">This plugin isn't installed anymore.</p>
        ) : (
          <>
            <div className="plugin-title plugin-page-meta">
              <span className="plugin-version">v{plugin.version}</span>
              {plugin.client && <span className="plugin-badge">UI</span>}
              {plugin.server && <span className="plugin-badge">server</span>}
              <code className="plugin-id">{plugin.id}</code>
            </div>
            {plugin.description && <p className="plugin-description">{plugin.description}</p>}
            {problem && (
              <div className="plugin-error">
                <TriangleAlert size={13} />
                <span>{problem}</span>
              </div>
            )}
            <SettingRow label="Enabled" desc={!systemEnabled ? "Plugins are off." : undefined}>
              {toggle(plugin, problem)}
            </SettingRow>
            {!!plugin.slots.length && (
              <SettingRow label="Slots" hint="Where in OpenBuild's interface it draws.">
                <div className="plugin-slots">
                  {plugin.slots.map((slot) => (
                    <code key={slot}>{slot}</code>
                  ))}
                </div>
              </SettingRow>
            )}
            <div className="setting-row bots-set-danger">
              <div className="setting-text">
                <div className="setting-label">Delete plugin</div>
                <p className="setting-desc">Removes its folder from the plugins folder.</p>
              </div>
              <button type="button" className="btn btn-sm btn-danger" disabled={deleting} onClick={() => requestDelete(plugin)}>
                <Trash2 size={14} /> Delete
              </button>
            </div>
          </>
        )}
        {dialog}
      </SubPage>
    );
  }

  return (
    <>
      <Heading>Plugins</Heading>
      <SettingRow label="Enable plugins" desc={systemEnabled ? "Only the plugins switched on below load." : "Off. Nothing from the plugins folder loads."}>
        <Toggle checked={systemEnabled} disabled={!info || !!info.safe} onChange={(next) => void setSystemEnabled(next)} label="Enable plugins" />
      </SettingRow>

      {info?.safe && (
        <div className="plugin-notice">
          <TriangleAlert size={15} />
          <span>Safe mode is on, so no plugins load. Restart without it to use them.</span>
        </div>
      )}
      {error && (
        <div className="plugin-notice plugin-notice-error">
          <TriangleAlert size={15} />
          <span>{error}</span>
        </div>
      )}

      <SettingsGroup
        title="Installed"
        action={
          <button type="button" className="btn btn-sm" onClick={() => void reload()} disabled={loading}>
            <RefreshCw size={14} className={loading ? "spin" : undefined} />
            {loading ? "Reloading…" : "Reload"}
          </button>
        }
      >
        <ul className="pi-list">
          {(info?.plugins ?? []).map((plugin) => {
            const problem = plugin.error ?? runtimeErrors[plugin.id];
            const active = systemEnabled && !disabled.has(plugin.id) && !problem;
            return (
              <li className={cx("pi-row plugin-row", !active && "pi-row-off")} key={plugin.id}>
                <button type="button" className="device-link" onClick={() => openSettingsPage(`plugin/${encodeURIComponent(plugin.id)}`)}>
                  <span className="plugin-mark" aria-hidden>
                    {problem ? <TriangleAlert size={16} className="bad" /> : <Puzzle size={16} />}
                  </span>
                  <span className="pi-row-text">
                    <span className="pi-row-name">
                      {plugin.name}
                      <span className="plugin-version">v{plugin.version}</span>
                    </span>
                    {(problem || plugin.description) && <span className={cx("pi-row-desc", problem && "bad")}>{problem ?? plugin.description}</span>}
                  </span>
                </button>
                {toggle(plugin, problem)}
                <ChevronRight size={16} className="nav-row-chevron" aria-hidden />
              </li>
            );
          })}
          {!info?.plugins.length && !loading && <li className="pi-empty">No plugins installed.</li>}
        </ul>
        {info && (
          <p className="field-help plugin-dir" title={info.dir}>
            <FolderOpen size={13} aria-hidden /> <code>{info.dir}</code>
          </p>
        )}
      </SettingsGroup>
      {dialog}
    </>
  );
}
