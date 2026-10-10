// Efficient web search: search results go through the digest model, and the chat model only sees
// the digest. Opencode, models.dev and the SearXNG instance are all faked.
import { afterEach, describe, expect, test } from "bun:test";
import { handleChat } from "../server/handlers";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const sse = (...chunks: unknown[]) =>
  new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(""), { headers: { "content-type": "text/event-stream" } });
const say = (text: string) => sse({ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] });
const callSearch = () =>
  sse(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "search_searxng", arguments: '{"query":"opencode news"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  );

/** Fake upstreams; returns what the chat model was sent on its second turn and what the digest model was asked. */
function fake(opts: { digestFails?: boolean; snippet?: string } = {}) {
  const seen = { toolResult: "", digestPrompt: "", digestCalls: 0 };
  const snippet = opts.snippet ?? "lorem ipsum dolor sit amet ".repeat(30);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("models.dev")) return new Response("nope", { status: 503 });
    if (url.startsWith("https://searx.test/")) {
      return Response.json({ results: Array.from({ length: 5 }, (_, i) => ({ title: `Result ${i}`, url: `https://example.com/${i}`, content: snippet })) });
    }
    if (url.endsWith("/chat/completions")) {
      const body = JSON.parse(String(init?.body));
      if (body.model === "small-model") {
        seen.digestCalls++;
        seen.digestPrompt = body.messages.at(-1).content;
        return opts.digestFails ? new Response("boom", { status: 500 }) : say("DIGEST: [Result 0](https://example.com/0) says hi.");
      }
      const tool = body.messages.find((m: any) => m.role === "tool");
      if (!tool) return callSearch();
      seen.toolResult = tool.content;
      return say("Answer.");
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return seen;
}

async function run(digest: boolean) {
  const body = {
    plan: "go" as const,
    model: "main-model",
    effort: "medium" as const,
    sessionId: "s",
    messages: [{ role: "user" as const, content: "What's new with opencode?" }],
    search: [{ provider: "searxng" as const, keys: ["https://searx.test"] }],
    digest: digest ? { plan: "go" as const, model: "small-model", effort: "low" as const } : undefined,
  };
  const res = await handleChat(new AbortController().signal, body, async () => ["key"]);
  return (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("efficient web search", () => {
  test("the chat model sees the digest, not the raw results", async () => {
    const seen = fake();
    const events = await run(true);
    expect(seen.digestCalls).toBe(1);
    expect(seen.digestPrompt).toContain("What's new with opencode?");
    expect(seen.digestPrompt).toContain("opencode news");
    expect(seen.digestPrompt).toContain("https://example.com/4");
    expect(seen.toolResult).toContain("DIGEST: [Result 0](https://example.com/0)");
    expect(seen.toolResult).not.toContain("lorem ipsum");
    const done = events.find((e) => e.t === "search" && e.status === "done");
    expect(done.digested).toBe(true);
    expect(done.results).toHaveLength(5);
    expect(events.filter((e) => e.t === "text").map((e) => e.v).join("")).toBe("Answer.");
  });

  test("off: raw results, no digest call", async () => {
    const seen = fake();
    await run(false);
    expect(seen.digestCalls).toBe(0);
    expect(seen.toolResult).toContain("lorem ipsum");
  });

  test("a failed digest falls back to the raw results", async () => {
    const seen = fake({ digestFails: true });
    const events = await run(true);
    expect(seen.digestCalls).toBe(1);
    expect(seen.toolResult).toContain("lorem ipsum");
    expect(events.find((e) => e.t === "search" && e.status === "done").digested).toBeUndefined();
  });

  test("short results skip the digest", async () => {
    const seen = fake({ snippet: "tiny" });
    await run(true);
    expect(seen.digestCalls).toBe(0);
    expect(seen.toolResult).toContain("tiny");
  });
});
