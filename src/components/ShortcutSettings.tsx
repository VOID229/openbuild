import { RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  SHORTCUTS,
  assignShortcut,
  bindingFromEvent,
  bindingKeys,
  bindingNote,
  defaultBinding,
  formatBinding,
  isDefaultShortcut,
  isMacPlatform,
  parseBinding,
  setShortcutRecording,
  shortcutDef,
  shortcutValue,
  type KeyBinding,
  type ShortcutId,
} from "../lib/shortcuts";
import { useStore } from "../lib/store";
import { cx } from "../lib/ui";
import { SettingsHeading } from "./primitives";

const Heading = SettingsHeading;

function Keycaps({ binding }: { binding: KeyBinding | null }) {
  if (!binding) return <span className="shortcut-unset">Not set</span>;
  return (
    <>
      {bindingKeys(binding).map((key, i) => (
        <kbd key={`${key}-${i}`} className="shortcut-key">
          {key}
        </kbd>
      ))}
    </>
  );
}

/**
 * Settings → Shortcuts. Click a combination, press the new one, and it's saved to settings — Escape
 * (or clicking away) cancels. A combination another action already uses moves here, leaving that
 * action unset rather than letting one key run two things.
 */
export function ShortcutsSection() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const [capturing, setCapturing] = useState<ShortcutId>();
  const [notice, setNotice] = useState<{ id: ShortcutId; text: string }>();
  const buttons = useRef<Partial<Record<ShortcutId, HTMLButtonElement | null>>>({});
  const mac = isMacPlatform();
  const shortcuts = settings.shortcuts;

  useEffect(() => {
    if (!capturing) return;
    setShortcutRecording(true);
    const onKey = (e: KeyboardEvent) => {
      // Escape means "never mind": leave the old shortcut as it was.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setNotice(undefined);
        setCapturing(undefined);
        return;
      }
      if (e.repeat || e.isComposing) return;
      const binding = bindingFromEvent(e);
      if (!binding) return;
      const def = shortcutDef(capturing);
      e.preventDefault();
      e.stopPropagation();
      if (!def.bare && !binding.mod && !binding.alt) {
        setNotice({
          id: capturing,
          text: `Hold ${mac ? "⌘, ⌃ or ⌥" : "Ctrl or Alt"} too, so the shortcut doesn't get in the way of typing.`,
        });
        return;
      }
      update({ shortcuts: assignShortcut(shortcuts, capturing, binding) });
      setNotice(undefined);
      setCapturing(undefined);
    };
    // A click anywhere else puts the old combination back and leaves the row alone.
    const onPointerDown = (e: PointerEvent) => {
      const button = buttons.current[capturing];
      if (button && e.target instanceof Node && button.contains(e.target)) return;
      setNotice(undefined);
      setCapturing(undefined);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      setShortcutRecording(false);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [capturing, mac, shortcuts, update]);

  return (
    <>
      <Heading>Shortcuts</Heading>
      <p className="shortcut-intro">
        Click a shortcut, then press the keys you want. Press <kbd className="shortcut-key">Esc</kbd>{" "}
        to cancel and keep the old one.
      </p>
      <p className="shortcut-intro shortcut-intro-muted">
        Some combinations belong to the browser or your system ({mac ? "⌘N, ⌘T, ⌘W" : "Ctrl+N, Ctrl+T, Ctrl+W"}) and
        may not reach OpenBuild.
      </p>
      <div className="shortcut-list">
        {SHORTCUTS.map((def) => {
          const value = shortcutValue(settings, def.id);
          const binding = parseBinding(value);
          const recording = capturing === def.id;
          const note = binding ? bindingNote(binding, mac) : undefined;
          return (
            <div className="setting-row shortcut-row" key={def.id}>
              <div className="setting-text">
                <div className="setting-label">{def.label}</div>
                <p className="setting-desc">{def.description}</p>
                {!recording && note && <p className="setting-desc shortcut-hint">{note}</p>}
                {notice?.id === def.id && (
                  <p className="setting-desc shortcut-warning" role="status">
                    {notice.text}
                  </p>
                )}
              </div>
              <div className="shortcut-controls">
                <button
                  ref={(el) => {
                    buttons.current[def.id] = el;
                  }}
                  type="button"
                  className={cx("shortcut-keys", recording && "shortcut-recording")}
                  aria-label={recording ? `Press the new shortcut for ${def.label}` : `Change shortcut for ${def.label}`}
                  aria-pressed={recording}
                  onClick={() => {
                    setNotice(undefined);
                    setCapturing(def.id);
                  }}
                >
                  {recording ? <span className="shortcut-prompt">Press keys…</span> : <Keycaps binding={binding} />}
                </button>
                {!isDefaultShortcut(settings, def.id) && (
                  <button
                    type="button"
                    className="shortcut-reset"
                    aria-label={`Reset ${def.label} to its default`}
                    data-tooltip={`Reset to ${formatBinding(defaultBinding(def.id), mac)}`}
                    onClick={() => {
                      const next = { ...(shortcuts ?? {}) };
                      delete next[def.id];
                      update({ shortcuts: next });
                      if (capturing === def.id) setCapturing(undefined);
                    }}
                  >
                    <RotateCcw size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="shortcut-footer">
        <button
          type="button"
          className="btn btn-sm"
          disabled={!shortcuts || Object.keys(shortcuts).length === 0}
          onClick={() => update({ shortcuts: {} })}
        >
          Reset all
        </button>
      </div>
    </>
  );
}
