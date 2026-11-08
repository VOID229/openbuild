// Settings → Bots → Bot replies in a row: a chat pauses once bots have sent this many messages since
// the user last wrote, so they can't keep answering each other forever. Off means they never pause.
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { BOT_LOOP_MAX, BOT_LOOP_MIN, parseBotLoopLimit } from "../../../shared/bots";
import { useBots } from "../../lib/bots/store";
import { cx } from "../../lib/ui";
import { Toggle } from "../primitives";

export function BotLoop() {
  const loop = useBots((s) => s.botLoop);
  const setBotLoop = useBots((s) => s.setBotLoop);
  const [draft, setDraft] = useState(String(loop.limit));
  const [invalid, setInvalid] = useState<string>();
  useEffect(() => {
    setDraft(String(loop.limit));
    setInvalid(undefined);
  }, [loop.limit]);

  const save = () => {
    const parsed = parseBotLoopLimit(draft);
    if ("error" in parsed) return setInvalid(parsed.error);
    setInvalid(undefined);
    if (parsed.limit !== loop.limit) setBotLoop({ ...loop, limit: parsed.limit });
    else setDraft(String(loop.limit));
  };

  return (
    <>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Pause bots replying to each other</div>
          <p className="setting-desc">Stop a chat after bots send this many messages in a row without you, until you send one. Off lets them keep going.</p>
        </div>
        <Toggle checked={loop.enabled} onChange={(enabled) => setBotLoop({ ...loop, enabled })} label="Pause bots replying to each other" />
      </div>
      <div className={cx("setting-row", !loop.enabled && "setting-row-disabled")}>
        <div className="setting-text">
          <label className="setting-label" htmlFor="bot-loop-limit">Bot messages in a row</label>
          <p className="setting-desc">
            From {BOT_LOOP_MIN} to {BOT_LOOP_MAX}.
          </p>
        </div>
        <input
          id="bot-loop-limit"
          className="input bots-loop-limit"
          type="number"
          inputMode="numeric"
          min={BOT_LOOP_MIN}
          max={BOT_LOOP_MAX}
          step={1}
          disabled={!loop.enabled}
          aria-invalid={!!invalid}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setDraft(String(loop.limit));
              setInvalid(undefined);
            }
          }}
        />
      </div>
      {invalid && (
        <div className="key-status key-status-bad" role="alert">
          <CircleAlert size={13} className="bad" /> {invalid}
        </div>
      )}
    </>
  );
}
