// OpenBots' dialogs: making a bot, a group or a poll, naming things, and confirming a delete. The shape and
// colour picker here is also the details panel's avatar editor.
import { Check, Plus, Trash, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { COLORS, SHAPES, randomLook, type BotLook } from "../../lib/bots/looks";
import { useBots } from "../../lib/bots/store";
import { uid } from "../../lib/id";
import { makePoll, POLL_OPTIONS } from "../../../shared/bots";
import { cx, useMediaQuery } from "../../lib/ui";
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
export function useModal(onClose: () => void) {
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

export function DialogHead({ title, onClose }: { title: string; onClose: () => void }) {
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
  const touch = useMediaQuery("(pointer: coarse)");
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
          <input className="input bots-name-input" value={name} maxLength={48} placeholder="Name your bot" aria-label="Name" autoFocus={!touch} onChange={(e) => setName(e.target.value)} />
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
  const touch = useMediaQuery("(pointer: coarse)");
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
          <input className="input bots-name-input" value={name} maxLength={48} placeholder="Name your group" aria-label="Name" autoFocus={!touch} onChange={(e) => setName(e.target.value)} />
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

/** Put a poll to a group: a question, options lettered A, B, C…, and one answer or several. */
export function PollDialog({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const modal = useModal(onClose);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(() => [{ id: uid(), text: "" }, { id: uid(), text: "" }]);
  const [multiple, setMultiple] = useState(false);
  const [blind, setBlind] = useState(true);
  const [posting, setPosting] = useState(false);
  const [failed, setFailed] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  /** The row to put the cursor in once it's drawn. */
  const focusRow = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (focusRow.current === undefined) return;
    list.current?.querySelectorAll("input")[focusRow.current]?.focus();
    focusRow.current = undefined;
  }, [options.length]);
  const poll = makePoll(question, options.map((o) => o.text), { multiple, blind });
  const ok = !!poll.question && poll.options.length >= 2;
  const addOption = () => {
    focusRow.current = options.length;
    setOptions((cur) => [...cur, { id: uid(), text: "" }]);
  };
  const removeOption = (i: number) => {
    focusRow.current = Math.max(0, i - 1);
    setOptions((cur) => cur.filter((_, j) => j !== i));
  };
  const submit = async () => {
    if (!ok || posting) return;
    setPosting(true);
    setFailed(false);
    const posted = await useBots.getState().post(conversationId, { author: "me", text: poll.question, poll });
    if (posted) return onClose();
    setPosting(false);
    setFailed(true);
  };
  return (
    <dialog {...modal} className="bots-dialog" aria-label="New poll">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <DialogHead title="New poll" onClose={onClose} />
        <div className="bots-dialog-body">
          <label className="bots-field">
            <span className="bots-field-label">Question</span>
            <input className="input" value={question} maxLength={300} placeholder="What should the group weigh in on?" autoFocus onChange={(e) => setQuestion(e.target.value)} />
          </label>
          <div className="bots-field">
            <span className="bots-field-label">Options</span>
            <div ref={list} className="bots-poll-options">
              {options.map((o, i) => (
                <div key={o.id} className="bots-poll-option">
                  <span className="bm-option-key" aria-hidden>{String.fromCharCode(65 + i)}</span>
                  <input
                    className="input"
                    value={o.text}
                    maxLength={200}
                    placeholder={`Option ${String.fromCharCode(65 + i)}`}
                    aria-label={`Option ${String.fromCharCode(65 + i)}`}
                    onChange={(e) => setOptions((cur) => cur.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)))}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return;
                      if (e.key === "Backspace" && !o.text && options.length > 2) {
                        e.preventDefault();
                        removeOption(i);
                      }
                      // Enter moves down the list, then adds a row, and posts from an empty last one.
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      const inputs = list.current?.querySelectorAll("input");
                      if (i < options.length - 1) inputs?.[i + 1]?.focus();
                      else if (o.text.trim() && options.length < POLL_OPTIONS) addOption();
                      else void submit();
                    }}
                  />
                  {options.length > 2 && (
                    <IconButton label={`Remove option ${String.fromCharCode(65 + i)}`} tooltip={false} onClick={() => removeOption(i)}>
                      <X size={16} />
                    </IconButton>
                  )}
                </div>
              ))}
            </div>
            {options.length < POLL_OPTIONS && (
              <button type="button" className="bots-poll-add" onClick={addOption}>
                <Plus size={15} /> Add option
              </button>
            )}
          </div>
          <div className="bots-field">
            <span className="bots-field-label">Answers</span>
            <div className="segmented" role="radiogroup" aria-label="Answers">
              <button type="button" role="radio" aria-checked={!multiple} className="segment" onClick={() => setMultiple(false)}>
                Single answer
              </button>
              <button type="button" role="radio" aria-checked={multiple} className="segment" onClick={() => setMultiple(true)}>
                Multiple answers
              </button>
            </div>
          </div>
          <label className="bots-poll-check">
            <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
            Hide answers until each voter has answered
          </label>
          {failed && <div className="bots-poll-failed">The poll didn't post. Try again.</div>}
        </div>
        <div className="bots-dialog-foot">
          <button type="button" className="btn bots-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn bots-btn bots-btn-primary" disabled={!ok || posting}>
            {posting ? "Posting…" : "Post poll"}
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

export function ConfirmDeleteDialog({ title, body, action = <><Trash size={14} /> Delete</>, onConfirm, onClose }: { title: string; body: string; action?: React.ReactNode; onConfirm: () => void; onClose: () => void }) {
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
          {action}
        </button>
      </div>
    </dialog>
  );
}
