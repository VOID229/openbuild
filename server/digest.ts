// Efficient web search: a separate (usually small, cheap) model condenses each search's raw
// results into a dense digest, and only that digest goes back to the chat model. Long chats then
// carry a few hundred tokens per search instead of several thousand, on every later turn.
import type { ChatRequest, SearchDigestModel, WireMessage } from "../shared/types";
import { describeModels } from "./catalog";
import { buildUpstream, isKeyFailure, readTurn } from "./opencode";
import type { SearchOutcome } from "./search";

/** Results shorter than this go to the chat model as they are: a digest wouldn't save anything. */
const MIN_CHARS = 1500;
const TIMEOUT = 60_000;

const SYSTEM = [
  "You condense raw web search results for another AI model, which will use your digest to answer the user. That model never sees the raw results, only what you write, so anything you leave out is lost.",
  "- Keep every fact relevant to the search query and the user's message: numbers, prices, dates, versions, names, specs, direct quotes, and steps. Keep exact figures and wording; don't round or paraphrase them away.",
  "- Attribute facts to their sources with inline Markdown links using the exact URLs from the results, e.g. [Title](https://example.com). Never invent or alter URLs.",
  "- Note publication dates when given, and flag when sources disagree or a result looks outdated or unreliable.",
  "- Drop what doesn't help: navigation text, ads, cookie banners, boilerplate, duplicates, and off-topic results.",
  "- If the results don't answer the query, or only partly, say so plainly, so the other model can search again.",
  "- Report only what the results say: don't add your own knowledge, and don't answer the user yourself.",
  "Write dense Markdown (short sections or bullets), as long as the relevant content needs and no longer. No preamble.",
].join("\n");

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The most recent user message, for context on what the search is for. */
function lastQuestion(messages: WireMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") return messages[i]!.content.trim();
  return "";
}

export type Digest = (outcome: SearchOutcome, label: string, signal: AbortSignal) => Promise<string | undefined>;

/** A digest function for the chosen model, or undefined when it can't be used (unknown model, no key). */
export async function searchDigest(choice: SearchDigestModel, keys: string[], request: ChatRequest): Promise<Digest | undefined> {
  if (!keys.length) return undefined;
  const [model] = await describeModels(choice.plan, [choice.model]).catch(() => []);
  if (!model) return undefined;
  const question = clip(lastQuestion(request.messages), 4000);

  return async (outcome, label, signal) => {
    if (outcome.error || outcome.text.length < MIN_CHARS) return undefined;
    const content = [
      question && `The user's message:\n<message>\n${question}\n</message>`,
      `Search query (${label}): ${outcome.query}`,
      `Results:\n<results>\n${outcome.text}\n</results>`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const req: ChatRequest = {
      plan: choice.plan,
      model: model.id,
      effort: choice.effort,
      system: SYSTEM,
      sessionId: `${request.sessionId}-search`.slice(0, 128),
      messages: [{ role: "user", content }],
    };
    const timed = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]);
    // Try the plan's keys in order, like a chat turn. Any other failure falls back to the raw results.
    for (const key of keys) {
      try {
        const upstream = buildUpstream(model, { ...req, key }, undefined);
        const res = await fetch(upstream.url, { method: "POST", headers: upstream.headers, body: JSON.stringify(upstream.body), signal: timed });
        if (!res.ok || !res.body) {
          const message = await res.text().catch(() => "");
          if (isKeyFailure(res.status, message)) continue;
          return undefined;
        }
        const turn = await readTurn(model, res, () => {});
        const text = turn?.text.trim();
        return text || undefined;
      } catch (err) {
        if (signal.aborted) throw err;
        return undefined;
      }
    }
    return undefined;
  };
}
