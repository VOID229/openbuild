import { Check, ChevronRight, CircleAlert, Copy, FileText, Globe, RotateCcw, Sparkles } from "lucide-react";
import { SEARCH_PROVIDERS } from "../../shared/types";
import { memo, useEffect, useRef, useState } from "react";
import { forkWithModel, regenerate } from "../lib/chat";
import { formatBytes } from "../lib/files";
import { useStore } from "../lib/store";
import type { Message, ModelRef, SearchCall } from "../lib/types";
import { copyText, cx } from "../lib/ui";
import { openLightbox } from "./Lightbox";
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

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function SearchRow({ call }: { call: SearchCall }) {
  const label = SEARCH_PROVIDERS[call.provider]?.label ?? call.provider;
  return (
    <li className="search-call">
      <div className="search-call-head">
        <span className="search-provider">{label}</span>
        <span className={cx("search-query", call.status === "running" && "shimmer")}>{call.query || "…"}</span>
        <span className={cx("search-meta", call.status === "error" && "bad")}>
          {call.status === "running" ? "searching" : call.status === "error" ? (call.error ?? "failed") : `${call.results?.length ?? 0} results${call.digested ? " · summarized" : ""}`}
        </span>
      </div>
      {call.results?.length ? (
        <ul className="search-results">
          {call.results.map((r, i) => (
            <li key={`${r.url}-${i}`}>
              <a href={r.url} target="_blank" rel="noopener noreferrer" title={r.url}>
                <span className="search-result-title">{r.title}</span>
                <span className="search-result-host">{hostOf(r.url)}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Web searches the model ran for this reply. */
function Searches({ searches }: { searches: SearchCall[] }) {
  const [open, setOpen] = useState(false);
  const running = searches.filter((s) => s.status === "running");
  const sources = searches.reduce((n, s) => n + (s.results?.length ?? 0), 0);
  const current = running[running.length - 1];
  const summary = current
    ? `Searching ${SEARCH_PROVIDERS[current.provider]?.label ?? "the web"}: ${current.query}`
    : `Searched the web${searches.length > 1 ? ` ${searches.length} times` : ""} · ${sources} source${sources === 1 ? "" : "s"}`;
  return (
    <div className={cx("reasoning searches", open && "reasoning-open")}>
      <button type="button" className="reasoning-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Globe size={13} />
        <span className={cx("searches-summary", current && "shimmer")}>{summary}</span>
        <ChevronRight size={14} className="reasoning-chevron" />
      </button>
      {open && (
        <ul className="reasoning-body search-calls">
          {searches.map((c) => (
            <SearchRow key={c.id} call={c} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Every image sent in the chat, so the preview can step through all of them. */
function chatImages(chatId: string) {
  const chat = useStore.getState().chats.find((c) => c.id === chatId);
  return (chat?.messages ?? []).flatMap((m) => m.attachments?.filter((a) => a.mime.startsWith("image/")) ?? []);
}

function UserMessage({ message, chatId }: { message: Message; chatId: string }) {
  return (
    <div className="msg msg-user" data-message-id={message.id}>
      {message.attachments?.length ? (
        <div className="msg-attachments">
          {message.attachments.map((a) =>
            a.mime.startsWith("image/") ? (
              <button key={a.id} type="button" className="msg-image" aria-label={`Preview ${a.name}`} onClick={() => openLightbox(chatImages(chatId), a.id)}>
                <img src={a.dataUrl} alt={a.name} />
              </button>
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
  const waiting = streaming && !message.content && !message.reasoning && !message.searches?.some((s) => s.status === "running");
  return (
    <div className={cx("msg msg-assistant", isLast && "msg-last")} data-message-id={message.id}>
      {message.reasoning && <Reasoning message={message} />}
      {message.searches?.length ? <Searches searches={message.searches} /> : null}
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
              <span className="msg-model-name">
                {message.model.name}
                {message.status === "stopped" && <span className="msg-stopped"> · stopped</span>}
              </span>
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
  return message.role === "user" ? <UserMessage message={message} chatId={chatId} /> : <AssistantMessage message={message} chatId={chatId} isLast={isLast} />;
});
