import { Search } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { cheatsheetGroups, closeCheatsheet, useCheatsheet } from "../lib/cheatsheet";
import { useStore } from "../lib/store";
import { usePresence } from "../lib/ui";

/**
 * ⌘K (Settings → Shortcuts can move it): every keyboard shortcut in one scrolling list, with a
 * search. Only for looking: the combinations are changed in Settings. Escape clears the search,
 * then closes; ↑/↓ and Page Up/Down scroll the list while the search has focus.
 */
export function Cheatsheet() {
  const open = useCheatsheet((s) => s.open);
  const { mounted, visible } = usePresence(open, 180);
  if (!mounted) return null;
  return <Sheet open={open} visible={visible} />;
}

function Sheet({ open, visible }: { open: boolean; visible: boolean }) {
  const shortcuts = useStore((s) => s.settings.shortcuts);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const groups = useMemo(() => cheatsheetGroups(deferred, shortcuts), [deferred, shortcuts]);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // Focus goes to the search, and back where it was on closing.
  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement as HTMLElement | null;
    field.current?.focus({ preventScroll: true });
    return () => {
      if (restore?.isConnected) restore.focus({ preventScroll: true });
    };
  }, [open]);

  // A new search starts from the top.
  useEffect(() => {
    list.current?.scrollTo({ top: 0 });
  }, [deferred]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (field.current?.value) setQuery("");
      else closeCheatsheet();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const scroll = (e: React.KeyboardEvent) => {
    const el = list.current;
    if (!el || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const by = e.key === "ArrowDown" ? 40 : e.key === "ArrowUp" ? -40 : e.key === "PageDown" ? el.clientHeight - 40 : e.key === "PageUp" ? 40 - el.clientHeight : 0;
    if (!by) return;
    e.preventDefault();
    el.scrollBy({ top: by });
  };

  return (
    <div className="modal-root cheatsheet-root" data-state={visible ? "open" : "closed"}>
      <div className="modal-backdrop" onClick={closeCheatsheet} aria-hidden />
      <div className="modal cheatsheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <label className="cheatsheet-search">
          <Search size={15} aria-hidden />
          <input
            ref={field}
            type="text"
            value={query}
            placeholder="Search shortcuts"
            aria-label="Search shortcuts"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={scroll}
          />
          <kbd className="shortcut-key cheatsheet-esc">Esc</kbd>
        </label>
        <div ref={list} className="cheatsheet-list" tabIndex={-1}>
          {groups.length ? (
            groups.map((group) => (
              <section key={group.title} className="cheatsheet-group" aria-label={group.title}>
                <h3 className="cheatsheet-title">{group.title}</h3>
                {group.rows.map((row) => (
                  <div key={row.key} className="cheatsheet-row">
                    <span className="cheatsheet-label">{row.label}</span>
                    <span className="cheatsheet-keys">
                      {row.keys.length ? (
                        row.keys.map((key, i) => (
                          <kbd key={`${key}-${i}`} className="shortcut-key">
                            {key}
                          </kbd>
                        ))
                      ) : (
                        <span className="shortcut-unset">Not set</span>
                      )}
                    </span>
                  </div>
                ))}
              </section>
            ))
          ) : (
            <p className="cheatsheet-empty">No shortcuts match “{deferred.trim()}”</p>
          )}
        </div>
      </div>
    </div>
  );
}
