import { Mic } from "lucide-react";
import { cx } from "../lib/ui";
import type { useFieldDictation } from "../lib/useFieldDictation";

/** The mic for a dictation field (see useFieldDictation). `className` picks the button style. */
export function DictationButton({
  dictation,
  className = "icon-btn field-mic",
  size = 15,
  tooltipSide = "top",
}: {
  dictation: ReturnType<typeof useFieldDictation>;
  className?: string;
  size?: number;
  tooltipSide?: "top" | "bottom";
}) {
  const label = dictation.busy ? "Transcribing…" : dictation.listening ? "Stop dictation" : "Dictate";
  return (
    <button
      type="button"
      className={cx(className, dictation.listening && "dictation-listening")}
      disabled={dictation.busy}
      aria-busy={dictation.busy}
      data-local-dictation={dictation.local || undefined}
      aria-label={label}
      aria-pressed={dictation.listening}
      data-tooltip={label}
      data-tooltip-side={tooltipSide}
      // Keep focus (and the caret) in the field.
      onMouseDown={(e) => e.preventDefault()}
      onClick={dictation.toggle}
    >
      <Mic size={size} />
    </button>
  );
}
