// Loaded into each bot's `pi --mode rpc` process (`-e`). No OpenBuild imports but the shared HTML
// page guide, which has none of its own: Pi runs this file on its own. Every tool calls the bots service over the unix socket the process was given
// (OPENBOTS_SOCKET, OPENBOTS_TOKEN). Built-in tools are off; bash/read/write/edit here run on the
// bot's computers (one on each machine it reaches, chosen per call), not on the machine the user is sitting at.
import { request as httpRequest } from "node:http";
import { BOT_HTML_WIDTH, HTML_THEME_GUIDE, htmlLayoutGuide } from "../../shared/htmlRender";

type Params = Record<string, unknown>;

function call(method: string, params: Params = {}): Promise<unknown> {
  const body = JSON.stringify({ method, params });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: process.env.OPENBOTS_SOCKET,
        path: "/",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.OPENBOTS_TOKEN ?? ""}`,
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let parsed: { result?: unknown; error?: string } = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString() || "{}");
          } catch {
            reject(new Error(`The bots service answered ${res.statusCode}`));
            return;
          }
          if ((res.statusCode ?? 500) >= 400 || parsed.error) reject(new Error(parsed.error || `The bots service answered ${res.statusCode}`));
          else resolve(parsed.result);
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const text = (value: unknown) => [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
const ok = (value: unknown) => ({ content: text(value), details: value });
const fail = (err: unknown) => ({ content: text(`Error: ${err instanceof Error ? err.message : String(err)}`), details: null, isError: true });

// These already show as typing or need no status line.
const NO_STATUS = new Set(["send_message", "react", "question", "poll", "html_render", "todo", "load_tools"]);

/**
 * The tools every request declares in full: chatting (all a friend's chat may use) and memory, which
 * nearly every turn reaches for, and load_tools. Every other tool is a line in load_tools' catalog,
 * and its schema reaches the model only once the bot loads it. That's Pi's own dynamic tool loading:
 * setActiveTools() during a tool call declares the tool on the next request of the same turn, and Pi
 * records each change of loadout in the session, where a restarted Pi finds it (session_start below).
 */
export const CORE_TOOLS = ["send_message", "react", "memory", "search", "load_tools"];
const CORE = new Set(CORE_TOOLS);

/** Each catalog tool in a line: enough for the bot to know it's there and when to load it. */
export const CATALOG_BRIEF: Record<string, string> = {
  bash: "run a shell command on your computer",
  read: "read a text file on your computer",
  write: "write a text file on your computer",
  edit: "replace text in a file on your computer",
  browser: "your web browser: open, click, type, screenshot",
  process: "start, read and stop long-running programs",
  question: "ask the user to pick from choices",
  poll: "start a poll in a group chat",
  vote_poll: "vote in a poll",
  html_render: "show an HTML page (chart, diagram, demo) in the chat",
  todo: "the conversation's to-do list",
  bot_web_search: "search the web through the user's search providers",
  apps: "the user's connected apps (GitHub, Notion…): their tools and skills",
  use_app: "call a connected app's tool",
  routine: "your schedule: recurring and one-off routines",
  ask_bot: "ask another bot and wait for the reply",
  side_chat: "talk something through with other bots",
  openbuild: "run coding agents in the user's OpenBuild",
  plugins: "OpenBuild plugins",
  manage_bot: "create and change bots, groups, models; see the team",
};

/** load_tools' description: what it does, then the catalog. */
export function catalogDescription(names: string[]): string {
  return "Load tools by name before you first call them; several at once is fine, and you can call them right after. They stay loaded for this session. Your other tools:\n" + names.map((name) => `- ${name}: ${CATALOG_BRIEF[name] ?? name}`).join("\n");
}

/**
 * The catalog tools a session had loaded, from the loadouts Pi recorded in it (its getCurrentTools).
 * undefined keeps every tool: a session that ran before there was a catalog, or with no recorded loadout.
 */
export function loadedTools(entries: any[], catalog: Set<string>): Set<string> | undefined {
  const system = entries.flatMap((entry) => (entry?.type === "message" && entry.message?.role === "system" ? [entry.message] : []));
  const loadouts = system.filter((message) => message.toolsAdded || message.toolsRemoved);
  if (!loadouts.length) return entries.some((entry) => entry?.type === "message") ? undefined : new Set();
  const tools = new Set<string>();
  for (const message of loadouts) {
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool?.name);
    for (const tool of message.toolsAdded ?? []) tools.add(tool?.name);
  }
  // Recorded before load_tools existed: it had every tool, so it keeps them.
  if (!tools.has("load_tools")) return undefined;
  return new Set([...tools].filter((name) => catalog.has(name)));
}
const status = { type: "string", minLength: 1, description: "Required. A short custom status (a few words, at most 50 characters) the user sees while this runs. Say what this specific call is for in plain terms, e.g. “Updating your school.md” or “Figuring out why the build broke”." };

/** Require a custom status in a work tool's parameters. */
function withStatus(name: string, parameters: object) {
  const schema = parameters as { properties?: Record<string, unknown>; required?: string[] };
  return NO_STATUS.has(name) ? parameters : { ...schema, properties: { ...schema.properties, status }, required: [...(schema.required ?? []), "status"] };
}

/** The tool's own parameters, without the status meant for the user. */
function own(params: Params | undefined): Params {
  const { status: _, ...rest } = params ?? {};
  return rest;
}

function tool(name: string, label: string, description: string, parameters: object, run: (params: Params) => Promise<unknown>) {
  return {
    name,
    label,
    description,
    parameters: withStatus(name, parameters),
    executionMode: "sequential" as const,
    exposure: "model-only" as const,
    async execute(_id: string, params: Params) {
      try {
        return ok(await run(own(params)));
      } catch (err) {
        return fail(err);
      }
    },
  };
}

const str = (description: string) => ({ type: "string", description });
/** The machine a computer tool runs on. Each has a computer of the bot's own; nothing falls back to another. */
const machine = str("The machine to run on: a name or id from your context's machine list. This server if omitted.");

/**
 * Tool guidelines other extensions registered. Pi lists them in the rules section of its default
 * prompt, which a bot's own system prompt (extensions.ts) replaces, so they come back on their own.
 */
export function toolRules(opts: any): Record<string, string> {
  const hidden = new Set<string>(Array.isArray(opts.hiddenTools) ? opts.hiddenTools : []);
  const tools: string[] = Array.isArray(opts.selectedTools) ? opts.selectedTools.filter((name: string) => !hidden.has(name)) : [];
  const rules = [...tools.flatMap((name) => opts.toolGuidelines?.[name] ?? []), ...(Array.isArray(opts.promptGuidelines) ? opts.promptGuidelines : [])].map((rule) => String(rule).trim()).filter(Boolean);
  return rules.length ? { openbots_tool_rules: [...new Set(rules)].map((rule) => `- ${rule}`).join("\n") } : {};
}

export default function openbots(pi: any) {
  const catalog: string[] = [];
  /** A catalog tool starts inactive: declared to the model only once loaded. */
  const register = (definition: any) => {
    if (!CORE.has(definition.name)) catalog.push(definition.name);
    pi.registerTool(CORE.has(definition.name) ? definition : { ...definition, defaultActive: false });
  };
  const dynamic = () => typeof pi.getActiveTools === "function" && typeof pi.setActiveTools === "function";
  /** Activates the catalog tools this Pi has (a friend's chat has none of them) and returns those now active. */
  const load = (names: string[]): string[] => {
    const registered = typeof pi.getAllTools === "function" ? new Set<string>(pi.getAllTools().map((t: any) => t.name)) : undefined;
    const wanted = names.filter((name) => catalog.includes(name) && (!registered || registered.has(name)));
    // A Pi without dynamic loading has every tool active already.
    if (!dynamic()) return wanted;
    const active: string[] = pi.getActiveTools();
    if (wanted.some((name) => !active.includes(name))) pi.setActiveTools([...new Set([...active, ...wanted])]);
    const now = new Set<string>(pi.getActiveTools());
    return wanted.filter((name) => now.has(name));
  };

  // `--tools` activates every tool it names, so a catalog tool the session hasn't loaded is put back out.
  pi.on("session_start", (_event: any, ctx: any) => {
    if (!dynamic()) return;
    const entries = typeof ctx?.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
    const kept = loadedTools(entries, new Set(catalog));
    if (!kept) return;
    const active: string[] = pi.getActiveTools();
    const next = active.filter((name) => !catalog.includes(name) || kept.has(name));
    if (next.length !== active.length) pi.setActiveTools(next);
  });

  // A call to a tool that isn't loaded yet loads it, and the bot is told to call it again.
  pi.on("message_end", (event: any) => {
    const message = event?.message;
    if (!dynamic() || message?.role !== "toolResult" || !message.isError || !catalog.includes(message.toolName)) return;
    if (message.content?.[0]?.text !== `Tool ${message.toolName} not found`) return;
    if (!load([message.toolName]).length) return;
    return { message: { ...message, content: text(`${message.toolName} wasn't loaded, so that call didn't run. It's loaded now: call it again.`) } };
  });

  pi.on("before_agent_start", async (event: any) => {
    try {
      const context = (await call("context")) as { sections: Record<string, string> };
      const opts = event.systemPromptOptions ?? event;
      const sections = { ...context.sections, ...toolRules(opts) };
      // Pi re-sends only the sections whose text changed, so a new memory doesn't repeat the whole context.
      if (opts.sections && typeof opts.sections === "object") return void Object.assign(opts.sections, sections);
      const note = Object.values(sections).filter(Boolean).join("\n\n");
      const current = String(opts.appendSystemPrompt ?? "");
      if (!current.includes("one of the user's bots in OpenBots")) opts.appendSystemPrompt = [current, note].filter(Boolean).join("\n\n");
    } catch {
      // The turn still has the message the server sent. A missing note isn't fatal.
    }
  });

  register(tool("bash", "Terminal", "Run a shell command on your computer and wait for it to finish. For something long-running, use process instead.", { type: "object", properties: { machine, command: str("The command."), cwd: str("Working directory, relative to your home if not absolute."), timeout: { type: "number", description: "Milliseconds before the command is stopped. Default 120000." } }, required: ["command"] }, (p) => call("bash", p)));

  register(tool("read", "Read file", "Read a text file on your computer.", { type: "object", properties: { machine, path: str("File path."), offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] }, (p) => call("read", p)));

  register(tool("write", "Write file", "Write a text file on your computer, creating it if needed.", { type: "object", properties: { machine, path: str("File path."), content: str("The whole file.") }, required: ["path", "content"] }, (p) => call("write", p)));

  register(tool("edit", "Edit file", "Replace one exact occurrence of text in a file on your computer.", { type: "object", properties: { machine, path: str("File path."), old: str("The exact text to replace, including enough around it to be unique."), new: str("The replacement.") }, required: ["path", "old", "new"] }, (p) => call("edit", p)));

  register(
    tool(
      "browser",
      "Browser",
      "Your browser. action is open (url, new_tab), snapshot (numbered refs for the elements you can click), click (ref), type (ref, text, submit), press (key), scroll (direction up or down), screenshot, eval (script), tabs, switch (index), close (index), back, or quit. snapshot before click or type. screenshot is for you; send_message with attach_screenshot shows it to the user.",
      {
        type: "object",
        properties: {
          machine,
          action: str("open, snapshot, click, type, press, scroll, screenshot, eval, tabs, switch, close, back, or quit."),
          url: str("For open."),
          ref: str("The number from the last snapshot."),
          text: str("For type."),
          key: str("For press, e.g. Enter or Control+A."),
          direction: str("up or down."),
          script: str("For eval. A JS expression."),
          index: { type: "number" },
          new_tab: { type: "boolean" },
          submit: { type: "boolean" },
        },
        required: ["action"],
      },
      (p) => call("browser", p.action === "back" ? { ...p, action: "history", direction: "back" } : p),
    ),
  );

  register(tool("process", "Process", "Start, read, stop or list long-running programs on your computer. action is start (command, name), read (id, input), stop (id) or list. You're told when one you started on this server exits. Processes belong to the machine they run on.", { type: "object", properties: { machine, action: str("start, read, stop or list."), command: str("For start."), name: str("A short name."), id: str("The process id."), input: str("Text to write to it.") }, required: ["action"] }, (p) => call("process", p)));

  register(tool("send_message", "Send", "Send a message. One call is one bubble; call it again for another. conversation defaults to the one you're in (pass the short id to write somewhere else). reply_to is a message's short id. images are file paths on your computer. attach_screenshot sends the current browser page. machine says which computer both come from.", { type: "object", properties: { text: str("The message."), machine, conversation: str("Short conversation id."), reply_to: str("Short message id."), images: { type: "array", items: { type: "string" } }, attach_screenshot: { type: "boolean" } }, required: ["text"] }, (p) => call("send_message", p)));

  register(
    tool(
      "html_render",
      "Show page",
      `Show a finished HTML page in the chat: a chart, diagram, demo, mockup, small interactive tool or visual summary. It's kept with the conversation like a message. ` +
        `It runs in a sandboxed frame: inline <style> and <script> work, and libraries load from CDNs, but it can't reach the app, your computer, the user's files or a local server. ` +
        `Don't describe the page in a message too. ${htmlLayoutGuide(BOT_HTML_WIDTH, 300, "the chat")} ${HTML_THEME_GUIDE}`,
      {
        type: "object",
        properties: {
          html: str("A complete, self-contained HTML document."),
          title: str("A short name for the page, e.g. \"Weekly signups\"."),
          height: { type: "integer", description: "Your best guess at its height in CSS pixels, until it has loaded; the frame then fits the page." },
          conversation: str("Short conversation id. The one you're in if omitted."),
        },
        required: ["html", "title"],
      },
      (p) => call("html_render", p),
    ),
  );

  register(
    tool(
      "todo",
      "To-do list",
      "The conversation's to-do list, which the user watches in the chat's details: the steps of the work going on here. action is add (items: the steps, in order), update (item, state todo|doing|done, or text to reword it), remove (item), clear (which: done or all) or list. item is an item's short id or its number. Each call returns the whole list. The list is temporary: clear it when the work changes or the user asks; adding steps after a finished list starts a new one.",
      {
        type: "object",
        properties: {
          action: str("add, update, remove, clear or list."),
          items: { type: "array", items: { type: "string" }, description: "add: one short line per step." },
          item: str("update, remove: the item's short id or number."),
          state: str("update: todo, doing or done."),
          text: str("update: new wording."),
          which: str("clear: done (the default is all)."),
          conversation: str("Short conversation id. The one you're in if omitted."),
        },
        required: ["action"],
      },
      (p) => call("todo", p),
    ),
  );

  register(tool("react", "React", "React to a message, or to someone's reaction on it, with one emoji. Reacting again with the same emoji takes it back.", { type: "object", properties: { message: str("Short message id."), emoji: str("One emoji."), to_reaction: { type: "number", description: "Optional: the number (#n) of the reaction on that message to react to, instead of the message itself." }, conversation: str("Short conversation id.") }, required: ["message", "emoji"] }, (p) => call("react", p)));

  register(tool("question", "Ask", "Ask the user to pick. They can also type their own answer. Don't invent the answer; stop after asking.", { type: "object", properties: { title: str("The question."), hint: str("Optional one line under it."), options: { type: "array", items: { type: "string" }, description: "Real choices. Don't add Other." }, offer: str("Only \"developer\" or \"team\", when you're told to ask whether the user writes code or to offer the starter team. The app sets their choices and makes the team."), conversation: str("Short conversation id.") }, required: ["title"] }, (p) => call("question", p)));

  register(tool("poll", "Poll", "Start a poll in a group chat. The user and every bot there can vote. Options are lettered A, B, C… for you.", { type: "object", properties: { question: str("The question."), options: { type: "array", items: { type: "string" }, description: "Two to ten choices." }, multiple: { type: "boolean", description: "Voters can pick several. One answer each if omitted." }, hide_votes: { type: "boolean", description: "Hide answers from each voter until they've answered. On if omitted; false shows them from the start." }, conversation: str("Short conversation id.") }, required: ["question", "options"] }, (p) => call("poll", p)));

  register(tool("vote_poll", "Vote", "Vote in a poll, by the letters of your choices. Voting again replaces your vote, even once the poll has closed.", { type: "object", properties: { message: str("The poll's short message id."), choices: { type: "array", items: { type: "string" }, description: "Option letters, e.g. [\"B\"]. Only one unless the poll takes several." }, conversation: str("Short conversation id.") }, required: ["message", "choices"] }, (p) => call("vote_poll", p)));

  register(tool("memory", "Memory", "Your private memory, kept across every conversation. write saves one fact as one self-contained sentence, dated for you: kind profile for a lasting fact about the user or how to work with them (always in your prompt, capped), journal (default) for what happened or was decided (search finds older ones). A fact you already have isn't copied. Newer wins: when a fact changes, pass replaces (the old one's id or exact text) rather than keeping both. forget deletes one, by id or exact text.", { type: "object", properties: { action: str("write (default) or forget."), text: str("write: one fact, in a sentence. forget: the memory's exact text."), kind: str("write: profile or journal. A new fact defaults to journal; one you already have keeps its kind unless you pass this."), replaces: str("write: the id or exact text of the outdated fact this takes the place of."), id: str("forget: the memory's id.") }, required: ["action"] }, (p) => call("memory", p)));

  register(tool("search", "Search", "Recall: search your memory (profile and journal, with each fact's kind and date), or everything ever said in your conversations. what is memory (default) or messages. An empty memory query lists your newest.", { type: "object", properties: { query: str("Words to look for, or a short id."), what: str("memory or messages.") }, required: ["query"] }, (p) => call("search", p)));

  register(
    tool(
      "bot_web_search",
      "Web search",
      "Search the web through a search provider the user set up. Your context lists which ones you have, what each is good at and which options each takes. Anything else about the web, use your browser.",
      {
        type: "object",
        properties: {
          query: str("What to search for."),
          provider: str("exa, brave, kagi, firecrawl, tavily, searxng, x or youtube. The cheapest you have, if omitted."),
          count: { type: "number", description: "How many results." },
          recency: str("day, week, month or year."),
          category: str("Exa or SearXNG: the kind of content."),
          depth: str("Tavily: basic or advanced."),
          topic: str("Tavily: general, news or finance."),
          sort: str("X: relevancy or recency."),
          order: str("YouTube: relevance, date, viewCount or rating."),
          duration: str("YouTube: short, medium or long."),
        },
        required: ["query"],
      },
      (p) => call("bot_web_search", p),
    ),
  );

  register(
    tool(
      "apps",
      "Apps",
      "The user's connected apps (GitHub, Notion, Gmail…) and the skills that came with them. action is tools (app; names or query to narrow it: each tool's description and parameters), skill (app, skill; file for one of its other files: read a skill), connect (app: show the user a card to connect an app that isn't connected), or list.",
      {
        type: "object",
        properties: {
          action: str("tools, skill, connect or list."),
          app: str("The app's id, e.g. github."),
          names: { type: "array", items: { type: "string" }, description: "For tools: just these tools." },
          query: str("For tools: words to look for in their names and descriptions."),
          skill: str("For skill: its name."),
          file: str("For skill: another file in it, as the skill names it."),
          conversation: str("For connect: short conversation id."),
        },
        required: ["action"],
      },
      (p) => call("apps", p),
    ),
  );

  register({
    name: "use_app",
    label: "Use app",
    description: "Call a tool of one of the user's connected apps. Look up its parameters with apps (action tools) first. It acts as the user in that service.",
    parameters: withStatus("use_app", { type: "object", properties: { app: str("The app's id, e.g. github."), tool: str("The tool's name."), arguments: { type: "object", description: "The tool's arguments." } }, required: ["app", "tool"] }),
    executionMode: "sequential" as const,
    exposure: "model-only" as const,
    async execute(_id: string, params: Params) {
      try {
        const out = (await call("use_app", own(params))) as { text: string; images?: { data: string; mimeType: string }[]; isError?: boolean };
        const images = (out.images ?? []).map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }));
        return { content: [...(out.text || !images.length ? text(out.text || "(no output)") : []), ...images], details: { app: params?.app, tool: params?.tool }, ...(out.isError ? { isError: true } : {}) };
      } catch (err) {
        return fail(err);
      }
    },
  });

  register(tool("routine", "Routine", "Your schedule. You can have any number of routines active at once. action is add (title, schedule like “Weekdays at 8:00” or “in 2 hours”, task), list, remove, pause or resume. follow_up true means it runs once then goes. It reports to the conversation you're in unless you name another.", { type: "object", properties: { action: str("add, list, remove, pause or resume."), title: str("What it's called."), schedule: str("When it runs."), task: str("What to do when it runs."), follow_up: { type: "boolean" }, conversation: str("Short conversation id to report to."), id: str("For remove, pause, resume.") }, required: ["action"] }, (p) => call("routine", p)));

  register(tool("ask_bot", "Ask bot", "Ask another bot and wait for their reply. It shows up as a side conversation the user can read. bot is their name or short id.", { type: "object", properties: { bot: str("Who."), text: str("What you're asking.") }, required: ["bot", "text"] }, (p) => call("ask_bot", p)));

  register(tool("side_chat", "Side chat", "Talk something through with other bots away from the main chat. action start (bots: one to four names, topic: the question, written to stand on its own, report_to: the short id of the chat to report back to, the one you're in if omitted) opens a temporary side chat the user can read but not write in. It closes after a few messages each, when it goes quiet, or with action close (conversation). Whoever opened it is asked to report back once it closes. For one quick question to one bot, use ask_bot.", { type: "object", properties: { action: str("start or close."), bots: { type: "array", items: { type: "string" }, description: "start: who to talk with, by name or short id." }, topic: str("start: what to work out."), report_to: str("start: short conversation id."), conversation: str("close: the side chat's short id. The one you're in if omitted.") }, required: ["action"] }, (p) => call("side_chat", p)));

  register(
    tool(
      "openbuild",
      "Open Build",
      "Run coding agents in the user's OpenBuild, if the user gave you access. action is options (harness for its models), add_project (primary only: path, name, create for a new folder, or url to clone), list, start (project, prompt, harness, model, effort, speed, permission, remote_control, mode worktree|local, branch, title, branch_name), read (thread), send (thread, text, and optionally model, effort, speed, permission for its next turn), answer (thread, question, answer), stop (thread), close (thread, remove_worktree), pr (thread or project, number) or merge (thread or project, number, method, delete_branch). You're told when a thread you started asks something or finishes.",
      { type: "object", properties: { action: str("options, add_project, list, start, read, send, answer, stop, close, pr or merge."), project: str("Project name or id."), path: str("add_project: the project's folder on this server, like ~/code/app."), name: str("add_project: what to call it. The folder's name if omitted."), create: { type: "boolean", description: "add_project: make the folder, empty, if it isn't there." }, url: str("add_project: a git URL to clone. Into an existing folder at path it goes in a subfolder named after the repository; otherwise path is the clone."), thread: str("Short thread id."), harness: str("A harness (pi, claude, codex, cursor, opencode, grok, hermes, fx) or a saved account id/name from options."), model: str("A model id from options. send: the thread's next turn, on its own harness and account."), query: str("options: narrow the model list."), effort: str("Reasoning effort. send: omitted keeps the thread's."), speed: str("Service tier id, from the model's speeds. send: standard turns it off."), permission: str("A permission mode id from options, if you may choose. send: the thread keeps it from its next turn."), remote_control: { type: "boolean", description: "start: Claude Code only. Open a Remote Control session so the user can continue the thread from claude.ai/code or the Claude app. Off by default; only when asked. options shows each harness's Remote Control." }, mode: str("worktree (default) or local."), branch: str("worktree: the branch to start from. local: the branch to switch to."), branch_name: str("worktree: a kebab-case name for its new branch."), title: str("A short title."), image_messages: { type: "array", items: { type: "string" }, description: "start/send: source message short ids in your conversations. Forward all their actual images to the coding agent." }, prompt: str("start: what the agent should do."), text: str("send: the message."), question: str("answer: the question id."), answer: str("answer: your answer. For choices, the option's text."), closed: { type: "boolean", description: "list: closed threads instead of open ones." }, messages: { type: "number", description: "read: how many recent messages. Default 6." }, remove_worktree: { type: "boolean" }, number: { type: "number", description: "Pull request number. The thread's own if omitted." }, method: str("merge, squash or rebase."), delete_branch: { type: "boolean" } }, required: ["action"] },
      (p) => call("openbuild", p),
    ),
  );

  register(tool("plugins", "Plugins", "OpenBuild plugins: guide gives the existing coding-thread authoring workflow to bots with this installation's project access. Primary only: list status, set a plugin's saved switch (id, enabled), or system master switch (enabled). Trusted code can run immediately when enabled. No install, delete or file access.", { type: "object", properties: { action: str("guide, list, set or system."), id: str("set: plugin id from list."), enabled: { type: "boolean" } }, required: ["action"] }, (p) => call("plugins", p)));

  register(
    tool(
      "manage_bot",
      "Manage bots",
      "Primary bot only, except renaming yourself, changing your own look, listing computers, reading the team or your conversations, or writing your own instructions or role while you have none. Setting any bot's model, effort or fallbacks is primary only too, even your own. action is status (primary only, read-only: all bots working/idle, turn start, conversation id, last runner activity, exact pending assignment deliveries; handoffs are not inferred), team (read-only: the other bots' roles and full instructions, or bot for one), conversations (read-only: every conversation you're in, with short ids and titles), create (name, instructions, role, look {shape, color}, model, effort, fallback, fallback_models), update (bot, name, instructions, role, look, proactivity off|low|normal|high, model, effort, fallback, fallback_models), models (query: the model ids bots can use), computers (the machines every bot reaches, what each allows and its isolation), defaults (default_model, default_fallbacks: the default model and fallbacks for bots without their own; omitted fields stay, none given only reads), delete (bot), create_group (name, bots: existing bot names or ids, optional instructions; always includes you), add_to_group (bot, conversation), or remove_from_group (bot, conversation). conversation is a group's short id, the one you're in if omitted.",
      { type: "object", properties: { action: str("status (primary only, read-only), team, conversations, create, create_group, update, delete, add_to_group, remove_from_group, models, defaults or computers."), bots: { type: "array", items: { type: "string" }, description: "create_group: existing bot names or full/short ids. You are included automatically." }, bot: str("Name or short id. You, if omitted, except for group changes."), conversation: str("add_to_group, remove_from_group: the group's short id."), name: str("New name."), instructions: str("What the bot is for and how it should act. Replaces the whole text. Optional when creating: leave it out if the conversation doesn't say."), role: str("What the bot is for, in one short line (100 characters at most) that teammates see in their roster. Optional, like instructions."), look: { type: "object", properties: { shape: { type: "string" }, color: { type: "string" } } }, proactivity: str("off, low, normal or high."), model: str("Primary only. A provider/model id from models, or default for the OpenBots default."), effort: str("Primary only. off, minimal, low, medium, high, xhigh, max, or default."), fallback: str("Primary only. inherit (the default fallbacks), own (fallback_models) or none."), fallback_models: { type: "array", items: { type: "string" }, description: "Primary only. With fallback own: up to 8 provider/model ids from models, tried in order. A second account's ids (openai-codex-2/…) are entries of their own." }, default_model: str("defaults, primary only. A provider/model id from models for every bot without its own, or default to clear it (Pi's default)."), default_fallbacks: { type: "array", items: { type: "string" }, description: "defaults, primary only. Up to 8 provider/model ids from models, tried in order by bots that inherit fallbacks. An empty list clears them." }, query: str("models: narrow the list.") }, required: ["action"] },
      (p) => call("manage_bot", p),
    ),
  );

  register({
    name: "load_tools",
    label: "Load tools",
    description: catalogDescription(catalog),
    parameters: { type: "object", properties: { names: { type: "array", items: { type: "string" }, description: "Tool names from the list." } }, required: ["names"] },
    executionMode: "sequential" as const,
    exposure: "model-only" as const,
    async execute(_id: string, params: Params) {
      const asked = [...new Set((Array.isArray(params?.names) ? params.names : [params?.names]).map((name) => String(name ?? "").trim()).filter(Boolean))];
      const loaded = load(asked);
      const missing = asked.filter((name) => !loaded.includes(name));
      if (!loaded.length) return fail(new Error(`${missing.length ? `No tool here is called ${missing.join(", ")}` : "Name the tools to load"}. You can load: ${catalog.join(", ")}.`));
      const said = `Loaded ${loaded.join(", ")}: call ${loaded.length === 1 ? "it" : "them"} now.${missing.length ? ` No tool here is called ${missing.join(", ")}.` : ""}`;
      return { content: text(said), details: { loaded, missing } };
    },
  });
}
