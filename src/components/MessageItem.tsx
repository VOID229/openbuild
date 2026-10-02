import { Check, ChevronRight, CircleAlert, Copy, FileText, RotateCcw, Sparkles } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { forkWithModel, regenerate } from "../lib/chat";
import { formatBytes } from "../lib/files";
import type { Message, ModelRef } from "../lib/types";
import { copyText, cx } from "../lib/ui";
import { Markdown } from "./Markdown";
import { ModelMenu } from "./ModelSelect";
import { BrandIcon, IconButton, Popover } from "./primitives";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? "Copied" : "Copy"}
      tooltipSide="top"
      className="msg-action"
      onClick={async () => {
        await copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </IconButton>
  );
}

function useElapsed(since: number | undefined, active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
}

function Reasoning({ message }: { message: Message }) {
  const thinking = message.status === "streaming" && !message.content;
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(message.startedAt, thinking);
  const seconds = message.reasoningMs != null ? Math.max(1, Math.round(message.reasoningMs / 1000)) : elapsed;
  return (
    <div className={cx("reasoning", open && "reasoning-open")}>
      <button type="button" className="reasoning-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={cx(thinking && "shimmer")}>{thinking ? "Thinking" : `Thought for ${seconds}s`}</span>
        <ChevronRight size={14} className="reasoning-chevron" />
      </button>
      <div className="reasoning-body" hidden={!open}>
        {open && <Markdown content={message.reasoning ?? ""} className="markdown-muted" />}
      </div>
    </div>
  );
}

function UserMessage({ message }: { message: Message }) {
  return (
    <div className="msg msg-user" data-message-id={message.id}>
      {message.attachments?.length ? (
        <div className="msg-attachments">
          {message.attachments.map((a) =>
            a.mime.startsWith("image/") ? (
              <a key={a.id} href={a.dataUrl} target="_blank" rel="noreferrer" className="msg-image">
                <img src={a.dataUrl} alt={a.name} />
              </a>
            ) : (
              <span key={a.id} className="attachment-file msg-file" title={a.name}>
                <FileText size={16} />
                <span>
                  <span className="attachment-name">{a.name}</span>
                  <span className="attachment-meta">{formatBytes(a.size)}</span>
                </span>
              </span>
            ),
          )}
        </div>
      ) : null}
      {message.content && <div className="bubble">{message.content}</div>}
      <div className="msg-actions msg-actions-end">
        <CopyButton text={message.content} />
      </div>
    </div>
  );
}

/** "2nd": fork the chat at this reply and answer the same question with another model. */
function SecondOpinion({ chatId, messageId, current }: { chatId: string; messageId: string; current?: ModelRef }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="msg-second"
        aria-label="Get a second opinion from another model"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tooltip={open ? undefined : "Get a second opinion from another model"}
        data-tooltip-side="top"
        onClick={() => setOpen((o) => !o)}
      >
        2nd
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu select-menu model-select-menu" role="listbox" label="Answer with" fixed="auto">
        <div className="menu-label menu-label-top">Get a second opinion from…</div>
        <ModelMenu
          selected={current}
          onPick={(ref) => {
            setOpen(false);
            forkWithModel(chatId, messageId, ref);
          }}
        />
      </Popover>
    </>
  );
}

function AssistantMessage({ message, chatId, isLast }: { message: Message; chatId: string; isLast: boolean }) {
  const streaming = message.status === "streaming";
  const waiting = streaming && !message.content && !message.reasoning;
  return (
    <div className={cx("msg msg-assistant", isLast && "msg-last")} data-message-id={message.id}>
      {message.reasoning && <Reasoning message={message} />}
      {waiting && (
        <div className="typing" aria-label="Waiting for response">
          <span />
          <span />
          <span />
        </div>
      )}
      {message.content && <Markdown content={message.content} className={cx(streaming && "markdown-streaming")} />}
      {message.status === "error" && (
        <div className="msg-error" role="alert">
          <CircleAlert size={16} />
          <span>{message.error ?? "Something went wrong."}</span>
          <button type="button" className="btn btn-sm" onClick={() => regenerate(chatId, message.id)}>
            Retry
          </button>
        </div>
      )}
      {message.notice && <div className="msg-notice">{message.notice}</div>}
      {!streaming && (
        <div className="msg-actions">
          {message.model && (
            <span className="msg-model" title={message.routed ? "Picked by the auto router" : undefined}>
              {message.routed ? <Sparkles size={13} /> : <BrandIcon id={message.model.id} />}
              {message.model.name}
              {message.status === "stopped" && <span className="msg-stopped">· stopped</span>}
            </span>
          )}
          {message.content && <CopyButton text={message.content} />}
          {isLast && message.status !== "error" && (
            <IconButton label="Regenerate" tooltipSide="top" className="msg-action" onClick={() => regenerate(chatId, message.id)}>
              <RotateCcw size={15} />
            </IconButton>
          )}
          <SecondOpinion chatId={chatId} messageId={message.id} current={message.model} />
        </div>
      )}
    </div>
  );
}

export const MessageItem = memo(function MessageItem({ message, chatId, isLast }: { message: Message; chatId: string; isLast: boolean }) {
  return message.role === "user" ? <UserMessage message={message} /> : <AssistantMessage message={message} chatId={chatId} isLast={isLast} />;
});
