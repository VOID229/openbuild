import { ArrowUp, BookOpen, Check, CornerUpLeft, FileText, Folder, GripVertical, Pencil, Plus, Puzzle, Slash, Square, SquareTerminal, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Attachment, PiCommand, WorkspaceEntry } from "../../shared/types";
import { drainQueue, interruptWith, sendMessage, steerQueued, stopGeneration, uid } from "../lib/chat";
import { BUILTIN_COMMANDS, matchCommands, usePiCommands } from "../lib/commands";
import { compactThread } from "../lib/pi";
import { useFieldDictation } from "../lib/useFieldDictation";
import { draftsReady, getDraft, NEW_CHAT, onRemoteDraft, saveDraft } from "../lib/drafts";
import { ACCEPT, AttachmentError, formatBytes, readAttachment } from "../lib/files";
import { cachedEntries, loadEntries, matchEntries, readMentionFile } from "../lib/fileMentions";
import { runShell, shellCommand } from "../lib/shell";
import { enqueue, moveQueued, queueOf, removeQueued, setEditingQueued, updateQueued, useEditingQueued, useQueueOf, useSteeringOf, type Queued } from "../lib/queue";
import { threadDevice, useStore } from "../lib/store";
import { PluginSlot } from "../lib/plugins";
import { cx } from "../lib/ui";
import { openLightbox } from "./Lightbox";
import { EffortPicker, ModelPicker } from "./Pickers";
import { IconButton } from "./primitives";
import { DictationButton } from "./DictationButton";
import { WorkspaceBelow, WorkspaceTop } from "./Workspace";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

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

/** A message handed to Pi that it hasn't read yet; it shows in the thread once Pi does. */
function SteeringRow({ item }: { item: Queued }) {
  const file = item.files[0];
  const more = item.files.length - (item.text ? 0 : 1);
  return (
    <div className="queued queued-steering" data-queued-id={item.id}>
      <CornerUpLeft className="queued-file" size={14} />
      {file &&
        (file.mime.startsWith("image/") ? (
          <img className="queued-thumb" src={file.dataUrl} alt="" />
        ) : (
          <FileText className="queued-file" size={15} />
        ))}
      <span className="queued-text">{item.text || file?.name}</span>
      {more > 0 && <span className="queued-more">+{more}</span>}
      <span className="queued-status shimmer">Steering</span>
    </div>
  );
}

/** Queued messages, first to be sent on top. Drag a row's grip to reorder. */
interface TrayProps {
  chatId: string;
  queue: Queued[];
  /** Steered into the reply, waiting for Pi to read them. */
  steering: Queued[];
  onEdit: (item: Queued) => void;
  onFinish: (save: boolean) => void;
  /** A reply is coming in, so a message can interrupt it, or (Pi) steer it. */
  live?: "pi" | "other";
  onError: (message: string) => void;
}

function QueueTray({ chatId, queue, steering, onEdit, onFinish, live, onError }: TrayProps) {
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
      const others = Array.from(tray.current?.querySelectorAll<HTMLElement>(".queued:not(.queued-steering)") ?? []).filter((el) => el.dataset.queuedId !== id);
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
      {steering.map((q) => (
        <SteeringRow key={q.id} item={q} />
      ))}
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

/** A tiny colored badge for a file's extension, like an editor's file icon. */
const FILE_GLYPH: Record<string, { label: string; color: string }> = {
  ts: { label: "TS", color: "#4f8ff7" },
  tsx: { label: "TS", color: "#4f8ff7" },
  js: { label: "JS", color: "#e5c07b" },
  jsx: { label: "JS", color: "#e5c07b" },
  mjs: { label: "JS", color: "#e5c07b" },
  cjs: { label: "JS", color: "#e5c07b" },
  json: { label: "{}", color: "#d9b44a" },
  jsonl: { label: "{}", color: "#d9b44a" },
  css: { label: "CSS", color: "#a97bd8" },
  scss: { label: "CSS", color: "#a97bd8" },
  less: { label: "CSS", color: "#a97bd8" },
  html: { label: "<>" , color: "#e07a5f" },
  md: { label: "MD", color: "#7fb3d5" },
  mdx: { label: "MD", color: "#7fb3d5" },
  py: { label: "PY", color: "#62a8d8" },
  go: { label: "GO", color: "#5bc0de" },
  rs: { label: "RS", color: "#d08770" },
  yml: { label: "YML", color: "#c792ea" },
  yaml: { label: "YML", color: "#c792ea" },
  toml: { label: "TML", color: "#c792ea" },
  sh: { label: "SH", color: "#89ca78" },
};

function FileGlyph({ entry }: { entry: WorkspaceEntry }) {
  if (entry.dir) return <Folder className="mention-folder" size={17} aria-hidden />;
  const path = entry.path;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const glyph = FILE_GLYPH[ext] ?? { label: ext ? ext.slice(0, 2).toUpperCase() : "•", color: "var(--text-3)" };
  return (
    <span className="mention-icon" style={{ color: glyph.color }} aria-hidden>
      {glyph.label}
    </span>
  );
}

/** The "@" file and folder list, above (in a thread) or below (new thread) the composer. */
function MentionMenu({ entries, active, dropUp, onPick, onHover }: { entries: WorkspaceEntry[]; active: number; dropUp: boolean; onPick: (entry: WorkspaceEntry) => void; onHover: (i: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div ref={list} className={cx("slash-menu mention-menu", dropUp ? "slash-up" : "slash-down")} role="listbox" aria-label="Files and folders">
      {entries.map((entry, i) => {
        const slash = entry.path.lastIndexOf("/");
        const name = entry.path.slice(slash + 1);
        const dir = slash === -1 ? "" : entry.path.slice(0, slash);
        return (
          <button
            key={`${entry.dir ? "d" : "f"}:${entry.path}`}
            type="button"
            role="option"
            data-index={i}
            aria-selected={i === active}
            className="slash-item mention-item"
            // Keep focus (and the keyboard) in the textarea.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(entry)}
          >
            <FileGlyph entry={entry} />
            <span className="mention-name">{entry.dir ? `${name}/` : name}</span>
            {dir && <span className="mention-dir">{dir}</span>}
          </button>
        );
      })}
    </div>
  );
}

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

/** Phones only: keeps the box (and what's above it) above the keyboard by scrolling the empty state
 *  up just enough, and lets it back down when the keyboard goes away and there's nothing to scroll. */
function keepAboveKeyboard(wrap: HTMLElement) {
  const scroller = wrap.closest<HTMLElement>(".home");
  if (!scroller || !window.matchMedia("(pointer: coarse)").matches) return;
  // Typing in this box is what moved things: a reader who scrolled up stays where they are.
  if (!wrap.contains(document.activeElement)) return;
  const gap = scroller.getBoundingClientRect().bottom - wrap.getBoundingClientRect().bottom - 12;
  if (gap < 0) scroller.scrollTop -= gap;
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
  const steering = useSteeringOf(chatId);
  const piReply = useStore((s) => s.chats.find((c) => c.id === chatId)?.messages.findLast((m) => m.role === "assistant")?.model?.plan === "pi");
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
  const dictation = useFieldDictation({ value: text, setValue: setText, field: textarea, onError: setNotice, fallback: true });
  useEffect(() => { dictation.cancel(); }, [draftKey]);

  // Auto-size the textarea to its content.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  // On a phone the keyboard shrinks the screen, not the page, so the empty state has to be scrolled
  // to keep the box out from under it. Following the screen as it shrinks, rather than animating a
  // scroll of our own, makes the box ride the keyboard's own animation up — and back down when it
  // closes, as the scroll it needs shrinks to nothing.
  useEffect(() => {
    const wrap = textarea.current?.closest<HTMLElement>(".composer-wrap");
    const scroller = wrap?.closest<HTMLElement>(".home");
    if (!wrap || !scroller) return;
    // The screen shrinking (the keyboard) and the box growing (a long draft, an attachment) both
    // move the box relative to the bottom of the screen.
    const ro = new ResizeObserver(() => keepAboveKeyboard(wrap));
    ro.observe(scroller);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

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

  // "/" at the start (and no space yet) lists commands. Legacy threads always use Pi.
  const runtime = useStore((s) => chatId ? s.chats.find((c) => c.id === chatId)?.runtime ?? "pi" : s.settings.threadRuntime ?? "pi");
  const workspace = useStore((s) => (chatId ? s.chats.find((c) => c.id === chatId)?.workspace : undefined));
  const homeProject = useStore((s) => (chatId ? undefined : s.projects.find((p) => p.id === s.settings.workspace.projectId)));
  // The device new threads start on (their project's, or the one picked without a project): a chat without a workspace yet starts there.
  const prefDevice = useStore((s) => threadDevice(s));

  // "@" mentions scan where this thread works (its workspace), or the home screen's project.
  const mentionCwd = workspace?.cwd ?? homeProject?.path;
  const mentionDevice = workspace ? workspace.deviceId : prefDevice;
  const [mentionEntries, setMentionEntries] = useState<WorkspaceEntry[]>(() => cachedEntries(mentionCwd, mentionDevice) ?? []);
  useEffect(() => {
    let live = true;
    setMentionEntries(cachedEntries(mentionCwd, mentionDevice) ?? []);
    // Warm the index as soon as the composer appears, so the first "@" has nothing to wait for.
    // The scratch root (no project on the home screen) is scanned lazily on first mention instead.
    if (mentionCwd) {
      loadEntries(mentionCwd, false, mentionDevice).then(
        (entries) => live && setMentionEntries(entries),
        () => {},
      );
    }
    return () => {
      live = false;
    };
  }, [mentionCwd, mentionDevice]);
  const [mention, setMention] = useState<{ start: number; end: number; query: string }>();
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState<string>();
  const mentionKey = mention ? `${mention.start}:${mention.query}` : "";
  const mentionMatches = useMemo(() => {
    if (!mention || mentionDismissed === mentionKey) return [];
    return matchEntries(mentionEntries, mention.query, 50);
  }, [mention, mentionEntries, mentionDismissed, mentionKey]);
  useEffect(() => setMentionIndex(0), [mentionKey]);

  /** Track whether the caret sits in an "@word" token (and what it starts with). */
  const syncMention = (value: string, caret: number) => {
    const upto = value.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at === -1) return setMention(undefined);
    // Only at a word boundary: not inside an email address or a path.
    if (at > 0 && !/[\s([{]/.test(upto[at - 1]!)) return setMention(undefined);
    const query = upto.slice(at + 1);
    if (query.length > 200 || /\s/.test(query)) return setMention(undefined);
    setMention({ start: at, end: caret, query });
    // Refresh if the index is stale, so files the agent just created show up. Usually instant (cached).
    loadEntries(mentionCwd, false, mentionDevice).then(setMentionEntries, () => {});
  };

  const pickMention = (entry: WorkspaceEntry) => {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.end);
    // A file is finished with a space. A folder keeps the menu open on its contents, so you can
    // drill into it; type a space (or Esc) to stop at the folder itself. A command gets the bare path.
    const insert = `${shellMode ? "" : "@"}${entry.path}${entry.dir ? "/" : ""}${entry.dir ? "" : " "}`;
    setText(before + insert + after);
    if (entry.dir) {
      setMention({ start: mention.start, end: before.length + insert.length, query: `${entry.path}/` });
    } else if (shellMode) {
      setMention(undefined);
    } else {
      setMention(undefined);
      // Read a file's contents in the background; the prompt inlines them like any attached text file.
      const path = entry.path;
      void readMentionFile(mentionCwd, path, mentionDevice).then(
        (file) => setFiles((all) => (all.some((f) => f.mention && f.name === path) ? all : [...all, file])),
        (err: Error) => setNotice(err.message),
      );
    }
    requestAnimationFrame(() => {
      const el = textarea.current;
      if (!el) return;
      const pos = before.length + insert.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  // Deleting a mention from the text also drops the file it had attached (even if it arrives later).
  useEffect(() => {
    const tokens = new Set(text.split(/\s+/));
    setFiles((all) => {
      const stale = all.some((f) => f.mention && !tokens.has(`@${f.name}`));
      return stale ? all.filter((f) => !f.mention || tokens.has(`@${f.name}`)) : all;
    });
  }, [text, files]);

  const typedCommand = /^\/(\S*)$/.exec(text)?.[1];
  const [slashDismissed, setSlashDismissed] = useState<string>();
  const [slashIndex, setSlashIndex] = useState(0);
  const piCmds = usePiCommands(workspace?.cwd ?? homeProject?.path, runtime === "pi" && typedCommand !== undefined, mentionDevice);
  const slashMatches = useMemo(() => {
    if (typedCommand === undefined || slashDismissed === text) return [];
    const builtins = BUILTIN_COMMANDS.filter((c) => c.name !== "compact" || (chatId && runtime === "pi"));
    return matchCommands([...builtins, ...(runtime === "pi" ? piCmds ?? [] : [])], typedCommand).slice(0, 50);
  }, [typedCommand, piCmds, slashDismissed, text, chatId, runtime]);
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
    if (runtime === "durable") {
      setNotice("Durable does not support Pi's /compact command.");
      return true;
    }
    if (!chatId) return false;
    setNotice("Compacting…");
    compactThread(chatId, m[2]?.trim() || undefined, workspace?.deviceId).then(
      (r) => setNotice(`Compacted: ${Math.round(r.tokensBefore / 1000)}k → ${r.estimatedTokensAfter ? `~${Math.round(r.estimatedTokensAfter / 1000)}k` : "less"} tokens`),
      (err: Error) => setNotice(err.message),
    );
    return true;
  };

  const hasContent = text.trim().length > 0 || files.length > 0;
  // "!cmd" runs a command in the thread's folder and the agent sees it; "!!cmd" runs it for you alone.
  const shellMode = /^\s*!!/.test(text) ? "!!" : /^\s*!/.test(text) ? "!" : undefined;
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
    if (line.startsWith("!")) {
      // Runs right away, even while a reply is coming in: it doesn't queue behind it or interrupt it.
      if (!shellCommand(line)) return;
      if (files.length) return setNotice("A command can't take attachments. Remove them to run it.");
      void runShell(line, chatId).catch((err: Error) => setNotice(err.message));
      saveDraft(draftKey, "", []);
      setText("");
      return;
    }
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
    if (mentionMatches.length && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = mentionMatches.length;
        setMentionIndex((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      // Tab or Enter picks the highlighted file; the composer keeps the text and the file's contents.
      if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && mentionMatches[mentionIndex]) {
        e.preventDefault();
        pickMention(mentionMatches[mentionIndex]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionDismissed(mentionKey);
        return;
      }
    }
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
  // Mentioned files live in the text ("@path"), so they don't need a second chip above it.
  const chipFiles = files.filter((f) => !f.mention);

  return (
    <div className={cx("composer-wrap", `composer-${variant}`)}>
      {!chatId && <WorkspaceTop />}
      {queue.length + steering.length > 0 && chatId && <QueueTray chatId={chatId} queue={queue} steering={steering} onEdit={startEdit} onFinish={finishEdit} live={streaming ? (piReply && runtime === "pi" ? "pi" : "other") : undefined} onError={setNotice} />}
      {slashMatches.length > 0 && <SlashMenu commands={slashMatches} active={slashIndex} dropUp={variant === "dock"} onPick={pickCommand} onHover={setSlashIndex} />}
      {mentionMatches.length > 0 && <MentionMenu entries={mentionMatches} active={mentionIndex} dropUp={variant === "dock"} onPick={pickMention} onHover={setMentionIndex} />}
      <PluginSlot name="composer:above" context={{ variant, chatId }} />
      <div
        className={cx("composer", dragging && "composer-drag", shellMode && "composer-shell")}
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
        {chipFiles.length > 0 && (
          <div className="attachments">
            {chipFiles.map((f) => (
              <div key={f.id} className="attachment" title={f.name}>
                {f.mime.startsWith("image/") ? (
                  <button
                    type="button"
                    className="attachment-preview"
                    aria-label={`Preview ${f.name}`}
                    onClick={() => openLightbox(chipFiles.filter((x) => x.mime.startsWith("image/")), f.id)}
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
          {...dictation.fieldProps}
          className="composer-input"
          value={text}
          rows={variant === "home" ? 2 : 1}
          placeholder={editing ? "Edit queued message" : "Describe a task or ask a question"}
          aria-label="Message"
          onChange={(e) => {
            lastTyped.current = Date.now();
            setText(e.target.value);
            setMentionDismissed(undefined);
            syncMention(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => syncMention(e.currentTarget.value, e.currentTarget.selectionStart)}
          onClick={(e) => syncMention(e.currentTarget.value, e.currentTarget.selectionStart)}
          onSelect={(e) => syncMention(e.currentTarget.value, e.currentTarget.selectionStart)}
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
          <ModelPicker dropUp={variant === "dock"} deviceId={mentionDevice} />
          <EffortPicker dropUp={variant === "dock"} deviceId={mentionDevice} />
          <PluginSlot name="composer:toolbar" context={{ variant, chatId }} />
          {notice ? (
            <span className="composer-notice">{notice}</span>
          ) : (
            shellMode && (
              <span className="composer-mode">
                <SquareTerminal size={14} />
                {shellMode === "!!" ? "Command · only you see the output" : "Command · the agent sees the output"}
              </span>
            )
          )}
          <div className="composer-controls">
            <DictationButton dictation={dictation} className="round-btn round-btn-mic" size={17} tooltipSide={variant === "dock" ? "top" : "bottom"} />
            {queueing && !hasContent && !editing ? (
              <button type="button" className="round-btn" aria-label="Stop generating" data-tooltip="Stop" data-tooltip-side="top" onClick={() => stopGeneration(chatId)}>
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="round-btn"
                aria-label={editing ? "Save edit" : shellMode ? "Run command" : queueing ? "Queue message" : "Send message"}
                data-tooltip={editing ? "Save edit" : shellMode ? (queueing ? "Run now, without waiting for the reply" : "Run command") : hasContent ? (queueing ? "Queue to send after this reply" : hint) : undefined}
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
