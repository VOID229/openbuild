// The side panel's diff tab: every change in the thread's checkout against HEAD (staged, unstaged and
// new files), one collapsible section per file, refreshed while it's showing so the agent's edits
// come in as they land. server/workspaceGit.ts `patch` does the git; this only parses and draws it.
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, RotateCcw, WrapText } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "../lib/devices";
import type { TerminalFolder } from "../lib/terminal";
import { cx } from "../lib/ui";
import { FileIcon } from "./FileTree";
import { IconButton, Spinner } from "./primitives";

interface Line {
  kind: "add" | "del" | "ctx" | "hunk" | "note";
  text: string;
  old?: number;
  new?: number;
}

export interface FileDiff {
  path: string;
  from?: string;
  status: "added" | "deleted" | "renamed" | "modified";
  binary: boolean;
  adds: number;
  dels: number;
  lines: Line[];
}

/** A unified patch (`git diff`), as files and their lines. */
export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let oldNo = 0;
  let newNo = 0;
  const unquote = (p: string) => (p.startsWith('"') ? p.slice(1, -1).replace(/\\(.)/g, "$1") : p);
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(raw);
      file = { path: m ? unquote(m[2]!) : raw.slice(11), status: "modified", binary: false, adds: 0, dels: 0, lines: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      file.lines.push({ kind: "hunk", text: raw });
      continue;
    }
    // Header lines, before the first hunk.
    if (!file.lines.length) {
      if (raw.startsWith("new file mode")) file.status = "added";
      else if (raw.startsWith("deleted file mode")) file.status = "deleted";
      else if (raw.startsWith("rename from ")) {
        file.status = "renamed";
        file.from = raw.slice(12);
      } else if (raw.startsWith("Binary files ")) file.binary = true;
      continue;
    }
    if (raw.startsWith("+")) {
      file.adds++;
      file.lines.push({ kind: "add", text: raw.slice(1), new: newNo++ });
    } else if (raw.startsWith("-")) {
      file.dels++;
      file.lines.push({ kind: "del", text: raw.slice(1), old: oldNo++ });
    } else if (raw.startsWith(" ")) {
      file.lines.push({ kind: "ctx", text: raw.slice(1), old: oldNo++, new: newNo++ });
    } else if (raw.startsWith("\\")) {
      file.lines.push({ kind: "note", text: raw });
    }
  }
  return files;
}

interface PatchResponse {
  repo: boolean;
  patch: string;
  truncated?: boolean;
  branch?: string;
}

/** Big files start folded, so one generated file doesn't bury the rest. */
const FOLD_OVER = 400;
const REFRESH_MS = 4000;
const WRAP_KEY = "openbuild:diff-wrap";

const FileSection = memo(function FileSection({ file, open, onToggle }: { file: FileDiff; open: boolean; onToggle: (path: string) => void }) {
  const name = file.path.split("/").pop()!;
  const dir = file.path.slice(0, file.path.length - name.length);
  return (
    <section className="dv-file">
      <button type="button" className="dv-file-head" aria-expanded={open} onClick={() => onToggle(file.path)} title={file.from ? `${file.from} → ${file.path}` : file.path}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <FileIcon name={name} size={13} />
        <span className="dv-file-path">
          {dir && <span className="dv-file-dir">{dir}</span>}
          <span className="dv-file-name">{name}</span>
        </span>
        {file.status !== "modified" && <span className={cx("dv-badge", `dv-badge-${file.status}`)}>{file.status}</span>}
        <span className="dv-count">
          {file.adds > 0 && <span className="dv-adds">+{file.adds}</span>}
          {file.dels > 0 && <span className="dv-dels">-{file.dels}</span>}
        </span>
      </button>
      {open && (
        <div className="dv-lines">
          {file.binary ? (
            <div className="dv-empty-file">Binary file</div>
          ) : !file.lines.length ? (
            <div className="dv-empty-file">{file.status === "renamed" ? "Renamed, no changes" : "No content changes"}</div>
          ) : (
            file.lines.map((l, i) =>
              l.kind === "hunk" ? (
                <div key={i} className="dv-hunk">
                  {l.text}
                </div>
              ) : (
                <div key={i} className={cx("dv-line", `dv-${l.kind}`)}>
                  <span className="dv-no">{l.old ?? ""}</span>
                  <span className="dv-no">{l.new ?? ""}</span>
                  <span className="dv-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : ""}</span>
                  <span className="dv-text">{l.text || " "}</span>
                </div>
              ),
            )
          )}
        </div>
      )}
    </section>
  );
});

export function DiffView({ folder }: { folder: TerminalFolder }) {
  const [data, setData] = useState<PatchResponse>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [wrap, setWrap] = useState(() => localStorage.getItem(WRAP_KEY) === "1");
  // Which files are folded, by path; files not in it follow FOLD_OVER.
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const last = useRef<string>(undefined);

  const load = useCallback(
    async (manual = false) => {
      if (!folder.cwd) return;
      if (manual) setLoading(true);
      try {
        const res = await fetch(apiUrl(folder.deviceId, `/api/workspaces/patch?cwd=${encodeURIComponent(folder.cwd)}`));
        const body = (await res.json().catch(() => null)) as (PatchResponse & { error?: string }) | null;
        if (!res.ok || !body) throw new Error(body?.error ?? (res.status === 404 ? "This server is too old for the diff viewer. Restart it to update." : `HTTP ${res.status}`));
        setError(undefined);
        // Unchanged: keep the same object, so nothing redraws.
        const sig = `${body.repo}|${body.branch}|${body.patch}`;
        if (sig !== last.current) {
          last.current = sig;
          setData(body);
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (manual) setLoading(false);
      }
    },
    [folder.deviceId, folder.cwd],
  );

  useEffect(() => {
    last.current = undefined;
    setData(undefined);
    setFolded({});
    void load(true);
    const tick = () => document.visibilityState === "visible" && void load();
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  const files = useMemo(() => (data ? parsePatch(data.patch) : []), [data]);
  const isOpen = (f: FileDiff) => !(folded[f.path] ?? f.lines.length > FOLD_OVER);
  const toggle = useCallback((path: string) => setFolded((s) => {
    const file = files.find((f) => f.path === path);
    const wasFolded = s[path] ?? (file ? file.lines.length > FOLD_OVER : false);
    return { ...s, [path]: !wasFolded };
  }), [files]);
  const allFolded = files.length > 0 && files.every((f) => !isOpen(f));
  const adds = files.reduce((n, f) => n + f.adds, 0);
  const dels = files.reduce((n, f) => n + f.dels, 0);

  return (
    <div className="diff-view">
      <div className="fv-bar">
        <span className="fv-path">
          {data?.branch ? <span className="fv-name">{data.branch}</span> : "Working tree"}
          {files.length > 0 && (
            <>
              <span className="fv-sep">·</span>
              {files.length} {files.length === 1 ? "file" : "files"} <span className="dv-adds">+{adds}</span> <span className="dv-dels">-{dels}</span>
            </>
          )}
        </span>
        {loading && <Spinner />}
        <IconButton
          label={allFolded ? "Expand all files" : "Collapse all files"}
          className="fv-tool"
          disabled={!files.length}
          onClick={() => setFolded(Object.fromEntries(files.map((f) => [f.path, !allFolded])))}
        >
          {allFolded ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
        </IconButton>
        <IconButton
          label={wrap ? "Don't wrap lines" : "Wrap lines"}
          className={cx("fv-tool", wrap && "fv-tool-on")}
          aria-pressed={wrap}
          onClick={() => {
            localStorage.setItem(WRAP_KEY, wrap ? "0" : "1");
            setWrap(!wrap);
          }}
        >
          <WrapText size={14} />
        </IconButton>
        <IconButton label="Refresh the diff" className="fv-tool" onClick={() => void load(true)}>
          <RotateCcw size={13} />
        </IconButton>
      </div>
      <div className={cx("dv-body", wrap && "dv-wrap")}>
        {!folder.cwd ? (
          <p className="fv-note">No project folder to compare.</p>
        ) : error && !data ? (
          <p className="fv-note">{error}</p>
        ) : !data ? (
          <p className="fv-note">Loading the diff…</p>
        ) : !data.repo ? (
          <p className="fv-note">This folder isn't a git repository.</p>
        ) : !files.length ? (
          <p className="fv-note">No changes against HEAD.</p>
        ) : (
          <>
            {files.map((f) => (
              <FileSection key={f.path} file={f} open={isOpen(f)} onToggle={toggle} />
            ))}
            {data.truncated && <p className="dv-truncated">The diff is too big to show all of it.</p>}
          </>
        )}
      </div>
    </div>
  );
}
