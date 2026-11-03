import { Bookmark, ChevronDown, FileText, X } from "lucide-react";
import { useRef } from "react";
import type { Stashed } from "../lib/stash";
import { ago, cx, useDismiss } from "../lib/ui";
import { IconButton } from "./primitives";

interface StashTrayProps {
  items: Stashed[];
  open: boolean;
  /** The row Up/Down and Enter act on while the list is open. */
  active: number;
  onToggle: () => void;
  onClose: () => void;
  onHover: (i: number) => void;
  onUse: (item: Stashed) => void;
  onRemove: (id: string) => void;
}

/** A tab on top of the composer; with several, opening into a list over what's above it, without moving anything. */
export function StashTray({ items, open, active, onToggle, onClose, onHover, onUse, onRemove }: StashTrayProps) {
  const tray = useRef<HTMLDivElement>(null);
  useDismiss(open, onClose, [tray]);
  // One stash has no list to choose from: the tab pastes it, and carries its remove button.
  const only = items.length === 1 ? items[0] : undefined;
  // Keep focus (and the keyboard) in the textarea.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  const header = (
    <>
      <Bookmark size={15} />
      <span className="stash-label">Stash</span>
      <span className="stash-count">{items.length}</span>
    </>
  );
  return (
    <div ref={tray} className="stash">
      {open ? (
        <div className="stash-panel">
          <button type="button" className="stash-head" aria-expanded aria-label="Close stash" onMouseDown={keepFocus} onClick={onToggle}>
            {header}
            <ChevronDown size={16} />
          </button>
          <div className="stash-list">
            {items.map((item, i) => {
              const chips = item.files.filter((f) => !f.mention);
              const image = chips.find((f) => f.mime.startsWith("image/"));
              return (
                <div key={item.id} className={cx("stash-row", i === active && "stash-row-active")} onMouseEnter={() => onHover(i)}>
                  <button type="button" className="stash-use" onMouseDown={keepFocus} onClick={() => onUse(item)}>
                    <FileText className="queued-file" size={15} />
                    <span className="queued-text">{item.text.trim() || chips[0]?.name}</span>
                    {image && <img className="queued-thumb" src={image.dataUrl} alt="" />}
                    <span className="stash-time">{ago(item.createdAt)}</span>
                  </button>
                  <IconButton label="Remove from stash" tooltipSide="top" className="queued-btn" onMouseDown={keepFocus} onClick={() => onRemove(item.id)}>
                    <X size={15} />
                  </IconButton>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="stash-tab">
          {only ? (
            <button type="button" className="stash-tab-btn" aria-label="Paste stash" onMouseDown={keepFocus} onClick={() => onUse(only)}>
              {header}
            </button>
          ) : (
            <button type="button" className="stash-tab-btn" aria-expanded={false} aria-label={`Open stash, ${items.length} saved`} onMouseDown={keepFocus} onClick={onToggle}>
              {header}
            </button>
          )}
          {only && (
            <IconButton label="Remove from stash" tooltipSide="top" className="queued-btn" onMouseDown={keepFocus} onClick={() => onRemove(only.id)}>
              <X size={15} />
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}
