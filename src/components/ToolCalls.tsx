// What Pi did while answering: each run of tool calls folded into one line ("Read 3 files, ran 2
// commands") that opens to a row per call and its output or diff, with what Pi is doing right now
// under it; and the questions Pi extensions ask on the way.
import { Bot, Brain, Check, ChevronRight, CircleAlert, Eye, FilePen, FilePlus, FileText, FolderSearch, Globe, MessageCircleQuestion, PanelTop, Search, SquareTerminal, Wrench, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { answerQuestion } from "../lib/chat";
import type { AskPart, ThoughtPart, ToolPart } from "../lib/types";
import { cx, duration } from "../lib/ui";
import { Fold } from "./Fold";
import { Markdown } from "./Markdown";
import { Spinner } from "./primitives";
import { DictationButton } from "./DictationButton";
import { useFieldDictation } from "../lib/useFieldDictation";
import { PluginRender, useToolRenderers } from "../lib/plugins";

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** A path as shown: relative to the thread's folder when it's inside it. */
function shortPath(path: string | undefined, cwd?: string) {
  if (!path) return "";
  if (cwd && path.startsWith(cwd + "/")) return path.slice(cwd.length + 1);
  return path.replace(/^\/Users\/[^/]+/, "~");
}

const firstLine = (s: string) => {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

/** How a tool call reads in one line, and its icon. */
function describe(part: ToolPart, cwd?: string): { icon: LucideIcon; verb: string; target: string; mono?: boolean } {
  const a = part.args ?? {};
  const path = shortPath(str(a.path) ?? str(a.file_path) ?? str(a.filePath), cwd);
  const running = part.status === "running";
  switch (part.name) {
    case "read":
      return { icon: FileText, verb: running ? "Reading" : "Read", target: path };
    case "bash":
      return { icon: SquareTerminal, verb: running ? "Running" : "", target: firstLine(str(a.command) ?? ""), mono: true };
    case "edit":
      return { icon: FilePen, verb: running ? "Editing" : "Edited", target: path };
    case "write":
      return { icon: FilePlus, verb: running ? "Writing" : "Wrote", target: path };
    case "grep":
      return { icon: Search, verb: running ? "Searching for" : "Searched for", target: str(a.pattern) ?? "" };
    case "find":
    case "ls":
      return { icon: FolderSearch, verb: running ? "Looking in" : "Looked in", target: path || str(a.pattern) || "." };
    case "web_search":
    case "fetch":
      return { icon: Globe, verb: running ? "Searching the web for" : "Searched the web for", target: str(a.query) ?? str(a.url) ?? "" };
    case "html_render":
      return { icon: PanelTop, verb: running ? "Showing" : "Showed", target: str(a.title) ?? "a page" };
    case "html_preview":
      return { icon: Eye, verb: running ? "Previewing" : "Previewed", target: `a page${typeof a.width === "number" ? ` at ${a.width}px` : ""}` };
    default: {
      if (/subagent|agent/.test(part.name)) return { icon: Bot, verb: part.name.replace(/_/g, " "), target: firstLine(str(a.task) ?? str(a.prompt) ?? "") };
      const first = Object.values(a).find((v) => typeof v === "string") as string | undefined;
      return { icon: Wrench, verb: part.name.replace(/_/g, " "), target: first ? firstLine(first) : "" };
    }
  }
}

/** Added and removed line counts of a unified diff. */
function diffStat(patch: string) {
  let add = 0;
  let del = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return { add, del };
}

function Diff({ patch }: { patch: string }) {
  const lines = useMemo(() => patch.replace(/\n$/, "").split("\n"), [patch]);
  return (
    <pre className="tool-diff">
      {lines.map((line, i) => (
        <span
          key={i}
          className={cx(
            "diff-line",
            line.startsWith("@@") ? "diff-hunk" : line.startsWith("+++") || line.startsWith("---") ? "diff-file" : line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : undefined,
          )}
        >
          {line || " "}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

const seconds = (ms?: number) => (ms === undefined ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);

/** What a call changed, as a diff. A new file (write) has no patch from Pi: its content, as all-added lines. */
function patchOf(part: ToolPart) {
  const written = part.name === "write" && !part.patch ? str(part.args?.content) : undefined;
  return part.patch ?? (written !== undefined ? written.replace(/\n$/, "").split("\n").map((l) => `+${l}`).join("\n") : undefined);
}

/** How long a call has been running, once it's been a few seconds (a long build or test run). */
function RunningFor() {
  const [start] = useState(Date.now);
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now - start >= 3000 ? <span className="tool-time">{duration(now - start)}</span> : null;
}

export function ToolRow({ part, cwd }: { part: ToolPart; cwd?: string }) {
  const [open, setOpen] = useState(false);
  // A plugin can take over rendering a tool by name (e.g. a richer diff for "edit").
  const renderers = useToolRenderers(part.name);
  if (renderers.length) {
    return (
      <>
        {renderers.map((Component, i) => (
          <PluginRender key={i} pluginId={`tool:${part.name}:${i}`}>
            <Component part={part} cwd={cwd} />
          </PluginRender>
        ))}
      </>
    );
  }
  const d = describe(part, cwd);
  const Icon = d.icon;
  const patch = patchOf(part);
  const stat = patch ? diffStat(patch) : undefined;
  const command = part.name === "bash" ? str(part.args?.command) : undefined;
  const hasBody = !!(patch || part.output?.trim() || (command && command.includes("\n")));
  return (
    <div className={cx("tool", open && "tool-open", part.status === "error" && "tool-error")}>
      <button type="button" className="tool-head" aria-expanded={open} disabled={!hasBody} onClick={() => setOpen((o) => !o)}>
        <Icon size={14} className="tool-icon" />
        <span className={cx("tool-text", part.status === "running" && "shimmer")}>
          {d.verb && <span className="tool-verb">{d.verb} </span>}
          <span className={cx("tool-target", d.mono && "tool-mono")}>{d.target}</span>
        </span>
        {stat && (
          <span className="tool-stat">
            {stat.add > 0 && <span className="diff-add-n">+{stat.add}</span>}
            {stat.del > 0 && <span className="diff-del-n">−{stat.del}</span>}
          </span>
        )}
        <span className="tool-status">
          {part.status === "running" ? (
            <>
              <RunningFor />
              <Spinner size={12} />
            </>
          ) : part.status === "error" ? (
            <CircleAlert size={13} className="bad" />
          ) : (
            <span className="tool-time">{seconds(part.ms)}</span>
          )}
        </span>
        {hasBody && <ChevronRight size={14} className="tool-chevron" />}
      </button>
      <Fold open={open && hasBody} className="tool-body">
        {command && command.includes("\n") && <pre className="tool-output tool-command">{command}</pre>}
        {patch ? <Diff patch={patch} /> : part.output?.trim() ? <pre className="tool-output">{part.output.replace(/\n+$/, "")}</pre> : null}
      </Fold>
    </div>
  );
}

/** The first line of a thought's paragraph, without its markdown (summaries often open with a bold heading). */
const plainLine = (paragraph: string) => firstLine(paragraph.replace(/^#+\s*/, "").replace(/\*\*|__|`/g, ""));

/**
 * A stretch of thinking, in its place among the tools. Folded by default: while live it shows the
 * paragraph it's on, once done the one it started with; open it for the whole thought.
 */
export function ThoughtRow({ part, live }: { part: ThoughtPart; live: boolean }) {
  const [open, setOpen] = useState(false);
  const paragraphs = part.text.split(/\n\s*\n/).filter((p) => p.trim());
  const preview = plainLine((live ? paragraphs.at(-1) : paragraphs[0]) ?? "");
  return (
    <div className={cx("tool tool-thought", open && "tool-open")}>
      <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Brain size={14} className="tool-icon" />
        <span className={cx("tool-text", live && "shimmer")}>
          <span className="tool-verb">{live ? "Thinking" : "Thought"} </span>
          <span className="tool-target">{preview}</span>
        </span>
        <span className="tool-status">{live ? <Spinner size={12} /> : part.ms !== undefined && part.ms >= 1000 && <span className="tool-time">{seconds(part.ms)}</span>}</span>
        <ChevronRight size={14} className="tool-chevron" />
      </button>
      <Fold open={open} className="tool-body tool-thought-body">
        <Markdown content={part.text} className="markdown-muted" />
      </Fold>
    </div>
  );
}

type Work = ToolPart | ThoughtPart;

/** How long a call or thought has to be going before it shows as what Pi is doing. */
const SETTLE_MS = 500;

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
/** Tools that read the same in a summary. */
const kindOf = (name: string) =>
  name === "grep" || name === "find" ? "search" : name === "web_search" || name === "fetch" ? "web" : /subagent|agent/.test(name) ? "agent" : name;

/**
 * A run of work in one line: "Read 3 files, ran 2 commands, edited 1 file", with the lines its edits
 * added and removed. Thinking only counts when that's all it did ("Thought for 4s").
 */
export function summarize(parts: Work[]) {
  const tools = parts.filter((p): p is ToolPart => p.type === "tool");
  let add = 0;
  let del = 0;
  if (!tools.length) {
    const ms = parts.reduce((n, p) => n + (p.ms ?? 0), 0);
    return { text: ms >= 1000 ? `Thought for ${duration(ms)}` : "Thought", add, del };
  }
  // Each kind of call in the order it first came up, with the files (or folders) it touched.
  const kinds = new Map<string, { n: number; targets: Set<string> }>();
  for (const t of tools) {
    const kind = kindOf(t.name);
    const k = kinds.get(kind) ?? { n: 0, targets: new Set<string>() };
    kinds.set(kind, k);
    k.n++;
    k.targets.add(str(t.args?.path) ?? str(t.args?.file_path) ?? str(t.args?.filePath) ?? t.id);
    const patch = patchOf(t);
    if (patch) {
      const s = diffStat(patch);
      add += s.add;
      del += s.del;
    }
  }
  const text = [...kinds]
    .map(([kind, { n, targets }]) => {
      switch (kind) {
        case "read":
          return `read ${count(targets.size, "file")}`;
        case "edit":
          return `edited ${count(targets.size, "file")}`;
        case "write":
          return `wrote ${count(targets.size, "file")}`;
        case "ls":
          return `listed ${count(targets.size, "folder")}`;
        case "bash":
          return `ran ${count(n, "command")}`;
        case "search":
          return `searched ${times(n)}`;
        case "web":
          return `searched the web${n > 1 ? ` ${times(n)}` : ""}`;
        case "agent":
          return `ran ${count(n, "subagent")}`;
        case "html_preview":
          return n === 1 ? "previewed a page" : `previewed ${count(n, "page")}`;
        case "html_render":
          return `tried to show ${n === 1 ? "a page" : count(n, "page")}`;
        default:
          return `used ${kind.replace(/_/g, " ")}${n > 1 ? ` ${times(n)}` : ""}`;
      }
    })
    .join(", ");
  return { text: text.charAt(0).toUpperCase() + text.slice(1), add, del };
}

/**
 * Consecutive tool calls and the thinking between them. What's finished is one line summing it up,
 * opening to a row per call. While Pi is still on this run, what it's doing right now shows under
 * that line: the calls running, the thought it's on, or that it's working out the next step.
 */
export function WorkRun({
  parts,
  cwd,
  live,
  block,
}: {
  parts: Work[];
  cwd?: string;
  /** Pi is working on this run right now. */
  live: boolean;
  /** Its place in the reply, so the chat can keep the reader's place when the reply folds. */
  block?: number;
}) {
  const [open, setOpen] = useState(false);
  const last = parts.at(-1);
  const thought = live && last?.type === "thought" && last.ms === undefined ? last : undefined;
  const current = live ? parts.filter((p) => p === thought || (p.type === "tool" && p.status === "running")) : [];
  const done = current.length ? parts.filter((p) => !current.includes(p)) : parts;
  const summary = done.length ? summarize(done) : undefined;
  // Most calls are over in a few milliseconds: only one still going after a moment takes the live
  // line, so quick ones don't flash past "Working" on their way into the summary.
  const keyOf = (p: Work) => (p.type === "tool" ? p.id : `th${parts.indexOf(p)}`);
  const since = useRef(new Map<string, number>());
  const now = Date.now();
  for (const p of current) if (!since.current.has(keyOf(p))) since.current.set(keyOf(p), now);
  const shown = current.filter((p) => now - since.current.get(keyOf(p))! >= SETTLE_MS);
  const [, tick] = useState(0);
  const waiting = current.length > shown.length;
  useEffect(() => {
    if (!waiting) return;
    const next = Math.min(...current.filter((p) => !shown.includes(p)).map((p) => since.current.get(keyOf(p))! + SETTLE_MS));
    const t = setTimeout(() => tick((n) => n + 1), Math.max(0, next - Date.now()));
    return () => clearTimeout(t);
  });
  const row = (p: Work) =>
    p.type === "thought" ? <ThoughtRow key={`th${parts.indexOf(p)}`} part={p} live={p === thought} /> : <ToolRow key={p.id} part={p} cwd={cwd} />;
  return (
    <div className={cx("reasoning work", open && "reasoning-open")} data-block={block}>
      {summary && (
        <button type="button" className="reasoning-toggle work-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="work-summary">{summary.text}</span>
          {(summary.add > 0 || summary.del > 0) && (
            <span className="tool-stat">
              {summary.add > 0 && <span className="diff-add-n">+{summary.add}</span>}
              {summary.del > 0 && <span className="diff-del-n">−{summary.del}</span>}
            </span>
          )}
          <ChevronRight size={14} className="reasoning-chevron" />
        </button>
      )}
      <Fold open={open && !!summary} className="tools work-body">
        {done.map(row)}
      </Fold>
      <Fold open={live} settle className="work-live">
        {shown.length ? shown.map(row) : <div className="work-working shimmer">Working</div>}
      </Fold>
    </div>
  );
}

/** A question card's answer box, with a mic for dictating into it. */
function AskField({ value, setValue, placeholder, multiline, autoFocus, secret }: { value: string; setValue: React.Dispatch<React.SetStateAction<string>>; placeholder?: string; multiline?: boolean; autoFocus?: boolean; secret?: boolean }) {
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(undefined), 4000);
    return () => clearTimeout(t);
  }, [error]);
  const dictation = useFieldDictation({ value, setValue, field, onError: setError });
  const props = { ref: field, ...(secret ? {} : dictation.fieldProps), className: cx("input ask-input", multiline && !secret && "textarea"), value, placeholder, autoFocus, onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => setValue(e.target.value) };
  return (
    <div className={cx("ask-field", multiline && "ask-field-multiline")}>
      {multiline && !secret ? <textarea rows={5} {...props} /> : <input {...props} type={secret ? "password" : "text"} autoComplete={secret ? "off" : undefined} />}
      {!secret && <DictationButton dictation={dictation} />}
      {error && <p className="ask-field-error" role="status">{error}</p>}
    </div>
  );
}

/** A question from a Pi extension: choose, confirm or type, or dismiss. */
export function AskCard({ part, chatId, messageId, block }: { part: AskPart; chatId: string; messageId: string; block?: number }) {
  const [value, setValue] = useState(part.prefill ?? "");
  const answered = part.answer !== undefined;
  const reply = (r: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void answerQuestion(chatId, messageId, part, r);
  return (
    <div className={cx("ask", answered && "ask-answered")} role="group" aria-label={part.title} data-block={block}>
      <div className="ask-head">
        <MessageCircleQuestion size={15} />
        <span className="ask-title">{part.title}</span>
      </div>
      {part.message && <p className="ask-message">{part.message}</p>}
      {answered ? (
        <p className="ask-answer">{part.answer ? <><Check size={13} /> {part.answer}</> : <><X size={13} /> No answer</>}</p>
      ) : part.method === "confirm" ? (
        <div className="ask-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => reply({ confirmed: true })}>
            Yes
          </button>
          <button type="button" className="btn btn-sm" onClick={() => reply({ confirmed: false })}>
            No
          </button>
        </div>
      ) : part.method === "select" && part.other ? (
        // question_ask: lettered choices, or the user's own words.
        <>
          {!!part.options?.length && (
            <div className="ask-choices">
              {part.options.map((o, i) => (
                <button key={o} type="button" className="ask-choice" onClick={() => reply({ value: o })}>
                  <span className="ask-letter">{i < 26 ? String.fromCharCode(65 + i) : i + 1}</span>
                  <span>{o}</span>
                </button>
              ))}
            </div>
          )}
          <form
            className="ask-form ask-other"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim()) reply({ value: value.trim() });
            }}
          >
            <AskField value={value} setValue={setValue} placeholder={part.options?.length ? "Other…" : "Your answer"} secret={part.secret} />
            <button type="submit" className="btn btn-sm btn-primary" disabled={!value.trim()}>
              Send
            </button>
            <button type="button" className="link-btn" onClick={() => reply({ cancelled: true })}>
              Dismiss
            </button>
          </form>
        </>
      ) : part.method === "select" ? (
        <div className="ask-options">
          {(part.options ?? []).map((o) => (
            <button key={o} type="button" className="btn btn-sm ask-option" onClick={() => reply({ value: o })}>
              {o}
            </button>
          ))}
          <button type="button" className="link-btn" onClick={() => reply({ cancelled: true })}>
            Dismiss
          </button>
        </div>
      ) : (
        <form
          className="ask-form"
          onSubmit={(e) => {
            e.preventDefault();
            reply({ value });
          }}
        >
          <AskField value={value} setValue={setValue} placeholder={part.placeholder} multiline={part.method === "editor"} autoFocus={part.method !== "editor"} secret={part.secret} />
          <div className="ask-actions">
            <button type="submit" className="btn btn-sm btn-primary">
              Send
            </button>
            <button type="button" className="btn btn-sm" onClick={() => reply({ cancelled: true })}>
              Dismiss
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
