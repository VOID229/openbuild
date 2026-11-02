import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";

type ModelStream = ReturnType<Models["streamSimple"]>;

/**
 * Durable 1.4 joins its model iterator before running the task's abort handler. A provider that
 * ignores signal can therefore strand Stop (and Harness.close) forever. Cancel the host's wait,
 * not the durable task: the scheduler still owns abort marking, settlement and late-result fencing.
 */
function abortableStream(stream: ModelStream, signal?: AbortSignal): ModelStream {
  if (!signal) return stream;
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  async function* iterate() {
    const iterator = stream[Symbol.asyncIterator]();
    try {
      while (true) {
        signal!.throwIfAborted();
        const next = await awaitWithContext(iterator.next(), context);
        if (next.done) return;
        yield next.value;
      }
    } finally {
      // Best effort only: a stuck next() can also prevent the underlying generator's return().
      void iterator.return?.().catch(() => {});
    }
  }
  return new Proxy(stream, {
    get(target, property) {
      if (property === Symbol.asyncIterator) return iterate;
      if (property === "result") return () => awaitWithContext(target.result(), context);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Keep the configured ModelRuntime/credentials and method receivers intact. No provider requests added. */
export function cancellationSafeModels(models: Models): Models {
  const streamSimple: Models["streamSimple"] = (model, input, options) => {
    options?.signal?.throwIfAborted();
    return abortableStream(models.streamSimple(model, input, options), options?.signal);
  };
  // Compaction uses completeSimple rather than consuming streamSimple through this wrapper.
  const completeSimple: Models["completeSimple"] = (model, input, options) => {
    options?.signal?.throwIfAborted();
    const result = models.completeSimple(model, input, options);
    return options?.signal ? awaitWithContext(result, withAbortSignal(options.signal, BACKGROUND_CONTEXT)) : result;
  };
  const fetchDeferred: Models["fetchDeferred"] = (model, handle, options) => {
    options?.signal?.throwIfAborted();
    const result = models.fetchDeferred(model, handle, options);
    return options?.signal ? awaitWithContext(result, withAbortSignal(options.signal, BACKGROUND_CONTEXT)) : result;
  };
  return new Proxy(models, {
    get(target, property) {
      if (property === "streamSimple") return streamSimple;
      if (property === "completeSimple") return completeSimple;
      if (property === "fetchDeferred") return fetchDeferred;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
