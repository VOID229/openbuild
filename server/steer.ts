// Steering: handing a message to a thread's running turn, which the agent reads after its current
// step. One path for the composer's Steer button (/api/pi/threads/:id/steer) and for bots' send.
import type { PiChatRequest } from "../shared/types";
import * as remote from "./pi/remote";
import { threadRuntime } from "./threadRuntime";

export { isUnsupportedSteer, STEER_UNSUPPORTED } from "./steerErrors";

/**
 * Steer a thread's running turn. Resolves once its harness took the message (`handled` says an
 * extension consumed it rather than the model); the turn's `steer` event says when the agent read it.
 * Throws when it can't take it, with STEER_UNSUPPORTED when it never could.
 */
export async function steerThread(threadId: string, steerId: string, message: string, images?: PiChatRequest["images"], display?: string): Promise<{ handled: boolean }> {
  if (threadRuntime(threadId) === "durable") return (await import("./durable")).steer(threadId, steerId, message, images, display);
  return remote.steer(threadId, steerId, message, images, display);
}
