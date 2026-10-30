/**
 * Durable backend, as the rest of the server sees it.
 *
 * The runtime itself (storage, manifests, harness) lives in `runtime.ts`. It runs in a separate,
 * long-lived worker process (`worker.ts`) so a server restart doesn't interrupt a turn: the worker
 * keeps working and the restarted server reattaches to it through `remote.ts`.
 */
import type { PiChatRequest } from "../../shared/types";
import { DurableClient } from "./remote";

export { DurableRun } from "./remote";
export { DurableRuntime, DurableUnsupportedError } from "./runtime";

const hot = globalThis as typeof globalThis & { openbuildDurableClient?: DurableClient };
const client = (hot.openbuildDurableClient ??= new DurableClient());
export const startRun = (request: PiChatRequest) => client.startRun(request);
export const run = startRun;
export const findRun = (id: string) => client.findRun(id);
export const stopRun = (id: string) => client.stopRun(id);
export const answerQuestion = (threadId: string, askId: string, reply: import("./questions").QuestionReply) => client.answerQuestion(threadId, askId, reply);
export const stopThread = (threadId: string) => client.stopThread(threadId);
/** Call on server startup, not on first client reconnect. */
export const recover = () => client.recover();
export const compact = (threadId: string, instructions?: string) => client.compact(threadId, instructions);
export const steer = (threadId: string, steerId: string, message: string, images?: PiChatRequest["images"]) => client.steer(threadId, steerId, message, images);
