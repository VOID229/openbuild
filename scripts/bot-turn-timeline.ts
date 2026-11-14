// A bot's turn as a timeline: where the time goes between the user's message and the bot's last
// reply. It starts the bots server from this checkout on a throwaway data directory and a Pi set up
// like nobody's, sends a task through the app's own HTTP route to a new bot (cold), then again
// (warm), and writes down when each step happened: the route, the wake, every Pi process and RPC,
// each model request (start, first token, first tool call, end, tokens), each tool call (in Pi and in
// the server's handler), every `claude` process the Claude Code bridge starts, and each message.
//
//   bun scripts/bot-turn-timeline.ts --model claude-code/claude-opus-5-5            1 cold + 2 warm
//   bun scripts/bot-turn-timeline.ts --model … --cold 3 --warm 3 --json out.json    3 processes, 3 warm turns in each
//   bun scripts/bot-turn-timeline.ts --model … --idle                               also a turn after the bot's Pi idled out
//   bun scripts/bot-turn-timeline.ts --model … --task "what's 2+2?" --effort low
//   bun scripts/bot-turn-timeline.ts --model … --no-standby --starter "" --search   compare: no standby `claude`, other starter tools, a search provider set up
//
// It runs real model requests on the model you name, with this user's own sign-in for it (a Claude
// Code login for claude-code/…, Pi's auth.json for the rest), so it costs what those turns cost.
// Nothing is read from or written to the live data directory, and the bot's Pi sessions stay in
// the throwaway one. It prints times, token counts and tool names; with --verbose also what the bot
// said and ran.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TASK = "write a file in /tmp and read it";

interface Mark {
  /** Milliseconds since the user's message was sent. */
  at: number;
  kind: string;
  name: string;
  ms?: number;
  [key: string]: unknown;
}

/** One model request, as Pi streamed it. */
export interface Request {
  /** From the previous step ending (the prompt, or the last tool result) to the request's first sign of life. */
  gapMs: number;
  /** To the first token of any kind (thinking, text or a tool call). */
  firstTokenMs?: number;
  /** To the end of the message. */
  totalMs: number;
  start: number;
  end: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  stop?: string;
  tools: string[];
  /** Through the Claude Code bridge: where the request's time went inside it (its PI_CLAUDE_CODE_TRACE). */
  bridge?: BridgeRequest;
}

export interface BridgeRequest {
  /** It carried on in the `claude` process the last request left, instead of starting one. */
  continuation: boolean;
  /** It took the process the bridge had started ahead of it. */
  standby: boolean;
  /** From Pi asking for the request to `claude` being started (the login check, the files it's given). */
  spawnMs?: number;
  /** …to `claude` calling the API: its own start-up, and replaying the conversation into it. */
  apiCallMs?: number;
  /** From there to the API's response headers, and to its first streamed bytes. */
  headersMs?: number;
  firstBytesMs?: number;
  /** From the API call to the response's end. */
  apiMs?: number;
  totalMs?: number;
  /** The request as it went to the API, in characters of JSON: tool declarations, system prompt, messages. */
  toolChars?: number;
  tools?: number;
  systemChars?: number;
  messageChars?: number;
}

export interface ToolCall {
  tool: string;
  start: number;
  /** As Pi saw it: the extension, the socket, the server's handler and back. */
  ms: number;
  /** Inside the server's handler alone. */
  handlerMs?: number;
  detail?: string;
  error?: boolean;
  detached?: boolean;
}

export interface Turn {
  label: "cold" | "warm" | "idle";
  /** The route answered the POST. */
  routeMs: number;
  /** The runner took the wake (the turn's status first showed). */
  wakeMs?: number;
  /** Pi processes started for this turn, by what they were for. */
  spawns: { what: string; at: number; ms?: number }[];
  /** RPC commands the runner sent Pi before the prompt, and how long each took. */
  setup: { name: string; at: number; ms: number }[];
  promptSentMs?: number;
  /** The extension's `context` call, which Pi waits for before the first model request: how long the server took over it. */
  contextMs?: number;
  /** Pi had read the bot's context (the extension's `context` call) and started the agent. */
  agentStartMs?: number;
  requests: Request[];
  calls: ToolCall[];
  /** `claude` processes the bridge started, and how long each lived. */
  claude: { what: string; at: number; ms?: number }[];
  firstStatusMs?: number;
  firstReplyMs?: number;
  lastReplyMs?: number;
  settledMs?: number;
  doneMs: number;
  replies: number;
  marks: Mark[];
}

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const flag = (name: string) => args.includes(name);

// ------------------------------------------------------------------ the child: one server, its turns

async function child() {
  const model = option("--model")!;
  const effort = option("--effort");
  const warm = Number(option("--warm") ?? 2);
  const task = option("--task") ?? TASK;
  const out = option("--out")!;
  const verbose = flag("--verbose");
  const claudeLog = process.env.TIMELINE_CLAUDE_LOG;
  const bridgeTrace = process.env.PI_CLAUDE_CODE_TRACE;

  let origin = Date.now();
  let marks: Mark[] = [];
  /** The bot under test: other bots' Pis are traced too, and left out of its turns. */
  let botId = "";
  const mine = (cwd: unknown) => !botId || String(cwd ?? "").includes(botId);
  const mark = (kind: string, name: string, extra: Record<string, unknown> = {}) => marks.push({ at: Date.now() - origin, kind, name, ...extra });

  // Every process the server starts with Bun.spawn: Pi, and the probe that lists its models.
  const realSpawn = Bun.spawn.bind(Bun);
  (Bun as { spawn: unknown }).spawn = (...spawnArgs: unknown[]) => {
    const first = spawnArgs[0] as string[] | { cmd: string[] };
    const cmd = Array.isArray(first) ? first : first.cmd;
    const pi = cmd.includes("--mode") && cmd.includes("rpc");
    const what = !pi ? `${String(cmd[0]).split("/").pop()} ${cmd.slice(1, 3).join(" ")}` : cmd.includes("--no-session") ? "pi (model probe)" : cmd.includes("--no-tools") || cmd.some((a) => a.includes("OPENBOTS_HELPER")) ? "pi (helper)" : "pi (bot)";
    const started = Date.now();
    const options = (Array.isArray(first) ? spawnArgs[1] : first) as { cwd?: string } | undefined;
    const own = !pi || mine(options?.cwd);
    mark("spawn", what, { own });
    const proc = (realSpawn as (...a: unknown[]) => { exited: Promise<number> })(...spawnArgs);
    void proc.exited.then(() => mark("exit", what, { ms: Date.now() - started, own }));
    return proc;
  };

  const { PiProcess } = await import("../server/pi/rpc");
  const procs = new WeakMap<object, string>();
  let procN = 0;
  const send = PiProcess.prototype.send;
  PiProcess.prototype.send = async function (this: InstanceType<typeof PiProcess>, command: { type: string }, timeoutMs?: number) {
    if (!procs.has(this)) procs.set(this, `pi#${++procN}`);
    const started = Date.now();
    try {
      return await send.call(this, command, timeoutMs);
    } finally {
      mark("rpc", command.type, { ms: Date.now() - started, proc: procs.get(this), startedAt: started - origin, own: mine(this.cwd) });
    }
  } as typeof send;
  const on = PiProcess.prototype.on;
  PiProcess.prototype.on = function (this: InstanceType<typeof PiProcess>, listener: Parameters<typeof on>[0]) {
    if (!procs.has(this)) procs.set(this, `pi#${++procN}`);
    const seen = new Set<string>();
    on.call(this, (record) => {
      const ev = record.type === "message_update" ? record.assistantMessageEvent : undefined;
      if (ev) {
        // The first of each kind per content block: the rest are deltas of the same thing.
        const key = `${ev.type}:${ev.contentIndex ?? ""}`;
        if (seen.has(key)) return;
        seen.add(key);
        return void mark("stream", String(ev.type), { index: ev.contentIndex, own: mine(this.cwd) });
      }
      if (record.type === "message_start") seen.clear();
      const m = record.message;
      const extra: Record<string, unknown> = { own: mine(this.cwd), proc: procs.get(this) };
      if (m?.role) extra.role = m.role;
      if (record.type === "message_end" && m?.role === "assistant") {
        Object.assign(extra, { usage: m.usage, stop: m.stopReason, tools: (m.content ?? []).flatMap((b: { type?: string; name?: string }) => (b?.type === "toolCall" ? [b.name] : [])), error: m.errorMessage });
        if (verbose) extra.text = (m.content ?? []).map((b: { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }) => (b.type === "text" ? b.text : b.type === "thinking" ? `<thinking ${String(b.thinking ?? "").length} chars>` : `<${b.name} ${JSON.stringify(b.arguments)}>`)).join(" ");
      }
      if (record.type === "message_end" && m?.role === "toolResult") Object.assign(extra, { tool: m.toolName, error: !!m.isError, chars: JSON.stringify(m.content ?? "").length, ...(verbose ? { result: JSON.stringify(m.content ?? "").slice(0, 400) } : {}) });
      if (record.type === "tool_execution_start" || record.type === "tool_execution_end") Object.assign(extra, { tool: record.toolName, id: record.toolCallId, ...(record.type === "tool_execution_end" ? { error: !!(record.isError || record.result?.isError), detached: typeof record.result?.details?.job === "number" } : {}) });
      if (record.type === "extension_error") extra.error = record.error;
      mark("pi", record.type, extra);
    });
    return on.call(this, listener);
  } as typeof on;

  const agent = await import("../server/bots/agent");
  const handle = agent.seams.handle;
  agent.seams.handle = async (id, method, p, signal) => {
    const started = Date.now();
    try {
      return await handle(id, method, p, signal);
    } finally {
      mark("handler", method, { ms: Date.now() - started, startedAt: started - origin, own: !botId || id === botId, ...(verbose && method !== "context" ? { params: JSON.stringify(p).slice(0, 300) } : {}) });
    }
  };

  // --starter bash,read,write: what every bot's Pi declares from the start, to compare sets.
  if (option("--starter") !== undefined) {
    const { STARTER_TOOLS } = await import("../server/bots/toolPreload");
    STARTER_TOOLS.splice(0, STARTER_TOOLS.length, ...option("--starter")!.split(",").map((name) => name.trim()).filter(Boolean));
  }
  const svc = await import("../server/bots/service");
  const db = await import("../server/bots/db");
  const runner = await import("../server/bots/runner");
  const { botRoutes } = await import("../server/bots/routes");
  // The app's own routes, with nothing in front of them: the session and origin checks aren't what's measured.
  const routes = botRoutes(((handler: unknown) => handler) as never);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: routes as never, fetch: () => new Response("Not found", { status: 404 }) });
  const api = (path: string, body: unknown, method = "POST") => fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  svc.updateSettings({ onboarding: "done", user: { name: "Sam", context: "" } });
  // --search: a web search provider set up (a SearXNG address nothing answers at), as a user who added one has.
  if (flag("--search")) svc.updateSettings({ searxng: ["http://127.0.0.1:9/"] });
  // The bot every install starts with, or one the user just made (which has no instructions or role yet).
  const primary = db.listBots().find((b) => b.primary)!;
  const created = option("--bot") === "primary" ? { bot: primary, conversationId: svc.directId(primary.id)! } : ((await (await api("/api/bots", { name: "Timer" })).json()) as { bot: { id: string }; conversationId: string });
  botId = created.bot.id;
  const conversationId = created.conversationId;
  // No check-in turn of another bot's in the middle of the one being timed.
  for (const b of db.listBots()) svc.touchHeartbeat(b.id);
  // "default" leaves the bot as a new one is: on Pi's default model, which with only a Claude Code login is Opus.
  if (model !== "default" || effort) await api(`/api/bots/${botId}`, { ...(model !== "default" ? { model } : {}), ...(effort ? { effort } : {}) }, "PATCH");
  const bot = db.getBot(botId);
  if (model !== "default" && bot?.model !== model) throw new Error(`The bot didn't take the model ${model}: ${JSON.stringify(bot)}`);
  // One Claude Code login, as a new user has: any other on this machine stays out of the bots' Pi.
  const { allProfiles } = await import("../server/bots/claude");
  const keep = model.startsWith("claude-code") ? model.slice(0, model.indexOf("/")) : "claude-code";
  svc.updateSettings({ claude: { off: allProfiles().map((p) => p.id).filter((id) => id !== keep), changedAt: 1 } });

  svc.subscribe((e) => {
    if (e.t === "message" && e.conversationId === conversationId && e.message.author !== "me") mark("chat", e.message.event ? `event:${e.message.event.kind}` : "message", { chars: e.message.text.length, ...(verbose || e.message.event ? { text: (e.message.event ? `${e.message.event.text} ${(e.message.event as { detail?: string }).detail ?? ""}` : e.message.text).slice(0, 300) } : {}) });
    if (e.t === "status" && e.botId === botId) mark("status", e.status.state, { activity: e.status.activity, quiet: e.status.quiet });
    if (e.t === "typing" && e.conversationId === conversationId) mark("typing", e.botIds.includes(botId) ? "on" : "off");
  });

  /** The `claude` processes the bridge started since `from`, from the wrapper's log. */
  const claudeSince = (from: number, until: number) => {
    if (!claudeLog || !existsSync(claudeLog)) return [];
    const rows = readFileSync(claudeLog, "utf8").split("\n").filter(Boolean).map((line) => line.split("\t"));
    const starts = rows.filter((r) => r[0] === "start");
    return starts.flatMap((r) => {
      const at = Number(r[1]);
      if (at < from || at > until) return [];
      const end = rows.find((e) => e[0] === "end" && e[2] === r[2]);
      const what = r[3]!.startsWith("auth status") ? "claude auth status" : r[3]!.includes("--include-partial-messages") ? `claude -p (request, ${/--model (\S+)/.exec(r[3]!)?.[1]})` : r[3]!.startsWith("-p") ? "claude -p (model discovery)" : `claude ${r[3]!.slice(0, 40)}`;
      return [{ what, at: at - from, ...(end ? { ms: Number(end[1]) - at } : {}) }];
    });
  };

  /** The bridge's requests between two moments, each with where its time went. */
  const bridgeSince = (from: number, until: number): BridgeRequest[] => {
    if (!bridgeTrace || !existsSync(bridgeTrace)) return [];
    const rows = readFileSync(bridgeTrace, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { at: number; pid: number; step: string; continuation?: boolean; standby?: boolean; toolChars?: number; tools?: number; systemChars?: number; messageChars?: number });
    const found: BridgeRequest[] = [];
    rows.forEach((row, i) => {
      if (row.step !== "request" || row.at < from || row.at > until) return;
      // Its steps: this Pi's lines up to its next request.
      const next = rows.findIndex((r, j) => j > i && r.pid === row.pid && r.step === "request");
      const steps = rows.slice(i, next < 0 ? undefined : next).filter((r) => r.pid === row.pid);
      const at = (step: string) => steps.find((r) => r.step === step)?.at;
      const since = (step: string, base = row.at) => (at(step) === undefined ? undefined : at(step)! - base);
      const api = at("api-request");
      const acquired = steps.find((r) => r.step === "acquired");
      found.push({ continuation: !!acquired?.continuation, standby: !!acquired?.standby, spawnMs: since("spawned"), apiCallMs: since("api-request"), headersMs: api === undefined ? undefined : since("api-response", api), firstBytesMs: api === undefined ? undefined : since("api-first-chunk", api), apiMs: api === undefined ? undefined : since("api-end", api), totalMs: since("done"), ...(() => { const sent = steps.find((r) => r.step === "api-request"); return sent ? { toolChars: sent.toolChars, tools: sent.tools, systemChars: sent.systemChars, messageChars: sent.messageChars } : {}; })() });
    });
    return found;
  };

  async function turn(label: Turn["label"]): Promise<Turn> {
    marks = [];
    origin = Date.now();
    const posted = await api(`/api/bots/conversations/${conversationId}/messages`, { id: crypto.randomUUID(), author: "me", at: Date.now(), text: task });
    if (!posted.ok) throw new Error(`The route refused the message: ${posted.status} ${await posted.text()}`);
    const routeMs = Date.now() - origin;
    // The turn is over once the bot is idle again with nothing queued, and has stayed so for a moment.
    const deadline = Date.now() + 5 * 60_000;
    let quietSince = 0;
    for (;;) {
      await Bun.sleep(50);
      const state = svc.getStatus(botId)?.state;
      const idle = !runner.busy(botId) && state !== "working";
      if (!idle) quietSince = 0;
      else if (!quietSince) quietSince = Date.now();
      else if (Date.now() - quietSince > 1500 && marks.some((m) => m.kind === "pi" && m.name === "agent_settled" || m.kind === "chat" && m.name.startsWith("event:error"))) break;
      if (Date.now() > deadline) {
        mark("harness", "gave up waiting");
        break;
      }
    }
    const end = Date.now();
    const all = marks.filter((m) => m.own !== false);
    const pi = (name: string) => all.filter((m) => m.kind === "pi" && m.name === name);
    const requests: Request[] = [];
    let last = all.find((m) => m.kind === "rpc" && m.name === "prompt")?.at ?? 0;
    let open: { start: number; first?: number } | undefined;
    const calls: ToolCall[] = [];
    const running = new Map<string, Mark>();
    for (const m of all) {
      if (m.kind === "pi" && m.name === "message_start" && m.role === "assistant") open = { start: m.at };
      else if (m.kind === "stream" && open && open.first === undefined) open.first = m.at;
      else if (m.kind === "pi" && m.name === "message_end" && m.role === "assistant" && open) {
        const usage = (m.usage ?? {}) as Record<string, number>;
        requests.push({ gapMs: open.start - last, firstTokenMs: open.first === undefined ? undefined : open.first - last, totalMs: m.at - last, start: last, end: m.at, input: usage.input ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, output: usage.output ?? 0, stop: m.stop as string, tools: (m.tools as string[]) ?? [] });
        open = undefined;
        last = m.at;
      } else if (m.kind === "pi" && m.name === "tool_execution_start") running.set(String(m.id), m);
      else if (m.kind === "pi" && m.name === "tool_execution_end") {
        const started = running.get(String(m.id));
        const handler = all.find((h) => h.kind === "handler" && h.name === m.tool && (h.startedAt as number) >= (started?.at ?? 0) - 5 && !calls.some((c) => c.handlerMs !== undefined && (c as { handlerAt?: number }).handlerAt === h.startedAt));
        calls.push({ tool: String(m.tool), start: started?.at ?? m.at, ms: m.at - (started?.at ?? m.at), handlerMs: handler?.ms, ...(handler ? { handlerAt: handler.startedAt } : {}), error: !!m.error, detached: !!m.detached } as ToolCall);
        last = Math.max(last, m.at);
      }
    }
    // The bridge's requests are this turn's model requests, in order (one bot runs at a time here).
    const bridged = bridgeSince(origin, end);
    if (bridged.length === requests.length) requests.forEach((r, i) => (r.bridge = bridged[i]));
    const replies = all.filter((m) => m.kind === "chat" && m.name === "message");
    const promptRpc = all.find((m) => m.kind === "rpc" && m.name === "prompt");
    const promptAt = promptRpc ? (promptRpc.startedAt as number) : undefined;
    return {
      label,
      routeMs,
      wakeMs: all.find((m) => m.kind === "status" && m.name === "working")?.at,
      spawns: all.filter((m) => m.kind === "spawn").map((m) => ({ what: m.name, at: m.at, ms: all.find((e) => e.kind === "exit" && e.name === m.name && e.at >= m.at)?.ms })),
      setup: all.filter((m) => m.kind === "rpc" && promptAt !== undefined && (m.startedAt as number) < promptAt).map((m) => ({ name: `${m.name}${m.proc ? ` (${m.proc})` : ""}`, at: m.startedAt as number, ms: m.ms! })),
      promptSentMs: promptAt,
      contextMs: all.find((m) => m.kind === "handler" && m.name === "context")?.ms,
      agentStartMs: pi("agent_start")[0]?.at,
      requests,
      calls,
      claude: claudeSince(origin, end),
      firstStatusMs: all.find((m) => m.kind === "status" && m.name === "working" && !m.quiet)?.at,
      firstReplyMs: replies[0]?.at,
      lastReplyMs: replies.at(-1)?.at,
      settledMs: pi("agent_settled").at(-1)?.at,
      doneMs: all.findLast((m) => m.kind === "status" && m.name === "idle")?.at ?? end - origin,
      replies: replies.length,
      marks: all,
    };
  }

  const turns: Turn[] = [];
  const save = () => writeFileSync(out, JSON.stringify({ model, effort: effort ?? "default", task, bun: Bun.version, turns, usage: existsSync(join(db.botsDir(), "usage.jsonl")) ? readFileSync(join(db.botsDir(), "usage.jsonl"), "utf8") : "" }));
  try {
    turns.push(await turn("cold"));
    save();
    for (let i = 0; i < warm; i++) {
      turns.push(await turn("warm"));
      save();
    }
    if (flag("--idle")) {
      // What the runner does to a bot left alone for 20 minutes: its Pi is closed. Its next message starts one.
      runner.stop(botId);
      await Bun.sleep(1500);
      turns.push(await turn("idle"));
      save();
    }
  } finally {
    runner.stop(botId);
    server.stop(true);
  }
  await Bun.sleep(300);
  process.exit(0);
}

// ------------------------------------------------------------------ the driver

const s = (ms: number | undefined) => (ms === undefined ? "–" : `${(ms / 1000).toFixed(ms < 9950 ? 2 : 1)}s`);
const median = (values: number[]) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2) : undefined;
};

/** Where a turn's time went, in the buckets the report uses. They add up to `doneMs`. */
export function breakdown(turn: Turn) {
  const prompt = turn.promptSentMs ?? 0;
  const firstRequest = turn.requests[0];
  const model = turn.requests.reduce((n, r) => n + (r.end - r.start), 0);
  // Tool time that held the turn: calls in one step run one after another, so their spans don't overlap.
  const tools = turn.calls.reduce((n, c) => n + c.ms, 0);
  const typing = turn.calls.filter((c) => c.tool === "send_message").reduce((n, c) => n + c.ms, 0);
  const lastEnd = Math.max(prompt, ...turn.requests.map((r) => r.end), ...turn.calls.map((c) => c.start + c.ms));
  return {
    /** The route, the wake, Pi starting and the RPCs before the prompt. */
    beforePromptMs: prompt,
    /** Model requests: from the previous step ending to the message's end (the bridge's `claude` start included). */
    modelMs: model,
    requests: turn.requests.length,
    /** …of which waiting for each request's first token. */
    firstTokensMs: turn.requests.reduce((n, r) => n + (r.firstTokenMs ?? r.totalMs), 0),
    toolsMs: tools,
    /** …of which send_message (its typing delay). */
    sendMessageMs: typing,
    /** After the last step: Pi settling, and the runner letting go. */
    afterMs: Math.max(0, turn.doneMs - lastEnd),
    otherMs: Math.max(0, lastEnd - prompt - model - tools),
    /** Through the bridge: time before `claude` called the API at all, and inside the API calls. */
    bridgeStartMs: turn.requests.some((r) => r.bridge) ? turn.requests.reduce((n, r) => n + (r.bridge?.apiCallMs ?? 0), 0) : undefined,
    apiMs: turn.requests.some((r) => r.bridge) ? turn.requests.reduce((n, r) => n + (r.bridge?.apiMs ?? 0), 0) : undefined,
    firstRequestGapMs: firstRequest?.gapMs,
    doneMs: turn.doneMs,
  };
}

export function describe(turn: Turn): string {
  const lines: string[] = [];
  const row = (at: number | undefined, text: string) => lines.push(`${s(at).padStart(7)}  ${text}`);
  row(0, "user's message sent");
  row(turn.routeMs, "route answered");
  row(turn.wakeMs, "runner took the wake");
  for (const p of turn.spawns) row(p.at, `started ${p.what}${p.ms !== undefined ? `, lived ${s(p.ms)}` : ""}`);
  for (const c of turn.claude) row(c.at, `bridge started ${c.what}${c.ms !== undefined ? `, lived ${s(c.ms)}` : ""}`);
  for (const r of turn.setup) row(r.at, `rpc ${r.name}: ${s(r.ms)}`);
  row(turn.promptSentMs, "prompt sent to Pi");
  row(turn.agentStartMs, `Pi started the agent (its context call took ${s(turn.contextMs)})`);
  turn.requests.forEach((r, i) => {
    const b = r.bridge;
    const inside = b ? ` [bridge: ${b.continuation ? "same claude" : b.standby ? "standby claude" : `new claude, started after ${s(b.spawnMs)}`}, API called after ${s(b.apiCallMs)}, headers +${s(b.headersMs)}, first bytes +${s(b.firstBytesMs)}, API done +${s(b.apiMs)}]` : "";
    row(r.start, `model request ${i + 1}: first token after ${s(r.firstTokenMs)}, done after ${s(r.totalMs)}; prompt ${r.input + r.cacheRead + r.cacheWrite} tok (${r.cacheRead} cached, ${r.cacheWrite} written), output ${r.output} tok → ${r.tools.join(", ") || r.stop}${inside}`);
    for (const c of turn.calls.filter((c) => c.start >= r.end - 5 && c.start < (turn.requests[i + 1]?.end ?? Infinity) && (i === turn.requests.length - 1 || c.start < turn.requests[i + 1]!.start + (turn.requests[i + 1]!.gapMs ?? 0) + 1))) row(c.start, `  tool ${c.tool}: ${s(c.ms)} in Pi, ${s(c.handlerMs)} in the handler${c.detached ? " (detached as a job)" : ""}${c.error ? " (error)" : ""}`);
  });
  row(turn.firstReplyMs, "first reply in the chat");
  row(turn.lastReplyMs, `last reply in the chat (${turn.replies} in all)`);
  row(turn.settledMs, "Pi settled");
  row(turn.doneMs, "bot idle");
  return lines.sort((a, b) => parseFloat(a) - parseFloat(b)).join("\n");
}

async function driver() {
  const model = option("--model");
  if (!model || flag("--help") || flag("-h")) {
    console.log("Usage: bun scripts/bot-turn-timeline.ts --model provider/id [--effort level] [--cold n] [--warm n] [--idle] [--bot primary|new] [--no-standby] [--starter tool,tool] [--search] [--task text] [--json out.json] [--keep] [--verbose]");
    process.exit(model ? 0 : 1);
  }
  const cold = Number(option("--cold") ?? 1);
  const base = mkdtempSync(join(process.env.TIMELINE_TMP || tmpdir(), "openbuild-turn-timeline-"));
  const results: { model: string; effort: string; task: string; turns: Turn[]; usage: string }[] = [];
  const checkout = resolve(import.meta.dir, "..");
  try {
    // The bridge's `claude`, with its start and end written down. Only for a claude-code model.
    const realClaude = Bun.which("claude", { PATH: `${process.env.PATH ?? ""}:${join(homedir(), ".local", "bin")}` });
    const wrapper = join(base, "claude-timed");
    if (realClaude) {
      writeFileSync(wrapper, `#!/bin/sh\nid="$$-$(date +%s%N)"\nprintf 'start\\t%s\\t%s\\t%s\\n' "$(date +%s%3N)" "$id" "$*" | cut -c1-400 >> "$TIMELINE_CLAUDE_LOG"\n${JSON.stringify(realClaude)} "$@"\ncode=$?\nprintf 'end\\t%s\\t%s\\n' "$(date +%s%3N)" "$id" >> "$TIMELINE_CLAUDE_LOG"\nexit $code\n`);
      chmodSync(wrapper, 0o755);
    }
    for (let i = 0; i < cold; i++) {
      const dir = join(base, `run-${i + 1}`);
      const agentDir = join(dir, "agent");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(join(dir, "tmp"), { recursive: true });
      // A model that isn't the bridge's needs the user's Pi sign-ins: a copy, so this Pi's own state stays apart.
      if (model !== "default" && !model.startsWith("claude-code")) for (const name of ["auth.json", "models.json"]) if (existsSync(join(homedir(), ".pi", "agent", name))) copyFileSync(join(homedir(), ".pi", "agent", name), join(agentDir, name));
      const out = join(dir, "timeline.json");
      // A server started from a login shell: nothing of the session this script was run from.
      const env: Record<string, string> = {
        HOME: homedir(), USER: process.env.USER ?? "", LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "", LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb", SHELL: process.env.SHELL ?? "/bin/sh",
        PATH: `${join(homedir(), ".local", "bin")}:${join(homedir(), ".bun", "bin")}:/usr/local/bin:/usr/bin:/bin`,
        ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
        OPENCHAT_DATA_DIR: join(dir, "data"), PI_CODING_AGENT_DIR: agentDir, TMPDIR: join(dir, "tmp"), NODE_ENV: "production",
        // Its own, empty, key store: the user's search providers and app sign-ins stay out of the bot's context and reach.
        OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json"),
        ...(process.env.PI_BIN ? { PI_BIN: process.env.PI_BIN } : {}),
        ...(realClaude ? { CLAUDE_BIN: wrapper, TIMELINE_CLAUDE_LOG: join(dir, "claude.log") } : {}),
        PI_CLAUDE_CODE_TRACE: join(dir, "bridge-trace.jsonl"),
        ...(flag("--no-standby") ? { PI_CLAUDE_CODE_STANDBY: "0" } : {}),
      };
      const passed = ["--model", model, "--warm", option("--warm") ?? "2", "--task", option("--task") ?? TASK, "--out", out, ...(option("--effort") ? ["--effort", option("--effort")!] : []), ...(flag("--idle") ? ["--idle"] : []), ...(flag("--verbose") ? ["--verbose"] : []), ...(option("--bot") ? ["--bot", option("--bot")!] : []), ...(option("--starter") !== undefined ? ["--starter", option("--starter")!] : []), ...(flag("--search") ? ["--search"] : [])];
      const proc = spawn(process.execPath, [import.meta.path, "--child", ...passed], { cwd: checkout, env, stdio: ["ignore", "inherit", "inherit"] });
      const code = await new Promise<number>((done) => proc.on("close", (c) => done(c ?? -1)));
      if (existsSync(out)) results.push(JSON.parse(readFileSync(out, "utf8")));
      if (code !== 0) console.error(`Run ${i + 1} ended with code ${code}.`);
    }
    const turns = results.flatMap((r) => r.turns);
    if (option("--json")) writeFileSync(option("--json")!, JSON.stringify({ model, effort: option("--effort") ?? "default", task: option("--task") ?? TASK, at: new Date().toISOString(), turns }, null, 1));
    for (const label of ["cold", "warm", "idle"] as const) {
      const group = turns.filter((t) => t.label === label);
      if (!group.length) continue;
      const parts = group.map(breakdown);
      const mid = (pick: (b: ReturnType<typeof breakdown>) => number | undefined) => s(median(parts.map((b) => pick(b) ?? NaN)));
      console.log(`\n${label.toUpperCase()}: ${group.length} ${group.length === 1 ? "turn" : "turns"}, medians`);
      console.log(`  message → bot idle            ${mid((b) => b.doneMs)}   (each: ${group.map((t) => s(t.doneMs)).join(", ")})`);
      console.log(`  message → first reply         ${s(median(group.map((t) => t.firstReplyMs ?? NaN)))}`);
      console.log(`  message → last reply          ${s(median(group.map((t) => t.lastReplyMs ?? NaN)))}`);
      console.log(`  before the prompt reaches Pi  ${mid((b) => b.beforePromptMs)}`);
      console.log(`  model requests                ${mid((b) => b.modelMs)} over ${median(parts.map((b) => b.requests))} requests (waiting for first tokens: ${mid((b) => b.firstTokensMs)})`);
      if (parts.some((b) => b.bridgeStartMs !== undefined)) console.log(`    of which, in the bridge     ${mid((b) => b.bridgeStartMs)} before \`claude\` calls the API, ${mid((b) => b.apiMs)} in the API calls`);
      console.log(`  tool calls                    ${mid((b) => b.toolsMs)} (send_message: ${mid((b) => b.sendMessageMs)})`);
      console.log(`  after the last step           ${mid((b) => b.afterMs)}`);
      console.log(`\n${describe(group[Math.floor((group.length - 1) / 2)]!)}`);
    }
  } finally {
    if (flag("--keep")) console.log(`\nKept: ${base}`);
    else rmSync(base, { recursive: true, force: true });
  }
}

if (import.meta.main) await (flag("--child") ? child() : driver());
