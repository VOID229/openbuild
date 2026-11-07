// Loaded into each bot's `pi --mode rpc` process (`-e`). No OpenBuild imports: Pi runs this file
// on its own. Every tool calls the bots service over the unix socket the process was given
// (OPENBOTS_SOCKET, OPENBOTS_TOKEN). Built-in tools are off; bash/read/write/edit here run on the
// bot's computer, not on the machine the user is sitting at.
import { request as httpRequest } from "node:http";

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
const NO_STATUS = new Set(["send_message", "react", "question", "poll"]);
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

export default function openbots(pi: any) {
  pi.on("before_agent_start", async (event: any) => {
    try {
      const note = String(await call("context"));
      const opts = event.systemPromptOptions ?? event;
      const current = String(opts.appendSystemPrompt ?? "");
      if (!current.includes("one of the user's bots in OpenBots")) opts.appendSystemPrompt = [current, note].filter(Boolean).join("\n\n");
    } catch {
      // The turn still has the message the server sent. A missing note isn't fatal.
    }
  });

  pi.registerTool(tool("bash", "Terminal", "Run a shell command on your computer and wait for it to finish. For something long-running, use process instead.", { type: "object", properties: { command: str("The command."), cwd: str("Working directory, relative to your home if not absolute."), timeout: { type: "number", description: "Milliseconds before the command is stopped. Default 120000." } }, required: ["command"] }, (p) => call("bash", p)));

  pi.registerTool(tool("read", "Read file", "Read a text file on your computer.", { type: "object", properties: { path: str("File path."), offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] }, (p) => call("read", p)));

  pi.registerTool(tool("write", "Write file", "Write a text file on your computer, creating it if needed.", { type: "object", properties: { path: str("File path."), content: str("The whole file.") }, required: ["path", "content"] }, (p) => call("write", p)));

  pi.registerTool(tool("edit", "Edit file", "Replace one exact occurrence of text in a file on your computer.", { type: "object", properties: { path: str("File path."), old: str("The exact text to replace, including enough around it to be unique."), new: str("The replacement.") }, required: ["path", "old", "new"] }, (p) => call("edit", p)));

  pi.registerTool(
    tool(
      "browser",
      "Browser",
      "Your browser. action is open (url, new_tab), snapshot (numbered refs for the elements you can click), click (ref), type (ref, text, submit), press (key), scroll (direction up or down), screenshot, eval (script), tabs, switch (index), close (index), back, or quit. snapshot before click or type. screenshot is for you; send_message with attach_screenshot shows it to the user.",
      {
        type: "object",
        properties: {
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

  pi.registerTool(tool("process", "Process", "Start, read, stop or list long-running programs on your computer. action is start (command, name), read (id, input), stop (id) or list. You're told when one you started exits.", { type: "object", properties: { action: str("start, read, stop or list."), command: str("For start."), name: str("A short name."), id: str("The process id."), input: str("Text to write to it.") }, required: ["action"] }, (p) => call("process", p)));

  pi.registerTool(tool("send_message", "Send", "Send a message. One call is one bubble; call it again for another. conversation defaults to the one you're in (pass the short id to write somewhere else). reply_to is a message's short id. images are file paths on your computer. attach_screenshot sends the current browser page.", { type: "object", properties: { text: str("The message."), conversation: str("Short conversation id."), reply_to: str("Short message id."), images: { type: "array", items: { type: "string" } }, attach_screenshot: { type: "boolean" } }, required: ["text"] }, (p) => call("send_message", p)));

  pi.registerTool(tool("react", "React", "React to a message, or to someone's reaction on it, with one emoji. Reacting again with the same emoji takes it back.", { type: "object", properties: { message: str("Short message id."), emoji: str("One emoji."), to_reaction: { type: "number", description: "Optional: the number (#n) of the reaction on that message to react to, instead of the message itself." }, conversation: str("Short conversation id.") }, required: ["message", "emoji"] }, (p) => call("react", p)));

  pi.registerTool(tool("question", "Ask", "Ask the user to pick. They can also type their own answer. Don't invent the answer; stop after asking.", { type: "object", properties: { title: str("The question."), hint: str("Optional one line under it."), options: { type: "array", items: { type: "string" }, description: "Real choices. Don't add Other." }, offer: str("Only \"developer\" or \"team\", when you're told to ask whether the user writes code or to offer the starter team. The app sets their choices and makes the team."), conversation: str("Short conversation id.") }, required: ["title"] }, (p) => call("question", p)));

  pi.registerTool(tool("poll", "Poll", "Start a poll in a group chat. The user and every bot there can vote. Options are lettered A, B, C… for you.", { type: "object", properties: { question: str("The question."), options: { type: "array", items: { type: "string" }, description: "Two to ten choices." }, multiple: { type: "boolean", description: "Voters can pick several. One answer each if omitted." }, hide_votes: { type: "boolean", description: "Hide answers from each voter until they've answered. On if omitted; false shows them from the start." }, conversation: str("Short conversation id.") }, required: ["question", "options"] }, (p) => call("poll", p)));

  pi.registerTool(tool("vote_poll", "Vote", "Vote in a poll, by the letters of your choices. Voting again replaces your vote, even once the poll has closed.", { type: "object", properties: { message: str("The poll's short message id."), choices: { type: "array", items: { type: "string" }, description: "Option letters, e.g. [\"B\"]. Only one unless the poll takes several." }, conversation: str("Short conversation id.") }, required: ["message", "choices"] }, (p) => call("vote_poll", p)));

  pi.registerTool(tool("remember", "Remember", "Save something you'll need later, across every conversation.", { type: "object", properties: { text: str("One fact, in a sentence.") }, required: ["text"] }, (p) => call("remember", p)));

  pi.registerTool(tool("forget", "Forget", "Delete one memory by its id.", { type: "object", properties: { id: str("The memory id.") }, required: ["id"] }, (p) => call("forget", p)));

  pi.registerTool(tool("search", "Search", "Search your memory, or everything ever said in your conversations. what is memory (default) or messages.", { type: "object", properties: { query: str("Words to look for."), what: str("memory or messages.") }, required: ["query"] }, (p) => call("search", p)));

  pi.registerTool(
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

  pi.registerTool(
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

  pi.registerTool({
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

  pi.registerTool(tool("routine", "Routine", "Your schedule. You can have any number of routines active at once. action is add (title, schedule like “Weekdays at 8:00” or “in 2 hours”, task), list, remove, pause or resume. follow_up true means it runs once then goes. It reports to the conversation you're in unless you name another.", { type: "object", properties: { action: str("add, list, remove, pause or resume."), title: str("What it's called."), schedule: str("When it runs."), task: str("What to do when it runs."), follow_up: { type: "boolean" }, conversation: str("Short conversation id to report to."), id: str("For remove, pause, resume.") }, required: ["action"] }, (p) => call("routine", p)));

  pi.registerTool(tool("ask_bot", "Ask bot", "Ask another bot and wait for their reply. It shows up as a side conversation the user can read. bot is their name or short id.", { type: "object", properties: { bot: str("Who."), text: str("What you're asking.") }, required: ["bot", "text"] }, (p) => call("ask_bot", p)));

  pi.registerTool(
    tool(
      "openbuild",
      "Open Build",
      "Run coding agents in the user's OpenBuild, if the user gave you access. action is options (harness for its models), list, start (project, prompt, harness, model, effort, speed, permission, mode worktree|local, branch, title, branch_name), read (thread), send (thread, text), answer (thread, question, answer), stop (thread), close (thread, remove_worktree), pr (thread or project, number) or merge (thread or project, number, method, delete_branch). You're told when a thread you started asks something or finishes.",
      { type: "object", properties: { action: str("options, list, start, read, send, answer, stop, close, pr or merge."), project: str("Project name or id."), thread: str("Short thread id."), harness: str("A harness (pi, claude, codex, cursor, opencode, grok, hermes, fx) or a saved account id/name from options."), model: str("A model id from options."), query: str("options: narrow the model list."), effort: str("Reasoning effort."), speed: str("Service tier id, from the model's speeds."), permission: str("A permission mode id from options, if you may choose."), mode: str("worktree (default) or local."), branch: str("worktree: the branch to start from. local: the branch to switch to."), branch_name: str("worktree: a kebab-case name for its new branch."), title: str("A short title."), image_messages: { type: "array", items: { type: "string" }, description: "start/send: source message short ids in your conversations. Forward all their actual images to the coding agent." }, prompt: str("start: what the agent should do."), text: str("send: the message."), question: str("answer: the question id."), answer: str("answer: your answer. For choices, the option's text."), closed: { type: "boolean", description: "list: closed threads instead of open ones." }, messages: { type: "number", description: "read: how many recent messages. Default 6." }, remove_worktree: { type: "boolean" }, number: { type: "number", description: "Pull request number. The thread's own if omitted." }, method: str("merge, squash or rebase."), delete_branch: { type: "boolean" } }, required: ["action"] },
      (p) => call("openbuild", p),
    ),
  );

  pi.registerTool(
    tool(
      "manage_bot",
      "Manage bots",
      "Primary bot only, except renaming yourself, changing your own look, or writing your own instructions while you have none. Setting any bot's model, effort or fallbacks is primary only too, even your own. action is create (name, instructions, look {shape, color}, model, effort, fallback, fallback_models), update (bot, name, instructions, look, proactivity off|low|normal|high, model, effort, fallback, fallback_models), models (query: the model ids bots can use), delete (bot), create_group (name, bots: existing bot names or ids, optional instructions; always includes you), add_to_group (bot, conversation), or remove_from_group (bot, conversation). conversation is a group's short id, the one you're in if omitted.",
      { type: "object", properties: { action: str("create, create_group, update, delete, add_to_group, remove_from_group or models."), bots: { type: "array", items: { type: "string" }, description: "create_group: existing bot names or full/short ids. You are included automatically." }, bot: str("Name or short id. You, if omitted, except for group changes."), conversation: str("add_to_group, remove_from_group: the group's short id."), name: str("New name."), instructions: str("What the bot is for and how it should act. Replaces the whole text. Optional when creating: leave it out if the conversation doesn't say."), look: { type: "object", properties: { shape: { type: "string" }, color: { type: "string" } } }, proactivity: str("off, low, normal or high."), model: str("Primary only. A provider/model id from models, or default for the OpenBots default."), effort: str("Primary only. off, minimal, low, medium, high, xhigh, max, or default."), fallback: str("Primary only. inherit (the default fallbacks), own (fallback_models) or none."), fallback_models: { type: "array", items: { type: "string" }, description: "Primary only. With fallback own: up to 8 provider/model ids from models, tried in order. A second account's ids (openai-codex-2/…) are entries of their own." }, query: str("models: narrow the list.") }, required: ["action"] },
      (p) => call("manage_bot", p),
    ),
  );
}
