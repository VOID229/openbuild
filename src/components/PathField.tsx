// A folder path field with shell-style completion. The folders it suggests come from the device
// that holds them (`/api/fs` through the device proxy), so a path on a paired machine completes
// from that machine's disk, not this one's. Tab completes what's typed (to the folders' common
// start, or to the one picked with the arrow keys), the arrows pick a folder, and clicking one
// descends into it. Enter still submits the form unless a folder was picked from the list.
import { Folder, FolderGit2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { browseFolders } from "../lib/pi";
import { completePath, matchFolders, pathParts } from "../lib/pathComplete";
import { cx } from "../lib/ui";
import { Popover } from "./primitives";

type Entry = { name: string; path: string; git: boolean };

/** Listings by device and folder, so going back up a path (or reopening the field) is instant. */
const listings = new Map<string, Entry[]>();
const remember = (key: string, entries: Entry[]) => {
  if (listings.size > 200) listings.clear();
  listings.set(key, entries);
};

export interface PathFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** The paired device whose disk is listed; none for this server. */
  deviceId?: string;
  /** Extra classes for the input (it already has `.input`). */
  className?: string;
  label: string;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  onBlur?: () => void;
}

export function PathField({ value, onChange, deviceId, className, label, placeholder, autoFocus, disabled, onBlur }: PathFieldProps) {
  const parts = pathParts(value);
  // A fragment starting with "." asks for dotfolders, which a project list otherwise leaves out.
  const hidden = parts.fragment.startsWith(".");
  const key = `${deviceId ?? "local"}|${parts.dir}|${hidden ? "h" : ""}`;
  const [entries, setEntries] = useState<Entry[]>(() => listings.get(key) ?? []);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Whether the arrow keys picked a folder (then Enter takes it instead of submitting).
  const [picked, setPicked] = useState(false);
  const [width, setWidth] = useState<number>();
  const input = useRef<HTMLInputElement>(null);

  // Read the folder as the path is typed, even before Tab asks: the completion is then instant.
  useEffect(() => {
    const cached = listings.get(key);
    setEntries(cached ?? []);
    if (disabled) return;
    let live = true;
    const t = setTimeout(
      () => {
        browseFolders(parts.dir, deviceId, hidden).then(
          (r) => {
            remember(key, r.entries);
            if (live) setEntries(r.entries);
          },
          () => {
            // No folder there (yet): a path being created simply has nothing to suggest.
            if (live) setEntries([]);
          },
        );
      },
      cached ? 400 : 90,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, deviceId, hidden, disabled]);

  const byName = useMemo(() => new Map(entries.map((e) => [e.name, e])), [entries]);
  const names = useMemo(() => entries.map((e) => e.name), [entries]);
  const matches = useMemo(() => matchFolders(names, parts.fragment), [names, parts.fragment]);
  const chosen = picked && matches.length ? Math.min(active, matches.length - 1) : undefined;
  const shown = open && matches.length > 0 && !disabled;

  const show = () => {
    if (open) return;
    setOpen(true);
    setWidth(input.current?.getBoundingClientRect().width);
    setActive(0);
    setPicked(false);
  };
  const complete = (index?: number) => {
    const next = completePath(value, matches, index);
    if (next !== value) onChange(next);
    setPicked(false);
    setActive(0);
  };
  const type = (next: string) => {
    onChange(next);
    setPicked(false);
    setActive(0);
  };
  const step = (delta: 1 | -1) => {
    show();
    // The first arrow picks a folder rather than moving on from nothing picked.
    if (!picked) {
      setPicked(true);
      setActive(delta === 1 ? 0 : matches.length - 1);
      return;
    }
    const n = matches.length;
    setActive((i) => (i + delta + n) % n);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      if (!matches.length) return;
      e.preventDefault();
      show();
      complete(chosen);
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && matches.length) {
      e.preventDefault();
      step(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Enter" && chosen !== undefined) {
      // Enter takes the folder the arrows picked; otherwise it belongs to the form.
      e.preventDefault();
      complete(chosen);
    }
  };

  const id = useId();
  const listId = shown ? `${id}-folders` : undefined;
  return (
    <>
      <input
        ref={input}
        className={cx("input", className)}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && chosen !== undefined ? `${listId}-${chosen}` : undefined}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(e) => type(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          // Coming back to a field that already has a path suggests what's under it.
          if (value.endsWith("/")) show();
        }}
        onBlur={() => {
          setOpen(false);
          onBlur?.();
        }}
      />
      <Popover open={shown} onClose={() => setOpen(false)} anchor={input} className="menu path-menu" role="listbox" label={`Folders in ${parts.dir}`} fixed="auto" style={width ? { width } : undefined}>
        {matches.map((name, i) => {
          const entry = byName.get(name);
          return (
            <button
              key={name}
              id={`${listId}-${i}`}
              type="button"
              role="option"
              aria-selected={i === chosen}
              className={cx("menu-item path-item", i === chosen && "path-item-active")}
              // Keep the focus in the field, so the form's blur (and the list) behave while picking.
              onMouseDown={(e) => {
                e.preventDefault();
                complete(i);
              }}
              onMouseEnter={() => {
                if (picked) setActive(i);
              }}
            >
              {entry?.git ? <FolderGit2 size={15} className="path-icon" /> : <Folder size={15} className="path-icon" />}
              <span className="menu-item-label">{name}</span>
            </button>
          );
        })}
        <p className="path-hint" aria-hidden>
          Tab completes · {chosen === undefined ? "↑↓ picks" : "↵ opens"}
        </p>
      </Popover>
    </>
  );
}
