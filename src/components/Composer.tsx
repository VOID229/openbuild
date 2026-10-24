import { ArrowUp, BookOpen, Check, CornerUpLeft, FileText, GripVertical, Mic, Pencil, Plus, Puzzle, Slash, Square, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Attachment, PiCommand } from "../../shared/types";
import { drainQueue, interruptWith, sendMessage, steerQueued, stopGeneration, uid } from "../lib/chat";
import { BUILTIN_COMMANDS, matchCommands, usePiCommands } from "../lib/commands";
import { compactThread } from "../lib/pi";
import { dictationSupported, useDictation } from "../lib/dictation";
import { draftsReady, getDraft, NEW_CHAT, onRemoteDraft, saveDraft } from "../lib/drafts";
import { ACCEPT, AttachmentError, formatBytes, readAttachment } from "../lib/files";
import { enqueue, moveQueued, queueOf, removeQueued, setEditingQueued, updateQueued, useEditingQueued, useQueueOf, type Queued } from "../lib/queue";
import { useStore } from "../lib/store";
import { PluginSlot } from "../lib/plugins";
import { cx } from "../lib/ui";
import { openLightbox } from "./Lightbox";
import { EffortPicker, ModelPicker } from "./Pickers";
import { IconButton } from "./primitives";
import { WorkspaceBelow, WorkspaceTop } from "./Workspace";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const isIOS = typeof navigator !== "undefined" && (/iPhone|iPad/.test(navigator.platform) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** A draft from another device doesn't replace the text while you've typed within this long. */
const TYPING_PAUSE = 3000;

interface Props {
  /** Home: dropdowns open below. Docked at the bottom of a chat: they open upward. */
  variant: "home" | "dock";
  chatId?: string;
  streaming: boolean;
}

/** A queued message open in the box to edit, and the draft set aside meanwhile. */
interface Editing {
  id: string;
  stash: { text: string; files: Attachment[] };
}

interface RowProps {
  item: Queued;
  editing: boolean;
  dragging: boolean;
  onGrab: (e: React.PointerEvent) => void;
  onNudge: (by: number) => void;
  onEdit: () => void;
  onDelete: () => void;
  onFinish: (save: boolean) => void;
  /** While a reply is coming in: stop it and send this now. */
  onInterrupt?: () => void;
  /** While Pi is working: hand this to it now, without stopping. */
  onSteer?: () => void;
}

function QueuedRow({ item, editing, dragging, onGrab, onNudge, onEdit, onDelete, onFinish, onInterrupt, onSteer }: RowProps) {
  const file = item.files[0];
  const more = item.files.length - (item.text ? 0 : 1);
  if (editing) {
    return (
      <div className="queued queued-editing" data-queued-id={item.id}>
        <span className="queued-text">Editing in composer</span>
        <IconButton label="Save edit" tooltip="Save edit · Enter" tooltipSide="top" className="queued-btn" onClick={() => onFinish(true)}>
          <Check size={15} />
        </IconButton>
        <IconButton label="Cancel edit" tooltip="Cancel edit · Esc" tooltipSide="top" className="queued-btn" onClick={() => onFinish(false)}>
          <X size={15} />
        </IconButton>
      </div>
    );
  }
  return (
    <div className={cx("queued", dragging && "queued-dragging")} data-queued-id={item.id}>
      <button
        type="button"
        className="queued-grip"
        aria-label="Reorder (drag, or Alt+↑/↓)"
        onPointerDown={onGrab}
        onKeyDown={(e) => {
          if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          e.preventDefault();
          onNudge(e.key === "ArrowUp" ? -1 : 1);
        }}
      >
        <GripVertical size={14} />
      </button>
      {file &&
        (file.mime.startsWith("image/") ? (
          <img className="queued-thumb" src={file.dataUrl} alt="" />
        ) : (
          <FileText className="queued-file" size={15} />
        ))}
      <span className="queued-text">{item.text || file?.name}</span>
      {more > 0 && <span className="queued-more">+{more}</span>}
      <IconButton label="Delete queued message" tooltipSide="top" className="queued-btn" onClick={onDelete}>
        <Trash2 size={15} />
      </IconButton>
      <IconButton label="Edit queued message" tooltipSide="top" className="queued-btn" onClick={onEdit}>
        <Pencil size={15} />
      </IconButton>
      {onSteer && (
        <IconButton label="Steer" tooltip="Steer · Pi reads it after its current step" tooltipSide="top" className="queued-btn queued-steer" onClick={onSteer}>
          <CornerUpLeft size={15} />
        </IconButton>
      )}
      {onInterrupt && (
        <IconButton label="Send now" tooltip="Send now · stops the reply" tooltipSide="top" className="queued-btn queued-steer" onClick={onInterrupt}>
          <ArrowUp size={15} />
        </IconButton>
      )}
    </div>
  );
}

/** Queued messages, first to be sent on top. Drag a row's grip to reorder. */
interface TrayProps {
  chatId: string;
  queue: Queued[];
  onEdit: (item: Queued) => void;
  onFinish: (save: boolean) => void;
  /** A reply is coming in, so a message can interrupt it, or (Pi) steer it. */
  live?: "pi" | "other";
  onError: (message: string) => void;
}

function QueueTray({ chatId, queue, onEdit, onFinish, live, onError }: TrayProps) {
  const tray = useRef<HTMLDivElement>(null);
  const editingId = useEditingQueued(chatId);
  const [dragId, setDragId] = useState<string>();

  const grab = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDragId(id);
    // Listen on the window: reordering moves rows in the DOM, which would drop pointer capture.
    const move = (ev: PointerEvent) => {
      // The slot is how many of the other rows sit above the pointer.
      const others = Array.from(tray.current?.querySelectorAll<HTMLElement>(".queued") ?? []).filter((el) => el.dataset.queuedId !== id);
      const to = others.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2 < ev.clientY;
      }).length;
      if (queueOf(chatId).findIndex((q) => q.id === id) !== to) moveQueued(chatId, id, to);
    };
    const end = () => {
      setDragId(undefined);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  return (
    <div ref={tray} className={cx("queue", dragId && "queue-dragging")} aria-label="Queued messages">
      {queue.map((q, i) => (
        <QueuedRow
          key={q.id}
          item={q}
          editing={q.id === editingId}
          dragging={q.id === dragId}
          onGrab={grab(q.id)}
          onNudge={(by) => {
            moveQueued(chatId, q.id, i + by);
            // Keep focus on the grip of the row that moved.
            requestAnimationFrame(() => tray.current?.querySelector<HTMLElement>(`[data-queued-id="${q.id}"] .queued-grip`)?.focus());
          }}
          onEdit={() => onEdit(q)}
          onDelete={() => removeQueued(chatId, q.id)}
          onFinish={onFinish}
          onInterrupt={live ? () => interruptWith(chatId, q.id) : undefined}
          onSteer={live === "pi" ? () => steerQueued(chatId, q.id).catch((err: Error) => onError(err.message)) : undefined}
        />
      ))}
    </div>
  );
}

const SOURCE_ICON = { extension: Puzzle, prompt: FileText, skill: BookOpen, openbuild: Slash } as const;

/** The "/" command list, above (in a thread) or below (new thread) the composer. */
function SlashMenu({ commands, active, dropUp, onPick, onHover }: { commands: PiCommand[]; active: number; dropUp: boolean; onPick: (c: PiCommand) => void; onHover: (i: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div ref={list} className={cx("slash-menu", dropUp ? "slash-up" : "slash-down")} role="listbox" aria-label="Commands">
      {commands.map((c, i) => {
        const Icon = SOURCE_ICON[c.source] ?? Slash;
        return (
          <button
            key={`${c.source}:${c.name}`}
            type="button"
            role="option"
            data-index={i}
            aria-selected={i === active}
            className="slash-item"
            // Keep focus (and the keyboard) in the textarea.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(c)}
          >
            <Icon size={14} className="slash-icon" />
            <span className="slash-name">/{c.name}</span>
            {c.description && <span className="slash-desc">{c.description}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Composer({ variant, chatId, streaming }: Props) {
  const draftKey = chatId ?? NEW_CHAT;
  const lastTyped = useRef(0);
  const [text, setText] = useState(() => getDraft(draftKey)?.text ?? "");
  const [files, setFiles] = useState<Attachment[]>(() => getDraft(draftKey)?.files ?? []);
  const [notice, setNotice] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const cmdEnter = useStore((s) => s.settings.cmdEnter);
  const queue = useQueueOf(chatId);
  const piReply = useStore((s) => s.chats.find((c) => c.id === chatId)?.messages.at(-1)?.model?.plan === "pi");
  const [editing, setEditing] = useState<Editing>();
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // Leaving the chat mid-edit keeps the message as it was (the draft was never overwritten).
  useEffect(
    () => () => {
      if (!editingRef.current || !chatId) return;
      setEditingQueued(chatId, undefined);
      drainQueue(chatId);
    },
    [],
  );
  // A plugin can put text in the composer (openbuild.insertComposerText).
  useEffect(() => {
    const onInsert = (e: Event) => {
      const value = (e as CustomEvent<{ text?: unknown }>).detail?.text;
      if (typeof value !== "string" || !value) return;
      setText((current) => (current ? `${current}${current.endsWith("\n") ? "" : "\n"}${value}` : value));
      textarea.current?.focus();
    };
    window.addEventListener("openbuild:composer-insert", onInsert);
    return () => window.removeEventListener("openbuild:composer-insert", onInsert);
  }, []);
  // Text in the box when dictation started; the live transcript is appended after it.
  const dictationBase = useRef("");
  const dictationSettings = useStore((s) => s.settings.dictation);
  const dictation = useDictation(
    (transcript) => {
      const base = dictationBase.current;
      const heard = transcript.trim();
      if (dictationSettings?.enabled) {
        // Whisper returns once, after recording; preserve anything typed while it transcribed.
        if (heard) setText((current) => current && !/\s$/.test(current) ? `${current} ${heard}` : current + heard);
      } else {
        setText(base && heard && !/\s$/.test(base) ? `${base} ${heard}` : base + heard);
      }
    },
    setNotice,
    dictationSettings,
  );
  useEffect(() => { dictation.cancel(); }, [draftKey]);

  const toggleDictation = () => {
    if (dictation.listening) return dictation.stop();
    if (dictation.busy) return;
    if (!dictationSettings?.enabled && !dictationSupported) {
      // No speech API in this browser: hand off to the OS's own dictation on the focused box.
      textarea.current?.focus();
      setNotice(isIOS ? "Tap the mic on the keyboard to dictate." : isMac ? "Press Fn twice (or 🎤) to dictate." : "Dictation isn't supported in this browser.");
      return;
    }
    dictationBase.current = text;
    textarea.current?.focus();
    dictation.start();
  };

  // Auto-size the textarea to its content.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  // Right after a reload the saved drafts may still be loading; fill them in unless typing has started.
  useEffect(() => {
    let live = true;
    void draftsReady.then(() => {
      const d = getDraft(draftKey);
      if (!live || !d) return;
      setText((t) => t || d.text);
      setFiles((f) => (f.length ? f : d.files));
    });
    // An edit from another device shows up here, unless you're typing in this box right now.
    const off = onRemoteDraft((key) => {
      if (key !== draftKey || editingRef.current || Date.now() - lastTyped.current < TYPING_PAUSE) return;
      const d = getDraft(key);
      setText(d?.text ?? "");
      setFiles(d?.files ?? []);
    });
    return () => {
      live = false;
      off();
    };
  }, [draftKey]);

  // Save the draft as it changes (not on mount, which would stamp an untouched draft as fresh).
  // While a queued message is being edited the box holds that message, not the draft.
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current && !editing) saveDraft(draftKey, text, files);
    mounted.current = true;
  }, [text, files]);

  // Focus on mount / chat switch (skip on touch devices to avoid popping the keyboard).
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) textarea.current?.focus();
  }, [chatId]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(undefined), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const addFiles = async (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      try {
        const a = await readAttachment(file);
        setFiles((f) => [...f, a]);
      } catch (err) {
        setNotice(err instanceof AttachmentError ? err.message : `Couldn't read ${file.name}.`);
      }
    }
  };

  // "/" at the start (and no space yet) lists commands.
  const workspace = useStore((s) => (chatId ? s.chats.find((c) => c.id === chatId)?.workspace : undefined));
  const homeProject = useStore((s) => (chatId ? undefined : s.projects.find((p) => p.id === s.settings.workspace.projectId)));
  const typedCommand = /^\/(\S*)$/.exec(text)?.[1];
  const [slashDismissed, setSlashDismissed] = useState<string>();
  const [slashIndex, setSlashIndex] = useState(0);
  const piCmds = usePiCommands(workspace?.cwd ?? homeProject?.path, typedCommand !== undefined);
  const slashMatches = useMemo(() => {
    if (typedCommand === undefined || slashDismissed === text) return [];
    const builtins = BUILTIN_COMMANDS.filter((c) => c.name !== "compact" || chatId);
    return matchCommands([...builtins, ...(piCmds ?? [])], typedCommand).slice(0, 50);
  }, [typedCommand, piCmds, slashDismissed, text, chatId]);
  useEffect(() => setSlashIndex(0), [typedCommand]);
  const pickCommand = (c: PiCommand) => {
    setText(`/${c.name} `);
    textarea.current?.focus();
  };

  /** Commands OpenBuild runs itself instead of sending to Pi. Returns true when handled. */
  const runBuiltin = (line: string): boolean => {
    const m = /^\/(compact|new)\b\s*([\s\S]*)$/.exec(line);
    if (!m) return false;
    if (m[1] === "new") {
      useStore.getState().newChat();
      return true;
    }
    if (!chatId) return false;
    setNotice("Compacting…");
    compactThread(chatId, m[2]?.trim() || undefined).then(
      (r) => setNotice(`Compacted: ${Math.round(r.tokensBefore / 1000)}k → ${r.estimatedTokensAfter ? `~${Math.round(r.estimatedTokensAfter / 1000)}k` : "less"} tokens`),
      (err: Error) => setNotice(err.message),
    );
    return true;
  };

  const hasContent = text.trim().length > 0 || files.length > 0;
  // While a reply is coming in, sending queues the message instead.
  const queueing = streaming && !!chatId;

  const fill = (next: { text: string; files: Attachment[] }) => {
    setText(next.text);
    setFiles(next.files);
  };

  /** Store the edit in the message's slot; an emptied message is dropped. */
  const saveEdit = (id: string) => {
    if (!chatId) return;
    if (hasContent) updateQueued(chatId, id, { text: text.trim(), files });
    else removeQueued(chatId, id);
  };

  const startEdit = (item: Queued) => {
    if (!chatId) return;
    dictation.cancel();
    let stash = { text, files };
    if (editing) {
      // Switching to another queued message keeps the edit made so far.
      saveEdit(editing.id);
      stash = editing.stash;
    }
    setEditing({ id: item.id, stash });
    setEditingQueued(chatId, item.id);
    fill(item);
    textarea.current?.focus();
  };

  /** Close the edit (saving it or not) and bring back the draft. */
  const finishEdit = (save: boolean) => {
    if (!editing || !chatId) return;
    dictation.cancel();
    if (save) saveEdit(editing.id);
    fill(editing.stash);
    setEditing(undefined);
    setEditingQueued(chatId, undefined);
    // The reply may have finished meanwhile.
    drainQueue(chatId);
    textarea.current?.focus();
  };

  // The message being edited was sent or deleted elsewhere (e.g. its chat was cleared): drop the edit.
  useEffect(() => {
    if (editing && !queue.some((q) => q.id === editing.id)) {
      fill(editing.stash);
      setEditing(undefined);
      if (chatId) setEditingQueued(chatId, undefined);
    }
  }, [queue]);

  /** Send the composer's text, or `line` instead of it (a command picked from the "/" menu). */
  const submit = (line = text.trim()) => {
    if (editing) return finishEdit(true);
    if (!line && !files.length) return;
    dictation.cancel();
    if (!files.length && runBuiltin(line)) {
      saveDraft(draftKey, "", []);
      setText("");
      return;
    }
    if (queueing && chatId) {
      enqueue(chatId, { id: uid(), text: line, files });
      saveDraft(draftKey, "", []);
      setText("");
      setFiles([]);
    } else if (sendMessage(line, files)) {
      // Sending from the new-chat screen unmounts this composer before its save effect could run.
      saveDraft(draftKey, "", []);
      setText("");
      setFiles([]);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMatches.length && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = slashMatches.length;
        setSlashIndex((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      // Tab completes the command so arguments can follow; Enter runs it straight away.
      if (e.key === "Tab" && slashMatches[slashIndex]) {
        e.preventDefault();
        pickCommand(slashMatches[slashIndex]!);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && slashMatches[slashIndex]) {
        e.preventDefault();
        // A queued message being edited only gets the command written in.
        if (editing) pickCommand(slashMatches[slashIndex]!);
        else submit(`/${slashMatches[slashIndex]!.name}`);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(text);
        return;
      }
    }
    if (e.key === "Escape" && editing) {
      e.preventDefault();
      return finishEdit(false);
    }
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (cmdEnter ? mod : !e.shiftKey && !mod) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (images.length) {
      e.preventDefault();
      void addFiles(images);
    }
  };

  const hint = cmdEnter ? `${isMac ? "⌘" : "Ctrl"}+Enter to send` : "Enter to send · Shift+Enter for a new line";

  return (
    <div className={cx("composer-wrap", `composer-${variant}`)}>
      {!chatId && <WorkspaceTop />}
      {queue.length > 0 && chatId && <QueueTray chatId={chatId} queue={queue} onEdit={startEdit} onFinish={finishEdit} live={streaming ? (piReply ? "pi" : "other") : undefined} onError={setNotice} />}
      {slashMatches.length > 0 && <SlashMenu commands={slashMatches} active={slashIndex} dropUp={variant === "dock"} onPick={pickCommand} onHover={setSlashIndex} />}
      <PluginSlot name="composer:above" context={{ variant, chatId }} />
      <div
        className={cx("composer", dragging && "composer-drag")}
        onClick={(e) => {
          if (e.target === e.currentTarget) textarea.current?.focus();
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addFiles(e.dataTransfer.files);
        }}
      >
        {files.length > 0 && (
          <div className="attachments">
            {files.map((f) => (
              <div key={f.id} className="attachment" title={f.name}>
                {f.mime.startsWith("image/") ? (
                  <button
                    type="button"
                    className="attachment-preview"
                    aria-label={`Preview ${f.name}`}
                    onClick={() => openLightbox(files.filter((x) => x.mime.startsWith("image/")), f.id)}
                  >
                    <img src={f.dataUrl} alt="" />
                  </button>
                ) : (
                  <span className="attachment-file">
                    <FileText size={16} />
                    <span>
                      <span className="attachment-name">{f.name}</span>
                      <span className="attachment-meta">{formatBytes(f.size)}</span>
                    </span>
                  </span>
                )}
                <button type="button" className="attachment-remove" aria-label={`Remove ${f.name}`} onClick={() => setFiles((all) => all.filter((x) => x.id !== f.id))}>
                  <X size={12} strokeWidth={2.5} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          className="composer-input"
          value={text}
          rows={variant === "home" ? 2 : 1}
          placeholder={editing ? "Edit queued message" : "Describe a task or ask a question"}
          aria-label="Message"
          onChange={(e) => {
            lastTyped.current = Date.now();
            setText(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="composer-bar">
          <IconButton label="Attach files" tooltipSide={variant === "dock" ? "top" : "bottom"} className="attach-btn" onClick={() => picker.current?.click()}>
            <Plus size={20} />
          </IconButton>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            accept={ACCEPT}
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <ModelPicker dropUp={variant === "dock"} />
          <EffortPicker dropUp={variant === "dock"} />
          <PluginSlot name="composer:toolbar" context={{ variant, chatId }} />
          {notice && <span className="composer-notice">{notice}</span>}
          <div className="composer-controls">
            <button
              type="button"
              className={cx("round-btn round-btn-mic", dictation.listening && "round-btn-listening")}
              disabled={dictation.busy}
              aria-busy={dictation.busy}
              data-local-dictation={dictationSettings?.enabled || undefined}
              aria-label={dictation.busy ? "Transcribing…" : dictation.listening ? "Stop dictation" : "Dictate"}
              aria-pressed={dictation.listening}
              data-tooltip={dictation.busy ? "Transcribing…" : dictation.listening ? "Stop dictation" : "Dictate"}
              data-tooltip-side={variant === "dock" ? "top" : "bottom"}
              onClick={toggleDictation}
            >
              <Mic size={17} />
            </button>
            {queueing && !hasContent && !editing ? (
              <button type="button" className="round-btn" aria-label="Stop generating" data-tooltip="Stop" data-tooltip-side="top" onClick={() => stopGeneration(chatId)}>
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="round-btn"
                aria-label={editing ? "Save edit" : queueing ? "Queue message" : "Send message"}
                data-tooltip={editing ? "Save edit" : hasContent ? (queueing ? "Queue to send after this reply" : hint) : undefined}
                data-tooltip-side={variant === "dock" ? "top" : "bottom"}
                disabled={!hasContent && !editing}
                onClick={() => submit()}
              >
                <ArrowUp size={18} strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>
      </div>
      <PluginSlot name="composer:below" context={{ variant, chatId }} />
      {chatId && <WorkspaceBelow chatId={chatId} streaming={streaming} />}
    </div>
  );
}
