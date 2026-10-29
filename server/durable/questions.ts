import { defineExtension } from "@earendil-works/pi-durable";
import { cleanOptions } from "../pi/extensions/question-ask";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";

/** Stored in the run manifest, indexed by the provider's native call ID. */
export interface DurableQuestion {
  question: string;
  options: string[];
  answered: boolean;
  answer?: string;
}
export interface QuestionReply { value?: string; confirmed?: boolean; cancelled?: boolean }
export const QUESTION_INSTRUCTIONS = "When you need a decision or clarification from the user to proceed, call question_ask instead of asking in prose, and wait for its answer. The user answers in the app: one of your options, or their own words (Other is always offered; never add an Other or Something else option). Do not invent the answer.";

/**
 * pi-durable's public ToolRegistration.replay='safe' reruns interrupted execute checkpoints with
 * the same api.callId. The host persists both the question and reply before publishing events;
 * polling is only a notification mechanism, never the source of truth. A worker crash on either
 * side of returning the result therefore reuses the same reply instead of asking twice.
 */
export function durableQuestions(wait: (callId: string, question: string, options: string[], context: Context) => Promise<string | undefined>) {
  return defineExtension({
    name: "openbuild-questions",
    sections: [{ key: "questions", render: () => QUESTION_INSTRUCTIONS }],
    tools: [{
      name: "question_ask",
      description: "Ask the user one question and wait for their answer. Supply real choices only; Other/free text is always available. Omit options for an open question. Never invent the answer.",
      replay: "safe",
      parameters: {
        type: "object", properties: {
          question: { type: "string", minLength: 1 },
          options: { type: "array", items: { type: "string" } },
        }, required: ["question"],
      },
      async execute(args: { question: string; options?: string[] }, api, context) {
        const question = args.question.trim();
        if (!question) return { output: [{ type: "text", text: "Error: question_ask needs a question." }], isError: true };
        const options = cleanOptions(args.options);
        const answer = await wait(api.callId, question, options, context);
        return { output: [{ type: "text", text: answer === undefined ? "The user dismissed the question without answering." : `The user answered: ${answer}` }] };
      },
    }],
  });
}

export async function questionTick(context: Context) {
  await awaitWithContext(Bun.sleep(50), context);
}
