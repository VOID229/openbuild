import { FolderOpen, Puzzle, RefreshCw, TriangleAlert } from "lucide-react";
import { usePlugins } from "../lib/plugins";
import { SettingsHeading as Heading, Toggle } from "./primitives";

/**
 * Settings → Plugins. Lists every folder the server found (including broken ones), lets each be
 * turned off without deleting it, and reloads after edits. Changes to client.tsx and styles.css
 * apply to open browsers immediately; server.ts is loaded at startup.
 */
export function PluginsSection() {
  const info = usePlugins((s) => s.info);
  const error = usePlugins((s) => s.error);
  const loading = usePlugins((s) => s.loading);
  const runtimeErrors = usePlugins((s) => s.errors);
  const reload = usePlugins((s) => s.reload);
  const setEnabled = usePlugins((s) => s.setEnabled);
  const disabled = new Set(info?.disabled ?? []);

  return (
    <>
      <Heading>Plugins</Heading>
      <p className="settings-hint">
        Add a folder with a <code>plugin.json</code> to extend OpenBuild's UI or server without changing its source.
        A plugin can fill slots (composer, sidebar, messages, settings), add a settings page, render custom tool rows,
        restyle the app, or add authenticated <code>/api/plugins/&lt;id&gt;/…</code> routes.
      </p>

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
          return (
            <div className={`plugin-row${enabled && !problem ? "" : " plugin-row-off"}`} key={plugin.id}>
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
              <Toggle checked={enabled && !info?.safe} onChange={(next) => void setEnabled(plugin.id, next)} label={`Enable ${plugin.name}`} />
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
        Edits to <code>client.tsx</code>, <code>styles.css</code> and <code>plugin.json</code> reload automatically while a browser is open.
        Changes to <code>server.ts</code> and toggling a server plugin take effect after restarting OpenBuild.
      </p>
    </>
  );
}
