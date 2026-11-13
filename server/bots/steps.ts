// What a bot is doing right now, read off Pi's event stream one record at a time. A step is a tool
// call: it starts showing the moment the model begins writing the call (its own status line as soon
// as that argument is written), stays while the tool runs, and is gone the moment the tool ends.
// Tools from one response can run side by side, so steps are told apart by Pi's call id, never by
// tool name. Between steps the status keeps saying what the bot is about: the heading of the model's
// reasoning when it writes one, else the last step it named, else what the turn started on (a message
// to read, a routine). Plain working words (shared/bots.ts, WORKING_PHRASES) are only for a turn with
// none of those, and "Writing a reply" shows while the model streams text. The runner (runner.ts)
// turns this into BotStatus.
import { appById } from "../../shared/apps";
import { workingPhrase, WRITING_REPLY } from "../../shared/bots";
import type { PiRecord } from "../pi/rpc";

export interface Step {
  /** Pi's id for the call, the same from the model writing it to the tool ending. */
  id: string;
  tool: string;
  /** What the status says while this is the live step. */
  activity: string;
  /** The model is still writing the call, has written it, or the tool is running. */
  state: "writing" | "ready" | "running";
  /** When it reached its state: for a running step, when the tool started. */
  since: number;
  args?: unknown;
  /** The call's arguments as written so far, while the model writes them. */
  json: string;
  contentIndex?: number;
}

export interface Live {
  /** The response's tool calls that aren't over yet, in the order the model wrote them. */
  steps: Step[];
  /** The model is writing text right now. */
  streaming: boolean;
  /** Pi is busy with something of its own before the next model call. */
  pause?: "compaction" | "retry";
  /** Which plain phrase the status is on when there's nothing more to say, and whether it's on one now. */
  phrase: number;
  plain: boolean;
  /** What the turn started on ("Reading your message"): the line until the bot names a step of its own. */
  start?: string;
  /** The model's reasoning so far in this response (its tail), and the heading it's under right now. */
  thinking: string;
  thought?: string;
  /** The last line this turn named, kept while the model works out its next step. */
  last?: string;
}

export const newLive = (start?: string): Live => ({ steps: [], streaming: false, phrase: 0, plain: true, start, thinking: "" });

/**
 * What a turn says it's doing before the bot names a step: what woke it, which it's reading and
 * working out what to do about. Messages come first: they're what someone is waiting on.
 */
export function startLine(kinds: string[], direct: boolean): string {
  if (kinds.includes("messages")) return direct ? "Reading your message" : "Reading the new messages";
  if (kinds.includes("routine")) return "Getting started on a routine";
  if (kinds.includes("note")) return "Reading a note";
  if (kinds.includes("heartbeat")) return "Checking in on things";
  return "Looking at a reaction";
}

export const COMPACTING = "Summarizing the conversation so far";
export const RETRYING = "Trying again";

const base = (path: unknown) => String(path ?? "").split("/").filter(Boolean).pop()?.slice(0, 40);

/** The status the bot wrote for this call: one short line, or nothing usable. */
export function ownStatus(value: unknown) {
  const line = typeof value === "string" ? value.split("\n")[0]!.replace(/\s+/g, " ").trim().replace(/[.…]+$/, "") : "";
  if (!line) return undefined;
  const short = line.length > 50 ? `${line.slice(0, 49).trimEnd()}…` : line;
  return short[0]!.toUpperCase() + short.slice(1);
}

/**
 * What a tool call shows as the bot's status: the line the bot wrote for it, else what it reads, runs
 * or opens. Never a generic "Thinking": a tool with no line of its own is named.
 */
export function activityFor(tool: string, args: unknown): string {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const own = ownStatus(a.status);
  if (own) return own;
  if (tool === "send_message") return WRITING_REPLY;
  if (tool === "question") return "Asking a question";
  if (tool === "poll") return "Starting a poll";
  if (tool === "react") return "Reacting";
  if (tool === "bash") return "Running a command";
  if (tool === "openbuild") return a.action === "start" ? "Starting a thread" : a.action === "merge" ? "Merging a pull request" : "Checking on threads";
  if (tool === "process") return a.action === "start" ? "Starting a program" : "Checking on a program";
  if (tool === "browser") {
    if (a.action === "open") {
      const host = (() => {
        try {
          return new URL(String(a.url)).hostname.replace(/^www\./, "");
        } catch {
          return "";
        }
      })();
      return host ? `Opening ${host}` : "Opening a page";
    }
    if (a.action === "screenshot") return "Taking a screenshot";
    if (a.action === "type") return "Filling something in";
    if (a.action === "click") return "Clicking around";
    return "Browsing";
  }
  if (tool === "read") return base(a.path) ? `Reading ${base(a.path)}` : "Reading a file";
  if (tool === "write") return base(a.path) ? `Writing ${base(a.path)}` : "Writing a file";
  if (tool === "edit") return base(a.path) ? `Editing ${base(a.path)}` : "Editing a file";
  if (tool === "vote_poll") return "Voting in the poll";
  if (tool === "html_render") return a.title ? `Drawing ${ownStatus(a.title)}` : "Drawing a page";
  if (tool === "todo") return "Updating the to-do list";
  if (tool === "load_tools") return "Getting tools ready";
  if (tool === "memory") return a.action === "forget" ? "Forgetting something" : "Making a note";
  if (tool === "search") return a.what === "messages" ? "Looking back through chats" : "Looking through its memory";
  if (tool === "bot_web_search") return "Searching the web";
  if (tool === "apps") return a.action === "skill" ? "Reading up on how to do it" : "Looking through apps";
  if (tool === "use_app") return `Using ${appById(String(a.app ?? ""))?.name ?? "an app"}`;
  if (tool === "routine") return "Sorting out a routine";
  if (tool === "jobs") return a.action === "cancel" ? "Cancelling a background job" : "Checking on background jobs";
  if (tool === "ask_bot") return "Asking another bot";
  if (tool === "background") return "Handing a lookup to a helper";
  if (tool === "side_chat") return a.action === "close" ? "Wrapping up a side chat" : "Talking it over with the others";
  if (tool === "manage_bot") return "Tending to the other bots";
  if (tool === "plugins") return a.action === "set" || a.action === "system" ? "Changing a plugin" : "Checking on plugins";
  // Another extension's tool, or an app's: named as it is, which says more than any stock phrase.
  const name = tool.replace(/^mcp__/, "").replace(/[_\-.:/]+/g, " ").trim().slice(0, 40).trim();
  return name ? `Using ${name}` : "";
}

/**
 * The top-level string arguments already complete in a tool call the model is still writing. The
 * JSON stops wherever the stream has got to: a value that isn't finished yet is left out, and a
 * `"status"` inside another argument's text or object is never taken for the call's own.
 */
export function partialArgs(json: string): Record<string, string> {
  const out: Record<string, string> = {};
  const n = json.length;
  let i = json.indexOf("{") + 1;
  if (!i) return out;
  const space = () => {
    while (i < n && /\s/.test(json[i]!)) i++;
  };
  /** Reads the string that opens at `i`, and moves past it. Undefined when it isn't closed yet. */
  const string = (): string | undefined => {
    let j = i + 1;
    while (j < n && json[j] !== '"') j += json[j] === "\\" ? 2 : 1;
    if (j >= n) return undefined;
    const raw = json.slice(i, j + 1);
    i = j + 1;
    try {
      return String(JSON.parse(raw));
    } catch {
      return "";
    }
  };
  while (i < n) {
    space();
    if (json[i] === ",") {
      i++;
      continue;
    }
    if (json[i] !== '"') break;
    const key = string();
    if (key === undefined) break;
    space();
    if (json[i] !== ":") break;
    i++;
    space();
    if (i >= n) break;
    if (json[i] === '"') {
      const value = string();
      if (value === undefined) break;
      out[key] = value;
      continue;
    }
    // Anything else (a number, a list, an object) is skipped whole.
    let depth = 0;
    let done = false;
    while (i < n && !done) {
      const ch = json[i]!;
      if (ch === '"') {
        if (string() === undefined) return out;
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        if (!depth) return out;
        depth--;
      } else if (ch === "," && !depth) done = true;
      if (!done) i++;
    }
    if (!done) break;
  }
  return out;
}

/** How much of a response's reasoning is kept to look for its heading in. */
const THINKING_TAIL = 4000;

/**
 * The heading the model's reasoning is under right now: the last line of its own in bold
 * ("**Checking the CI logs**"), as some models head each part of their reasoning. Undefined when it
 * writes none. One still being written isn't taken, nor bold words inside a sentence.
 */
export function heading(thinking: string): string | undefined {
  let found: string | undefined;
  for (const m of thinking.matchAll(/(?:^|\n)[ \t]*\*\*([^*\n]{3,80})\*\*[ \t]*(?=\n|$)/g)) found = m[1];
  const line = found && ownStatus(found);
  return line && /[a-z]/i.test(line) ? line : undefined;
}

/** Steps whose line stays up once they're over, while the model works out what's next: work, not words for the chat or a tool being loaded. */
const KEPT = (step: Step) => !["send_message", "question", "poll", "react", "load_tools"].includes(step.tool);

const blank = (tool: string, id: string, state: Step["state"], now: number, args?: unknown, contentIndex?: number): Step => ({ id, tool, activity: activityFor(tool, args), state, since: now, args, json: "", contentIndex });

/**
 * Take one of Pi's records in. Says which step it concerned: `began` when the model started writing
 * a call, `started` when its tool started running, `ended` when the tool ended (always, for a
 * tool_execution_end, even one whose start was never seen).
 */
export function follow(live: Live, record: PiRecord, now = Date.now()): { began?: Step; started?: Step; ended?: Step } {
  const type = record.type;
  if (type === "message_update") {
    const ev = (record.assistantMessageEvent ?? {}) as PiRecord;
    const index = typeof ev.contentIndex === "number" ? ev.contentIndex : undefined;
    const writing = () => live.steps.findLast((s) => s.state === "writing" && s.contentIndex === index);
    if (ev.type === "text_start" || ev.type === "text_delta") live.streaming = true;
    else if (ev.type === "thinking_start" || ev.type === "thinking_delta") {
      live.streaming = false;
      if (ev.type === "thinking_start") live.thinking = "";
      else if (typeof ev.delta === "string" && ev.delta) {
        live.thinking = (live.thinking + ev.delta).slice(-THINKING_TAIL);
        live.thought = heading(live.thinking) ?? live.thought;
      }
    } else if (ev.type === "toolcall_start") {
      live.streaming = false;
      live.thought = undefined;
      const tool = String(ev.toolName ?? "");
      if (!tool) return {};
      const step = blank(tool, String(ev.id || `call:${index ?? live.steps.length}`), "writing", now, undefined, index);
      live.steps.push(step);
      return { began: step };
    } else if (ev.type === "toolcall_delta") {
      const step = writing();
      if (step && typeof ev.delta === "string" && ev.delta) {
        step.json += ev.delta;
        step.activity = activityFor(step.tool, partialArgs(step.json));
      }
    } else if (ev.type === "toolcall_end") {
      const call = (ev.toolCall ?? {}) as PiRecord;
      const known = writing();
      const tool = known?.tool ?? String(call.name ?? "");
      if (!tool) return {};
      const step = known ?? blank(tool, String(call.id || `call:${index ?? live.steps.length}`), "ready", now, call.arguments, index);
      if (!known) live.steps.push(step);
      if (call.id) step.id = String(call.id);
      step.state = "ready";
      step.args = call.arguments ?? step.args;
      step.activity = activityFor(tool, call.arguments ?? partialArgs(step.json));
      return known ? {} : { began: step };
    }
    return {};
  }
  if (type === "message_start" && record.message?.role === "assistant") {
    // A new response: whatever the last one called is over, and so is any wait before this one.
    live.steps = [];
    live.streaming = false;
    live.pause = undefined;
    live.thinking = "";
    live.thought = undefined;
    return {};
  }
  if (type === "message_end" && record.message?.role === "assistant") {
    live.streaming = false;
    const message = record.message as PiRecord;
    const running = live.steps.filter((s) => s.state === "running");
    const written = live.steps.filter((s) => s.state !== "running");
    // A response that failed or was stopped runs none of the calls it was writing.
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      live.steps = running;
      return {};
    }
    // The finished message is the authority on what it calls: a call that never streamed is taken from it.
    const calls: PiRecord[] = Array.isArray(message.content) ? message.content.filter((block: PiRecord) => block?.type === "toolCall") : [];
    const next = calls.flatMap((call) => {
      const tool = String(call.name ?? "");
      if (!tool || running.some((s) => s.id === call.id)) return [];
      const at = written.findIndex((s) => (call.id ? s.id === call.id : s.tool === tool));
      const step = at >= 0 ? written.splice(at, 1)[0]! : blank(tool, String(call.id || `call:${tool}`), "ready", now, call.arguments);
      step.state = "ready";
      step.args = call.arguments ?? step.args;
      step.activity = activityFor(tool, step.args ?? partialArgs(step.json));
      return [step];
    });
    live.steps = [...running, ...next];
    return {};
  }
  if (type === "tool_execution_start") {
    const tool = String(record.toolName ?? "");
    const id = record.toolCallId ? String(record.toolCallId) : "";
    let step = (id ? live.steps.find((s) => s.id === id) : undefined) ?? live.steps.find((s) => s.state !== "running" && s.tool === tool);
    if (!step) live.steps.push((step = blank(tool, id || `run:${tool}:${now}:${live.steps.length}`, "running", now, record.args)));
    if (id) step.id = id;
    step.state = "running";
    step.since = now;
    step.args = record.args ?? step.args;
    step.activity = activityFor(tool, step.args);
    return { started: step };
  }
  if (type === "tool_execution_end") {
    const tool = String(record.toolName ?? "");
    const id = record.toolCallId ? String(record.toolCallId) : "";
    let at = id ? live.steps.findLastIndex((s) => s.id === id) : -1;
    if (at < 0) at = live.steps.findLastIndex((s) => s.tool === tool && s.state === "running");
    if (at < 0) at = live.steps.findLastIndex((s) => s.tool === tool);
    return { ended: at >= 0 ? live.steps.splice(at, 1)[0]! : blank(tool, id || `run:${tool}`, "running", now) };
  }
  if (type === "turn_end" || type === "agent_end" || type === "agent_settled") {
    // The response and every tool it called are finished: nothing of them is left showing.
    live.steps = [];
    live.streaming = false;
    if (type === "agent_settled") live.pause = undefined;
    return {};
  }
  if (type === "compaction_start") live.pause = "compaction";
  else if (type === "auto_retry_start") live.pause = "retry";
  else if (type === "compaction_end" || type === "auto_retry_end") live.pause = undefined;
  return {};
}

/**
 * The status line for where things stand: the newest step still running, else the newest call being
 * written, else what Pi is busy with, else "Writing a reply" while its words are on their way to the
 * chat (`writing`). Between those, it keeps saying what the bot is about: the heading of its reasoning,
 * else the last step it named this turn, else what the turn started on. Plain working words only when
 * there's none of that. `counts` leaves out steps the chat shows some other way.
 */
export function liveActivity(live: Live, opts: { writing?: boolean; counts?: (step: Step) => boolean } = {}): string {
  const steps = opts.counts ? live.steps.filter(opts.counts) : live.steps;
  const step = steps.findLast((s) => s.state === "running" && s.activity) ?? steps.findLast((s) => s.activity);
  // A heading is the newest thing it named until a step comes along; the step is newer from then on.
  if (step?.activity) live.thought = undefined;
  if (step?.activity && KEPT(step)) live.last = step.activity;
  else if (live.thought) live.last = live.thought;
  const specific = step?.activity || (live.pause === "compaction" ? COMPACTING : live.pause === "retry" ? RETRYING : opts.writing ? WRITING_REPLY : "") || live.last || live.start;
  if (specific) {
    live.plain = false;
    return specific;
  }
  if (!live.plain) {
    live.plain = true;
    live.phrase++;
  }
  return workingPhrase(live.phrase);
}
