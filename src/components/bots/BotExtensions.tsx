// Settings → Bots → Custom extensions: bots run on what OpenBots ships, and the user can also load
// their own Pi extensions and packages, one at a time. Off until they say otherwise, each of them too.
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { BotExtension } from "../../../shared/bots";
import { useBots } from "../../lib/bots/store";
import { botModels } from "../../lib/pi";
import { Spinner, Toggle } from "../primitives";

export function BotExtensions() {
  const custom = useBots((s) => s.customExtensions);
  const [list, setList] = useState<BotExtension[]>();
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string>();

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
          <p className="setting-desc">Bots have everything they need without these. Turn this on to pick extensions from your own Pi to add to them, including any that provide models.</p>
        </div>
        <Toggle checked={custom.enabled} label="Load my Pi extensions too" onChange={(enabled) => void apply({ ...custom, enabled })} />
      </div>
      {custom.enabled && (
        <>
          <p className="field-help keys-help">Most extensions work fine, but they weren't all made with bots in mind, so one may clash or misbehave. They also run on this server rather than in a bot's container. Changes apply from each bot's next reply.</p>
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
