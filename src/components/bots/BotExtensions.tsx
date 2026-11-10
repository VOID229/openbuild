// Settings → Bots → Custom extensions: bots run on what OpenBots ships, and the user can also load
// their own Pi extensions and packages, one at a time. Off until they say otherwise, each of them too.
import { CircleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { unavailableModels, type BotExtension } from "../../../shared/bots";
import { useBotModels } from "../../lib/bots/models";
import { useBots } from "../../lib/bots/store";
import { botModels } from "../../lib/pi";
import { Spinner, Toggle } from "../primitives";

/** Bots set to a model the extensions loaded now don't provide (one that was switched off), so they don't just fail later. */
function useMissingModels() {
  const { listing } = useBotModels();
  const bots = useBots((s) => s.bots);
  const defaultModel = useBots((s) => s.defaultModel);
  const defaultFallbackModels = useBots((s) => s.defaultFallbackModels);
  return useMemo(() => (listing ? unavailableModels(bots, { defaultModel, defaultFallbackModels }, new Set(listing.models.map((m) => m.id))) : []), [listing, bots, defaultModel, defaultFallbackModels]);
}

/** What Settings → Bots says custom extensions are set to: models left unavailable, off, or how many are loaded. */
export function useExtensionsSummary() {
  const custom = useBots((s) => s.customExtensions);
  const missing = useMissingModels();
  if (missing.length) return `${missing.length} ${missing.length === 1 ? "model" : "models"} unavailable`;
  return !custom.enabled ? "Off" : custom.ids.length ? `${custom.ids.length} loaded` : "None picked";
}

/** Settings → Bots → Custom extensions: extensions from your own Pi that bots load too. */
export function BotExtensions() {
  const custom = useBots((s) => s.customExtensions);
  const [list, setList] = useState<BotExtension[]>();
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const missing = useMissingModels();

  useEffect(() => {
    if (!custom.enabled) return;
    let live = true;
    void fetch("/api/bots/extensions")
      .then((res) => res.json())
      .then((r: { extensions: BotExtension[] }) => live && setList(r.extensions))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [custom.enabled]);

  /** Save, then start Pi the way bots will, so a clash shows here rather than in a chat later. */
  const apply = async (next: typeof custom) => {
    setProblem(undefined);
    setChecking(true);
    try {
      await useBots.getState().setCustomExtensions(next);
      await botModels(true);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const toggle = (id: string, on: boolean) => void apply({ ...custom, ids: on ? [...custom.ids, id] : custom.ids.filter((x) => x !== id) });

  return (
    <>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Load my Pi extensions too</div>
          <p className="setting-desc">Including ones that provide models.</p>
        </div>
        <Toggle checked={custom.enabled} label="Load my Pi extensions too" onChange={(enabled) => void apply({ ...custom, enabled })} />
      </div>
      {!checking && missing.length > 0 && (
            <p className="field-help key-status key-status-bad" role="alert">
              <CircleAlert size={13} className="bad" /> Bots can't use {missing.map((m) => `${m.model} (${m.usedBy.join(", ")})`).join("; ")} with the extensions loaded now, so they fall back or can't reply until that changes.
            </p>
          )}
          {custom.enabled && (
            <>
              <p className="field-help keys-help">Not every extension is made for bots. They run on this server, outside bots' containers.</p>
              {checking && (
                <p className="field-help key-status" role="status">
                  <Spinner size={12} /> Checking these work together
                </p>
              )}
              {problem && (
                <p className="field-help key-status key-status-bad" role="alert">
                  <CircleAlert size={13} className="bad" /> {problem}
                </p>
              )}
              {list?.map((e) => (
                <div key={e.id} className="setting-row">
                  <div className="setting-text">
                    <div className="setting-label">
                      {e.name} {e.kind === "package" && <span className="badge">package</span>}
                    </div>
                    {e.description && <p className="setting-desc">{e.description}</p>}
                  </div>
                  <Toggle checked={custom.ids.includes(e.id)} label={`Load ${e.name}`} onChange={(on) => toggle(e.id, on)} />
                </div>
              ))}
              {list && !list.length && <p className="pi-empty">Your Pi has no extensions or packages installed.</p>}
            </>
          )}
    </>
  );
}
