// An open file in the side panel: an editor for text (⌘S saves), the picture itself for images. A
// file the agent changes while it's open follows along when there's nothing unsaved in it; with
// unsaved edits, it asks which to keep, and a save never silently overwrites a change on disk.
import { AlertTriangle, Save, WrapText } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EditorState, EditorView } from "../lib/editor";
import { folderKey, usePanel } from "../lib/panel";
import type { TerminalFolder } from "../lib/terminal";
import { cx } from "../lib/ui";
import { FileError, isRaw, rawUrl, readFile, saveFile } from "../lib/workspaceFiles";
import { IconButton, Spinner } from "./primitives";

type Editor = typeof import("../lib/editor");

/** An open file's editor, kept while other tabs are showing: its text, undo history and selection. */
interface Buffer {
  state: EditorState;
  /** The text as it is on disk (as of `mtime`), to tell unsaved edits. */
  saved: string;
  mtime?: number;
  /** The file changed on disk while it had unsaved edits here. */
  stale?: boolean;
}

const buffers = new Map<string, Buffer>();
const bufferKey = (folder: TerminalFolder, path: string) => `${folderKey(folder)}|${path}`;

/** Forget a closed file's editor. */
export const dropBuffer = (folder: TerminalFolder, path: string) => buffers.delete(bufferKey(folder, path));

/** What the mounted editor does on typing and ⌘S (one file view is mounted at a time). */
const hooks = { current: { onChange: (_doc: string) => {}, onSave: () => {} } };

let editorModule: Promise<Editor> | undefined;
const loadEditor = () => (editorModule ??= import("../lib/editor"));

const WRAP_KEY = "openbuild:editor-wrap";

function TextFile({ folder, path }: { folder: TerminalFolder; path: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const [editor, setEditor] = useState<Editor>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<"save" | "disk">();
  // Saving needs this newer server; reading a file doesn't.
  const [notice, setNotice] = useState<string>();
  const [wrap, setWrap] = useState(() => localStorage.getItem(WRAP_KEY) === "1");
  const dirty = usePanel((s) => !!s.dirty[path]);
  const setDirty = usePanel((s) => s.setDirty);
  const key = bufferKey(folder, path);

  useEffect(() => {
    void loadEditor().then(setEditor, (err: Error) => setError(`Couldn't load the editor: ${err.message}`));
  }, []);

  const save = async (force = false) => {
    const buf = buffers.get(key);
    const v = view.current;
    if (!buf || !v || saving) return;
    const text = v.state.doc.toString();
    setSaving(true);
    try {
      const r = await saveFile(folder, path, text, force ? undefined : buf.mtime);
      setNotice(undefined);
      buf.saved = text;
      buf.mtime = r.mtime;
      buf.stale = false;
      setConflict(undefined);
      setDirty(path, v.state.doc.toString() !== text);
    } catch (err) {
      if (err instanceof FileError && err.code === "changed") setConflict("save");
      else if (err instanceof FileError && err.code === "stale") setNotice(err.message);
      else setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** Take the file as it is on disk now, dropping unsaved edits (undo still brings them back). */
  const reload = async () => {
    const buf = buffers.get(key);
    const v = view.current;
    if (!buf || !v || !editor) return;
    try {
      const file = await readFile(folder, path);
      if ("unchanged" in file) return;
      buf.saved = file.text;
      buf.mtime = file.mtime;
      buf.stale = false;
      editor.replaceDoc(v, file.text);
      setConflict(undefined);
      setDirty(path, false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  hooks.current = {
    onChange: (doc) => {
      const buf = buffers.get(key);
      if (!buf) return;
      setDirty(path, doc !== buf.saved);
    },
    onSave: () => void save(),
  };

  // The file's editor: the one kept from before, or a fresh one from disk.
  useLayoutEffect(() => {
    if (!editor || !host.current) return;
    let live = true;
    setError(undefined);
    setConflict(buffers.get(key)?.stale ? "disk" : undefined);
    const mount = (buf: Buffer) => {
      if (!live || !host.current) return;
      if (!view.current) view.current = new editor.EditorView({ state: buf.state, parent: host.current });
      else view.current.setState(buf.state);
      view.current.dispatch({ effects: editor.wrap.reconfigure(wrap ? editor.EditorView.lineWrapping : []) });
      setDirty(path, buf.state.doc.toString() !== buf.saved);
    };
    const kept = buffers.get(key);
    if (kept) mount(kept);
    else {
      setLoading(true);
      readFile(folder, path)
        .then((file) => {
          if (!live || "unchanged" in file) return;
          const buf: Buffer = { state: editor.createState(file.name, file.text, hooks), saved: file.text, mtime: file.mtime };
          buffers.set(key, buf);
          mount(buf);
        })
        .catch((err: Error) => live && setError(err.message))
        .finally(() => live && setLoading(false));
    }
    return () => {
      live = false;
      // Keep where it was (text, undo, selection) for coming back to this file.
      const buf = buffers.get(key);
      if (buf && view.current) buf.state = view.current.state;
    };
  }, [editor, key]);

  useEffect(() => () => view.current?.destroy(), []);

  useEffect(() => {
    if (editor && view.current) view.current.dispatch({ effects: editor.wrap.reconfigure(wrap ? editor.EditorView.lineWrapping : []) });
    try {
      localStorage.setItem(WRAP_KEY, wrap ? "1" : "0");
    } catch {}
  }, [wrap, editor]);

  // Follow changes made on disk (by the agent, a formatter, another editor).
  useEffect(() => {
    if (!editor) return;
    let live = true;
    const check = async () => {
      const buf = buffers.get(key);
      const v = view.current;
      if (!buf || !v || document.visibilityState !== "visible" || buf.mtime === undefined) return;
      try {
        const file = await readFile(folder, path, buf.mtime);
        if (!live || "unchanged" in file || file.mtime === buf.mtime) return;
        if (v.state.doc.toString() === buf.saved) {
          buf.saved = file.text;
          buf.mtime = file.mtime;
          editor.replaceDoc(v, file.text);
          setDirty(path, false);
        } else {
          buf.stale = true;
          setConflict("disk");
        }
      } catch {
        // Deleted or unreadable for now: the next check tries again.
      }
    };
    const timer = setInterval(check, 3000);
    document.addEventListener("visibilitychange", check);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [editor, key]);

  return (
    <div className="fv">
      <div className="fv-bar">
        <span className="fv-path" title={path}>
          {path.split("/").map((part, i, all) => (
            <span key={i} className={cx(i === all.length - 1 && "fv-name")}>
              {part}
              {i < all.length - 1 && <span className="fv-sep">/</span>}
            </span>
          ))}
        </span>
        <span className="fv-state">{saving ? "Saving…" : dirty ? "Unsaved" : ""}</span>
        <IconButton label={wrap ? "Don't wrap lines" : "Wrap lines"} className={cx("fv-tool", wrap && "fv-tool-on")} onClick={() => setWrap(!wrap)}>
          <WrapText size={14} />
        </IconButton>
        <IconButton label="Save (⌘S)" className="fv-tool" disabled={!dirty || saving} onClick={() => void save()}>
          <Save size={14} />
        </IconButton>
      </div>
      {notice && (
        <div className="fv-conflict" role="alert">
          <AlertTriangle size={14} />
          <span>{notice}</span>
          <button type="button" className="btn btn-sm" onClick={() => setNotice(undefined)}>
            Dismiss
          </button>
        </div>
      )}
      {conflict && (
        <div className="fv-conflict" role="alert">
          <AlertTriangle size={14} />
          <span>{conflict === "save" ? "This file changed on disk since you opened it." : "This file changed on disk, and you have unsaved edits."}</span>
          <button type="button" className="btn btn-sm" onClick={() => void reload()}>
            Use the file on disk
          </button>
          <button type="button" className="btn btn-sm" onClick={() => (conflict === "save" ? void save(true) : setConflict(undefined))}>
            {conflict === "save" ? "Overwrite it" : "Keep my edits"}
          </button>
        </div>
      )}
      <div className="fv-body">
        <div ref={host} className={cx("fv-editor", (error || loading) && "fv-editor-hidden")} />
        {loading && (
          <div className="fv-note">
            <Spinner size={14} />
          </div>
        )}
        {error && <div className="fv-note">{error}</div>}
      </div>
    </div>
  );
}

function ImageFile({ folder, path }: { folder: TerminalFolder; path: string }) {
  // Read fresh each time it's opened, not from the browser's cache.
  const [version] = useState(() => Date.now());
  return (
    <div className="fv">
      <div className="fv-bar">
        <span className="fv-path" title={path}>
          {path}
        </span>
      </div>
      <div className="fv-body fv-raw">
        <img src={rawUrl(folder, path, version)} alt={path} />
      </div>
    </div>
  );
}

export function FileView({ folder, path }: { folder: TerminalFolder; path: string }) {
  return isRaw(path) ? <ImageFile folder={folder} path={path} /> : <TextFile folder={folder} path={path} />;
}
