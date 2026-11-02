import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type Models } from "@earendil-works/pi-ai";
import { cancellationSafeModels } from "../server/durable/models";
import { fakeModels } from "./durable-fake";

test("Durable model cancellation covers missing stream results, compaction and deferred fetch", async () => {
  const fake = fakeModels();
  const model = fake.models.getModels().find(m => m.type === "chat")!;
  fake.models.streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    stream.end(); // a malformed provider ends iteration but never resolves result()
    return stream;
  };
  fake.models.fetchDeferred = () => new Promise(() => {});
  fake.models.completeSimple = () => new Promise(() => {});
  const wrapped = cancellationSafeModels(fake.models);
  const abort = new AbortController();
  const stream = wrapped.streamSimple(model, { messages: [] }, { signal: abort.signal });
  const waiting = stream.result();
  const fetching = wrapped.fetchDeferred(model, {} as any, { signal: abort.signal });
  const compacting = wrapped.completeSimple(model, { messages: [] }, { signal: abort.signal });
  abort.abort();
  await expect(waiting).rejects.toThrow();
  await expect(fetching).rejects.toThrow();
  await expect(compacting).rejects.toThrow();
});

test("Durable does not dispatch an already-cancelled provider request", () => {
  const fake = fakeModels();
  const model = fake.models.getModels().find(m => m.type === "chat")!;
  const abort = new AbortController();
  abort.abort();
  expect(() => cancellationSafeModels(fake.models).streamSimple(model, { messages: [] }, { signal: abort.signal })).toThrow();
  expect(fake.calls()).toBe(0);
});

test("Durable model wrapper preserves original method receivers", () => {
  class StatefulModels {
    #value = "original receiver";
    getProviders() { return this.#value; }
  }
  const wrapped = cancellationSafeModels(new StatefulModels() as unknown as Models);
  expect(wrapped.getProviders() as unknown).toBe("original receiver");
});
