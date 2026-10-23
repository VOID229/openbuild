// A Pi extension OpenBuild loads (`-e`) into every thread's `pi --mode rpc` process. It gives the
// model `question_ask`: one question with lettered choices and a free-text "Other", asked through
// Pi's RPC `select` dialog. sessions.ts recognizes that dialog as this tool's (same question, while
// the call runs) and the app draws it as a question card with a box for Other; Pi passes whatever
// the user typed back as the selected value.
//
// The terminal-only `ask` tool (an extension in ~/.pi/agent) can't work in RPC mode, so it's turned
// off here, along with the note it adds to the system prompt.
//
// No imports: Pi loads this file on its own, and OpenBuild typechecks it without Pi's packages.

export const TOOL = "question_ask";

interface Details {
  question: string;
  options: string[];
  answer: string | null;
  letter: string | null;
  custom?: boolean;
}

/** Choices that duplicate the built-in Other. */
const OTHER = /^(?:other|something else|something different|none of (?:these|the above)|type (?:something|your own)(?:\.{3})?|custom(?: answer)?|free[- ]?text)$/i;
const ASK_NOTE = /\n*When you need a decision or clarification to proceed, call the ask tool[^\n]*/g;
const NOTE =
  "When you need a decision or clarification from the user to proceed, call question_ask instead of asking in prose, and wait for its answer. The user answers in the app: one of your options, or their own words (Other is always offered; never add an Other or Something else option). Do not invent the answer.";

export const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));

/** The options as shown: trimmed, without blanks, duplicates, or a hand-made Other. */
export const cleanOptions = (options: unknown): string[] =>
  Array.isArray(options)
    ? [...new Set(options.filter((o): o is string => typeof o === "string").map((o) => o.trim()))].filter((o) => o && !OTHER.test(o.replace(/^[A-Z][.)]\s+/, "")))
    : [];

const text = (t: string) => [{ type: "text", text: t }];

export default function questionAsk(pi: any) {
  let wired = false;
  pi.on("session_start", () => {
    if (wired) return;
    wired = true;
    pi.setActiveTools(pi.getActiveTools().filter((name: string) => name !== "ask"));
    // Registered now, after every extension has loaded, so it runs after `ask`'s own handler.
    pi.on("before_agent_start", (event: any) => {
      const opts = event.systemPromptOptions;
      const current = String(opts.appendSystemPrompt ?? "").replace(ASK_NOTE, "");
      opts.appendSystemPrompt = current.includes("call question_ask") ? current : `${current}\n\n${NOTE}`.trim();
    });
  });

  pi.registerTool({
    name: TOOL,
    label: "Question",
    description:
      "Ask the user one question and wait for the answer. Give the real choices as options (shown as A, B, C, …); the user can always answer in their own words instead, so never include Other, Something else, or a free-text choice. Leave options empty for an open question. Use this instead of asking in prose when you need a decision to continue. Do not invent the answer.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, on its own. Put needed context in it briefly." },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Real choices only. Do not include Other or a free-text choice; one is always added.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    executionMode: "sequential",
    exposure: "model-only",

    async execute(_id: string, params: { question: string; options?: string[] }, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const question = String(params.question ?? "").trim();
      const options = cleanOptions(params.options);
      const details = (answer: string | null, letter: string | null, custom?: boolean): Details => ({ question, options, answer, letter, custom });
      if (!question) return { content: text("Error: question_ask needs a question."), details: details(null, null), isError: true };
      if (!ctx.hasUI) return { content: text("Error: there's no one to ask (Pi isn't running with a UI)."), details: details(null, null), isError: true };

      const answer: string | undefined = await ctx.ui.select(question, options, { signal });
      if (signal.aborted || answer === undefined) return { content: text("The user dismissed the question without answering."), details: details(null, null) };
      const at = options.indexOf(answer);
      if (at >= 0) return { content: text(`User selected ${letter(at)}. ${answer}`), details: details(answer, letter(at)) };
      return { content: text(`User answered in their own words: ${answer}`), details: details(answer, null, true) };
    },
  });
}
