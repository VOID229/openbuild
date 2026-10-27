import { describe, expect, test } from "bun:test";
import { claude, codex, cursorPriceModel, grok, opencodeRecord, pi, type Format, type Rec } from "../server/usage/formats";
import { readRoute } from "../src/lib/routes";

function run(format: Format, lines: unknown[]): Rec[] {
  const state = format.initial();
  const out: Rec[] = [];
  for (const l of lines) format.parse(l, state, out);
  return out;
}

describe("usage transcripts", () => {
  test("Pi: per-message usage, provider-qualified model, session id carried", () => {
    const out = run(pi, [
      { type: "session", id: "s1" },
      { type: "message", id: "a", timestamp: "2026-10-01T00:00:00Z", message: { role: "assistant", provider: "pi-claude", model: "claude-opus-5-5", usage: { input: 2, output: 5, cacheRead: 100, cacheWrite: 10, cost: { total: 0 } } } },
      { type: "message", id: "b", timestamp: "2026-10-01T00:00:01Z", message: { role: "user" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ model: "pi-claude/claude-opus-5-5", session: "s1", input: 2, cacheRead: 100, cacheWrite: 10, output: 5, cost: null });
  });

  test("Claude Code: skips synthetic replies; content blocks share a key", () => {
    const line = (uuid: string) => ({ type: "assistant", uuid, requestId: "r1", sessionId: "s", timestamp: "2026-10-01T00:00:00Z", message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 50, cache_creation_input_tokens: 2 } } });
    const out = run(claude, [line("u1"), line("u2"), { ...line("u3"), message: { ...line("u3").message, model: "<synthetic>" } }]);
    expect(out).toHaveLength(2);
    expect(out[0]!.key).toBe(out[1]!.key);
  });

  test("Codex: cached input is split out, re-emitted counters are skipped, resumed sessions count", () => {
    const tc = (t: number, last: [number, number, number], total: number) => ({ type: "event_msg", timestamp: new Date(t).toISOString(), payload: { type: "token_count", info: { last_token_usage: { input_tokens: last[0], cached_input_tokens: last[1], output_tokens: last[2] }, total_token_usage: { total_tokens: total } } } });
    const out = run(codex, [
      { type: "session_meta", timestamp: "2026-10-01T00:00:00Z", payload: { id: "s" } },
      { type: "turn_context", payload: { model: "gpt-6-astra" } },
      tc(1e12, [100, 80, 10], 110),
      tc(1e12 + 1, [100, 80, 10], 110), // re-emitted
      tc(1e12 + 2, [200, 150, 20], 330),
      tc(1e12 + 3, [50, 0, 5], 55), // resumed in a new process
    ]);
    expect(out.map((r) => [r.input, r.cacheRead, r.output])).toEqual([[20, 80, 10], [50, 150, 20], [50, 0, 5]]);
  });

  test("Codex: a fork's copied history isn't counted again", () => {
    const out = run(codex, [
      { type: "session_meta", timestamp: new Date(1e12).toISOString(), payload: { id: "child", forked_from_id: "parent" } },
      { type: "turn_context", payload: { model: "m" } },
      { type: "event_msg", timestamp: new Date(1e12 + 10).toISOString(), payload: { type: "token_count", info: { last_token_usage: { input_tokens: 9, output_tokens: 1 }, total_token_usage: { total_tokens: 10 } } } },
      { type: "event_msg", timestamp: new Date(1e12 + 60_000).toISOString(), payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5, output_tokens: 1 }, total_token_usage: { total_tokens: 16 } } } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.input).toBe(5);
  });

  test("Grok: per-model usage with reported cost in ticks", () => {
    const out = run(grok, [{ timestamp: 1790512576, params: { sessionId: "s", _meta: { agentTimestampMs: 1790512576003 }, update: { sessionUpdate: "turn_completed", prompt_id: "p1", usage: { inputTokens: 32183, outputTokens: 256, cachedReadTokens: 15872, costUsdTicks: 132326640, modelUsage: { "grok-4.5-build": { inputTokens: 32183, outputTokens: 256, cachedReadTokens: 15872, costUsdTicks: 132326640 } } } } } }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ model: "grok-4.5-build", input: 16311, cacheRead: 15872, output: 256 });
    expect(out[0]!.cost).toBeCloseTo(0.0132, 4);
  });

  test("OpenCode: zero cost means unknown; reasoning counts as output", () => {
    const r = opencodeRecord(JSON.stringify({ role: "assistant", modelID: "beam", cost: 0, time: { created: 5 }, tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 0 } } }), "id", "s", 0);
    expect(r).toMatchObject({ output: 5, cacheRead: 4, cost: null, key: "opencode:id" });
  });

  test("Cursor model names price as the base model", () => {
    expect(cursorPriceModel("cursor-grok-4.6-high-fast")).toBe("grok-4.6");
    expect(cursorPriceModel("claude-fable-5-thinking-high")).toBe("claude-fable-5");
  });

  test("/usage is a route", () => {
    expect(readRoute("/usage")).toEqual({ usage: true });
    expect(readRoute("/usage/")).toEqual({ usage: true });
  });
});
