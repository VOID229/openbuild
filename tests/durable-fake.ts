import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";

/** Zero network/key access: only use the static catalog, replace the dispatch method. */
export function fakeModels(options: { answer?: string; hold?: boolean; holdAfterTool?: boolean; marker?: string; tool?: boolean; command?: string; delayMs?: number } = {}) {
  const models = builtinModels();
  const model = models.getModels().find(m => m.type === "chat")!;
  let calls = 0;
  const inputs: unknown[] = [];
  models.streamSimple = (_model, input, request) => {
    calls++;
    inputs.push(structuredClone(input.messages));
    const stream = createAssistantMessageEventStream();
    const hasTool = input.messages.some(m => m.role === "toolResult");
    const content: AssistantMessage["content"] = options.tool && !hasTool
      ? [{ type: "text", text: "before tool" }, { type: "toolCall", id: "call1", name: "bash", arguments: { command: options.command ?? "printf durable-tool" } } satisfies ToolCall]
      : [{ type: "text", text: options.answer ?? "offline answer" }];
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content, stopReason: options.tool && !hasTool ? "toolUse" : "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (options.hold || (options.holdAfterTool && hasTool)) {
        if (options.marker) writeFileSync(options.marker, "model-entered");
        request?.signal?.addEventListener("abort", () => {
          const aborted = { ...message, stopReason: "aborted" as const };
          stream.push({ type: "error", reason: "aborted", error: aborted });
        }, { once: true });
      } else if (options.delayMs) {
        // Answers after a while, like a real model, so work can be observed in flight.
        if (options.marker) writeFileSync(options.marker, "model-entered");
        const timer = setTimeout(() => stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }), options.delayMs);
        request?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const aborted = { ...message, stopReason: "aborted" as const };
          stream.push({ type: "error", reason: "aborted", error: aborted });
        }, { once: true });
      } else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    });
    return stream;
  };
  return { models, model: `${model.provider}/${model.id}`, calls: () => calls, inputs: () => inputs };
}
