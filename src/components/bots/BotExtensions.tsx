// Settings → Bots → Custom extensions: bots run on what OpenBots ships, and the user can also load
// their own Pi extensions and packages, one at a time. Off until they say otherwise, each of them too.
import { ChevronDown, CircleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { unavailableModels, type BotExtension } from "../../../shared/bots";
import { useBotModels } from "../../lib/bots/models";
import { useBots } from "../../lib/bots/store";
import { botModels } from "../../lib/pi";
import { cx } from "../../lib/ui";
import { Spinner, Toggle } from "../primitives";

export function BotExtensions() {
  const custom = useBots((s) => s.customExtensions);
  const [list, setList] = useState<BotExtension[]>();
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string>();
  // Collapsed by default, like Harnesses, and whether it's open has nothing to do with whether it's on.
  const [open, setOpen] = useState(false);
  // Bots set to a model these extensions don't provide (one that was switched off) are named, so they don't just fail later.
  const { listing } = useBotModels();
  const bots = useBots((s) => s.bots);
  const defaultModel = useBots((s) => s.defaultModel);
  const defaultFallbackModels = useBots((s) => s.defaultFallbackModels);
  const missing = useMemo(() => (listing ? unavailableModels(bots, { defaultModel, defaultFallbackModels }, new Set(listing.models.map((m) => m.id))) : []), [listing, bots, defaultModel, defaultFallbackModels]);

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
  const loaded = custom.ids.map((id) => list?.find((e) => e.id === id)?.name ?? id);
  const note = missing.length ? `${missing.length} ${missing.length === 1 ? "model" : "models"} unavailable` : !custom.enabled ? "Off" : loaded.length ? loaded.join(", ") : "None picked";

  return (
    <>
      <div className="pi-subhead">
        <button type="button" className="pi-subhead-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="pi-subhead-title">Custom extensions</span>
          <span className="pi-subhead-note">{note}</span>
          <ChevronDown size={15} className="pi-subhead-chevron" />
        </button>
      </div>
      <div className={cx("collapse", open && "collapse-open")} inert={!open}>
        <div className="collapse-inner">
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-label">Load my Pi extensions too</div>
              <p className="setting-desc">Add extensions from your own Pi, including ones that provide models.</p>
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
              <p className="field-help keys-help">Not every extension is made for bots, so one may misbehave. They run on this server, outside bots' containers.</p>
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
        </div>
      </div>
    </>
  );
}
