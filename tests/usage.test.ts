import { describe, expect, test } from "bun:test";
import { addUsage, emptyUsage } from "../server/pi/usage";
import { billingOf, lookup, modelKey, pricing, referencePrice, type PriceBook } from "../server/pi/pricing";
import { contextFill, formatUsd, spendKind, threadSpend } from "../src/lib/usage";
import type { ModelInfo } from "../shared/types";
import type { Message } from "../src/lib/types";

const book = (listings: PriceBook["listings"], subscriptions: string[] = []): PriceBook => {
  const byKey = new Map<string, PriceBook["listings"]>();
  for (const l of listings) byKey.set(modelKey(l.id), [...(byKey.get(modelKey(l.id)) ?? []), l]);
  return { listings, subscriptions: new Set(subscriptions), byKey };
};
const price = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });
const zero = price(0, 0);

describe("usage from Pi's messages", () => {
  test("sums requests, keeps the last as the context, and the first prompt", () => {
    const u = emptyUsage();
    addUsage(u, { input: 5000, cacheRead: 0, cacheWrite: 0, output: 200, cost: { total: 0.01 } });
    addUsage(u, { input: 300, cacheRead: 5000, cacheWrite: 100, output: 50, cost: { total: 0.002 } });
    addUsage(u, { input: 0, output: 0 }); // an aborted request
    expect(u).toMatchObject({ input: 5300, cacheRead: 5000, cacheWrite: 100, output: 250, firstPrompt: 5000, contextTokens: 5450 });
    expect(u.cost).toBeCloseTo(0.012);
    expect(u.last).toEqual({ input: 300, cacheRead: 5000, cacheWrite: 100, output: 50 });
  });
});

describe("pricing", () => {
  test("model keys drop vendor, tag, quantization and format", () => {
    expect(modelKey("Qwen/Qwen3-Coder-30B-A3B-Instruct-GGUF")).toBe("qwen3-coder-30b-a3b");
    expect(modelKey("qwen3-coder:30b-a3b-q4_K_M")).toBe("qwen3-coder-30b-a3b");
    expect(modelKey("deepseek/deepseek-chat-v3:free")).toBe("deepseek-chat-v3");
    expect(modelKey("gpt-oss-20b-mxfp4")).toBe("gpt-oss-20b");
    expect(modelKey("glm-5.3:latest")).toBe("glm-5.3");
  });

  test("billing: local hosts, plans, subscriptions, free tiers and per token", () => {
    expect(billingOf({ provider: "ollama", baseUrl: "https://example.com" })).toBe("local");
    expect(billingOf({ provider: "genesis", baseUrl: "http://192.168.50.155:8080/v1", cost: zero })).toBe("local");
    expect(billingOf({ provider: "pc", baseUrl: "http://cachyos:8080/v1", cost: zero })).toBe("local");
    expect(billingOf({ provider: "tail", baseUrl: "http://100.101.1.2:11434", cost: zero })).toBe("local");
    expect(billingOf({ provider: "openai-codex-2", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", cost: price(1, 2) })).toBe("plan");
    expect(billingOf({ provider: "pi-claude", api: "claude-bridge", baseUrl: "claude-bridge", cost: zero })).toBe("plan");
    expect(billingOf({ provider: "opencode-go", baseUrl: "https://opencode.ai/inference/go", cost: price(1, 2) })).toBe("plan");
    expect(billingOf({ provider: "opencode", baseUrl: "https://opencode.ai/inference", cost: price(1, 2) })).toBe("api");
    expect(billingOf({ provider: "xai", baseUrl: "https://api.x.ai/v1", cost: price(1, 2) }, book([], ["xai"]))).toBe("plan");
    expect(billingOf({ provider: "xai", baseUrl: "https://api.x.ai/v1", cost: price(1, 2) }, book([]))).toBe("api");
    expect(billingOf({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", cost: zero })).toBe("free");
  });

  test("zero-priced models borrow the vendor's price, else the closest listing", () => {
    const b = book([
      { provider: "vercel-ai-gateway", id: "anthropic/claude-fable-5-1", cost: price(11, 55) },
      { provider: "anthropic", id: "claude-fable-5-1", cost: price(10, 50, 1, 12.5) },
      { provider: "together", id: "Qwen/Qwen3-Coder-30B-A3B-Instruct", cost: price(0.15, 0.6) },
    ]);
    expect(pricing({ provider: "pi-claude", id: "claude-fable-5-1", api: "claude-bridge", cost: zero }, b)).toEqual({
      billing: "plan", price: price(10, 50, 1, 12.5), priceFrom: "anthropic/claude-fable-5-1",
    });
    expect(referencePrice("qwen3-coder:30b", b)?.provider).toBe("together");
    expect(referencePrice("totally-unknown-model", b)).toBeUndefined();
    // Models Pi no longer lists: quantized ones ran locally.
    expect(lookup("strata/qwen3-coder-30b-a3b-iq1_m", b)).toMatchObject({ billing: "local", priceFrom: "together/Qwen/Qwen3-Coder-30B-A3B-Instruct" });
    expect(lookup("anthropic/claude-fable-5-1", b)).toMatchObject({ billing: "api", price: price(10, 50, 1, 12.5) });
    expect(lookup("gone/unknown", b)).toEqual({ billing: undefined });
    // Its own price wins.
    expect(pricing({ provider: "openrouter", id: "x/y", baseUrl: "https://openrouter.ai/api/v1", cost: price(1, 2, 0.1) }, b)).toEqual({ billing: "api", price: price(1, 2, 0.1, 0) });
  });
});

describe("thread spend and context", () => {
  const models: ModelInfo[] = [
    { id: "openrouter/a", name: "A", protocol: "chat", reasoning: { efforts: [], mode: "none", toggle: false }, input: ["text"], billing: "api", price: price(1, 2), contextLimit: 100_000 },
    { id: "ollama/q", name: "Q", protocol: "chat", reasoning: { efforts: [], mode: "none", toggle: false }, input: ["text"], billing: "local", price: price(1, 10), priceFrom: "together/q" },
  ];
  const reply = (id: string, model: string, usage: Message["usage"]): Message => ({ id, role: "assistant", content: "", createdAt: 0, model: { plan: "pi", id: model, name: model }, usage });
  const user = (content: string): Message => ({ id: content, role: "user", content, createdAt: 0 });

  test("billed costs as reported; local ones estimated", () => {
    const s = threadSpend([user("hi"), reply("1", "openrouter/a", { input: 1000, output: 100, cost: 0.0012 }), user("more"), reply("2", "ollama/q", { input: 1000, output: 100, cost: 0 })], models)!;
    expect(s.billed).toBeCloseTo(0.0012);
    expect(s.free).toBeCloseTo(0.002);
    expect(s.estimatedFrom).toEqual(["together/q"]);
    expect(spendKind(s)).toBe("");
    const local = threadSpend([user("x"), reply("2", "ollama/q", { input: 1000, output: 100, cost: 0 })], models)!;
    expect(spendKind(local)).toBe("free");
    expect(formatUsd(local.total)).toBe("$0.002");
  });

  test("the context by kind, with the system prompt taken out of the cached input", () => {
    const prompt = "x".repeat(400); // ~100 tokens
    const fill = contextFill([
      user(prompt),
      reply("1", "openrouter/a", { firstPrompt: 6100, last: { input: 500, cacheRead: 9000, cacheWrite: 0, output: 300 }, contextTokens: 9800 }),
    ], models)!;
    expect(fill.window).toBe(100_000);
    expect(fill.rows).toEqual({ system: 6000, cacheRead: 3000, cacheWrite: 0, input: 500, output: 300 });
  });

  test("money", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0004)).toBe("<$0.001");
    expect(formatUsd(0.021)).toBe("$0.021");
    expect(formatUsd(3.456)).toBe("$3.46");
  });
});
