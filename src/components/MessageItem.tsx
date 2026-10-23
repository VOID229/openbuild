import { Check, ChevronRight, CircleAlert, Copy, FileText, Globe, RotateCcw, Sparkles } from "lucide-react";
import { SEARCH_PROVIDERS, type Attachment } from "../../shared/types";
import { memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { regenerate } from "../lib/chat";
import { formatBytes } from "../lib/files";
import { useStore } from "../lib/store";
import type { Message, Part, SearchCall, ThoughtPart, ToolPart } from "../lib/types";
import { copyText, cx, duration } from "../lib/ui";
import { Linkify } from "./Linkify";
import { openLightbox } from "./Lightbox";
import { Fold } from "./Fold";
import { Markdown } from "./Markdown";
import { BrandIcon, IconButton } from "./primitives";
import { AskCard, WorkRun } from "./ToolCalls";

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
  // Still thinking only until it writes or starts running tools.
  const thinking = message.status === "streaming" && !message.content && !message.parts?.some((p) => p.type !== "text");
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(message.startedAt, thinking);
  const seconds = message.reasoningMs != null ? Math.max(1, Math.round(message.reasoningMs / 1000)) : elapsed;
  return (
    <div className={cx("reasoning", open && "reasoning-open")}>
      <button type="button" className="reasoning-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={cx(thinking && "shimmer")}>{thinking ? "Thinking" : `Thought for ${seconds}s`}</span>
        <ChevronRight size={14} className="reasoning-chevron" />
      </button>
      <Fold open={open} className="reasoning-body">
        <Markdown content={message.reasoning ?? ""} className="markdown-muted" />
      </Fold>
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
      <Fold open={open} as="ul" className="reasoning-body search-calls">
        {searches.map((c) => (
          <SearchRow key={c.id} call={c} />
        ))}
      </Fold>
    </div>
  );
}

/** Every image sent in the chat, so the preview can step through all of them. */
function chatImages(chatId: string) {
  const chat = useStore.getState().chats.find((c) => c.id === chatId);
  const files = (chat?.messages ?? []).flatMap((m) => [...(m.attachments ?? []), ...(m.parts ?? []).flatMap((p) => (p.type === "steer" && p.attachments) || [])]);
  return files.filter((a) => a.mime.startsWith("image/"));
}

function Attachments({ files, chatId }: { files: Attachment[]; chatId: string }) {
  return (
    <div className="msg-attachments">
      {files.map((a) =>
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
  );
}

function UserMessage({ message, chatId }: { message: Message; chatId: string }) {
  return (
    <div className="msg msg-user" data-message-id={message.id}>
      {message.attachments?.length ? <Attachments files={message.attachments} chatId={chatId} /> : null}
      {message.content.trim() && (
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

type Block = Part | (ToolPart | ThoughtPart)[];

/** Everything Pi did before its final answer, folded into one line. `folding`: it was just on screen
 *  (the reply finished in front of the reader), so it folds away instead of starting shut. */
function Worked({ message, folding, children }: { message: Message; folding: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Older replies didn't record how long they took.
  const ms = message.workedMs;
  return (
    <div className={cx("reasoning worked", open && "reasoning-open")}>
      <button type="button" className="reasoning-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{ms ? `Worked for ${duration(ms)}` : "Worked"}</span>
        <ChevronRight size={14} className="reasoning-chevron" />
      </button>
      <Fold open={open} initiallyOpen={folding} className="worked-body">
        {children}
      </Fold>
    </div>
  );
}

/** A Pi reply in order: text, runs of tool calls and thinking, and questions. */
function Parts({ message, chatId }: { message: Message; chatId: string }) {
  const cwd = useStore((s) => s.chats.find((c) => c.id === chatId)?.workspace?.cwd);
  const streaming = message.status === "streaming";
  // Seen streaming here, so the fold below happens in front of the reader and should animate.
  const watched = useRef(streaming);
  if (streaming) watched.current = true;
  // Thinking shares a block with the tools around it, like in flash.
  const blocks: Block[] = [];
  for (const p of message.parts ?? []) {
    const last = blocks.at(-1);
    const grouped = p.type === "tool" || p.type === "thought";
    if (grouped && Array.isArray(last)) last.push(p);
    else blocks.push(grouped ? [p] : p);
  }
  const render = (b: Block, i: number) =>
    Array.isArray(b) ? (
      <WorkRun key={`g${i}`} parts={b} cwd={cwd} live={streaming && i === blocks.length - 1} block={i} />
    ) : b.type === "text" ? (
      <Markdown key={`t${i}`} content={b.text} className={cx(streaming && i === blocks.length - 1 && "markdown-streaming")} block={i} />
    ) : b.type === "ask" ? (
      <AskCard key={b.id} part={b} chatId={chatId} messageId={message.id} block={i} />
    ) : b.type === "steer" ? (
      // Sent while Pi worked, shown where Pi read it.
      <div key={`s${i}`} className="msg-user msg-steer" data-block={i}>
        {b.attachments?.length ? <Attachments files={b.attachments} chatId={chatId} /> : null}
        {b.text?.trim() && (
          <div className="bubble">
            <Linkify text={b.text} />
          </div>
        )}
      </div>
    ) : null;
  // Done, and it ran tools or thought: fold all of that (and what it wrote along the way) behind
  // "Worked for Xs", leaving the answer out in the open. Only once it's over: while Pi works, what
  // it writes stays where it is, and the answer keeps its key so it isn't redrawn when the rest folds.
  const last = blocks.at(-1);
  const final = last && !Array.isArray(last) && last.type === "text" ? last : undefined;
  if (message.status === "done" && blocks.some(Array.isArray)) {
    const work = final ? blocks.slice(0, -1) : blocks;
    return <>{[<Worked key="worked" message={message} folding={watched.current}>{work.map(render)}</Worked>, final && render(final, blocks.length - 1)]}</>;
  }
  return <>{blocks.map(render)}</>;
}

const PULSE_MS = 1200;

/** The waiting dots, phased off the page clock so a remount (e.g. switching threads) continues the loop
 *  mid-beat instead of restarting it. */
function Typing() {
  const [phase] = useState(() => -(performance.now() % PULSE_MS));
  return (
    <div className="typing" aria-label="Waiting for response" style={{ "--typing-phase": `${phase}ms` } as CSSProperties}>
      <span />
      <span />
      <span />
    </div>
  );
}

function AssistantMessage({ message, chatId, isLast }: { message: Message; chatId: string; isLast: boolean }) {
  const streaming = message.status === "streaming";
  const busy = message.searches?.some((s) => s.status === "running") || message.parts?.some((p) => p.type === "tool" && p.status === "running");
  const waiting = streaming && !message.content && !message.reasoning && !busy && !message.parts?.length;
  return (
    <div className={cx("msg msg-assistant", isLast && "msg-last")} data-message-id={message.id}>
      {message.reasoning && <Reasoning message={message} />}
      {message.searches?.length ? <Searches searches={message.searches} /> : null}
      {waiting && (
        <Typing />
      )}
      {message.parts?.length ? (
        <Parts message={message} chatId={chatId} />
      ) : (
        message.content && <Markdown content={message.content} className={cx(streaming && "markdown-streaming")} />
      )}
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
        </div>
      )}
    </div>
  );
}

export const MessageItem = memo(function MessageItem({
  message,
  chatId,
  isLast,
}: {
  message: Message;
  chatId: string;
  isLast: boolean;
}) {
  return message.role === "user" ? (
    <UserMessage message={message} chatId={chatId} />
  ) : (
    <AssistantMessage message={message} chatId={chatId} isLast={isLast} />
  );
});
