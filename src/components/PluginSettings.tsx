import { FolderOpen, Puzzle, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PluginInfo } from "../../shared/plugins";
import { usePlugins } from "../lib/plugins";
import { IconButton, SettingsHeading as Heading, Toggle } from "./primitives";

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
      className="plugin-confirm-dialog"
      aria-labelledby="plugin-delete-title"
      aria-describedby="plugin-delete-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="plugin-delete-title">Delete “{plugin.name}”?</h2>
      <p id="plugin-delete-description">
        This permanently removes the <code>{plugin.id}</code> folder from <code>plugins/</code>, including its manifest, client and
        server files. It can't be undone from OpenBuild.
      </p>
      <label className="plugin-confirm-skip">
        <input type="checkbox" checked={skipNextTime} onChange={(event) => setSkipNextTime(event.target.checked)} />
        Don't ask again
      </label>
      <div className="plugin-confirm-actions">
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
 * turned off without deleting it, and reloads after edits. Client modules, styles, manifests and
 * server modules all hot-reload; only changes to OpenBuild's own app code need a restart.
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
    if (ok) setPendingDelete(undefined);
    // A failure (or the error banner) still leaves a way to retry.
    else setPendingDelete(plugin);
  };

  const requestDelete = (plugin: PluginInfo) => {
    // Delete immediately when the confirmation was turned off earlier.
    if (skipDeleteConfirm()) void deletePlugin(plugin, true);
    else setPendingDelete(plugin);
  };

  return (
    <>
      <Heading>Plugins</Heading>
      <p className="settings-hint">
        Add a folder with a <code>plugin.json</code> to extend OpenBuild's UI or server without changing its source.
        A plugin can fill slots (composer, sidebar, messages, settings), add a settings page, render custom tool rows,
        restyle the app, or add authenticated <code>/api/plugins/&lt;id&gt;/…</code> routes.
      </p>

      <div className={`plugin-master${systemEnabled ? " plugin-master-on" : ""}`}>
        <div className="plugin-master-copy">
          <div className="plugin-master-title">Enable plugins</div>
          <p className="plugin-master-hint">
            {systemEnabled
              ? "Plugins are on. Only the plugins enabled below load."
              : "Plugins are off. Nothing from the plugin folder loads — no UI slots, styles, server routes or hooks. This is the default."}
          </p>
        </div>
        <Toggle
          checked={systemEnabled}
          disabled={!info || !!info.safe}
          onChange={(next) => void setSystemEnabled(next)}
          label="Enable plugins"
        />
      </div>

      {info?.safe && (
        <div className="plugin-notice">
          <TriangleAlert size={15} />
          <span>Safe mode is on (<code>OPENBUILD_SAFE=1</code> or <code>?safe</code>). No plugins load. Restart without it to use them.</span>
        </div>
      )}
      {error && (
        <div className="plugin-notice plugin-notice-error">
          <TriangleAlert size={15} />
          <span>{error}</span>
        </div>
      )}

      {!info?.plugins.length && !loading && (
        <p className="settings-hint">
          No plugins yet. Create <code>{info ? `${info.dir}/my-plugin/plugin.json` : "plugins/my-plugin/plugin.json"}</code> — see{" "}
          <code>plugins/daily-note</code> for an example with a button, a server route and styles.
        </p>
      )}

      <div className="plugin-list">
        {(info?.plugins ?? []).map((plugin) => {
          const problem = plugin.error ?? runtimeErrors[plugin.id];
          const enabled = !disabled.has(plugin.id);
          const active = systemEnabled && enabled && !problem;
          return (
            <div className={`plugin-row${active ? "" : " plugin-row-off"}`} key={plugin.id}>
              <div className="plugin-mark" aria-hidden>
                <Puzzle size={17} />
              </div>
              <div className="plugin-body">
                <div className="plugin-title">
                  <span className="plugin-name">{plugin.name}</span>
                  <span className="plugin-version">v{plugin.version}</span>
                  {plugin.client && <span className="plugin-badge">UI</span>}
                  {plugin.server && <span className="plugin-badge">server</span>}
                </div>
                <div className="plugin-id">{plugin.id}</div>
                {plugin.description && <p className="plugin-description">{plugin.description}</p>}
                {!!plugin.slots.length && (
                  <div className="plugin-slots">
                    {plugin.slots.map((slot) => (
                      <code key={slot}>{slot}</code>
                    ))}
                  </div>
                )}
                {problem && (
                  <div className="plugin-error">
                    <TriangleAlert size={13} />
                    <span>{problem}</span>
                  </div>
                )}
              </div>
              <div className="plugin-actions">
                <Toggle
                  checked={enabled}
                  disabled={!systemEnabled || !!problem}
                  onChange={(next) => void setEnabled(plugin.id, next)}
                  label={`Enable ${plugin.name}`}
                />
                <IconButton
                  label={`Delete ${plugin.name}`}
                  tooltip="Delete plugin"
                  tooltipSide="left"
                  className="plugin-delete"
                  disabled={deleting}
                  onClick={() => requestDelete(plugin)}
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
            </div>
          );
        })}
      </div>

      {pendingDelete && (
        <DeletePluginDialog
          plugin={pendingDelete}
          busy={deleting}
          onCancel={() => setPendingDelete(undefined)}
          onConfirm={(skip) => void deletePlugin(pendingDelete, skip)}
        />
      )}

      <div className="plugin-footer">
        <button type="button" className="btn btn-sm" onClick={() => void reload()} disabled={loading}>
          <RefreshCw size={14} className={loading ? "spin" : undefined} />
          {loading ? "Reloading…" : "Reload plugins"}
        </button>
        {info && (
          <span className="plugin-dir" title={info.dir}>
            <FolderOpen size={14} />
            <code>{info.dir}</code>
          </span>
        )}
      </div>

    </>
  );
}
