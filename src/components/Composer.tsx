import { ArrowUp, FileText, Mic, Plus, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Attachment } from "../../shared/types";
import { sendMessage, stopGeneration } from "../lib/chat";
import { ACCEPT, AttachmentError, formatBytes, readAttachment } from "../lib/files";
import { useStore } from "../lib/store";
import { cx } from "../lib/ui";
import { EffortPicker, ModelPicker } from "./Pickers";
import { IconButton } from "./primitives";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

interface Props {
  /** Home: dropdowns open below. Docked at the bottom of a chat: they open upward. */
  variant: "home" | "dock";
  chatId?: string;
  streaming: boolean;
}

export function Composer({ variant, chatId, streaming }: Props) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const cmdEnter = useStore((s) => s.settings.cmdEnter);

  // Auto-size the textarea to its content.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

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
    if (sendMessage(text.trim(), files)) {
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
                  <img src={f.dataUrl} alt="" />
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
          placeholder={variant === "dock" ? "Reply…" : undefined}
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
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
              className="round-btn round-btn-muted"
              aria-label="Dictation (coming soon)"
              aria-disabled
              data-tooltip="Dictation coming soon"
              data-tooltip-side={variant === "dock" ? "top" : "bottom"}
              onClick={() => textarea.current?.focus()}
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
