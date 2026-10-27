// The file editor (CodeMirror), loaded only when a file is first opened. Its colours come from the
// app's own CSS variables, so it follows the theme like everything else.
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { c, cpp, csharp, java, kotlin, scala } from "@codemirror/legacy-modes/mode/clike";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { crosshairCursor, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export { EditorState, EditorView };

const legacy = (mode: Parameters<typeof StreamLanguage.define>[0]) => StreamLanguage.define(mode);

/** The language for a file, by its name. */
function languageFor(name: string): LanguageSupport | StreamLanguage<unknown> | undefined {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return legacy(dockerFile);
  if (lower === "justfile" || lower === "makefile" || /^\.(bash|zsh)rc$|^\.env/.test(lower)) return legacy(shell);
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "json":
    case "jsonc":
    case "json5":
      return json();
    case "md":
    case "markdown":
    case "mdx":
      return markdown();
    case "css":
    case "scss":
    case "less":
      return css();
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return html();
    case "py":
      return python();
    case "rs":
      return rust();
    case "go":
      return go();
    case "sql":
      return sql();
    case "yml":
    case "yaml":
      return yaml();
    case "toml":
      return legacy(toml);
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return legacy(shell);
    case "swift":
      return legacy(swift);
    case "c":
    case "h":
      return legacy(c);
    case "cc":
    case "cpp":
    case "hpp":
    case "mm":
    case "m":
      return legacy(cpp);
    case "cs":
      return legacy(csharp);
    case "java":
      return legacy(java);
    case "kt":
    case "kts":
      return legacy(kotlin);
    case "scala":
      return legacy(scala);
    case "rb":
      return legacy(ruby);
    case "lua":
      return legacy(lua);
  }
  return undefined;
}

// Token colours: the same quiet palette the chat's code blocks use (styles.css, .hljs-*), by role.
const highlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--cm-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--cm-string)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.literal], color: "var(--cm-number)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--cm-type)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--cm-function)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--cm-property)" },
  { tag: [t.tagName, t.heading], color: "var(--cm-tag)", fontWeight: "600" },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: "var(--cm-meta)" },
  { tag: t.link, color: "var(--cm-string)", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.invalid, color: "var(--danger)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", color: "var(--text)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono-ui)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--text)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--cm-selection) !important" },
  ".cm-activeLine": { backgroundColor: "var(--cm-active-line)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--text-3)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-2)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px", minWidth: "36px" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--text-3)", padding: "0 4px 0 0" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "var(--active)", outline: "none" },
  ".cm-selectionMatch": { backgroundColor: "var(--hover)" },
  ".cm-searchMatch": { backgroundColor: "var(--cm-search)", outline: "1px solid var(--border-strong)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--cm-selection)" },
  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panel.cm-search": { padding: "6px 8px", fontFamily: "var(--font-normal)", fontSize: "12.5px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontFamily: "inherit", fontSize: "12.5px" },
  ".cm-textfield": { border: "1px solid var(--border-strong)", borderRadius: "7px", background: "var(--surface-2)", color: "var(--text)", padding: "3px 7px" },
  ".cm-button": { border: "1px solid var(--border-strong)", borderRadius: "7px", backgroundImage: "none", background: "var(--surface)", color: "var(--text-2)", padding: "3px 9px" },
  ".cm-panel.cm-search label": { color: "var(--text-2)" },
  ".cm-tooltip": { border: "1px solid var(--border)", borderRadius: "10px", backgroundColor: "var(--surface)", boxShadow: "var(--shadow-md)", overflow: "hidden" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--active)", color: "var(--text)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--surface-3)", border: "none", color: "var(--text-2)" },
});

export interface EditorHooks {
  onChange(doc: string): void;
  onSave(): void;
}

/** A fresh editor state for a file's text. The hooks are read through a ref, so they can change. */
export function createState(name: string, text: string, hooks: { current: EditorHooks }, readOnly = false): EditorState {
  const lang = languageFor(name);
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(highlight),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: false }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: false }),
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => (hooks.current.onSave(), true) },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    theme,
    wrap.of([]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) hooks.current.onChange(u.state.doc.toString());
    }),
    ...(readOnly ? [EditorState.readOnly.of(true)] : []),
  ];
  if (lang) extensions.push(lang);
  return EditorState.create({ doc: text, extensions });
}

/** Soft wrapping, switched per editor without rebuilding it. */
export const wrap = new Compartment();
export const wrapping = (on: boolean) => wrap.of(on ? EditorView.lineWrapping : []);

/** Replace the whole text (a file reloaded from disk), keeping undo so it can be taken back. */
export function replaceDoc(view: EditorView, text: string) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}
