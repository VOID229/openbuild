import { Check, ChevronLeft, ChevronRight, CircleAlert, Copy, FileText, Globe, RotateCcw, Sparkles } from "lucide-react";
import { SEARCH_PROVIDERS, type Effort } from "../../shared/types";
import { memo, useEffect, useRef, useState } from "react";
import { forkWithModel, regenerate } from "../lib/chat";
import { formatBytes } from "../lib/files";
import { chatDepth, MAX_FORK_DEPTH, opinionWord, ordinal } from "../lib/forks";
import { findModel } from "../lib/models";
import { useStore } from "../lib/store";
import type { Message, ModelRef, SearchCall } from "../lib/types";
import { copyText, cx } from "../lib/ui";
import { Linkify } from "./Linkify";
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

/** Pages are read by fetch_url: plain web pages ("fetch") or GitHub's own hosts ("github"). */
const isPage = (p: SearchCall["provider"]) => p === "fetch" || p === "github";
const toolLabel = (p: SearchCall["provider"]) => (p === "fetch" ? "Web page" : p === "github" ? "GitHub" : (SEARCH_PROVIDERS[p]?.label ?? p));
/** A URL for display: no scheme or "www.", and long paths cut short. */
const shortUrl = (url: string) => {
  const s = url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  return s.length > 72 ? `${s.slice(0, 71)}…` : s;
};

/** What a running tool call is doing, in plain words: "Searching Exa: …", "Fetching github.com/…". */
const activity = (call: SearchCall) =>
  call.provider === "github" ? `Fetching from GitHub: ${shortUrl(call.query)}` : call.provider === "fetch" ? `Fetching ${shortUrl(call.query)}` : `Searching ${toolLabel(call.provider)}: ${call.query}`;

function SearchRow({ call }: { call: SearchCall }) {
  const label = toolLabel(call.provider);
  const page = isPage(call.provider);
  return (
    <li className="search-call">
      <div className="search-call-head">
        <span className="search-provider">{label}</span>
        <span className={cx("search-query", call.status === "running" && "shimmer")}>{page ? shortUrl(call.query) : call.query || "…"}</span>
        <span className={cx("search-meta", call.status === "error" && "bad")}>
          {call.status === "running"
            ? page
              ? "fetching"
              : "searching"
            : call.status === "error"
              ? (call.error ?? "failed")
              : page
                ? `read${call.digested ? " · summarized" : ""}`
                : `${call.results?.length ?? 0} results${call.digested ? " · summarized" : ""}`}
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
  const searched = searches.filter((s) => !isPage(s.provider)).length;
  const pages = searches.filter((s) => s.provider === "fetch" && s.status !== "error").length;
  const github = searches.filter((s) => s.provider === "github" && s.status !== "error").length;
  const done = [
    searched ? `Searched the web${searched > 1 ? ` ${searched} times` : ""}` : "",
    pages ? `Read ${pages === 1 ? "a page" : `${pages} pages`}` : "",
    github ? `Read ${github === 1 ? "from GitHub" : `${github} GitHub files`}` : "",
  ].filter(Boolean);
  const summary = current
    ? activity(current)
    : `${done.join(" · ") || "Looked things up"}${sources ? ` · ${sources} source${sources === 1 ? "" : "s"}` : ""}`;
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
      {message.content && (
        <div className="bubble">
          <Linkify text={message.content} />
        </div>
      )}
      <div className="msg-actions msg-actions-end">
        <CopyButton text={message.content} />
      </div>
    </div>
  );
}

const EFFORT_LONG: Record<Effort, string> = { off: "Off", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };

/**
 * "2nd": fork the chat at this reply and answer the same question with another model.
 * Step 1 picks the model; step 2 picks its reasoning level (skipped for models without levels).
 * `dock` renders it as a pill beside the think buttons.
 */
export function SecondOpinion({ chatId, messageId, current, dock }: { chatId: string; messageId: string; current?: ModelRef; dock?: boolean }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ModelRef>();
  const anchor = useRef<HTMLButtonElement>(null);
  const detection = useStore((s) => s.detection);
  const depth = useStore((s) => {
    const chat = s.chats.find((c) => c.id === chatId);
    return chat ? chatDepth(chat) : 1;
  });
  // A 5th opinion is the last one: no more forks from it.
  if (depth >= MAX_FORK_DEPTH) return null;
  const model = picked ? findModel(detection, picked) : undefined;
  const levels = model?.reasoning.efforts ?? [];
  // Toggle-only models (thinking on/off, no levels): "medium" means "on, at the model's default".
  const onOff = !!model && model.reasoning.mode === "none" && model.reasoning.toggle;
  const close = () => {
    setOpen(false);
    setPicked(undefined);
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={dock ? "think-btn think-second" : "msg-second"}
        aria-label={`Get a ${opinionWord(depth + 1)} opinion from another model`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tooltip={open ? undefined : `Get a ${opinionWord(depth + 1)} opinion from another model`}
        data-tooltip-side="top"
        onClick={() => (open ? close() : setOpen(true))}
      >
        {ordinal(depth + 1)}
      </button>
      <Popover open={open} onClose={close} anchor={anchor} className="menu select-menu model-select-menu" role="listbox" label="Answer with" fixed="auto">
        {picked && model ? (
          <>
            <div className="menu-label menu-label-top second-level-head">
              <button type="button" className="second-back" aria-label="Back to models" onClick={() => setPicked(undefined)}>
                <ChevronLeft size={14} />
              </button>
              <span>Reasoning for {model.name}</span>
            </div>
            <div className="select-list" role="presentation">
              {levels.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="menu-item"
                  onClick={() => {
                    close();
                    forkWithModel(chatId, messageId, { ...picked, effort: level });
                  }}
                >
                  <span className="menu-item-label">{onOff && level === "medium" ? "On" : EFFORT_LONG[level]}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="menu-label menu-label-top">Get a {opinionWord(depth + 1)} opinion from…</div>
            <ModelMenu
              selected={current}
              onPick={(ref) => {
                if (findModel(detection, ref)?.reasoning.efforts.length) setPicked(ref);
                else {
                  close();
                  forkWithModel(chatId, messageId, ref);
                }
              }}
            />
          </>
        )}
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
