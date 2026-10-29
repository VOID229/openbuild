/** Local to this page: cursor positions should not follow drafts onto another device. */
type Selection = {
  text: string;
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
};
const selections = new Map<string, Selection>();

type Field = Pick<HTMLTextAreaElement, "value" | "selectionStart" | "selectionEnd" | "selectionDirection" | "setSelectionRange">;

export function rememberDraftSelection(key: string, field: Field) {
  selections.set(key, {
    text: field.value,
    start: field.selectionStart,
    end: field.selectionEnd,
    direction: field.selectionDirection,
  });
}

export function restoreDraftSelection(key: string, field: Field) {
  const saved = selections.get(key);
  // A restored/remote draft may have different text. Never apply an old offset to new content.
  if (saved?.text === field.value) {
    field.setSelectionRange(saved.start, saved.end, saved.direction);
  } else {
    field.setSelectionRange(field.value.length, field.value.length);
  }
}
