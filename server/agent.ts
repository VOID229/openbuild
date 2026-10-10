// Streams a chat reply as NDJSON StreamEvents. When web search is configured, runs the tool
// loop: the model calls search tools, OpenChat runs them and sends the results back, until
// the model answers (or the round limit forces a final answer). With a digest model set, each
// search's results are condensed by that model first, and the chat model only sees the digest.
import { SEARCH_PROVIDERS, type ChatRequest, type ModelInfo, type StreamEvent } from "../shared/types";
import type { Digest } from "./digest";
import { buildUpstream, finishTurn, readTurn, toolResults, upstreamError, type ToolOptions } from "./opencode";
import type { SearchToolkit } from "./search";

const MAX_ROUNDS = 8;

export function streamReply(
  model: ModelInfo,
  request: ChatRequest & { key: string },
  first: Response,
  signal: AbortSignal,
  opts: { prelude: StreamEvent[]; label: string; search?: SearchToolkit; digest?: Digest },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (e: StreamEvent) => {
        if (!closed) controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      };
      // Keep the connection warm while a model thinks silently or a search runs.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);
      for (const e of opts.prelude) send(e);

      // Separate text (and reasoning) written before and after a round of searches.
      let wroteText = false;
      let wroteReasoning = false;
      let breakText = false;
      let breakReasoning = false;
      const emit = (e: StreamEvent) => {
        if (e.t === "text") {
          if (breakText) send({ t: "text", v: "\n\n" });
          breakText = false;
          wroteText = true;
        } else if (e.t === "reasoning") {
          if (breakReasoning) send({ t: "reasoning", v: "\n\n" });
          breakReasoning = false;
          wroteReasoning = true;
        }
        send(e);
      };

      const tools: ToolOptions | undefined = opts.search && { tools: opts.search.specs, extra: [] };
      let res = first;
      let output = 0;
      try {
        for (let round = 1; ; round++) {
          const turn = await readTurn(model, res, emit);
          if (!turn) break;
          output += turn.usage.output ?? 0;
          const { calls, assistant } = finishTurn(model.protocol, turn);
          if (!tools || !calls.length) {
            send({ t: "done", finish: turn.finish, usage: { input: turn.usage.input, output: output || undefined } });
            break;
          }

          const outputs = await Promise.all(
            calls.map(async (c) => {
              const provider = opts.search!.providerFor(c.name);
              if (!provider) return `Error: unknown tool ${c.name}.`;
              // Unique across rounds: some providers number their call ids per response.
              const id = `${round}:${c.id}`;
              let query = "";
              try {
                query = String(JSON.parse(c.args).query ?? "");
              } catch {}
              send({ t: "search", id, provider, query, status: "running" });
              const r = await opts.search!.run(c.name, c.args, signal);
              const digest = opts.digest && (await opts.digest(r, SEARCH_PROVIDERS[r.provider].label, signal));
              send({
                t: "search",
                id,
                provider: r.provider,
                query: r.query,
                status: r.error ? "error" : "done",
                results: r.links,
                error: r.error,
                digested: digest ? true : undefined,
              });
              return digest ? `Digest of the search results (condensed by another model; search again with a more specific query if you need more detail):\n\n${digest}` : r.text;
            }),
          );
          tools.extra.push(...assistant, ...toolResults(model.protocol, calls, outputs));
          tools.final = round >= MAX_ROUNDS;
          breakText = wroteText;
          breakReasoning = wroteReasoning;

          const upstream = buildUpstream(model, request, tools);
          res = await fetch(upstream.url, { method: "POST", headers: upstream.headers, body: JSON.stringify(upstream.body), signal });
          if (!res.ok || !res.body) {
            send(await upstreamError(res, opts.label));
            break;
          }
        }
      } catch (err) {
        if (!signal.aborted) send({ t: "error", message: `Connection to Opencode was interrupted: ${(err as Error).message}` });
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      first.body?.cancel().catch(() => {});
    },
  });
}
