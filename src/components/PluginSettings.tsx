import { FolderOpen, Puzzle, RefreshCw, TriangleAlert } from "lucide-react";
import { usePlugins } from "../lib/plugins";
import { SettingsHeading as Heading, Toggle } from "./primitives";

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
  const disabled = new Set(info?.disabled ?? []);
  const systemEnabled = !!info?.enabled && !info?.safe;

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
              <Toggle
                checked={enabled}
                disabled={!systemEnabled || !!problem}
                onChange={(next) => void setEnabled(plugin.id, next)}
                label={`Enable ${plugin.name}`}
              />
            </div>
          );
        })}
      </div>

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

      <p className="settings-hint">
        Edits to <code>client.tsx</code>, <code>styles.css</code>, <code>server.ts</code> and <code>plugin.json</code> reload automatically,
        including new plugin folders. The master switch and plugin toggles apply immediately. Changes to OpenBuild's own code still need a restart.
      </p>
    </>
  );
}
