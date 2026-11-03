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

function tool(name: string, label: string, description: string, parameters: object, run: (params: Params) => Promise<unknown>) {
  return {
    name,
    label,
    description,
    parameters,
    executionMode: "sequential" as const,
    exposure: "model-only" as const,
    async execute(_id: string, params: Params) {
      try {
        return ok(await run(params ?? {}));
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

  pi.registerTool(tool("question", "Ask", "Ask the user to pick. They can also type their own answer. Don't invent the answer; stop after asking.", { type: "object", properties: { title: str("The question."), hint: str("Optional one line under it."), options: { type: "array", items: { type: "string" }, description: "Real choices. Don't add Other." }, conversation: str("Short conversation id.") }, required: ["title"] }, (p) => call("question", p)));

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

  pi.registerTool(tool("routine", "Routine", "Your schedule. You can have any number of routines active at once. action is add (title, schedule like “Weekdays at 8:00” or “in 2 hours”, task), list, remove, pause or resume. follow_up true means it runs once then goes. It reports to the conversation you're in unless you name another.", { type: "object", properties: { action: str("add, list, remove, pause or resume."), title: str("What it's called."), schedule: str("When it runs."), task: str("What to do when it runs."), follow_up: { type: "boolean" }, conversation: str("Short conversation id to report to."), id: str("For remove, pause, resume.") }, required: ["action"] }, (p) => call("routine", p)));

  pi.registerTool(tool("ask_bot", "Ask bot", "Ask another bot and wait for their reply. It shows up as a side conversation the user can read. bot is their name or short id.", { type: "object", properties: { bot: str("Who."), text: str("What you're asking.") }, required: ["bot", "text"] }, (p) => call("ask_bot", p)));

  pi.registerTool(
    tool(
      "manage_bot",
      "Manage bots",
      "Primary bot only, except renaming yourself, changing your own look, or writing your own instructions while you have none. action is create (name, instructions, look {shape, color}), update (bot, name, instructions, look, proactivity off|low|normal|high), delete (bot), or finish_onboarding.",
      { type: "object", properties: { action: str("create, update, delete or finish_onboarding."), bot: str("Name or short id. You, if omitted."), name: str("New name."), instructions: str("What the bot is for and how it should act. Replaces the whole text. Optional when creating: leave it out if the conversation doesn't say."), look: { type: "object", properties: { shape: { type: "string" }, color: { type: "string" } } }, proactivity: str("off, low, normal or high.") }, required: ["action"] },
      (p) => call("manage_bot", p),
    ),
  );
}
