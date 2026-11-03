// OpenBots' dialogs: making a bot or a group, naming things, and confirming a delete. The shape and
// colour picker here is also the details panel's avatar editor.
import { Check, Trash, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { COLORS, SHAPES, randomLook, type BotLook } from "../../lib/bots/looks";
import { useBots } from "../../lib/bots/store";
import { cx } from "../../lib/ui";
import { IconButton } from "../primitives";
import { BotAvatar, BotHuddle } from "./BotAvatar";

/** Pick a shape (each drawn in the chosen colour) and a colour. */
export function LookPicker({ look, onChange }: { look: BotLook; onChange: (look: BotLook) => void }) {
  return (
    <div className="bots-look-picker">
      <div className="bots-shapes" role="radiogroup" aria-label="Shape">
        {SHAPES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={look.shape === s.id}
            aria-label={s.label}
            data-tooltip={s.label}
            className={cx("bots-shape", look.shape === s.id && "bots-shape-on")}
            onClick={() => onChange({ ...look, shape: s.id })}
          >
            <BotAvatar look={{ shape: s.id, color: look.color }} size={40} alive={false} />
          </button>
        ))}
      </div>
      <div className="bots-colors" role="radiogroup" aria-label="Colour">
        {COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={look.color === c.id}
            aria-label={c.label}
            data-tooltip={c.label}
            className={cx("bots-color", look.color === c.id && "bots-color-on")}
            style={{ "--swatch": c.hex } as React.CSSProperties}
            onClick={() => onChange({ ...look, color: c.id })}
          />
        ))}
      </div>
    </div>
  );
}

/** A native modal dialog that opens as it mounts and asks to close on Escape. */
function useModal(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return {
    ref,
    onCancel: (e: React.SyntheticEvent) => {
      e.preventDefault();
      onClose();
    },
    // A click on the backdrop lands on the dialog element itself.
    onMouseDown: (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    // Escape closes this dialog only, not Settings behind it (which listens on the window).
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") e.stopPropagation();
    },
  };
}

function DialogHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="bots-dialog-head">
      <h2>{title}</h2>
      <IconButton label="Close" tooltip={false} onClick={onClose}>
        <X size={18} />
      </IconButton>
    </div>
  );
}

export function CreateBotDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: (conversationId: string) => void }) {
  const modal = useModal(onClose);
  const [look, setLook] = useState(randomLook);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [changes, setChanges] = useState(0);
  const create = () => {
    if (!name.trim()) return;
    const id = useBots.getState().createBot({ name: name.trim(), look, instructions: instructions.trim() });
    onClose();
    onCreated?.(id);
  };
  return (
    <dialog {...modal} className="bots-dialog" aria-label="New bot">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <DialogHead title="New bot" onClose={onClose} />
        <div className="bots-dialog-body">
          <div className="bots-dialog-hero">
            <BotAvatar look={look} size={112} lively track playful pulse={changes ? { key: changes, action: changes % 3 === 0 ? "spin" : "hop" } : undefined} />
          </div>
          <input className="input bots-name-input" value={name} maxLength={48} placeholder="Name your bot" aria-label="Name" autoFocus onChange={(e) => setName(e.target.value)} />
          <LookPicker
            look={look}
            onChange={(next) => {
              setLook(next);
              setChanges((n) => n + 1);
            }}
          />
          <label className="bots-field">
            <span className="bots-field-label">Instructions <span className="bots-field-optional">optional</span></span>
            <textarea
              className="input textarea bots-textarea"
              rows={3}
              value={instructions}
              placeholder="What is this bot for, and how should it act?"
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>
        </div>
        <div className="bots-dialog-foot">
          <button type="button" className="btn bots-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn bots-btn bots-btn-primary" disabled={!name.trim()}>
            Create
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function CreateGroupDialog({ onClose, onCreated, preset = [] }: { onClose: () => void; onCreated?: (conversationId: string) => void; preset?: string[] }) {
  const modal = useModal(onClose);
  const bots = useBots((s) => s.bots);
  const [picked, setPicked] = useState<string[]>(preset);
  const [name, setName] = useState("");
  const members = bots.filter((b) => picked.includes(b.id));
  const ok = name.trim() && picked.length >= 2;
  const create = () => {
    if (!ok) return;
    const id = useBots.getState().createGroup({ name: name.trim(), botIds: picked });
    onClose();
    onCreated?.(id);
  };
  return (
    <dialog {...modal} className="bots-dialog" aria-label="New group">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <DialogHead title="New group" onClose={onClose} />
        <div className="bots-dialog-body">
          <div className="bots-dialog-hero">
            {members.length ? (
              <BotHuddle key={picked.join()} looks={members.map((b) => b.look)} size={112} extra={members.length > 4 ? members.length - 4 : undefined} />
            ) : (
              <div className="bots-hero-empty">Pick at least two bots</div>
            )}
          </div>
          <input className="input bots-name-input" value={name} maxLength={48} placeholder="Name your group" aria-label="Name" autoFocus onChange={(e) => setName(e.target.value)} />
          <div className="bots-pick-list" role="group" aria-label="Members">
            {bots.map((b) => {
              const on = picked.includes(b.id);
              return (
                <button
                  key={b.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  className={cx("bots-pick", on && "bots-pick-on")}
                  onClick={() => setPicked((p) => (on ? p.filter((x) => x !== b.id) : [...p, b.id]))}
                >
                  <BotAvatar look={b.look} size={30} mood={on ? "happy" : "idle"} alive={false} />
                  <span className="bots-pick-name">{b.name}</span>
                  <span className="bots-pick-check">{on && <Check size={13} strokeWidth={3} />}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="bots-dialog-foot">
          <button type="button" className="btn bots-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn bots-btn bots-btn-primary" disabled={!ok}>
            Create
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Ask for a name: renaming a bot or group, or naming a new section. */
export function NameDialog({ title, initial = "", action, placeholder, onSubmit, onClose }: { title: string; initial?: string; action: string; placeholder?: string; onSubmit: (name: string) => void; onClose: () => void }) {
  const modal = useModal(onClose);
  const [value, setValue] = useState(initial);
  return (
    <dialog {...modal} className="confirm-dialog bots-small-dialog" aria-label={title}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          onSubmit(value.trim());
          onClose();
        }}
      >
        <h2>{title}</h2>
        <input className="input" value={value} maxLength={48} placeholder={placeholder} aria-label={title} autoFocus onFocus={(e) => e.currentTarget.select()} onChange={(e) => setValue(e.target.value)} />
        <div className="confirm-actions">
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={!value.trim()}>
            {action}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function ConfirmDeleteDialog({ title, body, onConfirm, onClose }: { title: string; body: string; onConfirm: () => void; onClose: () => void }) {
  const modal = useModal(onClose);
  return (
    <dialog {...modal} className="confirm-dialog bots-small-dialog" aria-label={title}>
      <h2>{title}</h2>
      <p>{body}</p>
      <div className="confirm-actions">
        <button type="button" className="btn btn-sm" onClick={onClose} autoFocus>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          <Trash size={14} /> Delete
        </button>
      </div>
    </dialog>
  );
}
