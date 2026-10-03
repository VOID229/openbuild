import { ArrowUp, FileText, Mic, Plus, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Attachment } from "../../shared/types";
import { sendMessage, stopGeneration } from "../lib/chat";
import { dictationSupported, useDictation } from "../lib/dictation";
import { draftsReady, getDraft, NEW_CHAT, onRemoteDraft, saveDraft } from "../lib/drafts";
import { ACCEPT, AttachmentError, formatBytes, readAttachment } from "../lib/files";
import { useStore } from "../lib/store";
import { cx } from "../lib/ui";
import { openLightbox } from "./Lightbox";
import { EffortPicker, ModelPicker } from "./Pickers";
import { IconButton } from "./primitives";

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
  // Text in the box when dictation started; the live transcript is appended after it.
  const dictationBase = useRef("");
  const dictation = useDictation(
    (transcript) => {
      const base = dictationBase.current;
      const heard = transcript.trim();
      setText(base && heard && !/\s$/.test(base) ? `${base} ${heard}` : base + heard);
    },
    setNotice,
  );

  const toggleDictation = () => {
    if (dictation.listening) return dictation.stop();
    if (!dictationSupported) {
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
      if (key !== draftKey || Date.now() - lastTyped.current < TYPING_PAUSE) return;
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
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) saveDraft(draftKey, text, files);
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

  const canSend = (text.trim().length > 0 || files.length > 0) && !streaming;

  const submit = () => {
    if (!canSend) return;
    dictation.stop();
    if (sendMessage(text.trim(), files)) {
      // Sending from the new-chat screen unmounts this composer before its save effect could run.
      saveDraft(draftKey, "", []);
      setText("");
      setFiles([]);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
          placeholder="Ask anything"
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
          {notice && <span className="composer-notice">{notice}</span>}
          <div className="composer-controls">
            <EffortPicker dropUp={variant === "dock"} />
            <ModelPicker dropUp={variant === "dock"} />
            <button
              type="button"
              className={cx("round-btn round-btn-mic", dictation.listening && "round-btn-listening")}
              aria-label={dictation.listening ? "Stop dictation" : "Dictate"}
              aria-pressed={dictation.listening}
              data-tooltip={dictation.listening ? "Stop dictation" : "Dictate"}
              data-tooltip-side={variant === "dock" ? "top" : "bottom"}
              onClick={toggleDictation}
            >
              <Mic size={17} />
            </button>
            {streaming && chatId ? (
              <button type="button" className="round-btn" aria-label="Stop generating" data-tooltip="Stop" data-tooltip-side="top" onClick={() => stopGeneration(chatId)}>
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="round-btn"
                aria-label="Send message"
                data-tooltip={canSend ? hint : undefined}
                data-tooltip-side={variant === "dock" ? "top" : "bottom"}
                disabled={!canSend}
                onClick={submit}
              >
                <ArrowUp size={18} strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
